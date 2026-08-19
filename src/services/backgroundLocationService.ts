// src/services/backgroundLocationService.ts

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Alert, AppState, Linking, Platform } from "react-native";
import { client } from "../lib/client";

import {
    BACKGROUND_LOCATION_TASK_HEARTBEAT_KEY,
    BACKGROUND_LOCATION_TASK_NAME,
    BACKGROUND_RECORDING_STATE_KEY,
    type BackgroundLocationTaskHeartbeat,
} from "../tasks/backgroundLocationTask";
import { saveBackgroundLocationDebugLog } from "./backgroundLocationDebugLogService";

export const BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED =
    "BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED";

export const BACKGROUND_LOCATION_DISCLOSURE_DECLINED =
    "BACKGROUND_LOCATION_DISCLOSURE_DECLINED";

export const FOREGROUND_LAST_SAVED_LOCATION_KEY =
    "location-tracker-foreground-last-saved-location";

export class BackgroundLocationPermissionError extends Error {
    code = BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED;

    constructor() {
        super(BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED);
        this.name = "BackgroundLocationPermissionError";
    }
}

export const FOREGROUND_LOCATION_PERMISSION_NOT_GRANTED =
    "FOREGROUND_LOCATION_PERMISSION_NOT_GRANTED";

export function isForegroundLocationPermissionError(error: unknown) {
    return (
        error instanceof Error &&
        error.message === FOREGROUND_LOCATION_PERMISSION_NOT_GRANTED
    );
}

export function isBackgroundLocationDisclosureDeclined(error: unknown) {
    return (
        error instanceof Error &&
        error.message === BACKGROUND_LOCATION_DISCLOSURE_DECLINED
    );
}

export function isBackgroundLocationPermissionError(error: unknown) {
    return (
        error instanceof BackgroundLocationPermissionError ||
        (error instanceof Error &&
            error.message === BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED)
    );
}

type StartBackgroundLocationRecordingParams = {
    userId: string;
    recordingSessionId: string;
    startedAt?: string | null;
    recordingExpiresAt?: string | null;
    intervalMs: number;
    distanceMeters: number;
    liveShareOwnerValues?: string[];
    lastSavedLocation?: {
        latitude: number;
        longitude: number;
        recordedAt: number;
    } | null;
    liveLocationId?: string | null;
};
export type BackgroundRecordingState = {
    userId: string;
    isRecording: boolean;
    recordingSessionId?: string | null;
    startedAt?: string | null;
    recordingExpiresAt?: string | null;
    liveShareOwnerValues?: string[];
    liveLocationId?: string | null;
    lastSavedLocation?: {
        latitude: number;
        longitude: number;
        recordedAt: number;
    } | null;
    intervalMs: number;
    distanceMeters: number;
};

type StopBackgroundLocationRecordingOptions = {
    continueLiveSharing?: boolean;
};

export type BackgroundLocationHeartbeatStatus = {
    heartbeat: BackgroundLocationTaskHeartbeat | null;
    /**
     * heartbeatが現在時刻から何ミリ秒前のものか。
     */
    ageMs: number | null;
    /**
     * heartbeatのJSONが存在したが、不正な形式だったか。
     */
    invalidStoredValue: boolean;
};

/**
 * background location task のhealth判定。
 *
 * AndroidのLocation.hasStartedLocationUpdatesAsync()は登録状態を示すだけで、
 * callbackが現在も配送されていることまでは保証しない。
 * heartbeatを併用して、一定時間callbackが来ていない場合だけcontrolled restartする。
 */
const BACKGROUND_TASK_HEALTH_MIN_STALE_MS = 60_000;
const BACKGROUND_TASK_HEALTH_MAX_STALE_MS = 180_000;
/*
 * controlled restart後のfresh heartbeat待機時間。
 *
 * native側は最大5秒間隔で位置callbackを受信する設定のため、
 * 30秒以内に現在sessionのheartbeatが来なければ
 * 正常復旧していない可能性が高いと判断する。
 */
const BACKGROUND_TASK_RESTART_HEARTBEAT_TIMEOUT_MS = 30_000;
const BACKGROUND_TASK_HEALTH_POLL_INTERVAL_MS = 2_000;
/*
 * Android側でstopしたLocation task / foreground serviceが
 * 完全に終了する時間を確保してから再登録する。
 */
const BACKGROUND_TASK_COLD_RESTART_DELAY_MS = 1_000;
/*
 * 自動記録開始直後にfresh heartbeatを待つ時間。
 *
 * native側は最大5秒間隔で位置callbackを受信するため、
 * 20秒間まったく現在sessionのheartbeatが来なければ、
 * 登録済みに見えても実際のcallback配送が開始していない可能性がある。
 */
const BACKGROUND_TASK_STARTUP_HEARTBEAT_TIMEOUT_MS = 10_000;

/*
 * startup recoveryでTaskManager登録まで完全解除したあと、
 * Android側のLocation / Foreground Serviceが終了する時間を確保する。
 *
 * 通常のcontrolled restartより少し長く待つ。
 */
const BACKGROUND_TASK_STARTUP_REINITIALIZE_DELAY_MS = 2_000;

/*
 * startup recovery後のfresh heartbeat確認時間。
 */
const BACKGROUND_TASK_STARTUP_RECOVERY_HEARTBEAT_TIMEOUT_MS = 20_000;

let backgroundTaskHealthCheckGeneration = 0;
/*
 * Background taskの復旧処理を同時に複数実行しない。
 *
 * controlled restart中にperiodic health check等から
 * 別のrestartが開始されると、
 * 復旧途中のtaskを再びstopしてしまうため、
 * 1つの復旧処理だけを許可する。
 */
let backgroundTaskRecoveryPromise: Promise<boolean> | null = null;
let backgroundTaskRecoveryStartedAtMs: number | null = null;

/*
 * OSからの位置受信間隔。
 *
 * 設定値の intervalMs / distanceMeters は
 * LocationLogを「保存する条件」として使用する。
 *
 * native側で timeInterval=30秒 としてしまうと、
 * 20m移動しても30秒以内の位置callbackを受信できないため、
 * native側は最大5秒間隔で位置を受信する。
 */
const NATIVE_LOCATION_SAMPLE_INTERVAL_MS = 5_000;

let backgroundTaskStartupRecoverySessionId: string | null = null;
let backgroundTaskStartupRecoveryGeneration: number | null = null;

function getNativeLocationSampleIntervalMs(intervalMs: number): number {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        return NATIVE_LOCATION_SAMPLE_INTERVAL_MS;
    }

    return Math.min(intervalMs, NATIVE_LOCATION_SAMPLE_INTERVAL_MS);
}

function getBackgroundTaskHeartbeatStaleMs(intervalMs: number): number {
    const safeIntervalMs =
        Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 30_000;

    return Math.min(
        BACKGROUND_TASK_HEALTH_MAX_STALE_MS,
        Math.max(BACKGROUND_TASK_HEALTH_MIN_STALE_MS, safeIntervalMs * 3),
    );
}

function createRecordingLocationTaskOptions(
    intervalMs: number,
    distanceMeters: number,
) {
    return {
        accuracy: Location.Accuracy.BestForNavigation,

        /*
         * native側では細かく位置を受信する。
         * 実際のLocationLog保存条件
         * 「intervalMs OR distanceMeters」は
         * backgroundLocationTask側で判定する。
         */
        timeInterval: getNativeLocationSampleIntervalMs(intervalMs),
        distanceInterval: 0,

        deferredUpdatesInterval: 0,
        deferredUpdatesDistance: 0,
        activityType: Location.ActivityType.Fitness,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,

        foregroundService: {
            notificationTitle: "位置情報を記録中",
            notificationBody:
                "自動記録または現在地共有をバックグラウンドで継続しています",
            notificationColor: "#4b6f8f",
        },
    };
}

async function readBackgroundRecordingStateSafely(): Promise<BackgroundRecordingState | null> {
    try {
        const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

        if (!raw) {
            return null;
        }

        return JSON.parse(raw) as BackgroundRecordingState;
    } catch (error) {
        console.error(
            "Read background recording state for health check error:",
            error,
        );
        return null;
    }
}

