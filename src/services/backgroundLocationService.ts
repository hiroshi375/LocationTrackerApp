// src/services/backgroundLocationService.ts

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Alert, Linking, Platform } from "react-native";
import { client } from "../lib/client";

import {
    BACKGROUND_LOCATION_TASK_NAME,
    BACKGROUND_RECORDING_STATE_KEY,
} from "../tasks/backgroundLocationTask";
import {
    getErrorMessage,
    saveBackgroundLocationDebugLog,
} from "./backgroundLocationDebugLogService";
import { clearLocationSaveLock } from "./locationLogDeduplicationService";
import { initializeRecordingContinuationState } from "./recordingContinuationService";

type BackgroundDebugLogInput = Parameters<
    typeof saveBackgroundLocationDebugLog
>[0];

async function safeSaveBackgroundLocationDebugLog(
    input: BackgroundDebugLogInput,
): Promise<void> {
    try {
        await saveBackgroundLocationDebugLog(input);
    } catch (debugLogError) {
        console.error(
            "Failed to save background location service debug log:",
            debugLogError,
        );
    }
}

export const BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED =
    "BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED";

export class BackgroundLocationPermissionError extends Error {
    code = BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED;

    constructor() {
        super(BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED);
        this.name = "BackgroundLocationPermissionError";
    }
}

export function isBackgroundLocationPermissionError(error: unknown) {
    return (
        error instanceof BackgroundLocationPermissionError ||
        (error instanceof Error &&
            error.message === BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED)
    );
}

type StartBackgroundLocationTrackingParams = {
    userId: string;

    isRecording: boolean;
    recordingSessionId?: string | null;
    startedAt?: string | null;

    intervalMs: number;
    distanceMeters: number;

    liveShareOwnerValues?: string[];
    liveLocationId?: string | null;

    lastSavedLocation?: {
        latitude: number;
        longitude: number;
        recordedAt: number;
        accuracy?: number | null;
    } | null;
};

export type BackgroundRecordingState = {
    userId: string;

    /*
     * trueの場合だけLocationLogを保存する。
     */
    isRecording: boolean;

    /*
     * 非記録中の共有ではnull。
     */
    recordingSessionId?: string | null;
    startedAt?: string | null;

    liveShareOwnerValues: string[];
    liveLocationId?: string | null;

    lastSavedLocation?: {
        latitude: number;
        longitude: number;
        recordedAt: number;
        accuracy?: number | null;
    } | null;

    /*
     * ネットワーク遅延などで古い位置情報が後から届いた場合に、
     * その古い時系列内で30秒/距離条件を判定するための基準地点。
     */
    lastOutOfOrderLocation?: {
        latitude: number;
        longitude: number;
        recordedAt: number;
        accuracy?: number | null;
    } | null;

    intervalMs: number;
    distanceMeters: number;
};

export async function getBackgroundRecordingState(): Promise<BackgroundRecordingState | null> {
    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw) as Partial<BackgroundRecordingState>;

        if (!parsed.userId) {
            return null;
        }

        /*
         * 旧形式のAsyncStorageデータとの互換性を保つ。
         *
         * 旧データにはisRecordingがないため、
         * recordingSessionIdの有無から自動記録状態を推定する。
         */
        const normalizedState: BackgroundRecordingState = {
            userId: parsed.userId,

            isRecording:
                typeof parsed.isRecording === "boolean"
                    ? parsed.isRecording
                    : Boolean(parsed.recordingSessionId),

            recordingSessionId: parsed.recordingSessionId ?? null,

            startedAt: parsed.startedAt ?? null,

            liveShareOwnerValues: Array.isArray(parsed.liveShareOwnerValues)
                ? Array.from(
                      new Set(
                          parsed.liveShareOwnerValues.filter(
                              (value): value is string =>
                                  typeof value === "string" && value.length > 0,
                          ),
                      ),
                  )
                : [],

            liveLocationId: parsed.liveLocationId ?? null,

            lastSavedLocation: parsed.lastSavedLocation ?? null,

            lastOutOfOrderLocation: parsed.lastOutOfOrderLocation ?? null,

            intervalMs:
                typeof parsed.intervalMs === "number" &&
                Number.isFinite(parsed.intervalMs) &&
                parsed.intervalMs > 0
                    ? parsed.intervalMs
                    : 30_000,

            distanceMeters:
                typeof parsed.distanceMeters === "number" &&
                Number.isFinite(parsed.distanceMeters) &&
                parsed.distanceMeters > 0
                    ? parsed.distanceMeters
                    : 50,
        };

        return normalizedState;
    } catch (error) {
        console.error("Parse background recording state error:", error);

        return null;
    }
}

