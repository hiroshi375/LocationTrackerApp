// src/services/backgroundLocationService.ts

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { Alert, Linking, Platform } from "react-native";
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
 * heartbeatを併用して、callbackの停止や異常を診断する。
 *
 * 異常を検出しても、ここからTaskの停止・再登録は行わない。
 */
const BACKGROUND_TASK_HEALTH_MIN_STALE_MS = 60_000;
const BACKGROUND_TASK_HEALTH_MAX_STALE_MS = 180_000;

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

    if (hasStartedBeforeRestart) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "restartBackgroundLocationUpdatesForRecordingStarted",
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
            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "stopExistingLocationUpdatesBeforeRecordingFailed",
                hasStartedLocationUpdates: true,
                errorMessage:
                    error instanceof Error ? error.message : String(error),
            });

            /*
             * 既存taskを停止できていない状態では、
             * 同じtask名で新たにstartしない。
             */
            throw error;
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
     * startLocationUpdatesAsync直後にcallbackが到着しても、
     * backgroundLocationTaskが新しいRecordingSessionを読めるよう、
     * task開始前にstateを保存する。
     */
    await AsyncStorage.setItem(
        BACKGROUND_RECORDING_STATE_KEY,
        JSON.stringify(nextState),
    );

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
         * 重要:
         *
         * heartbeatを使ったstartup recoveryやcold restartは行わない。
         *
         * heartbeatは診断情報としてのみ使用し、
         * 自動記録開始の成否判定には使用しない。
         *
         */
    } catch (error) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "startLocationUpdatesFailed",
            hasStartedLocationUpdates: await safeHasStartedLocationUpdates(),
            errorMessage:
                error instanceof Error ? error.message : String(error),
            details: {
                restartedExistingTask: hasStartedBeforeRestart,
                restoringPreviousState: Boolean(previousState),
            },
        });

        /*
         * 新しい自動記録stateだけが残ると、
         * 画面上は記録中なのにtaskが開始できていない状態になる。
         *
         * 起動失敗時には以前のstateへ戻す。
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
         * 開始前が現在地共有状態だった場合、
         * 自動記録開始のために既存taskを停止している可能性がある。
         *
         * その場合だけ共有用background taskを復旧する。
         *
         * この復旧に失敗しても、
         * 元の自動記録開始エラーを優先してthrowする。
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
