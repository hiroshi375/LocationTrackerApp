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

type StartBackgroundLocationRecordingParams = {
    userId: string;
    recordingSessionId: string;
    startedAt?: string | null;
    intervalMs: number;
    distanceMeters: number;
    liveShareOwnerValues?: string[];
    lastSavedLocation?: {
        latitude: number;
        longitude: number;
        recordedAt: number;
    } | null;
};

export type BackgroundRecordingState = {
    userId: string;
    recordingSessionId: string;
    startedAt?: string | null;
    liveShareOwnerValues?: string[];
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

export async function startBackgroundLocationRecording({
    userId,
    recordingSessionId,
    startedAt = null,
    intervalMs,
    distanceMeters,
    liveShareOwnerValues = [],
    lastSavedLocation = null,
}: StartBackgroundLocationRecordingParams) {
    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "startBackgroundLocationRecordingCalled",
        details: {
            startedAt,
            intervalMs,
            distanceMeters,
            liveShareOwnerValues,
            hasLastSavedLocation: Boolean(lastSavedLocation),
        },
    });

    await ensureBackgroundLocationPermission(userId, recordingSessionId);

    await AsyncStorage.setItem(
        BACKGROUND_RECORDING_STATE_KEY,
        JSON.stringify({
            userId,
            recordingSessionId,
            startedAt,
            intervalMs,
            distanceMeters,
            liveShareOwnerValues: Array.from(new Set(liveShareOwnerValues)),
            liveLocationId: null,
            lastSavedLocation,
        }),
    );

    const hasStarted = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    );

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "hasStartedLocationUpdatesCheckedBeforeStart",
        hasStartedLocationUpdates: hasStarted,
    });

    if (hasStarted) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "startBackgroundLocationRecordingSkippedAlreadyStarted",
            hasStartedLocationUpdates: hasStarted,
        });

        return;
    }

    try {
        await Location.startLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK_NAME,
            {
                accuracy: Location.Accuracy.Balanced,
                timeInterval: intervalMs,
                distanceInterval: distanceMeters,
                deferredUpdatesInterval: intervalMs,
                deferredUpdatesDistance: distanceMeters,
                pausesUpdatesAutomatically: false,
                showsBackgroundLocationIndicator: true,
                foregroundService: {
                    notificationTitle: "位置情報を記録中",
                    notificationBody:
                        "自動記録をバックグラウンドで継続しています",
                    notificationColor: "#4b6f8f",
                },
            },
        );
    } catch (error) {
        await saveBackgroundLocationDebugLog({
            userId,
            recordingSessionId,
            eventName: "startLocationUpdatesFailed",
            errorMessage:
                error instanceof Error ? error.message : String(error),
        });

        throw error;
    }

    const hasStartedAfterStart = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    );

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "startBackgroundLocationRecordingCompleted",
        hasStartedLocationUpdates: hasStartedAfterStart,
    });
}

export async function stopBackgroundLocationRecording() {
    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    let recordingSessionId: string | null = null;
    let userId: string | null = null;
    let liveLocationId: string | null = null;

    if (raw) {
        try {
            const state = JSON.parse(raw) as BackgroundRecordingState;

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
    });

    const hasStarted = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    );

    await saveBackgroundLocationDebugLog({
        userId,
        recordingSessionId,
        eventName: "hasStartedLocationUpdatesCheckedBeforeStop",
        hasStartedLocationUpdates: hasStarted,
    });

    if (hasStarted) {
        try {
            await Location.stopLocationUpdatesAsync(
                BACKGROUND_LOCATION_TASK_NAME,
            );
        } catch (error) {
            await saveBackgroundLocationDebugLog({
                userId,
                recordingSessionId,
                eventName: "stopLocationUpdatesFailed",
                errorMessage:
                    error instanceof Error ? error.message : String(error),
            });

            throw error;
        }
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
        },
    });

    if (liveLocationId) {
        try {
            await client.models.LiveLocation.update({
                id: liveLocationId,
                isActive: false,
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
        "バックグラウンドで自動記録を続けるには、端末の設定で位置情報を「常に許可」に変更してください。変更後はアプリに戻り、もう一度「自動記録開始」を押してください。",
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

export async function updateBackgroundRecordingLastSavedLocation(lastSavedLocation: {
    latitude: number;
    longitude: number;
    recordedAt: number;
}) {
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
                lastSavedLocation,
            }),
        );
    } catch (error) {
        console.error("Update background lastSavedLocation error:", error);
    }
}
