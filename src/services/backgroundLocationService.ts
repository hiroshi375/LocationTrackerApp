// src/services/backgroundLocationService.ts

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Alert, Linking, Platform } from "react-native";

import {
    BACKGROUND_LOCATION_TASK_HEARTBEAT_KEY,
    BACKGROUND_LOCATION_TASK_NAME,
    BACKGROUND_RECORDING_STATE_KEY,
    type BackgroundLocationTaskHeartbeat,
} from "../tasks/backgroundLocationTask";
import { saveBackgroundLocationDebugLog } from "./backgroundLocationDebugLogService";
import {
    getLiveLocationSharingState,
    setLiveLocationSharingState,
    startLiveLocationRecording,
    stopLiveLocationRecording,
} from "./liveLocationMutationService";

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

type StartBackgroundLiveSharingParams = {
    userId: string;
    intervalMs: number;
    distanceMeters: number;
    liveShareOwnerValues: string[];
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
    shareRevision?: number;
    liveSharingStartedAt?: number | null;
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

    /*
     * 指定された場合、
     * このRecordingSessionが現在のstateと一致するときだけ停止する。
     *
     * 古い非同期stopが新しいRecordingSessionを削除するのを防ぐ。
     */
    expectedRecordingSessionId?: string | null;
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
 * heartbeatを併用して、callbackの停止や異常を診断する。
 *
 * 異常を検出しても、ここからTaskの停止・再登録は行わない。
 */
const BACKGROUND_TASK_HEALTH_MIN_STALE_MS = 60_000;
const BACKGROUND_TASK_HEALTH_MAX_STALE_MS = 180_000;
/*
 * 現在地共有開始直後は、
 * native task開始から最初のcallback到着まで多少時間がかかることがある。
 *
 * この間はheartbeatがまだ無くても
 * 「task停止」と判断して再起動しない。
 */
const BACKGROUND_LIVE_SHARING_START_GRACE_MS = 30_000;
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

/**
 * Background Locationのlifecycle操作を直列化する。
 *
 * start / stop / sharing切替 / shareRevision保存の
 * 同時実行によるAsyncStorageとOS Taskの競合を抑止する。
 *
 * 同一JavaScriptランタイム内でのみ有効。
 */
let backgroundLifecycleQueue: Promise<void> = Promise.resolve();

async function withBackgroundLifecycleLock<T>(
    operation: string,
    task: () => Promise<T>,
): Promise<T> {
    const previous = backgroundLifecycleQueue;

    let release!: () => void;

    backgroundLifecycleQueue = new Promise<void>((resolve) => {
        release = resolve;
    });

    await previous.catch(() => undefined);

    try {
        return await task();
    } finally {
        release();
    }
}

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
    _distanceMeters: number,
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

function sameSharedOwners(a: string[], b: string[]): boolean {
    const left = [...new Set(a)].sort();
    const right = [...new Set(b)].sort();

    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}

/**
 * Cloudに確定している共有世代を取得する。
 *
 * 共有対象が一致しない場合、位置更新用の世代を渡さない。
 */
async function resolveShareRevision(
    sharedOwners: string[],
): Promise<number | undefined> {
    if (sharedOwners.length === 0) {
        return undefined;
    }

    const sharingState = await getLiveLocationSharingState();

    if (
        !sharingState.enabled ||
        !Number.isSafeInteger(sharingState.revision) ||
        sharingState.revision < 1 ||
        !sameSharedOwners(sharingState.sharedOwners, sharedOwners)
    ) {
        throw new Error("LIVE_LOCATION_SHARING_STATE_MISMATCH");
    }

    return sharingState.revision;
}

export async function saveBackgroundShareRevision(
    userId: string,
    shareRevision: number,
    sharedOwners: string[],
): Promise<void> {
    return withBackgroundLifecycleLock(
        "saveBackgroundShareRevision",
        async () => {
            await saveBackgroundShareRevisionInternal(
                userId,
                shareRevision,
                sharedOwners,
            );
        },
    );
}

/**
 * 共有変更Mutationが成功した後に呼び出す。
 *
 * ローカル状態が存在する場合だけ、
 * shareRevisionと共有先を保存する。
 */
async function saveBackgroundShareRevisionInternal(
    userId: string,
    shareRevision: number,
    sharedOwners: string[],
): Promise<void> {
    if (!Number.isSafeInteger(shareRevision) || shareRevision < 1) {
        throw new Error("INVALID_SHARE_REVISION");
    }

    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    if (!raw) {
        // BG stateがない場合は、共有開始処理で新規作成する。
        return;
    }

    const state = JSON.parse(raw) as BackgroundRecordingState;

    if (state.userId !== userId) {
        throw new Error("BACKGROUND_SHARE_REVISION_USER_MISMATCH");
    }

    const nextState: BackgroundRecordingState = {
        ...state,
        shareRevision,
        liveShareOwnerValues: [...sharedOwners],
    };

    await AsyncStorage.setItem(
        BACKGROUND_RECORDING_STATE_KEY,
        JSON.stringify(nextState),
    );
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

async function saveTaskManagerDiagnosticSnapshot({
    userId,
    recordingSessionId,
    eventName,
}: {
    userId?: string | null;
    recordingSessionId?: string | null;
    eventName: string;
}): Promise<void> {
    let locationHasStarted: boolean | null = null;
    let locationHasStartedError: string | null = null;

    let taskManagerIsRegistered: boolean | null = null;
    let taskManagerIsRegisteredError: string | null = null;

    let registeredTasks:
        | {
              taskName: string | null;
              taskType: string | null;
              options: unknown;
          }[]
        | null = null;
    let registeredTasksError: string | null = null;

    let targetTaskOptions: unknown = null;
    let targetTaskOptionsError: string | null = null;

    try {
        locationHasStarted = await Location.hasStartedLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
        );
    } catch (error) {
        locationHasStartedError =
            error instanceof Error ? error.message : String(error);
    }

    try {
        taskManagerIsRegistered = await TaskManager.isTaskRegisteredAsync(
            BACKGROUND_LOCATION_TASK_NAME,
        );
    } catch (error) {
        taskManagerIsRegisteredError =
            error instanceof Error ? error.message : String(error);
    }

    try {
        const tasks = await TaskManager.getRegisteredTasksAsync();

        registeredTasks = tasks.map((task: any) => ({
            taskName: typeof task?.taskName === "string" ? task.taskName : null,
            taskType: typeof task?.taskType === "string" ? task.taskType : null,
            options: task?.options ?? null,
        }));
    } catch (error) {
        registeredTasksError =
            error instanceof Error ? error.message : String(error);
    }

    try {
        targetTaskOptions = await TaskManager.getTaskOptionsAsync(
            BACKGROUND_LOCATION_TASK_NAME,
        );
    } catch (error) {
        targetTaskOptionsError =
            error instanceof Error ? error.message : String(error);
    }

    try {
        await saveBackgroundLocationDebugLog({
            userId: userId ?? null,
            recordingSessionId: recordingSessionId ?? null,
            eventName,
            hasStartedLocationUpdates: locationHasStarted,
            details: {
                taskName: BACKGROUND_LOCATION_TASK_NAME,

                locationHasStarted,
                locationHasStartedError,

                taskManagerIsRegistered,
                taskManagerIsRegisteredError,

                registeredTasks,
                registeredTasksError,

                targetTaskOptions,
                targetTaskOptionsError,
            },
        });
    } catch (error) {
        /*
         * 診断ログ自体の失敗によって
         * 自動記録開始・停止処理を失敗させない。
         */
        console.error(
            "[BackgroundLocation] TaskManager diagnostic snapshot failed:",
            eventName,
            error,
        );
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
 * 自動記録中のBackground location taskを診断する。
 *
 * 注意:
 * ・記録間隔/距離などの記録方法は変更しない
 * ・権限要求UIは出さない
 * ・hasStarted=trueでもheartbeatがstaleなら異常扱い
 * ・異常を検出してもTaskの停止・再登録は行わない
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

    const { userId, recordingSessionId, intervalMs } = state;

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
     * native登録あり + heartbeat正常ならhealthy。
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

    /*
     * 重要:
     *
     * heartbeat異常は診断ログへ記録するだけにする。
     *
     * health checkからLocation taskの停止・再登録など、
     * Task lifecycleを変更する処理は行わない。
     *
     */
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

            /*
             * 今回は診断専用であり、
             * 自動restartを行っていないことをログ上でも明示する。
             */
            automaticRecoveryPerformed: false,
        },
    });

    return {
        healthy: false,
        restarted: false,
        permissionGranted: true,
        hasStartedLocationUpdates,
        heartbeatAgeMs,
        heartbeatStaleMs,
        reason,
    };
}