function isHeartbeatForRecordingSession(
    status: BackgroundLocationHeartbeatStatus,
    recordingSessionId: string,
    notBeforeMs: number,
): boolean {
    const heartbeat = status.heartbeat;

    return Boolean(
        heartbeat &&
        heartbeat.firedAt >= notBeforeMs &&
        heartbeat.isRecording &&
        heartbeat.recordingSessionId === recordingSessionId &&
        !heartbeat.hasTaskError,
    );
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

async function waitForAppToBecomeActive(input: {
    recordingSessionId: string;
    generation: number;
}): Promise<boolean> {
    const { recordingSessionId, generation } = input;

    const isStillCurrentRecording = async () => {
        if (generation !== backgroundTaskHealthCheckGeneration) {
            return false;
        }

        const state = await readBackgroundRecordingStateSafely();

        return Boolean(
            state?.isRecording &&
            state.recordingSessionId === recordingSessionId,
        );
    };

    if (AppState.currentState === "active") {
        return isStillCurrentRecording();
    }

    return new Promise<boolean>((resolve) => {
        let settled = false;

        const finish = (result: boolean) => {
            if (settled) {
                return;
            }

            settled = true;
            subscription.remove();
            resolve(result);
        };

        const subscription = AppState.addEventListener(
            "change",
            (nextState) => {
                if (nextState !== "active") {
                    return;
                }

                void (async () => {
                    finish(await isStillCurrentRecording());
                })();
            },
        );
    });
}

async function waitForFreshRecordingHeartbeat(
    recordingSessionId: string,
    notBeforeMs: number,
    timeoutMs: number,
    generation: number,
): Promise<boolean> {
    const deadlineAtMs = Date.now() + timeoutMs;

    while (Date.now() < deadlineAtMs) {
        if (generation !== backgroundTaskHealthCheckGeneration) {
            return false;
        }

        const state = await readBackgroundRecordingStateSafely();

        if (
            !state?.isRecording ||
            state.recordingSessionId !== recordingSessionId
        ) {
            return false;
        }

        const heartbeatStatus =
            await getBackgroundLocationTaskHeartbeatStatus();

        if (
            isHeartbeatForRecordingSession(
                heartbeatStatus,
                recordingSessionId,
                notBeforeMs,
            )
        ) {
            return true;
        }

        await delay(BACKGROUND_TASK_HEALTH_POLL_INTERVAL_MS);
    }

    return false;
}

type StartupHeartbeatWaitResult =
    | "heartbeat"
    | "timeout"
    | "appInactive"
    | "cancelled";

async function waitForFreshRecordingHeartbeatDuringStartup(
    recordingSessionId: string,
    notBeforeMs: number,
    timeoutMs: number,
    generation: number,
): Promise<StartupHeartbeatWaitResult> {
    const deadlineAtMs = Date.now() + timeoutMs;

    while (Date.now() < deadlineAtMs) {
        if (generation !== backgroundTaskHealthCheckGeneration) {
            return "cancelled";
        }

        const state = await readBackgroundRecordingStateSafely();

        if (
            !state?.isRecording ||
            state.recordingSessionId !== recordingSessionId
        ) {
            return "cancelled";
        }

        if (AppState.currentState !== "active") {
            return "appInactive";
        }

        const heartbeatStatus =
            await getBackgroundLocationTaskHeartbeatStatus();

        if (
            isHeartbeatForRecordingSession(
                heartbeatStatus,
                recordingSessionId,
                notBeforeMs,
            )
        ) {
            return "heartbeat";
        }

        await delay(BACKGROUND_TASK_HEALTH_POLL_INTERVAL_MS);
    }

    return "timeout";
}

async function controlledRestartBackgroundLocationTask(input: {
    userId: string;
    recordingSessionId: string;
    intervalMs: number;
    distanceMeters: number;
    reason: string;
    generation: number;
}): Promise<boolean> {
    const {
        userId,
        recordingSessionId,
        intervalMs,
        distanceMeters,
        reason,
        generation,
    } = input;

    const stateBeforeRestart = await readBackgroundRecordingStateSafely();

    if (
        generation !== backgroundTaskHealthCheckGeneration ||
        !stateBeforeRestart?.isRecording ||
        stateBeforeRestart.recordingSessionId !== recordingSessionId
    ) {
        return false;
    }

    const restartStartedAtMs = Date.now();

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "backgroundLocationTaskControlledRestartStarted",
        hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
        details: {
            reason,
            intervalMs,
            distanceMeters,
        },
    });

    try {
        const hasStartedBeforeRestart =
            await Location.hasStartedLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );

        if (hasStartedBeforeRestart) {
            await Location.stopLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );

            /*
             * Android側でLocation task / foreground serviceが
             * 完全に停止する時間を与える。
             *
             * stop直後に同じtask名でstartすると、
             * 古いnative側の状態を引き継ぐ可能性があるため、
             * 1秒待ってから再登録する。
             */
            await delay(BACKGROUND_TASK_COLD_RESTART_DELAY_MS);
        }

        const stateAfterStop = await readBackgroundRecordingStateSafely();

        if (
            generation !== backgroundTaskHealthCheckGeneration ||
            !stateAfterStop?.isRecording ||
            stateAfterStop.recordingSessionId !== recordingSessionId
        ) {
            return false;
        }

        await Location.startLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
            createRecordingLocationTaskOptions(intervalMs, distanceMeters),
        );

        const hasStartedAfterRestart =
            await Location.hasStartedLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationTaskControlledRestartCompleted",
            hasStartedLocationUpdates: hasStartedAfterRestart,
            details: {
                reason,
                restartStartedAtMs,
            },
        });

        if (!hasStartedAfterRestart) {
            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "backgroundLocationTaskControlledRestartFailed",
                hasStartedLocationUpdates: false,
                errorMessage:
                    "Background location task restart registration could not be confirmed.",
                details: {
                    reason,
                    restartStartedAtMs,
                },
            });

            Alert.alert(
                "バックグラウンド位置記録を再開できませんでした",
                [
                    "バックグラウンド位置タスクを再起動しましたが、タスクの再登録を確認できませんでした。",
                    "",
                    "自動記録は停止せず継続しています。",
                    "",
                    "改善しない場合は、",
                    "「設定」→「位置情報」→「LocationTrackerApp」",
                    "を開き、位置情報の権限を一度「許可しない」に変更してください。",
                    "",
                    "その後アプリへ戻り、再度「自動記録開始」を押して「常に許可」に変更してください。",
                ].join("\n"),
                [{ text: "OK" }],
            );

            return false;
        }

        const heartbeatTimeoutMs = BACKGROUND_TASK_RESTART_HEARTBEAT_TIMEOUT_MS;

        const heartbeatRecovered = await waitForFreshRecordingHeartbeat(
            recordingSessionId,
            restartStartedAtMs,
            heartbeatTimeoutMs,
            generation,
        );

        if (heartbeatRecovered) {
            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "backgroundLocationTaskHealthRecoveredAfterRestart",
                hasStartedLocationUpdates: true,
                details: {
                    reason,
                    heartbeatTimeoutMs,
                },
            });

            return true;
        }

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationTaskHealthFailedAfterRestart",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            errorMessage:
                "Background location task restarted but no fresh heartbeat was received.",
            details: {
                reason,
                heartbeatTimeoutMs,
            },
        });

        Alert.alert(
            "バックグラウンド位置情報を確認できません",
            [
                "バックグラウンド位置タスクを再起動しましたが、一定時間内に位置情報の受信を確認できませんでした。",
                "",
                "自動記録は停止せず継続しています。",
                "",
                "改善しない場合は、端末の設定を確認してください。",
                "",
                "1. 「設定」→「位置情報」→「LocationTrackerApp」を開く",
                "2. 位置情報の権限を一度「許可しない」に変更する",
                "3. LocationTrackerAppへ戻る",
                "4. 再度「自動記録開始」を押す",
                "5. 位置情報の権限を「常に許可」に変更する",
                "",
                "あわせて、LocationTrackerAppのバッテリー使用が制限されていないことも確認してください。",
            ].join("\n"),
            [{ text: "OK" }],
        );

        return false;
    } catch (error) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationTaskControlledRestartFailed",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            errorMessage:
                error instanceof Error ? error.message : String(error),
            details: {
                reason,
            },
        });

        Alert.alert(
            "バックグラウンド位置記録の再起動に失敗しました",
            "自動記録は停止せず継続しますが、バックグラウンド位置タスクを再起動できませんでした。端末の位置情報設定を確認してください。",
            [{ text: "OK" }],
        );

        return false;
    }
}

async function recoverBackgroundLocationTaskOnce(input: {
    userId: string;
    recordingSessionId: string;
    intervalMs: number;
    distanceMeters: number;
    reason: string;
    generation: number;
}): Promise<boolean> {
    /*
     * すでに別の復旧処理が進行中なら、
     * 新しいstop/startは開始しない。
     */
    if (backgroundTaskRecoveryPromise) {
        await saveBackgroundLocationDebugLog({
            userId: input.userId,
            recordingSessionId: input.recordingSessionId,
            eventName: "backgroundLocationTaskRecoverySkippedAlreadyRunning",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            details: {
                reason: input.reason,
                recoveryStartedAtMs: backgroundTaskRecoveryStartedAtMs,
            },
        });

        return backgroundTaskRecoveryPromise;
    }

    backgroundTaskRecoveryStartedAtMs = Date.now();

    const recoveryPromise = controlledRestartBackgroundLocationTask(input);

    backgroundTaskRecoveryPromise = recoveryPromise;

    try {
        return await recoveryPromise;
    } finally {
        if (backgroundTaskRecoveryPromise === recoveryPromise) {
            backgroundTaskRecoveryPromise = null;
            backgroundTaskRecoveryStartedAtMs = null;
        }
    }
}

