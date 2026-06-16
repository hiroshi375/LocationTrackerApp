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
    liveShareOwnerValue?: string | null;
};

type LiveLocationMutationResult = {
    data?: {
        id?: string | null;
    } | null;
    errors?: unknown;
};

export function useForegroundLocationRecorder({
    intervalMs,
    distanceMeters,
    liveShareOwnerValue = null,
}: RecorderOptions) {
    const [isRecording, setIsRecording] = useState(false);
    const [recordingStartedAt, setRecordingStartedAt] = useState<string | null>(
        null,
    );

    const subscriptionRef = useRef<Location.LocationSubscription | null>(null);
    const lastSavedLocationRef = useRef<SavedLocation | null>(null);
    const recordingSessionIdRef = useRef<string | null>(null);
    const liveLocationIdRef = useRef<string | null>(null);

    const [activeRecordingSessionId, setActiveRecordingSessionId] = useState<
        string | null
    >(null);

    const startLocationRef = useRef<{
        latitude: number;
        longitude: number;
    } | null>(null);

    const [distanceFromStartMeters, setDistanceFromStartMeters] = useState<
        number | null
    >(null);

    // 位置を保存すべきか判定する関数
    const shouldSaveLocation = useCallback(
        (latitude: number, longitude: number) => {
            if (!lastSavedLocationRef.current) {
                return true;
            }

            const elapsedMs =
                Date.now() - lastSavedLocationRef.current.recordedAt;

            const distance = calculateDistanceMeters(
                lastSavedLocationRef.current.latitude,
                lastSavedLocationRef.current.longitude,
                latitude,
                longitude,
            );

            if (elapsedMs >= intervalMs) {
                return true;
            }

            if (distance >= distanceMeters) {
                return true;
            }

            return false;
        },
        [intervalMs, distanceMeters],
    );

    //
    const updateDistanceFromStart = useCallback(
        (location: Location.LocationObject) => {
            const startLocation = startLocationRef.current;

            if (!startLocation) {
                return;
            }

            const currentLocation = {
                latitude: location.coords.latitude,
                longitude: location.coords.longitude,
            };

            const distance = calculateDistanceMeters(
                startLocation.latitude,
                startLocation.longitude,
                currentLocation.latitude,
                currentLocation.longitude,
            );

            setDistanceFromStartMeters(distance);
        },
        [],
    );

    //
    const updateLiveLocation = useCallback(
        async (location: Location.LocationObject) => {
            if (!liveShareOwnerValue) {
                return;
            }

            const recordingSessionId = recordingSessionIdRef.current;

            if (!recordingSessionId) {
                return;
            }

            const latitude = location.coords.latitude;
            const longitude = location.coords.longitude;

            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                return;
            }

            try {
                const liveLocationModel = client.models.LiveLocation as any;

                const currentUser = await getCurrentUser();
                const updatedAt = new Date().toISOString();

                const payload = {
                    userId: currentUser.userId,
                    recordingSessionId,
                    latitude,
                    longitude,
                    accuracy: location.coords.accuracy ?? null,
                    updatedAt,
                    isActive: true,
                    sharedOwners: [liveShareOwnerValue],
                };

                if (liveLocationIdRef.current) {
                    const result = (await liveLocationModel.update({
                        id: liveLocationIdRef.current,
                        ...payload,
                    })) as LiveLocationMutationResult;

                    if (result.errors) {
                        console.error(
                            "LiveLocation update errors:",
                            result.errors,
                        );
                    }

                    return;
                }

                const result = (await liveLocationModel.create(
                    payload,
                )) as LiveLocationMutationResult;

                if (result.errors) {
                    console.error("LiveLocation create errors:", result.errors);
                    return;
                }

                liveLocationIdRef.current = result.data?.id ?? null;
            } catch (error) {
                console.error("LiveLocation update error:", error);
            }
        },
        [liveShareOwnerValue],
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

            updateDistanceFromStart(location);

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

                console.log("Auto location saved:", {
                    latitude,
                    longitude,
                    recordedAt,
                });
            } catch (error) {
                console.error("Auto LocationLog create error:", error);
            }
        },
        [shouldSaveLocation, updateDistanceFromStart],
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

        startLocationRef.current = {
            latitude: currentLocation.coords.latitude,
            longitude: currentLocation.coords.longitude,
        };

        setDistanceFromStartMeters(0);

        await updateLiveLocation(currentLocation);
        await saveLocationLog(currentLocation, true);

        const subscription = await Location.watchPositionAsync(
            {
                accuracy: Location.Accuracy.Balanced,
                timeInterval: 2000,
                distanceInterval: 1,
            },
            async (location) => {
                await updateLiveLocation(location);
                await saveLocationLog(location);
            },
        );

        subscriptionRef.current = subscription;
        setIsRecording(true);
    }, [saveLocationLog, updateLiveLocation]);

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

                await updateLiveLocation(currentLocation);
                await saveLocationLog(currentLocation, true);
            } catch (error) {
                console.error("Save stop location error:", error);
            }
        }

        if (liveLocationIdRef.current) {
            try {
                await client.models.LiveLocation.update({
                    id: liveLocationIdRef.current,
                    isActive: false,
                    updatedAt: new Date().toISOString(),
                });
            } catch (error) {
                console.error("LiveLocation stop update error:", error);
            }
        }

        liveLocationIdRef.current = null;
        recordingSessionIdRef.current = null;
        setActiveRecordingSessionId(null);
        setRecordingStartedAt(null);
        setIsRecording(false);

        startLocationRef.current = null;
        lastSavedLocationRef.current = null;
        setDistanceFromStartMeters(null);

        return finishedSessionId;
    }, [saveLocationLog, updateLiveLocation]);

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
        distanceFromStartMeters,
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
