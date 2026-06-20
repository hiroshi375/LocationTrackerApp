// src/services/backgroundLocationService.ts

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { Alert, Linking } from "react-native";

import {
    BACKGROUND_LOCATION_TASK_NAME,
    BACKGROUND_RECORDING_STATE_KEY,
} from "../tasks/backgroundLocationTask";

export const BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED =
    "BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED";

type StartBackgroundLocationRecordingParams = {
    userId: string;
    recordingSessionId: string;
    intervalMs: number;
    distanceMeters: number;
    liveShareOwnerValue?: string | null;
    lastSavedLocation?: {
        latitude: number;
        longitude: number;
        recordedAt: number;
    } | null;
};

export async function startBackgroundLocationRecording({
    userId,
    recordingSessionId,
    intervalMs,
    distanceMeters,
    liveShareOwnerValue = null,
    lastSavedLocation = null,
}: StartBackgroundLocationRecordingParams) {
    await ensureBackgroundLocationPermission();
    await AsyncStorage.setItem(
        BACKGROUND_RECORDING_STATE_KEY,
        JSON.stringify({
            userId,
            recordingSessionId,
            intervalMs,
            distanceMeters,
            liveShareOwnerValue,
            lastSavedLocation,
        }),
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
            notificationTitle: "位置情報を記録中",
            notificationBody: "アプリを閉じていても自動記録を継続しています。",
        },
    });
}

export async function stopBackgroundLocationRecording() {
    const hasStarted = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK_NAME,
    );

    if (hasStarted) {
        await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK_NAME);
    }

    await AsyncStorage.removeItem(BACKGROUND_RECORDING_STATE_KEY);
}

export async function ensureBackgroundLocationPermission() {
    const foregroundPermission =
        await Location.requestForegroundPermissionsAsync();

    if (foregroundPermission.status !== "granted") {
        Alert.alert(
            "位置情報の許可が必要です",
            "自動記録を使うには、位置情報の使用を許可してください。",
        );

        throw new Error("FOREGROUND_LOCATION_PERMISSION_NOT_GRANTED");
    }

    let backgroundPermission = await Location.getBackgroundPermissionsAsync();

    if (backgroundPermission.status === "granted") {
        return;
    }

    backgroundPermission = await Location.requestBackgroundPermissionsAsync();

    if (backgroundPermission.status === "granted") {
        return;
    }

    Alert.alert(
        "位置情報の「常に許可」が必要です",
        "バックグラウンドで自動記録を続けるには、端末の設定で位置情報を「常に許可」に変更してください。",
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

    throw new Error(BACKGROUND_LOCATION_PERMISSION_NOT_GRANTED);
}