async function fullyRestartBackgroundLocationTaskOnce(input: {
    userId: string;
    recordingSessionId: string;
    intervalMs: number;
    distanceMeters: number;
    reason: string;
}): Promise<boolean> {
    if (backgroundTaskRecoveryPromise) {
        await saveBackgroundLocationDebugLog({
            userId: input.userId,
            recordingSessionId: input.recordingSessionId,
            eventName:
                "backgroundLocationTaskColdRestartSkippedRecoveryAlreadyRunning",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            details: {
                reason: input.reason,
                recoveryStartedAtMs: backgroundTaskRecoveryStartedAtMs,
            },
        });

        return backgroundTaskRecoveryPromise;
    }

    backgroundTaskRecoveryStartedAtMs = Date.now();

    const recoveryPromise = fullyRestartBackgroundLocationTask(input);

    backgroundTaskRecoveryPromise = recoveryPromise;

    try {
        return await recoveryPromise;
    } finally {
        if (backgroundTaskRecoveryPromise === recoveryPromise) {
            backgroundTaskRecoveryPromise = null;
            backgroundTaskRecoveryStartedAtMs = null;
        }
    }
}

async function ensureBackgroundLocationStartupHealthy(input: {
    userId: string;
    recordingSessionId: string;
    intervalMs: number;
    distanceMeters: number;
    stateActivatedAtMs: number;
    generation: number;
}): Promise<void> {
    const {
        userId,
        recordingSessionId,
        intervalMs,
        distanceMeters,
        stateActivatedAtMs,
        generation,
    } = input;

    try {
        /*
         * startup確認・強いrecoveryはforegroundでのみ実施する。
         */
        if (AppState.currentState !== "active") {
            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName:
                    "backgroundLocationTaskStartupCheckPausedForBackground",
                hasStartedLocationUpdates:
                    await safeHasStartedLocationUpdates(),
            });

            const activeAgain = await waitForAppToBecomeActive({
                recordingSessionId,
                generation,
            });

            if (!activeAgain) {
                throw new Error(
                    "Background location startup verification was cancelled.",
                );
            }

            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName:
                    "backgroundLocationTaskStartupCheckResumedInForeground",
                hasStartedLocationUpdates:
                    await safeHasStartedLocationUpdates(),
            });
        }

        while (true) {
            const heartbeatResult =
                await waitForFreshRecordingHeartbeatDuringStartup(
                    recordingSessionId,
                    stateActivatedAtMs,
                    BACKGROUND_TASK_STARTUP_HEARTBEAT_TIMEOUT_MS,
                    generation,
                );

            if (heartbeatResult === "heartbeat") {
                await saveBackgroundLocationDebugLog({
                    userId,
                    recordingSessionId,
                    eventName: "backgroundLocationTaskStartupHealthCheckPassed",
                    hasStartedLocationUpdates:
                        await safeHasStartedLocationUpdates(),
                    details: {
                        heartbeatTimeoutMs:
                            BACKGROUND_TASK_STARTUP_HEARTBEAT_TIMEOUT_MS,
                    },
                });

                return;
            }

            if (heartbeatResult === "cancelled") {
                throw new Error(
                    "Background location startup verification was cancelled.",
                );
            }

            if (heartbeatResult === "appInactive") {
                await saveBackgroundLocationDebugLog({
                    userId,
                    recordingSessionId,
                    eventName:
                        "backgroundLocationTaskStartupCheckPausedForBackground",
                    hasStartedLocationUpdates:
                        await safeHasStartedLocationUpdates(),
                });

                const activeAgain = await waitForAppToBecomeActive({
                    recordingSessionId,
                    generation,
                });

                if (!activeAgain) {
                    throw new Error(
                        "Background location startup verification was cancelled.",
                    );
                }

                await saveBackgroundLocationDebugLog({
                    userId,
                    recordingSessionId,
                    eventName:
                        "backgroundLocationTaskStartupCheckResumedInForeground",
                    hasStartedLocationUpdates:
                        await safeHasStartedLocationUpdates(),
                });

                /*
                 * foreground復帰後にもう一度heartbeatを確認する。
                 */
                continue;
            }

            /*
             * foregroundで10秒待ってもheartbeatが来なかった。
             */
            const heartbeatStatus =
                await getBackgroundLocationTaskHeartbeatStatus();

            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "backgroundLocationTaskStartupHeartbeatMissing",
                hasStartedLocationUpdates:
                    await safeHasStartedLocationUpdates(),
                details: {
                    heartbeatTimeoutMs:
                        BACKGROUND_TASK_STARTUP_HEARTBEAT_TIMEOUT_MS,
                    heartbeatAgeMs: heartbeatStatus.ageMs,
                    heartbeatRecordingSessionId:
                        heartbeatStatus.heartbeat?.recordingSessionId ?? null,
                    heartbeatIsRecording:
                        heartbeatStatus.heartbeat?.isRecording ?? null,
                    invalidStoredHeartbeat: heartbeatStatus.invalidStoredValue,
                },
            });

            /*
             * 強いstartup recoveryを行う直前にもforegroundを保証する。
             */
            const activeBeforeRecovery = await waitForAppToBecomeActive({
                recordingSessionId,
                generation,
            });

            if (!activeBeforeRecovery) {
                throw new Error(
                    "Background location startup recovery was cancelled.",
                );
            }

            const recovered = await recoverBackgroundLocationTaskAtStartupOnce({
                userId,
                recordingSessionId,
                intervalMs,
                distanceMeters,
                generation,
            });

            if (recovered) {
                return;
            }

            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "backgroundLocationTaskStartupRecoveryExhausted",
                hasStartedLocationUpdates:
                    await safeHasStartedLocationUpdates(),
            });

            throw new Error(
                "Background location task startup recovery failed.",
            );
        }
    } finally {
        if (
            backgroundTaskStartupRecoverySessionId === recordingSessionId &&
            backgroundTaskStartupRecoveryGeneration === generation
        ) {
            backgroundTaskStartupRecoverySessionId = null;
            backgroundTaskStartupRecoveryGeneration = null;
        }
    }
}

async function fullyRestartBackgroundLocationTask(input: {
    userId: string;
    recordingSessionId: string;
    intervalMs: number;
    distanceMeters: number;
    reason: string;
}): Promise<boolean> {
    const { userId, recordingSessionId, intervalMs, distanceMeters, reason } =
        input;

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "backgroundLocationTaskColdRestartStarted",
        hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
        details: {
            reason,
            intervalMs,
            distanceMeters,
        },
    });

    try {
        /*
         * まずexpo-locationの正規APIで停止する。
         */
        const locationStarted = await Location.hasStartedLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
        );

        if (locationStarted) {
            await Location.stopLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );
        }

        /*
         * Android側のForeground Service / LocationManagerが
         * 完全に破棄される時間を少し与える。
         */
        await delay(BACKGROUND_TASK_COLD_RESTART_DELAY_MS);

        /*
         * stopLocationUpdatesAsync後もTaskManager登録が残る
         * 異常状態だけフォールバックで明示解除する。
         */
        const locationStillStarted =
            await Location.hasStartedLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );

        const taskStillRegistered = await TaskManager.isTaskRegisteredAsync(
            BACKGROUND_LOCATION_TASK_NAME,
        );

        if (locationStillStarted || taskStillRegistered) {
            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "backgroundLocationTaskResidualRegistrationDetected",
                hasStartedLocationUpdates: locationStillStarted,
                details: {
                    reason,
                    taskStillRegistered,
                },
            });

            if (taskStillRegistered) {
                await TaskManager.unregisterTaskAsync(
                    BACKGROUND_LOCATION_TASK_NAME,
                );
            }

            await delay(BACKGROUND_TASK_COLD_RESTART_DELAY_MS);
        }

        /*
         * 現在の自動記録条件で新規登録する。
         */
        await Location.startLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
            createRecordingLocationTaskOptions(intervalMs, distanceMeters),
        );

        const hasStartedAfterRestart =
            await Location.hasStartedLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );

        const taskRegisteredAfterRestart =
            await TaskManager.isTaskRegisteredAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationTaskColdRestartCompleted",
            hasStartedLocationUpdates: hasStartedAfterRestart,
            details: {
                reason,
                taskRegisteredAfterRestart,
            },
        });

        return hasStartedAfterRestart && taskRegisteredAfterRestart;
    } catch (error) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationTaskColdRestartFailed",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            errorMessage:
                error instanceof Error ? error.message : String(error),
            details: {
                reason,
            },
        });

        console.error("Background location task cold restart error:", error);

        return false;
    }
}