export async function startBackgroundLiveSharing(
    params: StartBackgroundLiveSharingParams,
): Promise<void> {
    return withBackgroundLifecycleLock(
        "startBackgroundLiveSharing",
        async () => {
            await startBackgroundLiveSharingInternal(params);
        },
    );
}

async function startBackgroundLiveSharingInternal({
    userId,
    intervalMs,
    distanceMeters,
    liveShareOwnerValues,
    liveLocationId = null,
}: StartBackgroundLiveSharingParams): Promise<void> {
    const normalizedLiveShareOwnerValues = Array.from(
        new Set(liveShareOwnerValues.filter(Boolean)),
    );

    if (normalizedLiveShareOwnerValues.length === 0) {
        return;
    }

    const shareRevision = await resolveShareRevision(
        normalizedLiveShareOwnerValues,
    );

    await ensureBackgroundLocationPermission(userId, null);

    const previousState = await readBackgroundRecordingStateSafely();

    /*
     * 自動記録中の場合はtaskを再起動しない。
     * 記録taskを維持したまま共有先だけ更新する。
     */
    if (previousState?.isRecording === true) {
        const nextState: BackgroundRecordingState = {
            ...previousState,
            liveShareOwnerValues: normalizedLiveShareOwnerValues,
            shareRevision,
            liveLocationId:
                liveLocationId ?? previousState.liveLocationId ?? null,
        };

        await AsyncStorage.setItem(
            BACKGROUND_RECORDING_STATE_KEY,
            JSON.stringify(nextState),
        );

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId: previousState.recordingSessionId ?? null,
            eventName: "backgroundLiveSharingUpdatedDuringRecording",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            details: {
                sharedOwnerCount: normalizedLiveShareOwnerValues.length,
                liveLocationId: nextState.liveLocationId ?? null,
            },
        });

        return;
    }

    const hasStartedBeforeStart = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    );

    const heartbeatStatus = await getBackgroundLocationTaskHeartbeatStatus();

    const heartbeat = heartbeatStatus.heartbeat;

    const heartbeatStaleMs = getBackgroundTaskHeartbeatStaleMs(intervalMs);

    /*
     * 現在のheartbeatが、
     * 「現在地共有のみ」のBackground taskから来た
     * 正常なheartbeatか判定する。
     */
    const sharingHeartbeatMatches =
        heartbeat !== null &&
        heartbeat.isRecording === false &&
        heartbeat.recordingSessionId === null &&
        heartbeat.userId === userId &&
        heartbeat.hasTaskError !== true;

    const sharingHeartbeatIsRecent =
        sharingHeartbeatMatches &&
        heartbeatStatus.ageMs !== null &&
        heartbeatStatus.ageMs <= heartbeatStaleMs &&
        !heartbeatStatus.invalidStoredValue;

    /*
     * 直前に共有taskを開始したばかりの場合、
     * 最初のheartbeatがまだ届いていない可能性がある。
     *
     * useEffectが短時間に再実行された場合も
     * 不要なstop/startを行わない。
     */
    const previousLiveSharingStartedAt =
        previousState?.isRecording === false &&
        typeof previousState.liveSharingStartedAt === "number"
            ? previousState.liveSharingStartedAt
            : null;

    const liveSharingIsWithinStartGrace =
        previousLiveSharingStartedAt !== null &&
        Date.now() - previousLiveSharingStartedAt <=
            BACKGROUND_LIVE_SHARING_START_GRACE_MS;

    /*
     * task開始時刻。
     *
     * 既存の正常な共有task、または開始直後のtaskなら
     * previous値を維持する。
     *
     * それ以外は、これから新規開始・再起動する時刻を設定する。
     */
    const nextLiveSharingStartedAt =
        hasStartedBeforeStart &&
        (sharingHeartbeatIsRecent || liveSharingIsWithinStartGrace) &&
        previousLiveSharingStartedAt !== null
            ? previousLiveSharingStartedAt
            : Date.now();

    const nextState: BackgroundRecordingState = {
        userId,
        isRecording: false,
        recordingSessionId: null,
        startedAt: null,
        recordingExpiresAt: null,
        intervalMs,
        distanceMeters,
        liveShareOwnerValues: normalizedLiveShareOwnerValues,
        shareRevision,
        liveLocationId: liveLocationId ?? previousState?.liveLocationId ?? null,
        liveSharingStartedAt: nextLiveSharingStartedAt,
        lastSavedLocation: null,
    };

    /*
     * callbackが直後に到着しても共有stateを読めるよう、
     * task開始より前に保存する。
     */
    await AsyncStorage.setItem(
        BACKGROUND_RECORDING_STATE_KEY,
        JSON.stringify(nextState),
    );

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId: null,
        eventName: "startBackgroundLiveSharingCalled",
        hasStartedLocationUpdates: hasStartedBeforeStart,
        details: {
            sharedOwnerCount: normalizedLiveShareOwnerValues.length,
            intervalMs,
            distanceMeters,
            liveLocationId: nextState.liveLocationId ?? null,

            heartbeatAgeMs: heartbeatStatus.ageMs,
            heartbeatStaleMs,
            heartbeatIsRecording: heartbeat?.isRecording ?? null,
            heartbeatRecordingSessionId: heartbeat?.recordingSessionId ?? null,
            heartbeatHasTaskError: heartbeat?.hasTaskError ?? null,

            sharingHeartbeatMatches,
            sharingHeartbeatIsRecent,
            liveSharingIsWithinStartGrace,
            previousLiveSharingStartedAt,
        },
    });

    /*
     * native登録が存在し、
     * かつ
     *
     * 1. 共有用heartbeatが正常
     * または
     * 2. 共有task開始直後の猶予期間内
     *
     * ならtaskはそのまま使用する。
     */
    if (
        hasStartedBeforeStart &&
        (sharingHeartbeatIsRecent || liveSharingIsWithinStartGrace)
    ) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId: null,
            eventName: "backgroundLiveSharingAlreadyHealthy",
            hasStartedLocationUpdates: true,
            details: {
                sharedOwnerCount: normalizedLiveShareOwnerValues.length,
                heartbeatAgeMs: heartbeatStatus.ageMs,
                heartbeatStaleMs,
                sharingHeartbeatIsRecent,
                liveSharingIsWithinStartGrace,
            },
        });

        return;
    }

    /*
     * hasStarted=trueでもheartbeatが無い・古い・
     * 自動記録時のheartbeatのまま等の場合は、
     * native登録だけ残ってcallbackが停止している可能性がある。
     *
     * 一度明示的にstopしてから共有用taskを再登録する。
     */
    if (hasStartedBeforeStart) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId: null,
            eventName: "staleBackgroundLiveSharingRestartStarted",
            hasStartedLocationUpdates: true,
            details: {
                heartbeatAgeMs: heartbeatStatus.ageMs,
                heartbeatStaleMs,
                heartbeatIsRecording: heartbeat?.isRecording ?? null,
                heartbeatRecordingSessionId:
                    heartbeat?.recordingSessionId ?? null,
                sharingHeartbeatMatches,
                sharingHeartbeatIsRecent,
            },
        });

        await saveTaskManagerDiagnosticSnapshot({
            userId,
            recordingSessionId: null,
            eventName: "taskManagerSnapshotBeforeLiveSharingRestart",
        });

        /*
         * Location.hasStartedLocationUpdatesAsync() が true でも、
         * TaskManager側ではすでにtaskが存在しないケースがある。
         *
         * その場合、
         * stopLocationUpdatesAsync() は TaskNotFoundException を返すが、
         * 実質的には「すでに停止済み」のため、
         * 共有taskの再登録処理を継続してよい。
         *
         * TaskNotFoundException以外のstopエラーは
         * 安全のため従来どおりthrowする。
         */
        let taskNotFoundOnStop = false;

        try {
            await Location.stopLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);

            const isTaskNotFound =
                errorMessage.includes("TaskNotFoundException") ||
                (errorMessage.includes(BACKGROUND_LOCATION_TASK_NAME) &&
                    errorMessage.includes("not found"));

            if (!isTaskNotFound) {
                await saveBackgroundLocationDebugLog({
                    userId,
                    recordingSessionId: null,
                    eventName: "staleBackgroundLiveSharingStopFailed",
                    hasStartedLocationUpdates:
                        await safeHasStartedLocationUpdates(),
                    errorMessage,
                });

                throw error;
            }

            taskNotFoundOnStop = true;

            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId: null,
                eventName: "staleBackgroundLiveSharingTaskNotFoundOnStop",
                hasStartedLocationUpdates:
                    await safeHasStartedLocationUpdates(),
                errorMessage,
                details: {
                    taskName: BACKGROUND_LOCATION_TASK_NAME,
                    treatedAsAlreadyStopped: true,
                },
            });
        }

        /*
         * TaskNotFoundExceptionの場合、
         * hasStartedLocationUpdatesAsync() 側が一時的に
         * staleなtrueを返す可能性があるため、
         * 「taskが残っている」とは判定しない。
         */
        const hasStartedAfterStop = taskNotFoundOnStop
            ? false
            : await Location.hasStartedLocationUpdatesAsync(
                  BACKGROUND_LOCATION_TASK_NAME,
              );

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId: null,
            eventName: "staleBackgroundLiveSharingStopped",
            hasStartedLocationUpdates: hasStartedAfterStop,
            details: {
                hasStartedBeforeStop: hasStartedBeforeStart,
                taskNotFoundOnStop,
            },
        });

        await saveTaskManagerDiagnosticSnapshot({
            userId,
            recordingSessionId: null,
            eventName: "taskManagerSnapshotAfterLiveSharingStop",
        });

        /*
         * 通常stopしたのにまだstarted=trueなら異常。
         *
         * TaskNotFoundExceptionの場合は、
         * TaskManager上は既に存在しないことが確認済みなので
         * この判定対象から除外する。
         */
        if (!taskNotFoundOnStop && hasStartedAfterStop) {
            throw new Error(
                "Background live sharing location updates remained started after stop.",
            );
        }
    }

    /*
     * 共有専用taskでもBackground callbackを安定して受信するため、
     * 自動記録側と同様のnative sampling設定を使用する。
     */
    const locationTaskOptions = {
        /*
         * 現在地共有でも、Android側からのLocation callbackを
         * 安定して受信することを優先する。
         *
         * 自動記録側と同様にnative側では細かく位置を受信し、
         * intervalMs / distanceMetersをnative側の
         * callback抑制条件として使用しない。
         */
        accuracy: Location.Accuracy.BestForNavigation,

        /*
         * OSからの位置callbackは最大5秒程度で受信する。
         *
         * intervalMsが5秒未満の場合だけ、
         * ユーザー設定値を優先する。
         */
        timeInterval: getNativeLocationSampleIntervalMs(intervalMs),
        /*
         * 移動距離によってnative callback自体が止まることを防ぐ。
         */
        distanceInterval: 0,
        /*
         * Android/iOS側で位置更新をまとめて遅延配送しない。
         */
        deferredUpdatesInterval: 0,
        deferredUpdatesDistance: 0,
        /*
         * ウォーキング・ランニング・サイクリング等の
         * アクティビティ用途であることをOSへ伝える。
         */
        activityType: Location.ActivityType.Fitness,
        /*
         * OSによる自動休止を抑止する。
         */
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
            notificationTitle: "現在地を共有中",
            notificationBody: "現在地共有をバックグラウンドで継続しています",
            notificationColor: "#4b6f8f",
        },
    };

    try {
        /*
         * 共有用Background Location task開始直前の
         * TaskManager / Expo Location登録状態を保存する。
         */
        await saveTaskManagerDiagnosticSnapshot({
            userId,
            recordingSessionId: null,
            eventName: "taskManagerSnapshotImmediatelyBeforeLiveSharingStart",
        });
        await Location.startLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
            locationTaskOptions,
        );

        /*
         * startLocationUpdatesAsync()直後の状態を保存する。
         *
         * Location.hasStartedLocationUpdatesAsync()だけではなく、
         * TaskManager側の登録状態・optionsも比較できるようにする。
         */
        await saveTaskManagerDiagnosticSnapshot({
            userId,
            recordingSessionId: null,
            eventName: "taskManagerSnapshotImmediatelyAfterLiveSharingStart",
        });

        const hasStartedAfterStart =
            await Location.hasStartedLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId: null,
            eventName: "startBackgroundLiveSharingCompleted",
            hasStartedLocationUpdates: hasStartedAfterStart,
            details: {
                sharedOwnerCount: normalizedLiveShareOwnerValues.length,
                intervalMs,
                distanceMeters,
            },
        });

        if (!hasStartedAfterStart) {
            throw new Error(
                "Background live sharing location updates did not start.",
            );
        }

        await AsyncStorage.setItem(
            BACKGROUND_RECORDING_STATE_KEY,
            JSON.stringify({
                ...nextState,
                liveSharingStartedAt: Date.now(),
            }),
        );
    } catch (error) {
        await saveTaskManagerDiagnosticSnapshot({
            userId,
            recordingSessionId: null,
            eventName: "taskManagerSnapshotOnLiveSharingStartFailure",
        });
        /*
         * 起動失敗時は、今回保存したsharing stateだけ残さない。
         */
        if (previousState) {
            await AsyncStorage.setItem(
                BACKGROUND_RECORDING_STATE_KEY,
                JSON.stringify(previousState),
            );
        } else {
            await AsyncStorage.removeItem(BACKGROUND_RECORDING_STATE_KEY);
        }

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId: null,
            eventName: "startBackgroundLiveSharingFailed",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            errorMessage:
                error instanceof Error ? error.message : String(error),
        });

        throw error;
    }
}