function shouldRestartBackgroundLocationUpdates(
    hasStarted: boolean,
    previousState: BackgroundRecordingState | null,
    nextState: BackgroundRecordingState,
): boolean {
    if (!hasStarted) {
        return false;
    }

    return (
        previousState?.isRecording !== nextState.isRecording ||
        previousState?.recordingSessionId !== nextState.recordingSessionId ||
        previousState?.intervalMs !== nextState.intervalMs ||
        previousState?.distanceMeters !== nextState.distanceMeters
    );
}

export async function startBackgroundLocationTracking({
    userId,
    isRecording,
    recordingSessionId = null,
    startedAt = null,
    intervalMs,
    distanceMeters,
    liveShareOwnerValues = [],
    liveLocationId,
    lastSavedLocation,
}: StartBackgroundLocationTrackingParams) {
    const normalizedLiveShareOwnerValues = Array.from(
        new Set(liveShareOwnerValues.filter(Boolean)),
    );

    const startDebugDetails = {
        isRecording,
        intervalMs,
        distanceMeters,
        sharedOwnersCount: normalizedLiveShareOwnerValues.length,
        hasRecordingSessionId: Boolean(recordingSessionId),
        hasStartedAt: Boolean(startedAt),
        hasLiveLocationId: Boolean(liveLocationId),
        hasLastSavedLocation: Boolean(lastSavedLocation),
    };

    try {
        /*
         * 自動記録も共有もしていない場合は追跡不要。
         */
        if (!isRecording && normalizedLiveShareOwnerValues.length === 0) {
            await safeSaveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "backgroundLocationTrackingSkippedNoPurpose",
                details: startDebugDetails,
            });

            await stopBackgroundLocationTracking();
            return;
        }

        await ensureBackgroundLocationPermission(
            userId,
            recordingSessionId ?? undefined,
        );

        await safeSaveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationStartPermissionGranted",
            details: startDebugDetails,
        });

        const previousState = await getBackgroundRecordingState();

        const isNewRecordingSession =
            isRecording &&
            Boolean(recordingSessionId) &&
            recordingSessionId !== previousState?.recordingSessionId;

        /*
         * 新しい自動記録セッション開始時は、
         * 前セッションの古いロックを除去する。
         */
        if (isNewRecordingSession && recordingSessionId) {
            await clearLocationSaveLock();

            await initializeRecordingContinuationState(
                recordingSessionId,
                startedAt ?? new Date().toISOString(),
            );
        }

        const nextState: BackgroundRecordingState = {
            userId,
            isRecording,
            recordingSessionId,
            startedAt,
            intervalMs,
            distanceMeters,
            liveShareOwnerValues: normalizedLiveShareOwnerValues,

            liveLocationId:
                liveLocationId !== undefined
                    ? liveLocationId
                    : (previousState?.liveLocationId ?? null),

            /*
             * 新規セッション開始時は、
             * 前セッションの最終保存地点を引き継がない。
             */
            lastSavedLocation: isNewRecordingSession
                ? null
                : lastSavedLocation !== undefined
                  ? lastSavedLocation
                  : (previousState?.lastSavedLocation ?? null),

            lastOutOfOrderLocation: isNewRecordingSession
                ? null
                : (previousState?.lastOutOfOrderLocation ?? null),
        };

        await AsyncStorage.setItem(
            BACKGROUND_RECORDING_STATE_KEY,
            JSON.stringify(nextState),
        );

        await safeSaveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationStateSaved",
            details: {
                ...startDebugDetails,
                isNewRecordingSession,
                previousRecordingSessionId:
                    previousState?.recordingSessionId ?? null,
                nextRecordingSessionId: nextState.recordingSessionId ?? null,
                hasPreviousState: Boolean(previousState),
                hasNextLastSavedLocation: Boolean(nextState.lastSavedLocation),
            },
        });

        const isTaskDefined = TaskManager.isTaskDefined(
            BACKGROUND_LOCATION_TASK_NAME,
        );

        if (!isTaskDefined) {
            throw new Error(
                `Background location task is not defined: ${BACKGROUND_LOCATION_TASK_NAME}`,
            );
        }

        const hasStarted = await Location.hasStartedLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
        );

        const shouldRestartByState = shouldRestartBackgroundLocationUpdates(
            hasStarted,
            previousState,
            nextState,
        );

        /*
         * 新しい記録セッションでは、OS側に古い登録が残っていても
         * 必ず停止・再登録する。
         */
        const shouldRestart =
            hasStarted && (isNewRecordingSession || shouldRestartByState);

        await safeSaveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationNativeStatusChecked",
            hasStartedLocationUpdates: hasStarted,
            details: {
                ...startDebugDetails,
                isTaskDefined,
                isNewRecordingSession,
                shouldRestartByState,
                shouldRestart,
                previousIsRecording: previousState?.isRecording ?? null,
                previousRecordingSessionId:
                    previousState?.recordingSessionId ?? null,
                previousIntervalMs: previousState?.intervalMs ?? null,
                previousDistanceMeters: previousState?.distanceMeters ?? null,
            },
        });

        if (shouldRestart) {
            await Location.stopLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );

            await safeSaveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "backgroundLocationUpdatesStoppedForRestart",
                hasStartedLocationUpdates: false,
                details: {
                    isNewRecordingSession,
                    shouldRestartByState,
                },
            });
        }

        if (hasStarted && !shouldRestart) {
            await safeSaveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "backgroundLocationTrackingAlreadyStarted",
                hasStartedLocationUpdates: true,
                details: {
                    ...startDebugDetails,
                    isTaskDefined,
                },
            });

            return;
        }

        /*
         * iOSではtimeIntervalが位置更新条件として使用されないため、
         * native側のdistanceIntervalを小さくして位置を受け取り、
         * 30秒または指定距離の判定はアプリ側で行う。
         */
        const nativeDistanceInterval =
            Platform.OS === "ios"
                ? Math.min(distanceMeters, 5)
                : distanceMeters;

        await Location.startLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
            {
                accuracy: Location.Accuracy.BestForNavigation,
                timeInterval: intervalMs,
                distanceInterval: nativeDistanceInterval,
                activityType: Location.ActivityType.Fitness,
                pausesUpdatesAutomatically: false,
                deferredUpdatesInterval: 0,
                deferredUpdatesDistance: 0,
                showsBackgroundLocationIndicator: true,
                foregroundService: {
                    notificationTitle: isRecording
                        ? "位置情報を記録中"
                        : "現在地を共有中",
                    notificationBody: isRecording
                        ? "自動記録をバックグラウンドで継続しています"
                        : "現在地のリアルタイム共有を継続しています",
                    notificationColor: "#4b6f8f",
                },
            },
        );

        const hasStartedAfterStart =
            await Location.hasStartedLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );

        await safeSaveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationTrackingStarted",
            hasStartedLocationUpdates: hasStartedAfterStart,
            details: {
                ...startDebugDetails,
                isTaskDefined,
                isNewRecordingSession,
                restartedExistingRegistration: shouldRestart,
                nativeDistanceInterval,
            },
        });

        if (!hasStartedAfterStart) {
            throw new Error(
                "Background location updates did not become active after startLocationUpdatesAsync.",
            );
        }
    } catch (error) {
        const errorMessage = getErrorMessage(error);

        console.error("Start background location tracking error:", error);

        await safeSaveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "backgroundLocationTrackingStartFailed",
            errorMessage,
            details: {
                ...startDebugDetails,
                errorName: error instanceof Error ? error.name : typeof error,
                errorStack:
                    error instanceof Error ? (error.stack ?? null) : null,
            },
        });

        throw error;
    }
}