async function reinitializeBackgroundLocationTaskForStartup(input: {
    userId: string;
    recordingSessionId: string;
    intervalMs: number;
    distanceMeters: number;
    generation: number;
}): Promise<boolean> {
    const {
        userId,
        recordingSessionId,
        intervalMs,
        distanceMeters,
        generation,
    } = input;

    const recoveryStartedAtMs = Date.now();

    /*
     * 遅延実行された古いstartup recoveryが、
     * 新しいsessionや停止済みsessionを触らないようにする。
     */
    const stateBeforeRecovery = await readBackgroundRecordingStateSafely();

    if (
        generation !== backgroundTaskHealthCheckGeneration ||
        !stateBeforeRecovery?.isRecording ||
        stateBeforeRecovery.recordingSessionId !== recordingSessionId
    ) {
        return false;
    }

    /*
     * recoveryを開始する直前にheartbeatを再確認する。
     *
     * 待機中に正常起動していた場合は、
     * 正常なtaskをstopしない。
     */
    const heartbeatBeforeRecovery =
        await getBackgroundLocationTaskHeartbeatStatus();

    if (
        isHeartbeatForRecordingSession(
            heartbeatBeforeRecovery,
            recordingSessionId,
            stateBeforeRecovery.startedAt
                ? new Date(stateBeforeRecovery.startedAt).getTime()
                : 0,
        )
    ) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName:
                "backgroundLocationTaskStartupRecoverySkippedHeartbeatRecovered",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
        });

        return true;
    }

    /*
     * 実際の権限状態を再取得する。
     *
     * ここではrequestしない。
     * startup recoveryは既に許可済みのtaskを復旧する処理に限定する。
     */
    const [foregroundPermission, backgroundPermission] = await Promise.all([
        Location.getForegroundPermissionsAsync(),
        Location.getBackgroundPermissionsAsync(),
    ]);

    const permissionGranted =
        foregroundPermission.status === Location.PermissionStatus.GRANTED &&
        backgroundPermission.status === Location.PermissionStatus.GRANTED;

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "backgroundLocationTaskStartupRecoveryStarted",
        hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
        foregroundPermissionStatus: foregroundPermission.status,
        foregroundPermissionGranted: foregroundPermission.granted,
        foregroundPermissionCanAskAgain: foregroundPermission.canAskAgain,
        backgroundPermissionStatus: backgroundPermission.status,
        backgroundPermissionGranted: backgroundPermission.granted,
        backgroundPermissionCanAskAgain: backgroundPermission.canAskAgain,
        details: {
            recoveryStartedAtMs,
            intervalMs,
            distanceMeters,
        },
    });

    if (!permissionGranted) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName:
                "backgroundLocationTaskStartupRecoveryPermissionNotGranted",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            foregroundPermissionStatus: foregroundPermission.status,
            foregroundPermissionGranted: foregroundPermission.granted,
            foregroundPermissionCanAskAgain: foregroundPermission.canAskAgain,
            backgroundPermissionStatus: backgroundPermission.status,
            backgroundPermissionGranted: backgroundPermission.granted,
            backgroundPermissionCanAskAgain: backgroundPermission.canAskAgain,
        });

        return false;
    }

    try {
        const activeBeforeRecovery = await waitForAppToBecomeActive({
            recordingSessionId,
            generation,
        });

        if (!activeBeforeRecovery) {
            return false;
        }

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName:
                "backgroundLocationTaskStartupRecoveryForegroundConfirmed",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
        });

        /*
         * expo-location側の登録を停止する。
         */
        const locationStarted = await Location.hasStartedLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
        );

        if (locationStarted) {
            await Location.stopLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );
        }

        /*
         * startup recoveryでは、
         * 残留判定に関係なくTaskManager登録も明示的に解除する。
         *
         * これが通常のcontrolled restartとの大きな違い。
         */
        const taskRegistered = await TaskManager.isTaskRegisteredAsync(
            BACKGROUND_LOCATION_TASK_NAME,
        );

        if (taskRegistered) {
            await TaskManager.unregisterTaskAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );
        }

        /*
         * Android側のLocationManager / Foreground Serviceが
         * 終了する時間を確保する。
         */
        await delay(BACKGROUND_TASK_STARTUP_REINITIALIZE_DELAY_MS);

        /*
         * stop/unregister中にbackgroundへ移った場合は、
         * foregroundへ戻るまで新しいLocation taskを開始しない。
         */
        if (AppState.currentState !== "active") {
            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName:
                    "backgroundLocationTaskStartupRecoveryPausedForBackground",
                hasStartedLocationUpdates:
                    await safeHasStartedLocationUpdates(),
            });

            const activeAgain = await waitForAppToBecomeActive({
                recordingSessionId,
                generation,
            });

            if (!activeAgain) {
                return false;
            }

            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName:
                    "backgroundLocationTaskStartupRecoveryResumedInForeground",
                hasStartedLocationUpdates:
                    await safeHasStartedLocationUpdates(),
            });
        }

        const stateAfterStop = await readBackgroundRecordingStateSafely();

        if (
            generation !== backgroundTaskHealthCheckGeneration ||
            !stateAfterStop?.isRecording ||
            stateAfterStop.recordingSessionId !== recordingSessionId
        ) {
            return false;
        }

        /*
         * 完全に新規登録する。
         */
        const restartStartedAtMs = Date.now();

        await Location.startLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
            createRecordingLocationTaskOptions(intervalMs, distanceMeters),
        );

        const hasStartedAfterRecovery =
            await Location.hasStartedLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );

        const taskRegisteredAfterRecovery =
            await TaskManager.isTaskRegisteredAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationTaskStartupRecoveryReinitialized",
            hasStartedLocationUpdates: hasStartedAfterRecovery,
            details: {
                recoveryStartedAtMs,
                restartStartedAtMs,
                taskRegisteredAfterRecovery,
            },
        });

        if (!hasStartedAfterRecovery || !taskRegisteredAfterRecovery) {
            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName:
                    "backgroundLocationTaskStartupRecoveryRegistrationFailed",
                hasStartedLocationUpdates: hasStartedAfterRecovery,
                details: {
                    taskRegisteredAfterRecovery,
                },
            });

            return false;
        }

        /*
         * hasStarted=trueだけでは成功とはしない。
         *
         * 今回のsessionのcallbackが本当に届いたことを
         * heartbeatで確認する。
         */
        let heartbeatRecovered = false;

        while (true) {
            const heartbeatResult =
                await waitForFreshRecordingHeartbeatDuringStartup(
                    recordingSessionId,
                    restartStartedAtMs,
                    BACKGROUND_TASK_STARTUP_RECOVERY_HEARTBEAT_TIMEOUT_MS,
                    generation,
                );

            if (heartbeatResult === "heartbeat") {
                heartbeatRecovered = true;
                break;
            }

            if (heartbeatResult === "cancelled") {
                return false;
            }

            if (heartbeatResult === "timeout") {
                break;
            }

            /*
             * backgroundへ移動した場合は、
             * foreground復帰後にheartbeatを再確認する。
             *
             * background中にtaskが正常発火していれば、
             * 復帰直後の確認でheartbeatを検出できる。
             */
            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName:
                    "backgroundLocationTaskStartupHeartbeatWaitPausedForBackground",
                hasStartedLocationUpdates:
                    await safeHasStartedLocationUpdates(),
            });

            const activeAgain = await waitForAppToBecomeActive({
                recordingSessionId,
                generation,
            });

            if (!activeAgain) {
                return false;
            }

            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName:
                    "backgroundLocationTaskStartupHeartbeatWaitResumedInForeground",
                hasStartedLocationUpdates:
                    await safeHasStartedLocationUpdates(),
            });
        }

        if (heartbeatRecovered) {
            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "backgroundLocationTaskStartupRecoverySucceeded",
                hasStartedLocationUpdates: true,
                details: {
                    recoveryStartedAtMs,
                    restartStartedAtMs,
                    heartbeatTimeoutMs:
                        BACKGROUND_TASK_STARTUP_RECOVERY_HEARTBEAT_TIMEOUT_MS,
                },
            });

            return true;
        }

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationTaskStartupRecoveryHeartbeatFailed",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            errorMessage:
                "Startup recovery completed but no fresh heartbeat was received.",
            details: {
                recoveryStartedAtMs,
                restartStartedAtMs,
                heartbeatTimeoutMs:
                    BACKGROUND_TASK_STARTUP_RECOVERY_HEARTBEAT_TIMEOUT_MS,
            },
        });

        return false;
    } catch (error) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationTaskStartupRecoveryFailed",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            errorMessage:
                error instanceof Error ? error.message : String(error),
            details: {
                recoveryStartedAtMs,
            },
        });

        console.error("Background location startup recovery error:", error);

        return false;
    }
}