/**
 * 記録開始失敗時に、以前のBackground Taskを復元する。
 *
 * previousStateが記録中なら記録用設定、
 * 共有専用なら共有用設定を使用する。
 *
 * ローカルのlifecycle lock内で呼び出すこと。
 */
async function restorePreviousLocationTask(
    previousState: BackgroundRecordingState | null,
): Promise<void> {
    if (!previousState) {
        return;
    }

    const shouldRestoreRecording =
        previousState.isRecording === true &&
        Boolean(previousState.recordingSessionId);

    const shouldRestoreSharing =
        !shouldRestoreRecording &&
        (previousState.liveShareOwnerValues?.length ?? 0) > 0;

    if (!shouldRestoreRecording && !shouldRestoreSharing) {
        return;
    }

    const options = createRecordingLocationTaskOptions(
        previousState.intervalMs,
        previousState.distanceMeters,
    );

    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK_NAME, {
        ...options,
        foregroundService: {
            ...options.foregroundService,
            notificationTitle: shouldRestoreRecording
                ? "位置情報を記録中"
                : "現在地を共有中",
            notificationBody: shouldRestoreRecording
                ? "自動記録または現在地共有をバックグラウンドで継続しています"
                : "現在地共有をバックグラウンドで継続しています",
        },
    });

    const hasStarted = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    );

    if (!hasStarted) {
        throw new Error("BACKGROUND_PREVIOUS_TASK_RESTORE_FAILED");
    }
}

