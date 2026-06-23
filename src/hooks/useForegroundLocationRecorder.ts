import { getCurrentUser } from "aws-amplify/auth";
import * as Location from "expo-location";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState } from "react-native";

import * as Battery from "expo-battery";
import { client } from "../lib/client";
import {
    ensureBackgroundLocationPermission,
    getBackgroundRecordingStatus,
    isBackgroundLocationPermissionError,
    startBackgroundLocationRecording,
    stopBackgroundLocationRecording,
    updateBackgroundRecordingLastSavedLocation,
    updateBackgroundRecordingLiveLocationId,
} from "../services/backgroundLocationService";

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
    const savingLocationKeyRef = useRef<string | null>(null);
    const recordingSessionIdRef = useRef<string | null>(null);
    const liveLocationIdRef = useRef<string | null>(null);

    const [activeRecordingSessionId, setActiveRecordingSessionId] = useState<
        string | null
    >(null);

    const startLocationRef = useRef<{
        latitude: number;
        longitude: number;
    } | null>(null);

    const appStateRef = useRef(AppState.currentState);

    const [distanceFromStartMeters, setDistanceFromStartMeters] = useState<
        number | null
    >(null);

    const forceDistanceMeters = Math.max(distanceMeters * 5, 100);

    // 位置を保存すべきか判定する関数
    const shouldSaveLocation = useCallback(
        (latitude: number, longitude: number, recordedAtMs: number) => {
            if (!lastSavedLocationRef.current) {
                return true;
            }

            const elapsedMs =
                recordedAtMs - lastSavedLocationRef.current.recordedAt;

            if (elapsedMs <= 0) {
                return false;
            }

            const distance = calculateDistanceMeters(
                lastSavedLocationRef.current.latitude,
                lastSavedLocationRef.current.longitude,
                latitude,
                longitude,
            );

            //指定間隔未満なら保存しない
            if (elapsedMs < intervalMs && distance < forceDistanceMeters) {
                return false;
            }

            if (elapsedMs >= intervalMs) {
                return true;
            }

            //100m以上動いた場合は例外的に保存
            if (distance >= forceDistanceMeters) {
                return true;
            }

            return false;
        },
        [intervalMs, forceDistanceMeters],
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

            const recordedAtMs =
                typeof location.timestamp === "number" &&
                Number.isFinite(location.timestamp)
                    ? location.timestamp
                    : Date.now();

            const recordedAt = new Date(recordedAtMs).toISOString();

            updateDistanceFromStart(location);

            const duplicateKey = createLocationDuplicateKey(
                latitude,
                longitude,
                recordedAtMs,
            );

            if (savingLocationKeyRef.current === duplicateKey) {
                return;
            }

            if (
                isExactDuplicateSavedLocation(
                    lastSavedLocationRef.current,
                    latitude,
                    longitude,
                    recordedAtMs,
                )
            ) {
                return;
            }

            try {
                const { state } = await getBackgroundRecordingStatus();

                if (
                    isExactDuplicateSavedLocation(
                        state?.lastSavedLocation ?? null,
                        latitude,
                        longitude,
                        recordedAtMs,
                    )
                ) {
                    return;
                }
            } catch (error) {
                console.error(
                    "Check background duplicate location error:",
                    error,
                );
            }

            if (
                !forceSave &&
                !shouldSaveLocation(latitude, longitude, recordedAtMs)
            ) {
                return;
            }

            try {
                savingLocationKeyRef.current = duplicateKey;

                const currentUser = await getCurrentUser();

                const batterySnapshot = await getBatterySnapshot();

                const sharedOwners = liveShareOwnerValue
                    ? [liveShareOwnerValue]
                    : undefined;

                const result = await client.models.LocationLog.create({
                    userId: currentUser.userId,
                    latitude,
                    longitude,
                    accuracy: location.coords.accuracy ?? null,
                    recordedAt,
                    memo: "自動記録",
                    recordingSessionId: recordingSessionIdRef.current,
                    source: "foreground",

                    sharedOwners,

                    batteryLevel: batterySnapshot.batteryLevel ?? undefined,
                    batteryState: batterySnapshot.batteryState ?? undefined,
                    lowPowerMode: batterySnapshot.lowPowerMode ?? undefined,
                });

                if (result.errors) {
                    console.error(
                        "Auto LocationLog create errors:",
                        result.errors,
                    );
                    return;
                }

                const nextSavedLocation = {
                    latitude,
                    longitude,
                    recordedAt: recordedAtMs,
                };

                lastSavedLocationRef.current = nextSavedLocation;

                await updateBackgroundRecordingLastSavedLocation(
                    nextSavedLocation,
                );

                console.log("Auto location saved:", {
                    latitude,
                    longitude,
                    recordedAt,
                });
            } catch (error) {
                console.error("Auto LocationLog create error:", error);
            } finally {
                if (savingLocationKeyRef.current === duplicateKey) {
                    savingLocationKeyRef.current = null;
                }
            }
        },
        [shouldSaveLocation, updateDistanceFromStart, liveShareOwnerValue],
    );

    const resetRecordingState = useCallback(() => {
        subscriptionRef.current?.remove();
        subscriptionRef.current = null;

        liveLocationIdRef.current = null;
        recordingSessionIdRef.current = null;
        startLocationRef.current = null;
        lastSavedLocationRef.current = null;

        setActiveRecordingSessionId(null);
        setRecordingStartedAt(null);
        setDistanceFromStartMeters(null);
        setIsRecording(false);
    }, []);

    const isStartingRef = useRef(false);

    const restoreRecordingState = useCallback(async () => {
        if (isRecording || isStartingRef.current) {
            return;
        }

        try {
            const { hasStarted, state } = await getBackgroundRecordingStatus();

            if (!hasStarted) {
                return;
            }

            if (!state?.recordingSessionId || !state.userId) {
                return;
            }

            recordingSessionIdRef.current = state.recordingSessionId;
            liveLocationIdRef.current = state.liveLocationId ?? null;
            lastSavedLocationRef.current = state.lastSavedLocation ?? null;

            setActiveRecordingSessionId(state.recordingSessionId);
            setRecordingStartedAt(state.startedAt ?? null);
            setDistanceFromStartMeters(null);
            setIsRecording(true);

            console.log("Restored background recording state:", {
                recordingSessionId: state.recordingSessionId,
                startedAt: state.startedAt,
            });
        } catch (error) {
            console.error("Restore recording state error:", error);
        }
    }, [isRecording]);

    // 記録開始関数
    const startRecording = useCallback(async () => {
        if (isRecording || subscriptionRef.current || isStartingRef.current) {
            return;
        }

        isStartingRef.current = true;

        try {
            try {
                await ensureBackgroundLocationPermission();
            } catch (error) {
                if (isBackgroundLocationPermissionError(error)) {
                    return;
                }

                console.error("Location permission error:", error);

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

            let currentLocation: Location.LocationObject;

            try {
                currentLocation = await Location.getCurrentPositionAsync({
                    accuracy: Location.Accuracy.Balanced,
                });
            } catch (error) {
                resetRecordingState();

                console.error("Get current location error:", error);

                Alert.alert(
                    "現在地を取得できませんでした",
                    "位置情報サービスが有効になっているか確認してください。",
                );
                return;
            }

            const currentLocationRecordedAtMs =
                typeof currentLocation.timestamp === "number" &&
                Number.isFinite(currentLocation.timestamp)
                    ? currentLocation.timestamp
                    : Date.now();

            startLocationRef.current = {
                latitude: currentLocation.coords.latitude,
                longitude: currentLocation.coords.longitude,
            };

            setDistanceFromStartMeters(0);

            try {
                const currentUser = await getCurrentUser();

                await startBackgroundLocationRecording({
                    userId: currentUser.userId,
                    recordingSessionId: newSessionId,
                    startedAt,
                    intervalMs,
                    distanceMeters,
                    liveShareOwnerValue,
                    lastSavedLocation: {
                        latitude: currentLocation.coords.latitude,
                        longitude: currentLocation.coords.longitude,
                        recordedAt: currentLocationRecordedAtMs,
                    },
                });
            } catch (error) {
                try {
                    await stopBackgroundLocationRecording();
                } catch (stopError) {
                    console.error(
                        "Stop background after start error:",
                        stopError,
                    );
                }

                resetRecordingState();

                if (isBackgroundLocationPermissionError(error)) {
                    return;
                }

                console.error(
                    "Start background location recording error:",
                    error,
                );

                Alert.alert(
                    "バックグラウンド記録エラー",
                    "バックグラウンドでの位置記録を開始できませんでした。位置情報の権限設定を確認してください。",
                );
                return;
            }

            try {
                const subscription = await Location.watchPositionAsync(
                    {
                        accuracy: Location.Accuracy.Balanced,
                        timeInterval: intervalMs,
                        distanceInterval: distanceMeters,
                    },
                    async (location) => {
                        if (appStateRef.current !== "active") {
                            return;
                        }

                        await updateLiveLocation(location);
                        await saveLocationLog(location);
                    },
                );

                subscriptionRef.current = subscription;
            } catch (error) {
                console.error("Foreground watch position start error:", error);

                // backgroundLocationRecording はすでに開始済みのため止めない。
                // foreground の watchPositionAsync に失敗しても、
                // background task による自動記録は継続させる。
            }

            setIsRecording(true);

            await updateLiveLocation(currentLocation);
            await updateBackgroundRecordingLiveLocationId(
                liveLocationIdRef.current,
            );
            await saveLocationLog(currentLocation, true);
        } finally {
            isStartingRef.current = false;
        }
    }, [
        isRecording,
        saveLocationLog,
        updateLiveLocation,
        intervalMs,
        distanceMeters,
        liveShareOwnerValue,
        resetRecordingState,
    ]);

    // 記録停止関数
    const stopRecording = useCallback(async (): Promise<string | null> => {
        const finishedSessionId = recordingSessionIdRef.current;

        subscriptionRef.current?.remove();
        subscriptionRef.current = null;

        try {
            await stopBackgroundLocationRecording();
        } catch (error) {
            console.error("Stop background location recording error:", error);
        }

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

    useEffect(() => {
        const subscription = AppState.addEventListener(
            "change",
            (nextState) => {
                appStateRef.current = nextState;
            },
        );

        return () => {
            subscription.remove();
        };
    }, []);

    useEffect(() => {
        void restoreRecordingState();
    }, [restoreRecordingState]);

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

const EXACT_DUPLICATE_DISTANCE_METERS = 1;

function createLocationDuplicateKey(
    latitude: number,
    longitude: number,
    recordedAtMs: number,
) {
    return [recordedAtMs, latitude.toFixed(7), longitude.toFixed(7)].join(":");
}

function isExactDuplicateSavedLocation(
    savedLocation: SavedLocation | null,
    latitude: number,
    longitude: number,
    recordedAtMs: number,
) {
    if (!savedLocation) {
        return false;
    }

    if (savedLocation.recordedAt !== recordedAtMs) {
        return false;
    }

    const distance = calculateDistanceMeters(
        savedLocation.latitude,
        savedLocation.longitude,
        latitude,
        longitude,
    );

    return distance < EXACT_DUPLICATE_DISTANCE_METERS;
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

type BatterySnapshot = {
    batteryLevel: number | null;
    batteryState: string | null;
    lowPowerMode: boolean | null;
};

async function getBatterySnapshot(): Promise<BatterySnapshot> {
    try {
        const [batteryLevel, batteryState, lowPowerMode] = await Promise.all([
            Battery.getBatteryLevelAsync(),
            Battery.getBatteryStateAsync(),
            Battery.isLowPowerModeEnabledAsync(),
        ]);

        return {
            batteryLevel:
                typeof batteryLevel === "number" && batteryLevel >= 0
                    ? batteryLevel
                    : null,
            batteryState: formatBatteryState(batteryState),
            lowPowerMode,
        };
    } catch (error) {
        console.error("Battery snapshot error:", error);

        return {
            batteryLevel: null,
            batteryState: "unknown",
            lowPowerMode: null,
        };
    }
}

function formatBatteryState(state: Battery.BatteryState) {
    switch (state) {
        case Battery.BatteryState.UNPLUGGED:
            return "unplugged";
        case Battery.BatteryState.CHARGING:
            return "charging";
        case Battery.BatteryState.FULL:
            return "full";
        case Battery.BatteryState.UNKNOWN:
        default:
            return "unknown";
    }
}