async function recoverBackgroundLocationTaskAtStartupOnce(input: {
    userId: string;
    recordingSessionId: string;
    intervalMs: number;
    distanceMeters: number;
    generation: number;
}): Promise<boolean> {
    if (backgroundTaskRecoveryPromise) {
        await saveBackgroundLocationDebugLog({
            userId: input.userId,
            recordingSessionId: input.recordingSessionId,
            eventName:
                "backgroundLocationTaskStartupRecoverySkippedAlreadyRunning",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            details: {
                recoveryStartedAtMs: backgroundTaskRecoveryStartedAtMs,
            },
        });

        return backgroundTaskRecoveryPromise;
    }

    backgroundTaskRecoveryStartedAtMs = Date.now();

    const recoveryPromise = reinitializeBackgroundLocationTaskForStartup(input);

    backgroundTaskRecoveryPromise = recoveryPromise;

    try {
        return await recoveryPromise;
    } finally {
        if (backgroundTaskRecoveryPromise === recoveryPromise) {
            backgroundTaskRecoveryPromise = null;
            backgroundTaskRecoveryStartedAtMs = null;
        }
    }
}

async function safeHasStartedLocationUpdates(): Promise<boolean> {
    try {
        return await Location.hasStartedLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
        );
    } catch (error) {
        console.error("Check background location updates status error:", error);

        return false;
    }
}

export type BackgroundLocationHealthCheckResult = {
    healthy: boolean;
    restarted: boolean;
    permissionGranted: boolean;
    hasStartedLocationUpdates: boolean;
    heartbeatAgeMs: number | null;
    heartbeatStaleMs: number;
    reason:
        | "healthy"
        | "notRecording"
        | "permissionNotGranted"
        | "taskNotStarted"
        | "heartbeatMissing"
        | "heartbeatStale"
        | "heartbeatInvalid"
        | "heartbeatSessionMismatch"
        | "restartFailed";
};

/**
 * 自動記録中のBackground location taskを診断し、
 * 必要な場合だけRecovery mutex経由でcontrolled restartする。
 *
 * 注意:
 * ・記録間隔/距離などの記録方法は変更しない
 * ・権限要求UIは出さない
 * ・hasStarted=trueでもheartbeatがstaleなら異常扱い
 */
export async function verifyAndRecoverBackgroundLocationRecording(): Promise<BackgroundLocationHealthCheckResult> {
    const state = await readBackgroundRecordingStateSafely();

    if (!state?.isRecording || !state.recordingSessionId || !state.userId) {
        return {
            healthy: true,
            restarted: false,
            permissionGranted: true,
            hasStartedLocationUpdates: false,
            heartbeatAgeMs: null,
            heartbeatStaleMs: 0,
            reason: "notRecording",
        };
    }

    const startupRecoveryInProgress =
        backgroundTaskStartupRecoverySessionId === state.recordingSessionId &&
        backgroundTaskStartupRecoveryGeneration ===
            backgroundTaskHealthCheckGeneration;

    if (startupRecoveryInProgress) {
        const heartbeatStatus =
            await getBackgroundLocationTaskHeartbeatStatus();

        await saveBackgroundLocationDebugLog({
            userId: state.userId,
            recordingSessionId: state.recordingSessionId,
            eventName:
                "backgroundLocationContinuousHealthSkippedDuringStartupRecovery",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            details: {
                heartbeatAgeMs: heartbeatStatus.ageMs,
            },
        });

        return {
            healthy: true,
            restarted: false,
            permissionGranted: true,
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            heartbeatAgeMs: heartbeatStatus.ageMs,
            heartbeatStaleMs: getBackgroundTaskHeartbeatStaleMs(
                state.intervalMs,
            ),
            reason: "healthy",
        };
    }

    const { userId, recordingSessionId, intervalMs, distanceMeters } = state;

    /*
     * health checkでは権限要求をしない。
     * 現在の状態を読むだけにする。
     */
    const [foregroundPermission, backgroundPermission] = await Promise.all([
        Location.getForegroundPermissionsAsync(),
        Location.getBackgroundPermissionsAsync(),
    ]);

    const permissionGranted =
        foregroundPermission.status === "granted" &&
        backgroundPermission.status === "granted";

    const heartbeatStaleMs = getBackgroundTaskHeartbeatStaleMs(intervalMs);

    const hasStartedLocationUpdates = await safeHasStartedLocationUpdates();

    const heartbeatStatus = await getBackgroundLocationTaskHeartbeatStatus();

    const heartbeatAgeMs = heartbeatStatus.ageMs;

    if (!permissionGranted) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationContinuousHealthPermissionNotGranted",
            hasStartedLocationUpdates,
            details: {
                foregroundPermissionStatus: foregroundPermission.status,
                backgroundPermissionStatus: backgroundPermission.status,
                heartbeatAgeMs,
                heartbeatStaleMs,
            },
        });

        return {
            healthy: false,
            restarted: false,
            permissionGranted: false,
            hasStartedLocationUpdates,
            heartbeatAgeMs,
            heartbeatStaleMs,
            reason: "permissionNotGranted",
        };
    }

    const heartbeat = heartbeatStatus.heartbeat;

    const heartbeatSessionMatches =
        heartbeat?.recordingSessionId === recordingSessionId &&
        heartbeat?.isRecording === true &&
        heartbeat?.hasTaskError !== true;

    const heartbeatIsRecent =
        heartbeatSessionMatches &&
        heartbeatAgeMs !== null &&
        heartbeatAgeMs <= heartbeatStaleMs &&
        !heartbeatStatus.invalidStoredValue;

    /*
     * native登録あり + heartbeat正常なら何もしない。
     */
    if (hasStartedLocationUpdates && heartbeatIsRecent) {
        return {
            healthy: true,
            restarted: false,
            permissionGranted: true,
            hasStartedLocationUpdates: true,
            heartbeatAgeMs,
            heartbeatStaleMs,
            reason: "healthy",
        };
    }

    let reason: BackgroundLocationHealthCheckResult["reason"];

    if (!hasStartedLocationUpdates) {
        reason = "taskNotStarted";
    } else if (heartbeatStatus.invalidStoredValue) {
        reason = "heartbeatInvalid";
    } else if (!heartbeat) {
        reason = "heartbeatMissing";
    } else if (!heartbeatSessionMatches) {
        reason = "heartbeatSessionMismatch";
    } else {
        reason = "heartbeatStale";
    }

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "backgroundLocationContinuousHealthIssueDetected",
        hasStartedLocationUpdates,
        details: {
            reason,
            heartbeatAgeMs,
            heartbeatStaleMs,
            heartbeatRecordingSessionId: heartbeat?.recordingSessionId ?? null,
            heartbeatIsRecording: heartbeat?.isRecording ?? null,
            heartbeatHasTaskError: heartbeat?.hasTaskError ?? null,
            invalidStoredHeartbeat: heartbeatStatus.invalidStoredValue,
        },
    });

    /*
     * 現在の記録sessionでstart時に作られたgenerationをそのまま使う。
     *
     * stopRecording()された場合はgenerationが変わるため、
     * recoverBackgroundLocationTaskOnce()経由で呼ばれる
     * controlledRestartBackgroundLocationTask内の既存ガードにより、
     * 古いhealth checkからの再起動を防止できる。
     */
    const generation = backgroundTaskHealthCheckGeneration;

    const restarted = await recoverBackgroundLocationTaskOnce({
        userId,
        recordingSessionId,
        intervalMs,
        distanceMeters,
        reason: `continuousHealthCheck:${reason}`,
        generation,
    });

    if (!restarted) {
        return {
            healthy: false,
            restarted: false,
            permissionGranted: true,
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            heartbeatAgeMs,
            heartbeatStaleMs,
            reason: "restartFailed",
        };
    }

    return {
        healthy: true,
        restarted: true,
        permissionGranted: true,
        hasStartedLocationUpdates: true,
        heartbeatAgeMs,
        heartbeatStaleMs,
        reason,
    };
}