type StartBackgroundLocationRecordingParams = Omit<
    StartBackgroundLocationTrackingParams,
    "isRecording"
>;

/*
 * 既存のuseForegroundLocationRecorderからの呼び出しを維持するための
 * 互換関数。
 */
export async function startBackgroundLocationRecording(
    params: StartBackgroundLocationRecordingParams,
) {
    return startBackgroundLocationTracking({
        ...params,
        isRecording: true,
    });
}

export async function updateBackgroundLocationTrackingState(
    updates: Partial<BackgroundRecordingState>,
) {
    const currentState = await getBackgroundRecordingState();

    if (!currentState) {
        return;
    }

    const updatedLiveShareOwnerValues =
        updates.liveShareOwnerValues !== undefined
            ? Array.from(
                  new Set(
                      updates.liveShareOwnerValues.filter(
                          (value): value is string =>
                              typeof value === "string" && value.length > 0,
                      ),
                  ),
              )
            : currentState.liveShareOwnerValues;

    const nextState: BackgroundRecordingState = {
        ...currentState,
        ...updates,
        liveShareOwnerValues: updatedLiveShareOwnerValues,
    };

    await AsyncStorage.setItem(
        BACKGROUND_RECORDING_STATE_KEY,
        JSON.stringify(nextState),
    );
}

