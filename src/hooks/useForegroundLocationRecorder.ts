import { getCurrentUser } from "aws-amplify/auth";
import * as Location from "expo-location";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

import { client } from "../lib/client";

type SavedLocation = {
    latitude: number;
    longitude: number;
    recordedAt: number;
};

type RecorderOptions = {
    intervalMs: number;
    distanceMeters: number;
};

export function useForegroundLocationRecorder({
    intervalMs,
    distanceMeters,
}: RecorderOptions) {
    const [isRecording, setIsRecording] = useState(false);
    const [recordingStartedAt, setRecordingStartedAt] = useState<string | null>(
        null,
    );

    const subscriptionRef = useRef<Location.LocationSubscription | null>(null);
    const lastSavedLocationRef = useRef<SavedLocation | null>(null);
    const recordingSessionIdRef = useRef<string | null>(null);

    const [activeRecordingSessionId, setActiveRecordingSessionId] = useState<
        string | null
    >(null);

    // 位置を保存すべきか判定する関数
    const shouldSaveLocation = useCallback(
        (latitude: number, longitude: number) => {
            const last = lastSavedLocationRef.current;

            if (!last) {
                return true;
            }

            const distance = calculateDistanceMeters(
                last.latitude,
                last.longitude,
                latitude,
                longitude,
            );

            const elapsedMs = Date.now() - last.recordedAt;

            return distance >= distanceMeters || elapsedMs >= intervalMs;
        },
        [distanceMeters, intervalMs],
    );

    // 位置を保存する関数
    const saveLocationLog = useCallback(
        async (
            location: Location.LocationObject,
            forceSave: boolean = false,
        ) => {
            const latitude = location.coords.latitude;
            const longitude = location.coords.longitude;

            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                return;
            }

            if (!forceSave && !shouldSaveLocation(latitude, longitude)) {
                return;
            }

            try {
                const currentUser = await getCurrentUser();

                const recordedAt = new Date().toISOString();

                const result = await client.models.LocationLog.create({
                    userId: currentUser.userId,
                    latitude,
                    longitude,
                    accuracy: location.coords.accuracy ?? null,
                    recordedAt,
                    memo: "自動記録",
                    recordingSessionId: recordingSessionIdRef.current,
                });

                if (result.errors) {
                    console.error(
                        "Auto LocationLog create errors:",
                        result.errors,
                    );
                    return;
                }

                lastSavedLocationRef.current = {
                    latitude,
                    longitude,
                    recordedAt: Date.now(),
                };

                //setLastRecordedAtText(formatDateTime(recordedAt));

                console.log("Auto location saved:", {
                    latitude,
                    longitude,
                    recordedAt,
                });
            } catch (error) {
                console.error("Auto LocationLog create error:", error);
            }
        },
        [shouldSaveLocation],
    );

    // 記録開始関数
    const startRecording = useCallback(async () => {
        if (subscriptionRef.current) {
            return;
        }

        const foregroundPermission =
            await Location.requestForegroundPermissionsAsync();

        if (foregroundPermission.status !== "granted") {
            Alert.alert(
                "位置情報の許可が必要です",
                "自動記録を使うには位置情報の許可が必要です。",
            );
            return;
        }

        const newSessionId = createRecordingSessionId();

        recordingSessionIdRef.current = newSessionId;
        setActiveRecordingSessionId(newSessionId);
        lastSavedLocationRef.current = null;

        const startedAt = new Date().toISOString();
        setRecordingStartedAt(startedAt);

        const currentLocation = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
        });

        await saveLocationLog(currentLocation, true);

        const subscription = await Location.watchPositionAsync(
            {
                accuracy: Location.Accuracy.Balanced,
                timeInterval: intervalMs,
                distanceInterval: distanceMeters,
            },
            async (location) => {
                await saveLocationLog(location);
            },
        );

        subscriptionRef.current = subscription;
        setIsRecording(true);
    }, [distanceMeters, intervalMs, saveLocationLog]);

    // 記録停止関数
    const stopRecording = useCallback(async (): Promise<string | null> => {
        const finishedSessionId = recordingSessionIdRef.current;

        subscriptionRef.current?.remove();
        subscriptionRef.current = null;

        if (recordingSessionIdRef.current) {
            try {
                const currentLocation = await Location.getCurrentPositionAsync({
                    accuracy: Location.Accuracy.Balanced,
                });

                await saveLocationLog(currentLocation, true);
            } catch (error) {
                console.error("Save stop location error:", error);
            }
        }

        recordingSessionIdRef.current = null;
        setActiveRecordingSessionId(null);
        setRecordingStartedAt(null);
        setIsRecording(false);

        return finishedSessionId;
    }, [saveLocationLog]);

    useEffect(() => {
        return () => {
            subscriptionRef.current?.remove();
            subscriptionRef.current = null;
        };
    }, []);

    return {
        isRecording,
        //lastRecordedAtText,
        recordingStartedAt,
        activeRecordingSessionId,
        startRecording,
        stopRecording,
    };
}

function calculateDistanceMeters(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
) {
    const earthRadiusMeters = 6371000;

    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadians(lat1)) *
            Math.cos(toRadians(lat2)) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return earthRadiusMeters * c;
}

function toRadians(value: number) {
    return (value * Math.PI) / 180;
}

function createRecordingSessionId() {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