export async function startBackgroundLocationRecording({
    userId,
    recordingSessionId,
    startedAt = null,
    recordingExpiresAt = null,
    intervalMs,
    distanceMeters,
    liveShareOwnerValues = [],
    liveLocationId = null,
    lastSavedLocation = null,
}: StartBackgroundLocationRecordingParams) {
    const normalizedLiveShareOwnerValues = Array.from(
        new Set(liveShareOwnerValues.filter(Boolean)),
    );

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "startBackgroundLocationRecordingCalled",
        details: {
            startedAt,
            recordingExpiresAt,
            intervalMs,
            distanceMeters,
            liveShareOwnerValues: normalizedLiveShareOwnerValues,
            liveLocationId,
            hasLastSavedLocation: Boolean(lastSavedLocation),
        },
    });

    await ensureBackgroundLocationPermission(userId, recordingSessionId);

    /*
     * 新しい自動記録状態で上書きする前に、
     * 現在地共有のみの状態を退避する。
     *
     * 起動失敗時には、この状態へ戻す。
     */
    const previousRaw = await AsyncStorage.getItem(
        BACKGROUND_RECORDING_STATE_KEY,
    );

    let previousState: BackgroundRecordingState | null = null;

    if (previousRaw) {
        try {
            previousState = JSON.parse(previousRaw) as BackgroundRecordingState;
        } catch (error) {
            console.error(
                "Parse previous background recording state error:",
                error,
            );

            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "previousBackgroundRecordingStateParseFailed",
                errorMessage:
                    error instanceof Error ? error.message : String(error),
            });
        }
    }

    const nextState: BackgroundRecordingState = {
        userId,
        isRecording: true,
        recordingSessionId,
        startedAt,
        recordingExpiresAt,
        intervalMs,
        distanceMeters,
        liveShareOwnerValues: normalizedLiveShareOwnerValues,
        liveLocationId,
        lastSavedLocation,
    };

    /*
     * 新しい自動記録session開始時は、
     * 以前のBackground taskをそのまま再利用せず、
     * 必要に応じてcold restartしてnative taskを再登録する。
     *
     * AsyncStorageのstateは新しいrecordingSessionへ切り替え、
     * その後fresh heartbeatが到着することを確認する。
     */
    await AsyncStorage.setItem(
        BACKGROUND_RECORDING_STATE_KEY,
        JSON.stringify(nextState),
    );

    const stateActivatedAtMs = Date.now();
    const healthCheckGeneration = ++backgroundTaskHealthCheckGeneration;
    backgroundTaskStartupRecoverySessionId = recordingSessionId;
    backgroundTaskStartupRecoveryGeneration = healthCheckGeneration;

    const hasStarted = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    );

    const heartbeatStatusBeforeStart =
        await getBackgroundLocationTaskHeartbeatStatus();
    const heartbeatStaleMs = getBackgroundTaskHeartbeatStaleMs(intervalMs);
    const heartbeatIsRecent = Boolean(
        heartbeatStatusBeforeStart.heartbeat &&
        heartbeatStatusBeforeStart.ageMs !== null &&
        heartbeatStatusBeforeStart.ageMs <= heartbeatStaleMs &&
        !heartbeatStatusBeforeStart.invalidStoredValue,
    );

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "hasStartedLocationUpdatesCheckedBeforeStart",
        hasStartedLocationUpdates: hasStarted,
        details: {
            previousStateExists: Boolean(previousState),
            previousIsRecording: previousState?.isRecording ?? null,
            previousRecordingSessionId:
                previousState?.recordingSessionId ?? null,
            previousLiveLocationId: previousState?.liveLocationId ?? null,
            heartbeatAgeMs: heartbeatStatusBeforeStart.ageMs,
            heartbeatStaleMs,
            heartbeatIsRecent,
            heartbeatRecordingSessionId:
                heartbeatStatusBeforeStart.heartbeat?.recordingSessionId ??
                null,
            heartbeatIsRecording:
                heartbeatStatusBeforeStart.heartbeat?.isRecording ?? null,
            invalidStoredHeartbeat:
                heartbeatStatusBeforeStart.invalidStoredValue,
        },
    });

    /*
     * 新しい自動記録session開始時は、
     * 現在地共有用として残っていたBackground taskを
     * そのまま再利用しない。
     *
     * 今回の実機ログでは、
     * previousIsRecording=false / heartbeatSessionId=null
     * のtaskをhealthyと誤判定して再利用し、
     * callbackが来ない状態が発生していた。
     */
    const previousTaskCanBeReused =
        hasStarted &&
        heartbeatIsRecent &&
        previousState?.isRecording === true &&
        previousState.recordingSessionId === recordingSessionId &&
        heartbeatStatusBeforeStart.heartbeat?.isRecording === true &&
        heartbeatStatusBeforeStart.heartbeat?.recordingSessionId ===
            recordingSessionId;

    if (previousTaskCanBeReused) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "startBackgroundLocationRecordingSkippedAlreadyStarted",
            hasStartedLocationUpdates: true,
            details: {
                reason: "reuseSameHealthyRecordingTask",
                previousIsRecording: previousState?.isRecording ?? null,
                heartbeatAgeMs: heartbeatStatusBeforeStart.ageMs,
                heartbeatStaleMs,
            },
        });

        await ensureBackgroundLocationStartupHealthy({
            userId,
            recordingSessionId,
            intervalMs,
            distanceMeters,
            stateActivatedAtMs,
            generation: healthCheckGeneration,
        });

        return;
    }

    /*
     * 新しいsession開始時にtaskが既に存在する場合は、
     * 前回の現在地共有taskや古いLocation registrationを
     * 引き継がず、必ずcold restartする。
     */
    if (hasStarted) {
        const restarted = await fullyRestartBackgroundLocationTaskOnce({
            userId,
            recordingSessionId,
            intervalMs,
            distanceMeters,
            reason: previousState?.isRecording
                ? "newRecordingSessionStarted"
                : "switchFromLiveSharingToRecording",
        });

        if (!restarted) {
            throw new Error("Background location task cold restart failed.");
        }

        /*
         * 登録済みだけでは成功としない。
         * 現在sessionのheartbeat到着確認は継続する。
         */
        await ensureBackgroundLocationStartupHealthy({
            userId,
            recordingSessionId,
            intervalMs,
            distanceMeters,
            stateActivatedAtMs,
            generation: healthCheckGeneration,
        });

        return;
    }

    const locationTaskOptions = createRecordingLocationTaskOptions(
        intervalMs,
        distanceMeters,
    );

    try {
        await Location.startLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
            locationTaskOptions,
        );

        const hasStartedAfterStart =
            await Location.hasStartedLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "startBackgroundLocationRecordingCompleted",
            hasStartedLocationUpdates: hasStartedAfterStart,
            details: {
                restartedExistingTask: false,
                intervalMs,
                distanceMeters,
                liveLocationId,
                liveShareOwnerCount: normalizedLiveShareOwnerValues.length,
            },
        });

        /*
         * startLocationUpdatesAsyncが例外を出さなくても、
         * 実際に登録されていなければ自動記録開始を成功扱いしない。
         */
        if (!hasStartedAfterStart) {
            throw new Error("Background location updates did not start.");
        }

        /*
         * 新規登録時もhasStarted=trueだけでは正常判定しない。
         * このsessionのfresh heartbeatが来ることを確認し、来なければ
         * controlled restartを1回だけ実施する。
         */
        await ensureBackgroundLocationStartupHealthy({
            userId,
            recordingSessionId,
            intervalMs,
            distanceMeters,
            stateActivatedAtMs,
            generation: healthCheckGeneration,
        });
    } catch (error) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "startLocationUpdatesFailed",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            errorMessage:
                error instanceof Error ? error.message : String(error),
            details: {
                restartedExistingTask: false,
                restoringPreviousState: Boolean(previousState),
            },
        });

        /*
         * 新規自動記録のstateだけが残ると、
         * 画面上は記録中なのにタスクが動いていない状態になる。
         *
         * そのため、起動失敗時は以前のstateへ戻す。
         */
        if (previousState) {
            await AsyncStorage.setItem(
                BACKGROUND_RECORDING_STATE_KEY,
                JSON.stringify(previousState),
            );
        } else {
            await AsyncStorage.removeItem(BACKGROUND_RECORDING_STATE_KEY);
        }

        /*
         * 以前が現在地共有状態だった場合は、
         * 共有用バックグラウンドタスクの復旧を試みる。
         *
         * この復旧に失敗しても、元の自動記録開始エラーを優先して返す。
         */
        if (
            previousState &&
            (previousState.liveShareOwnerValues?.length ?? 0) > 0
        ) {
            try {
                const sharingTaskAlreadyStarted =
                    await Location.hasStartedLocationUpdatesAsync(
                        BACKGROUND_LOCATION_TASK_NAME,
                    );

                if (!sharingTaskAlreadyStarted) {
                    await Location.startLocationUpdatesAsync(
                        BACKGROUND_LOCATION_TASK_NAME,
                        {
                            accuracy: Location.Accuracy.Balanced,
                            timeInterval: previousState.intervalMs,
                            distanceInterval: previousState.distanceMeters,
                            deferredUpdatesInterval: previousState.intervalMs,
                            deferredUpdatesDistance:
                                previousState.distanceMeters,
                            pausesUpdatesAutomatically: false,
                            showsBackgroundLocationIndicator: true,
                            foregroundService: {
                                notificationTitle: "現在地を共有中",
                                notificationBody:
                                    "現在地共有をバックグラウンドで継続しています",
                                notificationColor: "#4b6f8f",
                            },
                        },
                    );
                }

                await saveBackgroundLocationDebugLog({
                    userId: previousState.userId,
                    recordingSessionId:
                        previousState.recordingSessionId ?? null,
                    eventName:
                        "previousBackgroundLiveSharingRestoredAfterStartFailure",
                    hasStartedLocationUpdates:
                        await safeHasStartedLocationUpdates(),
                });
            } catch (restoreError) {
                console.error(
                    "Restore previous background live sharing error:",
                    restoreError,
                );

                await saveBackgroundLocationDebugLog({
                    userId: previousState.userId,
                    recordingSessionId:
                        previousState.recordingSessionId ?? null,
                    eventName: "previousBackgroundLiveSharingRestoreFailed",
                    errorMessage:
                        restoreError instanceof Error
                            ? restoreError.message
                            : String(restoreError),
                });
            }
        }

        throw error;
    }
}