export async function startBackgroundLocationRecording(
    params: StartBackgroundLocationRecordingParams,
): Promise<void> {
    return withBackgroundLifecycleLock(
        "startBackgroundLocationRecording",
        async () => {
            await startBackgroundLocationRecordingInternal(params);
        },
    );
}

async function startBackgroundLocationRecordingInternal({
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

    const shareRevision = await resolveShareRevision(
        normalizedLiveShareOwnerValues,
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

    /*
     * 2d0c5cfで安定していた単純なlifecycleへ戻す。
     *
     * 既にBackground Location Taskが起動中の場合は、
     * heartbeatを使った強いrecoveryは行わず、
     * Expo Location APIによる通常のstop/startだけを行う。
     */
    const hasStartedBeforeRestart =
        await Location.hasStartedLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
        );

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "hasStartedLocationUpdatesCheckedBeforeStart",
        hasStartedLocationUpdates: hasStartedBeforeRestart,
        details: {
            previousStateExists: Boolean(previousState),
            previousIsRecording: previousState?.isRecording ?? null,
            previousRecordingSessionId:
                previousState?.recordingSessionId ?? null,
            previousLiveLocationId: previousState?.liveLocationId ?? null,
        },
    });

    await saveTaskManagerDiagnosticSnapshot({
        userId,
        recordingSessionId,
        eventName: "taskManagerSnapshotBeforeRecordingStart",
    });

    try {
        if (hasStartedBeforeRestart) {
            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName:
                    "restartBackgroundLocationUpdatesForRecordingStarted",
                hasStartedLocationUpdates: true,
                details: {
                    reason:
                        previousState?.isRecording === true
                            ? "refreshExistingRecordingTask"
                            : "switchFromLiveSharingToRecording",
                },
            });

            try {
                await Location.stopLocationUpdatesAsync(
                    BACKGROUND_LOCATION_TASK_NAME,
                );
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);

                const isTaskNotFound =
                    message.includes("TaskNotFoundException") ||
                    message.includes(
                        "Task 'location-tracker-background-location-task' not found",
                    );

                if (!isTaskNotFound) {
                    throw error;
                }
            }

            const hasStartedAfterStop =
                await Location.hasStartedLocationUpdatesAsync(
                    BACKGROUND_LOCATION_TASK_NAME,
                );

            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "existingLocationUpdatesStoppedBeforeRecordingStart",
                hasStartedLocationUpdates: hasStartedAfterStop,
            });

            await saveTaskManagerDiagnosticSnapshot({
                userId,
                recordingSessionId,
                eventName: "taskManagerSnapshotAfterExistingTaskStop",
            });

            if (hasStartedAfterStop) {
                const error = new Error(
                    "Background location updates remained started after stop.",
                );

                await saveBackgroundLocationDebugLog({
                    userId,
                    recordingSessionId,
                    eventName: "existingLocationUpdatesStillStartedAfterStop",
                    hasStartedLocationUpdates: true,
                    errorMessage: error.message,
                });

                throw error;
            }
        }
    } catch (error) {
        console.error(
            "[BackgroundLocation] Stop previous task before start failed:",
            error,
        );

        /*
         * 以前のAsyncStorageはまだ変更していない。
         * 以前のOS Taskが停止済みであれば復旧する。
         */
        if (hasStartedBeforeRestart) {
            try {
                const stillStarted =
                    await Location.hasStartedLocationUpdatesAsync(
                        BACKGROUND_LOCATION_TASK_NAME,
                    );

                if (!stillStarted) {
                    await restorePreviousLocationTask(previousState);
                }
            } catch (restoreError) {
                console.error(
                    "[BackgroundLocation] Previous task restore failed:",
                    restoreError,
                );
            }
        }

        throw error;
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
        shareRevision,
        liveLocationId,
        lastSavedLocation,
    };

    /*
     * ここは2d0c5cfへ完全には戻さない。
     *
     * 現在版で導入した
     * ・native側最大5秒sampling
     * ・distanceInterval = 0
     *
     * を維持する。
     */
    const locationTaskOptions = createRecordingLocationTaskOptions(
        intervalMs,
        distanceMeters,
    );

    /*
     * Cloudへの開始要求が送信されたかを保持する。
     * 通信エラーでもCloud更新が成功している可能性がある。
     */
    let cloudRecordingStartAttempted = false;

    try {
        /*
         * Background Callbackが新しいRecordingSessionを
         * 読めるよう、OS Task開始前にstateを保存する。
         *
         * 保存失敗も同じcatchで復旧対象にする。
         */
        await AsyncStorage.setItem(
            BACKGROUND_RECORDING_STATE_KEY,
            JSON.stringify(nextState),
        );
        await saveTaskManagerDiagnosticSnapshot({
            userId,
            recordingSessionId,
            eventName: "taskManagerSnapshotImmediatelyBeforeStartCall",
        });
        await Location.startLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
            locationTaskOptions,
        );

        await saveTaskManagerDiagnosticSnapshot({
            userId,
            recordingSessionId,
            eventName: "taskManagerSnapshotImmediatelyAfterStartCall",
        });

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
                restartedExistingTask: hasStartedBeforeRestart,
                intervalMs,
                distanceMeters,
                liveLocationId,
                liveShareOwnerCount: normalizedLiveShareOwnerValues.length,
            },
        });

        /*
         * startLocationUpdatesAsyncが例外を出さなくても、
         * Expo側で登録済みになっていなければ開始失敗とする。
         *
         * heartbeatは開始成功条件には使用しない。
         */
        if (!hasStartedAfterStart) {
            throw new Error("Background location updates did not start.");
        }

        /*
         * 現在地共有中に自動記録を開始した場合だけ、
         * Cloud側の記録状態を開始する。
         *
         * 共有していない通常の自動記録には影響させない。
         */
        if (normalizedLiveShareOwnerValues.length > 0) {
            if (
                typeof shareRevision !== "number" ||
                !Number.isSafeInteger(shareRevision) ||
                shareRevision < 1
            ) {
                throw new Error("LIVE_LOCATION_START_SHARE_REVISION_MISSING");
            }

            cloudRecordingStartAttempted = true;

            await startLiveLocationRecording({
                expectedRevision: shareRevision,
                recordingSessionId,
            });
        }

        /*
         * 重要:
         *
         * heartbeatを使ったstartup recoveryやcold restartは行わない。
         *
         * heartbeatは診断情報としてのみ使用し、
         * 自動記録開始の成否判定には使用しない。
         *
         */
    } catch (error) {
        const originalError = error;

        /*
         * 1. 開始失敗を診断ログへ記録する。
         */
        await saveTaskManagerDiagnosticSnapshot({
            userId,
            recordingSessionId,
            eventName: "taskManagerSnapshotOnStartFailure",
        });

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "startLocationUpdatesFailed",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            errorMessage:
                originalError instanceof Error
                    ? originalError.message
                    : String(originalError),
            details: {
                restartedExistingTask: hasStartedBeforeRestart,
                restoringPreviousState: Boolean(previousState),
                cloudRecordingStartAttempted,
            },
        });

        /*
         * 2. Cloud側の開始要求を実行していた場合、
         * 今回のRecordingSessionだけを停止方向に補償する。
         *
         * 既存セッションの再初期化だった場合は、
         * 以前から記録中のCloud状態を停止しない。
         */
        const previousSessionIsSame =
            previousState?.isRecording === true &&
            previousState.userId === userId &&
            previousState.recordingSessionId === recordingSessionId;

        if (
            cloudRecordingStartAttempted &&
            !previousSessionIsSame &&
            typeof shareRevision === "number" &&
            Number.isSafeInteger(shareRevision) &&
            shareRevision >= 1
        ) {
            try {
                await stopLiveLocationRecording({
                    expectedRevision: shareRevision,
                    expectedRecordingSessionId: recordingSessionId,
                });
            } catch (compensationError) {
                console.error(
                    "[BackgroundLocation] Cloud start compensation failed:",
                    compensationError,
                );

                await saveBackgroundLocationDebugLog({
                    userId,
                    recordingSessionId,
                    eventName:
                        "backgroundCloudRecordingStartCompensationFailed",
                    errorMessage:
                        compensationError instanceof Error
                            ? compensationError.message
                            : String(compensationError),
                });
            }
        }

        /*
         * 3. 今回開始したOS Taskを停止する。
         */
        let taskCleanupSucceeded = false;

        try {
            const hasStarted = await Location.hasStartedLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );

            if (hasStarted) {
                await Location.stopLocationUpdatesAsync(
                    BACKGROUND_LOCATION_TASK_NAME,
                );
            }

            const stillStarted = await Location.hasStartedLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );

            if (stillStarted) {
                throw new Error("BACKGROUND_TASK_CLEANUP_NOT_CONFIRMED");
            }

            taskCleanupSucceeded = true;
        } catch (cleanupError) {
            console.error(
                "[BackgroundLocation] Recording task cleanup failed:",
                cleanupError,
            );
        }

        /*
         * 4. 開始前のAsyncStorageへ戻す。
         */
        let stateRestoreSucceeded = false;

        try {
            if (previousState) {
                await AsyncStorage.setItem(
                    BACKGROUND_RECORDING_STATE_KEY,
                    JSON.stringify(previousState),
                );
            } else {
                await AsyncStorage.removeItem(BACKGROUND_RECORDING_STATE_KEY);
            }

            stateRestoreSucceeded = true;
        } catch (stateError) {
            console.error(
                "[BackgroundLocation] Previous recording state restore failed:",
                stateError,
            );
        }

        /*
         * 5. 以前からOS Taskが起動していた場合だけ復旧する。
         *
         * 記録中 → 記録用Task
         * 共有のみ → 共有用Task
         */
        if (
            hasStartedBeforeRestart &&
            taskCleanupSucceeded &&
            stateRestoreSucceeded
        ) {
            try {
                await restorePreviousLocationTask(previousState);

                await saveBackgroundLocationDebugLog({
                    userId: previousState?.userId ?? userId,
                    recordingSessionId:
                        previousState?.recordingSessionId ?? null,
                    eventName:
                        "previousBackgroundTaskRestoredAfterStartFailure",
                    hasStartedLocationUpdates:
                        await safeHasStartedLocationUpdates(),
                });
            } catch (restoreError) {
                console.error(
                    "[BackgroundLocation] Previous task restore failed:",
                    restoreError,
                );

                await saveBackgroundLocationDebugLog({
                    userId: previousState?.userId ?? userId,
                    recordingSessionId:
                        previousState?.recordingSessionId ?? null,
                    eventName: "previousBackgroundTaskRestoreFailed",
                    errorMessage:
                        restoreError instanceof Error
                            ? restoreError.message
                            : String(restoreError),
                });
            }
        }

        /*
         * 6. 復旧処理によって元のエラーを隠さない。
         */
        throw originalError;
    }
}

