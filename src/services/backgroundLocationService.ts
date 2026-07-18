// src/services/backgroundLocationService.ts

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { Alert, Linking } from "react-native";
import { client } from "../lib/client";

import {
    BACKGROUND_LOCATION_TASK_NAME,
    BACKGROUND_RECORDING_STATE_KEY,
} from "../tasks/backgroundLocationTask";
import { saveBackgroundLocationDebugLog } from "./backgroundLocationDebugLogService";

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

            intervalMs:
                typeof parsed.intervalMs === "number" &&
                Number.isFinite(parsed.intervalMs) &&
                parsed.intervalMs > 0
                    ? parsed.intervalMs
                    : 60_000,

            distanceMeters:
                typeof parsed.distanceMeters === "number" &&
                Number.isFinite(parsed.distanceMeters) &&
                parsed.distanceMeters > 0
                    ? parsed.distanceMeters
                    : 100,
        };

        return normalizedState;
    } catch (error) {
        console.error("Parse background recording state error:", error);

        return null;
    }
}

export async function startBackgroundLocationTracking({
    userId,
    isRecording,
    recordingSessionId = null,
    startedAt = null,
    intervalMs,
    distanceMeters,
    liveShareOwnerValues = [],
    liveLocationId = null,
    lastSavedLocation = null,
}: StartBackgroundLocationTrackingParams) {
    const normalizedLiveShareOwnerValues = Array.from(
        new Set(liveShareOwnerValues.filter(Boolean)),
    );

    /*
     * 自動記録も共有もしていない場合は追跡不要。
     */
    if (!isRecording && normalizedLiveShareOwnerValues.length === 0) {
        await stopBackgroundLocationTracking();
        return;
    }

    await ensureBackgroundLocationPermission(
        userId,
        recordingSessionId ?? undefined,
    );

    const previousState = await getBackgroundRecordingState();

    const nextState: BackgroundRecordingState = {
        userId,
        isRecording,
        recordingSessionId,
        startedAt,
        intervalMs,
        distanceMeters,
        liveShareOwnerValues: normalizedLiveShareOwnerValues,
        liveLocationId: liveLocationId ?? previousState?.liveLocationId ?? null,
        lastSavedLocation:
            lastSavedLocation ?? previousState?.lastSavedLocation ?? null,
    };

    await AsyncStorage.setItem(
        BACKGROUND_RECORDING_STATE_KEY,
        JSON.stringify(nextState),
    );

    const hasStarted = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    );

    if (hasStarted) {
        return;
    }

    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: intervalMs,
        distanceInterval: distanceMeters,
        deferredUpdatesInterval: intervalMs,
        deferredUpdatesDistance: distanceMeters,
        pausesUpdatesAutomatically: false,
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
    });
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

    await saveBackgroundLocationDebugLog({
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

    backgroundPermission = await Location.requestBackgroundPermissionsAsync();

    await saveBackgroundLocationDebugLog({
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
    await updateBackgroundLocationTrackingState({
        lastSavedLocation,
    });
}