export async function stopBackgroundLocationTracking() {
    const state = await getBackgroundRecordingState();

    try {
        const hasStarted = await Location.hasStartedLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
        );

        if (hasStarted) {
            await Location.stopLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );
        }
    } catch (error) {
        console.error("Stop background location updates error:", error);
    }

    if (state?.liveLocationId) {
        try {
            const result = await client.models.LiveLocation.update({
                id: state.liveLocationId,
                isActive: false,
                isRecording: false,
                recordingSessionId: null,
                updatedAt: new Date().toISOString(),
            });

            if (result.errors) {
                console.error("Deactivate LiveLocation errors:", result.errors);
            }
        } catch (error) {
            console.error("Deactivate LiveLocation error:", error);
        }
    }

    await AsyncStorage.removeItem(BACKGROUND_RECORDING_STATE_KEY);
    await clearLocationSaveLock();
}

export async function stopBackgroundLocationRecording() {
    const state = await getBackgroundRecordingState();

    if (!state) {
        return;
    }

    const normalizedLiveShareOwnerValues = Array.isArray(
        state.liveShareOwnerValues,
    )
        ? state.liveShareOwnerValues.filter(Boolean)
        : [];

    const shouldContinueLiveSharing = normalizedLiveShareOwnerValues.length > 0;

    /*
     * 共有中の場合はバックグラウンド位置監視を止めず、
     * 自動記録状態だけを解除する。
     */
    if (shouldContinueLiveSharing) {
        await updateBackgroundLocationTrackingState({
            isRecording: false,
            recordingSessionId: null,
            startedAt: null,
            lastSavedLocation: null,
            lastOutOfOrderLocation: null,
            liveShareOwnerValues: normalizedLiveShareOwnerValues,
        });

        /*
         * 共有先には引き続き表示するが、
         * 自動記録中ではない状態へ変更する。
         */
        if (state.liveLocationId) {
            const result = await client.models.LiveLocation.update({
                id: state.liveLocationId,
                isRecording: false,
                recordingSessionId: null,
                isActive: true,
                updatedAt: new Date().toISOString(),
                sharedOwners: normalizedLiveShareOwnerValues,
            });

            if (result.errors) {
                console.error(
                    "Stop recording LiveLocation update errors:",
                    result.errors,
                );
            }
        }

        await clearLocationSaveLock();
        return;
    }

    await stopBackgroundLocationTracking();
}

export async function ensureBackgroundLocationPermission(
    userId?: string | null,
    recordingSessionId?: string | null,
) {
    const foregroundPermission =
        await Location.requestForegroundPermissionsAsync();

    await safeSaveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "foregroundPermissionChecked",
        foregroundPermissionStatus: foregroundPermission.status,
        foregroundPermissionGranted: foregroundPermission.granted,
        foregroundPermissionCanAskAgain: foregroundPermission.canAskAgain,
    });

    if (foregroundPermission.status !== Location.PermissionStatus.GRANTED) {
        Alert.alert(
            "位置情報の許可が必要です",
            "自動記録を使うには、位置情報の使用を許可してください。",
        );

        throw new Error("FOREGROUND_LOCATION_PERMISSION_NOT_GRANTED");
    }

    let backgroundPermission = await Location.getBackgroundPermissionsAsync();

    await safeSaveBackgroundLocationDebugLog({
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

    backgroundPermission = await Location.requestBackgroundPermissionsAsync();

    await safeSaveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "backgroundPermissionRequested",
        backgroundPermissionStatus: backgroundPermission.status,
        backgroundPermissionGranted: backgroundPermission.granted,
        backgroundPermissionCanAskAgain: backgroundPermission.canAskAgain,
    });

    if (backgroundPermission.status === Location.PermissionStatus.GRANTED) {
        return;
    }

    Alert.alert(
        "位置情報の「常に許可」が必要です",
        "自動記録または現在地共有をバックグラウンドでも継続するには、端末の設定で位置情報を「常に許可」に変更してください。変更後はアプリに戻り、もう一度操作してください。",
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
    await updateBackgroundLocationTrackingState({
        liveLocationId,
    });
}

export async function getBackgroundRecordingStatus(): Promise<{
    hasStarted: boolean;
    state: BackgroundRecordingState | null;
}> {
    const hasStarted = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    );

    const state = await getBackgroundRecordingState();

    return {
        hasStarted,
        state,
    };
}

export async function updateBackgroundRecordingLastSavedLocation(lastSavedLocation: {
    latitude: number;
    longitude: number;
    recordedAt: number;
    accuracy?: number | null;
}) {
    const currentState = await getBackgroundRecordingState();

    if (!currentState) {
        return;
    }

    /*
     * 後追いで届いた古い地点により、最新の保存基準時刻を巻き戻さない。
     */
    if (
        currentState.lastSavedLocation &&
        lastSavedLocation.recordedAt < currentState.lastSavedLocation.recordedAt
    ) {
        return;
    }

    await updateBackgroundLocationTrackingState({
        lastSavedLocation,
    });
}