export async function stopBackgroundLocationRecording(
    options: StopBackgroundLocationRecordingOptions = {},
): Promise<void> {
    return withBackgroundLifecycleLock(
        "stopBackgroundLocationRecording",
        async () => {
            await stopBackgroundLocationRecordingInternal(options);
        },
    );
}

async function stopBackgroundLocationRecordingInternal(
    options: StopBackgroundLocationRecordingOptions = {},
) {
    const continueLiveSharing = options.continueLiveSharing === true;

    /*
     * 指定されている場合、
     * このRecordingSessionだけを停止対象とする。
     *
     * 古い非同期stop処理が、
     * すでに開始された新しいRecordingSessionを
     * 停止・削除してしまうことを防ぐ。
     */
    const expectedRecordingSessionId = options.expectedRecordingSessionId;

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

    /*
     * ★ここに追加
     *
     * stop処理を開始した時点で想定していたsessionと、
     * 現在AsyncStorageに保存されているsessionが異なる場合、
     * このstop処理は古い処理と判断して何もしない。
     */
    if (
        expectedRecordingSessionId !== undefined &&
        currentState &&
        (currentState.recordingSessionId ?? null) !== expectedRecordingSessionId
    ) {
        await saveBackgroundLocationDebugLog({
            userId: currentState.userId ?? null,
            recordingSessionId: currentState.recordingSessionId ?? null,
            eventName: "stopBackgroundLocationRecordingSkippedSessionMismatch",
            details: {
                expectedRecordingSessionId,
                currentRecordingSessionId:
                    currentState.recordingSessionId ?? null,
            },
        });

        console.warn("[BackgroundRecordingState] Skip stale stop:", {
            expectedRecordingSessionId,
            currentRecordingSessionId: currentState.recordingSessionId ?? null,
        });

        return;
    }

    /*
     * session一致確認が終わってから、
     * 通常のstop開始ログを出す。
     */
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

    await saveTaskManagerDiagnosticSnapshot({
        userId,
        recordingSessionId,
        eventName: "taskManagerSnapshotBeforeRecordingStop",
    });

    if (continueLiveSharing && currentState) {
        let stateForUpdate = currentState;

        if (expectedRecordingSessionId !== undefined) {
            const latestRaw = await AsyncStorage.getItem(
                BACKGROUND_RECORDING_STATE_KEY,
            );

            if (!latestRaw) {
                return;
            }

            try {
                const latestState = JSON.parse(
                    latestRaw,
                ) as BackgroundRecordingState;

                if (
                    (latestState.recordingSessionId ?? null) !==
                    expectedRecordingSessionId
                ) {
                    console.warn(
                        "[BackgroundRecordingState] Skip stale continue sharing stop:",
                        {
                            expectedRecordingSessionId,
                            currentRecordingSessionId:
                                latestState.recordingSessionId ?? null,
                        },
                    );

                    return;
                }

                stateForUpdate = latestState;
            } catch (error) {
                console.error(
                    "Parse latest background recording state before continue sharing error:",
                    error,
                );

                return;
            }
        }

        /*
         * 自動記録だけ停止し、現在地共有を継続する。
         *
         * Cloud側の記録停止を確定してから、
         * ローカルの記録状態を終了状態へ変更する。
         */
        const expectedSessionId = stateForUpdate.recordingSessionId ?? null;

        const expectedRevision = stateForUpdate.shareRevision;

        if (
            typeof expectedRevision !== "number" ||
            !Number.isSafeInteger(expectedRevision) ||
            expectedRevision < 1
        ) {
            throw new Error("LIVE_LOCATION_STOP_SHARE_REVISION_MISSING");
        }

        if (!expectedSessionId) {
            throw new Error("LIVE_LOCATION_STOP_RECORDING_SESSION_MISSING");
        }

        /*
         * Cloud側の自動記録停止を確定する。
         *
         * 失敗時はAsyncStorageを更新せず、
         * OS Taskも停止しない。
         */
        try {
            await stopLiveLocationRecording({
                expectedRevision,
                expectedRecordingSessionId: expectedSessionId,
            });
        } catch (cloudError) {
            console.error(
                "[BackgroundLocation] Cloud recording stop failed:",
                cloudError,
            );

            try {
                await saveBackgroundLocationDebugLog({
                    userId: stateForUpdate.userId,
                    recordingSessionId: expectedSessionId,
                    eventName: "backgroundCloudRecordingStopFailed",
                    hasStartedLocationUpdates:
                        await safeHasStartedLocationUpdates(),
                    errorMessage:
                        cloudError instanceof Error
                            ? cloudError.message
                            : String(cloudError),
                    details: {
                        expectedRevision,
                        continueLiveSharing: true,
                        localStatePreserved: true,
                    },
                });
            } catch (logError) {
                console.error(
                    "[BackgroundLocation] Stop failure diagnostic failed:",
                    logError,
                );
            }

            throw cloudError;
        }

        /*
         * Cloud停止成功後、ローカルの記録状態を終了へ変更する。
         *
         * AsyncStorage保存失敗時は1回再試行する。
         *
         * Cloud側では停止が確定しているため、
         * 失敗してもCloudの記録状態を元に戻さない。
         */
        let localStateSaved = false;
        let localSaveError: unknown = null;

        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                /*
                 * 最新stateが別ユーザー・別セッション・別共有世代に
                 * 切り替わっていないことを確認する。
                 */
                const latestRaw = await AsyncStorage.getItem(
                    BACKGROUND_RECORDING_STATE_KEY,
                );

                if (!latestRaw) {
                    throw new Error(
                        "BACKGROUND_RECORDING_STATE_MISSING_AFTER_CLOUD_STOP",
                    );
                }

                const latestState = JSON.parse(
                    latestRaw,
                ) as BackgroundRecordingState;

                if (
                    latestState.userId !== stateForUpdate.userId ||
                    (latestState.recordingSessionId ?? null) !==
                        expectedSessionId ||
                    latestState.shareRevision !== expectedRevision
                ) {
                    throw new Error(
                        "BACKGROUND_RECORDING_STATE_CHANGED_AFTER_CLOUD_STOP",
                    );
                }

                /*
                 * latestStateから次の状態を生成することで、
                 * Cloud更新中に保存された他の項目を極力維持する。
                 */
                const updatedState: BackgroundRecordingState = {
                    ...latestState,
                    isRecording: false,
                    recordingSessionId: null,
                    startedAt: null,
                    recordingExpiresAt: null,
                    lastSavedLocation: null,
                };

                await AsyncStorage.setItem(
                    BACKGROUND_RECORDING_STATE_KEY,
                    JSON.stringify(updatedState),
                );

                localStateSaved = true;
                break;
            } catch (saveError) {
                localSaveError = saveError;

                console.error(
                    `[BackgroundLocation] Local recording stop save failed (${attempt}/2):`,
                    saveError,
                );

                /*
                 * 状態の切り替わりを検出した場合は、
                 * 古い状態での保存再試行を行わない。
                 */
                if (
                    saveError instanceof Error &&
                    saveError.message ===
                        "BACKGROUND_RECORDING_STATE_CHANGED_AFTER_CLOUD_STOP"
                ) {
                    break;
                }
            }
        }

        if (!localStateSaved) {
            try {
                await saveBackgroundLocationDebugLog({
                    userId: stateForUpdate.userId,
                    recordingSessionId: expectedSessionId,
                    eventName:
                        "backgroundLocalRecordingStopSaveFailedAfterCloudSuccess",
                    hasStartedLocationUpdates:
                        await safeHasStartedLocationUpdates(),
                    errorMessage:
                        localSaveError instanceof Error
                            ? localSaveError.message
                            : String(localSaveError),
                    details: {
                        expectedRevision,
                        cloudStopSucceeded: true,
                        localStateSaved: false,
                        continueLiveSharing: true,
                    },
                });
            } catch (logError) {
                console.error(
                    "[BackgroundLocation] Local stop diagnostic failed:",
                    logError,
                );
            }

            throw new Error(
                "BACKGROUND_LOCAL_STOP_SAVE_FAILED_AFTER_CLOUD_SUCCESS",
            );
        }

        // 以下既存処理

        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLiveSharingContinuedAfterRecordingStop",
            hasStartedLocationUpdates: hasStarted,
            details: {
                liveLocationId,
                sharedOwnerCount:
                    stateForUpdate.liveShareOwnerValues?.length ?? 0,
            },
        });

        return;
    }

    /*
     * 共有を継続しない場合の完全停止。
     *
     * Cloud共有権限の停止を先に確定してから、
     * OSのBackground Location Taskを停止する。
     *
     * 通常の自動記録のみの場合は、
     * Cloud共有Mutationを実行しない。
     */

    const hasLocalSharingEvidence =
        (currentState?.liveShareOwnerValues?.length ?? 0) > 0 ||
        (currentState?.shareRevision ?? 0) > 0 ||
        Boolean(liveLocationId);

    /*
     * 1. Cloud側の共有停止。
     *
     * Cloud停止が成功する前にOS Taskを停止しない。
     */
    if (hasLocalSharingEvidence) {
        try {
            if (!userId) {
                throw new Error("BACKGROUND_SHARING_STOP_USER_ID_MISSING");
            }

            const sharingState = await getLiveLocationSharingState();

            /*
             * すでに共有停止済みの場合は
             * 再度Mutationを実行しない。
             *
             * 前回Cloud停止成功後にOS Task停止だけ
             * 失敗したケースでも、再試行できる。
             */
            if (sharingState.enabled) {
                await setLiveLocationSharingState({
                    userId,
                    legacyLiveLocationId: liveLocationId,
                    continueSharing: false,
                    sharedOwners: [],
                    expectedRevision: sharingState.revision,
                });
            }

            console.log("[LiveLocation] Cloud sharing stop confirmed", {
                userId,
                previousRevision: sharingState.revision,
                alreadyDisabled: !sharingState.enabled,
            });

            /*
             * Cloud共有停止はすでに成功済み。
             * 診断ログの保存失敗では停止処理を中断しない。
             */
            try {
                await saveBackgroundLocationDebugLog({
                    userId,
                    recordingSessionId,
                    eventName: "backgroundCloudSharingStopConfirmed",
                    details: {
                        previousRevision: sharingState.revision,
                        alreadyDisabled: !sharingState.enabled,
                        continueLiveSharing: false,
                    },
                });
            } catch (logError) {
                console.error(
                    "[BackgroundLocation] Cloud stop success log failed:",
                    logError,
                );
            }
        } catch (cloudError) {
            console.error(
                "[BackgroundLocation] Cloud sharing stop failed:",
                cloudError,
            );

            /*
             * 診断ログ失敗によって元のCloudエラーを
             * 隠さないようにする。
             */
            try {
                await saveBackgroundLocationDebugLog({
                    userId,
                    recordingSessionId,
                    eventName: "backgroundCloudSharingStopFailed",
                    errorMessage:
                        cloudError instanceof Error
                            ? cloudError.message
                            : String(cloudError),
                    details: {
                        continueLiveSharing: false,
                        osTaskStopAttempted: false,
                        localStatePreserved: true,
                    },
                });
            } catch (logError) {
                console.error(
                    "[BackgroundLocation] Cloud stop log failed:",
                    logError,
                );
            }

            /*
             * Cloudの共有停止を確認できていない。
             * OS TaskとAsyncStorageは変更せず終了する。
             */
            throw cloudError;
        }
    }

    /*
     * 2. OS Taskを停止する。
     *
     * 共有していた場合はCloud停止確認後、
     * 通常記録のみの場合は直接ここへ進む。
     */
    try {
        const started = await Location.hasStartedLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
        );

        if (started) {
            await Location.stopLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );
        }

        const hasStartedAfterStop =
            await Location.hasStartedLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );

        if (hasStartedAfterStop) {
            throw new Error(
                "BACKGROUND_LOCATION_TASK_STILL_STARTED_AFTER_STOP",
            );
        }

        if (hasStartedAfterStop) {
            throw new Error(
                "BACKGROUND_LOCATION_TASK_STILL_STARTED_AFTER_STOP",
            );
        }
    } catch (stopError) {
        console.error("[BackgroundLocation] OS Task stop failed:", stopError);

        try {
            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "backgroundLocationTaskStopFailed",
                errorMessage:
                    stopError instanceof Error
                        ? stopError.message
                        : String(stopError),
                details: {
                    cloudSharingStopChecked: hasLocalSharingEvidence,
                    localStatePreserved: true,
                },
            });
        } catch (logError) {
            console.error("[BackgroundLocation] OS stop log failed:", logError);
        }

        throw stopError;
    }

    /*
     * ここに到達した場合、OS Task停止確認は成功している。
     *
     * 診断ログの失敗は停止処理の失敗と扱わない。
     */
    try {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "stopBackgroundLocationRecordingCompleted",
            hasStartedLocationUpdates: false,
            details: {
                hasStartedBeforeStop: hasStarted,
                continueLiveSharing: false,
                cloudSharingStopChecked: hasLocalSharingEvidence,
            },
        });
    } catch (logError) {
        console.error(
            "[BackgroundLocation] Stop success log failed:",
            logError,
        );
    }

    await saveTaskManagerDiagnosticSnapshot({
        userId,
        recordingSessionId,
        eventName: "taskManagerSnapshotAfterRecordingStop",
    });

    /*
     * この後の既存コードで、
     * セッション再確認 → AsyncStorage削除を実施する。
     */

    /*
     * stop処理中に新しいRecordingSessionが開始されていないか、
     * state削除直前でも再確認する。
     */
    if (expectedRecordingSessionId !== undefined) {
        const latestRaw = await AsyncStorage.getItem(
            BACKGROUND_RECORDING_STATE_KEY,
        );

        if (latestRaw) {
            try {
                const latestState = JSON.parse(
                    latestRaw,
                ) as BackgroundRecordingState;

                if (
                    (latestState.recordingSessionId ?? null) !==
                    expectedRecordingSessionId
                ) {
                    await saveBackgroundLocationDebugLog({
                        userId: latestState.userId ?? null,
                        recordingSessionId:
                            latestState.recordingSessionId ?? null,
                        eventName:
                            "backgroundRecordingStateRemoveSkippedSessionMismatch",
                        details: {
                            expectedRecordingSessionId,
                            currentRecordingSessionId:
                                latestState.recordingSessionId ?? null,
                        },
                    });

                    console.warn(
                        "[BackgroundRecordingState] Skip stale state removal:",
                        {
                            expectedRecordingSessionId,
                            currentRecordingSessionId:
                                latestState.recordingSessionId ?? null,
                        },
                    );

                    return;
                }
            } catch (error) {
                console.error(
                    "Parse background recording state before remove error:",
                    error,
                );

                /*
                 * state内容を安全に確認できない場合、
                 * 新しいsessionを誤削除するより削除しない方を優先する。
                 */
                return;
            }
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
    expectedRecordingSessionId?: string | null,
) {
    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    if (!raw) {
        return;
    }

    try {
        const state = JSON.parse(raw) as BackgroundRecordingState;

        if (
            expectedRecordingSessionId !== undefined &&
            (state.recordingSessionId ?? null) !== expectedRecordingSessionId
        ) {
            console.warn(
                "[BackgroundRecordingState] Skip stale liveLocationId update:",
                {
                    expectedRecordingSessionId,
                    currentRecordingSessionId: state.recordingSessionId ?? null,
                },
            );

            return;
        }

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