export async function stopBackgroundLocationRecording(
    options: StopBackgroundLocationRecordingOptions = {},
) {
    /* 停止済みsessionの遅延health checkがtaskを再起動しないよう無効化する。 */
    backgroundTaskHealthCheckGeneration += 1;
    backgroundTaskStartupRecoverySessionId = null;
    backgroundTaskStartupRecoveryGeneration = null;

    const continueLiveSharing = options.continueLiveSharing === true;
    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    let recordingSessionId: string | null = null;
    let userId: string | null = null;
    let liveLocationId: string | null = null;
    let currentState: BackgroundRecordingState | null = null;

    if (raw) {
        try {
            const state = JSON.parse(raw) as BackgroundRecordingState;
            currentState = state;
            recordingSessionId = state.recordingSessionId ?? null;
            userId = state.userId ?? null;
            liveLocationId = state.liveLocationId ?? null;
        } catch (error) {
            console.error(
                "Parse background recording state on stop error:",
                error,
            );
        }
    }

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "stopBackgroundLocationRecordingCalled",
        details: {
            continueLiveSharing,
        },
    });

    const hasStarted = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    );

    if (continueLiveSharing && currentState) {
        const nextState: BackgroundRecordingState = {
            ...currentState,
            isRecording: false,
            recordingSessionId: null,
            startedAt: null,
            recordingExpiresAt: null,
            lastSavedLocation: null,
        };

        await AsyncStorage.setItem(
            BACKGROUND_RECORDING_STATE_KEY,
            JSON.stringify(nextState),
        );

        if (liveLocationId) {
            try {
                const result = await client.models.LiveLocation.update({
                    id: liveLocationId,
                    isActive: true,
                    isRecording: false,
                    recordingSessionId: null,
                    updatedAt: new Date().toISOString(),
                    sharedOwners: nextState.liveShareOwnerValues ?? [],
                });

                if (result.errors) {
                    console.error(
                        "Background LiveLocation continue sharing update errors:",
                        result.errors,
                    );
                }
            } catch (error) {
                console.error(
                    "Background LiveLocation continue sharing update error:",
                    error,
                );

                await saveBackgroundLocationDebugLog({
                    userId,
                    recordingSessionId,
                    eventName:
                        "backgroundLiveLocationContinueSharingUpdateFailed",
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                });
            }
        }

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLiveSharingContinuedAfterRecordingStop",
            hasStartedLocationUpdates: hasStarted,
            details: {
                liveLocationId,
                sharedOwnerCount: nextState.liveShareOwnerValues?.length ?? 0,
            },
        });

        return;
    }

    /*
     * 共有を継続しない場合だけ、
     * バックグラウンド位置更新を完全停止する。
     */
    if (hasStarted) {
        await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK_NAME);
    }

    const hasStartedAfterStop = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    );

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "stopBackgroundLocationRecordingCompleted",
        hasStartedLocationUpdates: hasStartedAfterStop,
        details: {
            hasStartedBeforeStop: hasStarted,
            continueLiveSharing: false,
        },
    });

    if (liveLocationId) {
        try {
            await client.models.LiveLocation.update({
                id: liveLocationId,
                isActive: false,
                isRecording: false,
                recordingSessionId: null,
                updatedAt: new Date().toISOString(),
            });
        } catch (error) {
            console.error("Background LiveLocation stop update error:", error);

            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "backgroundLiveLocationStopUpdateFailed",
                errorMessage:
                    error instanceof Error ? error.message : String(error),
            });
        }
    }

    await AsyncStorage.removeItem(BACKGROUND_RECORDING_STATE_KEY);

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "backgroundRecordingStateRemoved",
    });
}

function showBackgroundLocationDisclosure(): Promise<boolean> {
    return new Promise((resolve) => {
        let resolved = false;

        const finish = (accepted: boolean) => {
            if (resolved) {
                return;
            }

            resolved = true;
            resolve(accepted);
        };

        Alert.alert(
            "バックグラウンド位置情報について",
            [
                "このアプリは、自動記録中の移動ルートを作成するため、アプリを閉じている間や使用していない間も、バックグラウンドで位置情報を取得して保存します。",
                "",
                "位置情報は、移動履歴の作成、ルートの地図表示、およびユーザーが明示的に開始した現在地共有に使用します。",
                "",
                "現在地共有を開始した場合は、ユーザーが選択した共有相手に位置情報が表示されます。",
            ].join("\n"),
            [
                {
                    text: "キャンセル",
                    style: "cancel",
                    onPress: () => {
                        finish(false);
                    },
                },
                {
                    text: "次へ",
                    onPress: () => {
                        finish(true);
                    },
                },
            ],
            {
                cancelable: true,
                onDismiss: () => {
                    /*
                     * Androidの戻るボタンやダイアログ外タップは、
                     * 同意として扱わない。
                     */
                    finish(false);
                },
            },
        );
    });
}

export async function ensureBackgroundLocationPermission(
    userId?: string | null,
    recordingSessionId?: string | null,
) {
    /*
     * 最初はrequestではなくgetで、現在の権限状態だけを確認する。
     *
     * Androidでは、OS権限ダイアログより先に
     * アプリ内の事前説明を表示する必要がある。
     */
    let foregroundPermission = await Location.getForegroundPermissionsAsync();

    let backgroundPermission = await Location.getBackgroundPermissionsAsync();

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "locationPermissionsCheckedBeforeDisclosure",
        foregroundPermissionStatus: foregroundPermission.status,
        foregroundPermissionGranted: foregroundPermission.granted,
        foregroundPermissionCanAskAgain: foregroundPermission.canAskAgain,
        backgroundPermissionStatus: backgroundPermission.status,
        backgroundPermissionGranted: backgroundPermission.granted,
        backgroundPermissionCanAskAgain: backgroundPermission.canAskAgain,
        details: {
            platform: Platform.OS,
            requiresForegroundPermission:
                foregroundPermission.status !==
                Location.PermissionStatus.GRANTED,
            requiresBackgroundPermission:
                backgroundPermission.status !==
                Location.PermissionStatus.GRANTED,
        },
    });

    const requiresForegroundPermission =
        foregroundPermission.status !== Location.PermissionStatus.GRANTED;

    const requiresBackgroundPermission =
        backgroundPermission.status !== Location.PermissionStatus.GRANTED;

    /*
     * Androidでこれから位置権限を要求する場合は、
     * OS権限ダイアログより先に事前説明を表示する。
     *
     * 既に両方許可済みの場合は表示しない。
     */
    if (
        Platform.OS === "android" &&
        (requiresForegroundPermission || requiresBackgroundPermission)
    ) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationDisclosureShown",
            foregroundPermissionStatus: foregroundPermission.status,
            foregroundPermissionGranted: foregroundPermission.granted,
            foregroundPermissionCanAskAgain: foregroundPermission.canAskAgain,
            backgroundPermissionStatus: backgroundPermission.status,
            backgroundPermissionGranted: backgroundPermission.granted,
            backgroundPermissionCanAskAgain: backgroundPermission.canAskAgain,
        });

        const accepted = await showBackgroundLocationDisclosure();

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: accepted
                ? "backgroundLocationDisclosureAccepted"
                : "backgroundLocationDisclosureDeclined",
            foregroundPermissionStatus: foregroundPermission.status,
            foregroundPermissionGranted: foregroundPermission.granted,
            foregroundPermissionCanAskAgain: foregroundPermission.canAskAgain,
            backgroundPermissionStatus: backgroundPermission.status,
            backgroundPermissionGranted: backgroundPermission.granted,
            backgroundPermissionCanAskAgain: backgroundPermission.canAskAgain,
        });

        if (!accepted) {
            throw new Error(BACKGROUND_LOCATION_DISCLOSURE_DECLINED);
        }
    }

    /*
     * 前景権限が未許可の場合だけ要求する。
     */
    if (foregroundPermission.status !== Location.PermissionStatus.GRANTED) {
        foregroundPermission =
            await Location.requestForegroundPermissionsAsync();

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "foregroundPermissionRequested",
            foregroundPermissionStatus: foregroundPermission.status,
            foregroundPermissionGranted: foregroundPermission.granted,
            foregroundPermissionCanAskAgain: foregroundPermission.canAskAgain,
        });
    } else {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "foregroundPermissionAlreadyGranted",
            foregroundPermissionStatus: foregroundPermission.status,
            foregroundPermissionGranted: foregroundPermission.granted,
            foregroundPermissionCanAskAgain: foregroundPermission.canAskAgain,
        });
    }

    if (foregroundPermission.status !== Location.PermissionStatus.GRANTED) {
        if (foregroundPermission.canAskAgain) {
            Alert.alert(
                "位置情報の許可が必要です",
                [
                    "自動記録を使うには、位置情報の使用を許可してください。",
                    "",
                    "もう一度「自動記録開始」を押し、OSの権限画面で「アプリの使用中のみ」を選択してください。",
                ].join("\n"),
                [{ text: "OK" }],
            );
        } else {
            Alert.alert(
                "位置情報の設定が必要です",
                [
                    "位置情報の権限が無効になっています。",
                    "",
                    "端末の設定で、このアプリの位置情報を「アプリの使用中のみ許可」または「常に許可」に変更してください。",
                    "",
                    "変更後はアプリへ戻り、もう一度「自動記録開始」を押してください。",
                ].join("\n"),
                [
                    {
                        text: "キャンセル",
                        style: "cancel",
                    },
                    {
                        text: "設定を開く",
                        onPress: () => {
                            void Linking.openSettings();
                        },
                    },
                ],
            );
        }

        throw new Error(FOREGROUND_LOCATION_PERMISSION_NOT_GRANTED);
    }

    /*
     * 前景権限取得後に、背景権限を再確認する。
     *
     * Androidでは前景権限取得によって状態が変化する可能性がある。
     */
    backgroundPermission = await Location.getBackgroundPermissionsAsync();

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "backgroundPermissionChecked",
        backgroundPermissionStatus: backgroundPermission.status,
        backgroundPermissionGranted: backgroundPermission.granted,
        backgroundPermissionCanAskAgain: backgroundPermission.canAskAgain,
    });

    if (backgroundPermission.status === Location.PermissionStatus.GRANTED) {
        return;
    }

    /*
     * OSが再質問を許可している場合だけ権限要求を実行する。
     *
     * canAskAgain=falseの場合、requestを繰り返しても
     * ダイアログが表示されないため設定画面へ案内する。
     */
    if (backgroundPermission.canAskAgain) {
        backgroundPermission =
            await Location.requestBackgroundPermissionsAsync();

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundPermissionRequested",
            backgroundPermissionStatus: backgroundPermission.status,
            backgroundPermissionGranted: backgroundPermission.granted,
            backgroundPermissionCanAskAgain: backgroundPermission.canAskAgain,
        });
    }

    if (backgroundPermission.status === Location.PermissionStatus.GRANTED) {
        return;
    }

    Alert.alert(
        "位置情報の「常に許可」が必要です",
        [
            "バックグラウンドで自動記録を続けるには、端末の設定で位置情報を「常に許可」に変更してください。",
            "",
            "変更後はアプリに戻り、もう一度「自動記録開始」を押してください。",
        ].join("\n"),
        [
            {
                text: "キャンセル",
                style: "cancel",
            },
            {
                text: "設定を開く",
                onPress: () => {
                    void Linking.openSettings();
                },
            },
        ],
    );

    throw new BackgroundLocationPermissionError();
}

export async function updateBackgroundRecordingLiveLocationId(
    liveLocationId: string | null,
) {
    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    if (!raw) {
        return;
    }

    try {
        const state = JSON.parse(raw);

        await AsyncStorage.setItem(
            BACKGROUND_RECORDING_STATE_KEY,
            JSON.stringify({
                ...state,
                liveLocationId,
            }),
        );
    } catch (error) {
        console.error("Update background liveLocationId error:", error);
    }
}

export async function getBackgroundRecordingStatus(): Promise<{
    hasStarted: boolean;
    state: BackgroundRecordingState | null;
}> {
    const hasStarted = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    );

    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    if (!raw) {
        return {
            hasStarted,
            state: null,
        };
    }

    try {
        const state = JSON.parse(raw) as BackgroundRecordingState;

        return {
            hasStarted,
            state,
        };
    } catch (error) {
        console.error("Parse background recording state error:", error);

        return {
            hasStarted,
            state: null,
        };
    }
}

export async function updateBackgroundRecordingExpiresAt(
    recordingSessionId: string,
    recordingExpiresAt: string | null,
): Promise<void> {
    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    if (!raw) {
        return;
    }

    try {
        const state = JSON.parse(raw) as BackgroundRecordingState;

        if (state.recordingSessionId !== recordingSessionId) {
            return;
        }

        await AsyncStorage.setItem(
            BACKGROUND_RECORDING_STATE_KEY,
            JSON.stringify({
                ...state,
                recordingExpiresAt,
            }),
        );
    } catch (error) {
        console.error("Update background recordingExpiresAt error:", error);
    }
}

export async function updateForegroundLastSavedLocation(lastSavedLocation: {
    latitude: number;
    longitude: number;
    recordedAt: number;
}): Promise<void> {
    try {
        const raw = await AsyncStorage.getItem(
            FOREGROUND_LAST_SAVED_LOCATION_KEY,
        );

        if (raw) {
            const current = JSON.parse(raw);

            if (
                typeof current?.recordedAt === "number" &&
                current.recordedAt >= lastSavedLocation.recordedAt
            ) {
                return;
            }
        }

        await AsyncStorage.setItem(
            FOREGROUND_LAST_SAVED_LOCATION_KEY,
            JSON.stringify(lastSavedLocation),
        );
    } catch (error) {
        console.error("Update foreground lastSavedLocation error:", error);
    }
}

/**
 * バックグラウンド位置タスクの最新heartbeatを読み取る。
 *
 * 診断専用の読み取り処理であり、
 * タスクの開始、停止、再登録、記録状態の更新は行わない。
 */
export async function getBackgroundLocationTaskHeartbeatStatus(): Promise<BackgroundLocationHeartbeatStatus> {
    let raw: string | null = null;

    try {
        raw = await AsyncStorage.getItem(
            BACKGROUND_LOCATION_TASK_HEARTBEAT_KEY,
        );

        if (!raw) {
            return {
                heartbeat: null,
                ageMs: null,
                invalidStoredValue: false,
            };
        }

        const parsed = JSON.parse(
            raw,
        ) as Partial<BackgroundLocationTaskHeartbeat>;

        /*
         * heartbeatとして最低限必要な項目を検証する。
         */
        if (
            typeof parsed.firedAt !== "number" ||
            !Number.isFinite(parsed.firedAt) ||
            typeof parsed.taskFiredAt !== "string" ||
            typeof parsed.locationsLength !== "number" ||
            !Number.isFinite(parsed.locationsLength) ||
            typeof parsed.isRecording !== "boolean" ||
            typeof parsed.hasTaskError !== "boolean"
        ) {
            console.warn(
                "Stored background location task heartbeat is invalid:",
                raw,
            );

            return {
                heartbeat: null,
                ageMs: null,
                invalidStoredValue: true,
            };
        }

        const heartbeat: BackgroundLocationTaskHeartbeat = {
            firedAt: parsed.firedAt,
            taskFiredAt: parsed.taskFiredAt,
            locationsLength: parsed.locationsLength,
            recordingSessionId:
                typeof parsed.recordingSessionId === "string"
                    ? parsed.recordingSessionId
                    : null,
            isRecording: parsed.isRecording,
            userId: typeof parsed.userId === "string" ? parsed.userId : null,
            hasTaskError: parsed.hasTaskError,
        };

        return {
            heartbeat,
            ageMs: Math.max(0, Date.now() - heartbeat.firedAt),
            invalidStoredValue: false,
        };
    } catch (error) {
        console.error("Read background location task heartbeat error:", error);

        return {
            heartbeat: null,
            ageMs: null,
            invalidStoredValue: raw !== null,
        };
    }
}
