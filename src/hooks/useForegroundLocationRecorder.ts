import { getCurrentUser } from "aws-amplify/auth";
import * as Location from "expo-location";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState } from "react-native";

import * as Battery from "expo-battery";
import { client } from "../lib/client";
import {
    getErrorMessage,
    saveBackgroundLocationDebugLog,
} from "../services/backgroundLocationDebugLogService";
import {
    ensureBackgroundLocationPermission,
    getBackgroundRecordingStatus,
    isBackgroundLocationPermissionError,
    startBackgroundLocationRecording,
    startBackgroundLocationTracking,
    stopBackgroundLocationRecording,
    stopBackgroundLocationTracking,
    updateBackgroundLocationTrackingState,
    updateBackgroundRecordingLastSavedLocation,
    updateBackgroundRecordingLiveLocationId,
} from "../services/backgroundLocationService";
import {
    calculateDistanceMeters,
    calculateSpeedMetersPerSecond,
    isAbnormalSpeedLocation,
    isExactDuplicateLocation,
    isLowAccuracyLocation,
    isNearDuplicateLocation,
} from "../utils/locationDuplicate";

type SavedLocation = {
    latitude: number;
    longitude: number;
    recordedAt: number;
};

type RecorderOptions = {
    intervalMs: number;
    distanceMeters: number;
    liveShareOwnerValues?: string[];
};

type LiveLocationMutationResult = {
    data?: {
        id?: string | null;
    } | null;
    errors?: unknown;
};

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
            "Failed to save foreground location debug log:",
            debugLogError,
        );
    }
}

export function useForegroundLocationRecorder({
    intervalMs,
    distanceMeters,
    liveShareOwnerValues = [],
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
    const recordingUserIdRef = useRef<string | null>(null);
    const [hasRestoredTrackingState, setHasRestoredTrackingState] =
        useState(false);

    const [activeRecordingSessionId, setActiveRecordingSessionId] = useState<
        string | null
    >(null);

    const startLocationRef = useRef<{
        latitude: number;
        longitude: number;
    } | null>(null);

    const appStateRef = useRef(AppState.currentState);

    /*
     * watchPositionAsyncのコールバックなどから、
     * 最新の自動記録状態を参照するためのref。
     */
    const isRecordingRef = useRef(false);

    const isSyncingLiveSharingRef = useRef(false);
    const isStartingRef = useRef(false);

    /*
     * Reactのstateとrefを同期する。
     */
    useEffect(() => {
        isRecordingRef.current = isRecording;
    }, [isRecording]);

    const [distanceFromStartMeters, setDistanceFromStartMeters] = useState<
        number | null
    >(null);

    const normalizedLiveShareOwnerValues = useMemo(() => {
        return Array.from(new Set(liveShareOwnerValues.filter(Boolean)));
    }, [liveShareOwnerValues]);

    // 位置を保存すべきか判定する関数
    const shouldSaveLocation = useCallback(
        (latitude: number, longitude: number, recordedAtMs: number) => {
            const lastSavedLocation = lastSavedLocationRef.current;

            if (!lastSavedLocation) {
                return true;
            }

            const elapsedMs = recordedAtMs - lastSavedLocation.recordedAt;

            if (elapsedMs <= 0) {
                return false;
            }

            const distance = calculateDistanceMeters(
                lastSavedLocation.latitude,
                lastSavedLocation.longitude,
                latitude,
                longitude,
            );

            const configuredIntervalMs =
                Number.isFinite(intervalMs) && intervalMs > 0
                    ? intervalMs
                    : 60_000;

            const configuredDistanceMeters =
                Number.isFinite(distanceMeters) && distanceMeters > 0
                    ? distanceMeters
                    : 100;

            return (
                elapsedMs >= configuredIntervalMs ||
                distance >= configuredDistanceMeters
            );
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
            if (normalizedLiveShareOwnerValues.length === 0) {
                return;
            }

            let userId = recordingUserIdRef.current;

            if (!userId) {
                try {
                    const currentUser = await getCurrentUser();
                    userId = currentUser.userId;
                    recordingUserIdRef.current = userId;
                } catch (error) {
                    console.error(
                        "Get current user for LiveLocation error:",
                        error,
                    );
                    return;
                }
            }

            const latitude = location.coords.latitude;
            const longitude = location.coords.longitude;

            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                return;
            }

            const isCurrentlyRecording = isRecordingRef.current;
            const recordingSessionId = isCurrentlyRecording
                ? recordingSessionIdRef.current
                : null;

            try {
                const liveLocationModel = client.models.LiveLocation as any;
                const updatedAt = new Date().toISOString();

                const payload = {
                    userId,
                    recordingSessionId,
                    isRecording: isCurrentlyRecording,
                    latitude,
                    longitude,
                    accuracy: location.coords.accuracy ?? null,
                    updatedAt,
                    isActive: true,
                    sharedOwners: normalizedLiveShareOwnerValues,
                };

                if (liveLocationIdRef.current) {
                    const result = (await liveLocationModel.update({
                        id: liveLocationIdRef.current,
                        ...payload,
                    })) as LiveLocationMutationResult;

                    if (result.errors) {
                        const errorMessage = getErrorMessage(result.errors);

                        console.error(
                            "LiveLocation update errors:",
                            result.errors,
                        );

                        await safeSaveBackgroundLocationDebugLog({
                            userId,
                            recordingSessionId,
                            eventName: "foregroundLiveLocationUpdateFailed",
                            errorMessage,
                            details: {
                                liveLocationId: liveLocationIdRef.current,
                                isRecording: isCurrentlyRecording,
                                sharedOwnersCount:
                                    normalizedLiveShareOwnerValues.length,
                                payloadKeys: Object.keys(payload),
                            },
                        });

                        return;
                    }

                    return;
                }

                const result = (await liveLocationModel.create(
                    payload,
                )) as LiveLocationMutationResult;

                if (result.errors) {
                    const errorMessage = getErrorMessage(result.errors);

                    console.error("LiveLocation create errors:", result.errors);

                    await safeSaveBackgroundLocationDebugLog({
                        userId,
                        recordingSessionId,
                        eventName: "foregroundLiveLocationCreateFailed",
                        errorMessage,
                        details: {
                            isRecording: isCurrentlyRecording,
                            sharedOwnersCount:
                                normalizedLiveShareOwnerValues.length,
                            payloadKeys: Object.keys(payload),
                        },
                    });

                    return;
                }

                liveLocationIdRef.current = result.data?.id ?? null;

                await updateBackgroundRecordingLiveLocationId(
                    liveLocationIdRef.current,
                );
            } catch (error) {
                console.error("LiveLocation update error:", error);

                await safeSaveBackgroundLocationDebugLog({
                    userId,
                    recordingSessionId,
                    eventName: "foregroundLiveLocationUnexpectedError",
                    errorMessage: getErrorMessage(error),
                    details: {
                        liveLocationId: liveLocationIdRef.current,
                        isRecording: isCurrentlyRecording,
                        sharedOwnersCount:
                            normalizedLiveShareOwnerValues.length,
                    },
                });
            }
        },
        [normalizedLiveShareOwnerValues],
    );

    // 位置を保存する関数
    const saveLocationLog = useCallback(
        async (
            location: Location.LocationObject,
            forceSave: boolean = false,
        ) => {
            /*
             * LocationLogは自動記録中だけ保存する。
             * 現在地共有のみの場合はLiveLocationだけを更新する。
             */
            if (!isRecordingRef.current || !recordingSessionIdRef.current) {
                return;
            }

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
            const accuracy = location.coords.accuracy ?? null;

            if (isLowAccuracyLocation(accuracy)) {
                await saveBackgroundLocationDebugLog({
                    userId: recordingUserIdRef.current,
                    recordingSessionId: recordingSessionIdRef.current,
                    eventName: "foregroundLocationLogSkippedLowAccuracy",
                    details: {
                        recordedAt,
                        latitude,
                        longitude,
                        accuracy,
                    },
                });

                return;
            }

            if (
                isAbnormalSpeedLocation(
                    lastSavedLocationRef.current,
                    latitude,
                    longitude,
                    recordedAtMs,
                )
            ) {
                const speedMetersPerSecond = calculateSpeedMetersPerSecond(
                    lastSavedLocationRef.current,
                    latitude,
                    longitude,
                    recordedAtMs,
                );

                await saveBackgroundLocationDebugLog({
                    userId: recordingUserIdRef.current,
                    recordingSessionId: recordingSessionIdRef.current,
                    eventName: "foregroundLocationLogSkippedAbnormalSpeed",
                    details: {
                        recordedAt,
                        latitude,
                        longitude,
                        accuracy,
                        speedMetersPerSecond,
                        speedKmPerHour:
                            speedMetersPerSecond == null
                                ? null
                                : speedMetersPerSecond * 3.6,
                    },
                });

                return;
            }

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
                isExactDuplicateLocation(
                    lastSavedLocationRef.current,
                    latitude,
                    longitude,
                    recordedAtMs,
                ) ||
                isNearDuplicateLocation(
                    lastSavedLocationRef.current,
                    latitude,
                    longitude,
                    recordedAtMs,
                )
            ) {
                console.log("Skip duplicate foreground location:", {
                    latitude,
                    longitude,
                    recordedAt,
                });

                return;
            }

            if (!forceSave) {
                try {
                    const { state } = await getBackgroundRecordingStatus();

                    const backgroundLastSavedLocation =
                        state?.lastSavedLocation ?? null;

                    if (
                        isExactDuplicateLocation(
                            backgroundLastSavedLocation,
                            latitude,
                            longitude,
                            recordedAtMs,
                        ) ||
                        isNearDuplicateLocation(
                            backgroundLastSavedLocation,
                            latitude,
                            longitude,
                            recordedAtMs,
                        )
                    ) {
                        console.log(
                            "Skip duplicate foreground location by background state:",
                            {
                                latitude,
                                longitude,
                                recordedAt,
                            },
                        );

                        return;
                    }
                } catch (error) {
                    console.error(
                        "Check background duplicate location error:",
                        error,
                    );
                }
            }

            if (
                !forceSave &&
                !shouldSaveLocation(latitude, longitude, recordedAtMs)
            ) {
                return;
            }

            try {
                savingLocationKeyRef.current = duplicateKey;

                const userId = recordingUserIdRef.current;

                if (!userId) {
                    console.error(
                        "Skip foreground LocationLog create: userId is missing",
                    );

                    await saveBackgroundLocationDebugLog({
                        userId: null,
                        recordingSessionId: recordingSessionIdRef.current,
                        eventName: "foregroundLocationLogSkippedNoUserId",
                        details: {
                            recordedAt,
                            latitude,
                            longitude,
                        },
                    });

                    return;
                }

                const batterySnapshot = await getBatterySnapshot();

                const sharedOwners =
                    normalizedLiveShareOwnerValues.length > 0
                        ? normalizedLiveShareOwnerValues
                        : undefined;

                const result = await client.models.LocationLog.create({
                    userId,
                    latitude,
                    longitude,
                    accuracy,
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
                    const errorMessage = getErrorMessage(result.errors);

                    console.error(
                        "Auto LocationLog create errors:",
                        result.errors,
                    );

                    await saveBackgroundLocationDebugLog({
                        userId,
                        recordingSessionId: recordingSessionIdRef.current,
                        eventName: "foregroundLocationLogCreateFailed",
                        errorMessage,
                        details: {
                            recordedAt,
                            latitude,
                            longitude,
                            source: "foreground",
                        },
                    });

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
        [
            shouldSaveLocation,
            updateDistanceFromStart,
            normalizedLiveShareOwnerValues,
        ],
    );

    const handleForegroundLocation = useCallback(
        async (location: Location.LocationObject) => {
            if (appStateRef.current !== "active") {
                return;
            }

            /*
             * LiveLocationは自動記録状態に関係なく更新する。
             * 共有先が0人の場合、updateLiveLocation内で何もしない。
             */
            await updateLiveLocation(location);

            /*
             * LocationLogはsaveLocationLog内のガードにより、
             * 自動記録中だけ保存される。
             */
            await saveLocationLog(location);
        },
        [saveLocationLog, updateLiveLocation],
    );

    const ensureForegroundLocationWatcher = useCallback(async () => {
        if (subscriptionRef.current) {
            return;
        }

        const subscription = await Location.watchPositionAsync(
            {
                accuracy: Location.Accuracy.Balanced,
                timeInterval: intervalMs,
                distanceInterval: distanceMeters,
            },
            (location) => {
                void handleForegroundLocation(location);
            },
        );

        subscriptionRef.current = subscription;
    }, [intervalMs, distanceMeters, handleForegroundLocation]);

    const deactivateLiveLocation = useCallback(async () => {
        const liveLocationId = liveLocationIdRef.current;

        if (!liveLocationId) {
            return;
        }

        try {
            const result = await client.models.LiveLocation.update({
                id: liveLocationId,
                isActive: false,
                isRecording: false,
                recordingSessionId: null,
                updatedAt: new Date().toISOString(),
                sharedOwners: [],
            });

            if (result.errors) {
                console.error("Deactivate LiveLocation errors:", result.errors);
                return;
            }

            liveLocationIdRef.current = null;

            await updateBackgroundRecordingLiveLocationId(null);
        } catch (error) {
            console.error("Deactivate LiveLocation error:", error);
        }
    }, []);

    /*
     * 自動記録状態だけを初期化する。
     * 現在地共有に必要なユーザーID、LiveLocation ID、
     * Foreground位置監視はここでは解除しない。
     */
    const resetAutomaticRecordingState = useCallback(() => {
        isRecordingRef.current = false;
        recordingSessionIdRef.current = null;
        startLocationRef.current = null;
        lastSavedLocationRef.current = null;

        setActiveRecordingSessionId(null);
        setRecordingStartedAt(null);
        setDistanceFromStartMeters(null);
        setIsRecording(false);
    }, []);

    const restoreRecordingState = useCallback(async () => {
        if (isStartingRef.current) {
            return;
        }

        try {
            const { hasStarted, state } = await getBackgroundRecordingStatus();

            if (!hasStarted || !state?.userId) {
                return;
            }

            recordingUserIdRef.current = state.userId;
            liveLocationIdRef.current = state.liveLocationId ?? null;

            if (state.isRecording && state.recordingSessionId) {
                isRecordingRef.current = true;
                recordingSessionIdRef.current = state.recordingSessionId;
                lastSavedLocationRef.current = state.lastSavedLocation ?? null;

                setActiveRecordingSessionId(state.recordingSessionId);
                setRecordingStartedAt(state.startedAt ?? null);
                setDistanceFromStartMeters(null);
                setIsRecording(true);

                console.log("Restored background recording state:", {
                    isRecording: true,
                    recordingSessionId: state.recordingSessionId,
                    startedAt: state.startedAt,
                });
            } else {
                isRecordingRef.current = false;
                recordingSessionIdRef.current = null;
                lastSavedLocationRef.current = null;

                setActiveRecordingSessionId(null);
                setRecordingStartedAt(null);
                setDistanceFromStartMeters(null);
                setIsRecording(false);

                console.log("Restored live sharing state:", {
                    isRecording: false,
                    sharedOwnersCount: state.liveShareOwnerValues?.length ?? 0,
                });
            }

            try {
                await ensureForegroundLocationWatcher();
            } catch (watchError) {
                console.error("Restore foreground watcher error:", watchError);
            }
        } catch (error) {
            console.error("Restore recording state error:", error);
        }
    }, [ensureForegroundLocationWatcher]);

    // 自動記録開始
    const startRecording = useCallback(async () => {
        if (isRecordingRef.current || isStartingRef.current) {
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
            let recordingUserId: string;

            try {
                const currentUser = await getCurrentUser();
                recordingUserId = currentUser.userId;
            } catch (error) {
                resetAutomaticRecordingState();

                console.error("Get current user for recording error:", error);

                Alert.alert(
                    "ユーザー情報の取得に失敗しました",
                    "ログイン状態を確認してから、もう一度自動記録を開始してください。",
                );
                return;
            }

            recordingUserIdRef.current = recordingUserId;
            recordingSessionIdRef.current = newSessionId;
            isRecordingRef.current = true;

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
                resetAutomaticRecordingState();

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
                await startBackgroundLocationRecording({
                    userId: recordingUserId,
                    recordingSessionId: newSessionId,
                    startedAt,
                    intervalMs,
                    distanceMeters,
                    liveShareOwnerValues: normalizedLiveShareOwnerValues,
                    liveLocationId: liveLocationIdRef.current,
                    lastSavedLocation: {
                        latitude: currentLocation.coords.latitude,
                        longitude: currentLocation.coords.longitude,
                        recordedAt: currentLocationRecordedAtMs,
                        accuracy: currentLocation.coords.accuracy ?? null,
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

                resetAutomaticRecordingState();

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
                await ensureForegroundLocationWatcher();
            } catch (error) {
                console.error("Foreground watch position start error:", error);

                /*
                 * Background位置更新は開始済みなので、
                 * Foreground監視に失敗しても自動記録は継続する。
                 */
            }

            setIsRecording(true);

            await updateLiveLocation(currentLocation);
            await saveLocationLog(currentLocation, true);
        } finally {
            isStartingRef.current = false;
        }
    }, [
        saveLocationLog,
        updateLiveLocation,
        intervalMs,
        distanceMeters,
        normalizedLiveShareOwnerValues,
        resetAutomaticRecordingState,
        ensureForegroundLocationWatcher,
    ]);

    // 自動記録停止
    const stopRecording = useCallback(async (): Promise<string | null> => {
        const finishedSessionId = recordingSessionIdRef.current;

        let stopLocation: Location.LocationObject | null = null;

        /*
         * 自動記録状態を解除する前に最終地点を保存する。
         */
        if (recordingSessionIdRef.current) {
            try {
                stopLocation = await Location.getCurrentPositionAsync({
                    accuracy: Location.Accuracy.Balanced,
                });

                await updateLiveLocation(stopLocation);
                await saveLocationLog(stopLocation, true);
            } catch (error) {
                console.error("Save stop location error:", error);
            }
        }

        /*
         * 以降の位置情報をLocationLogへ保存しないよう、
         * 自動記録状態を先に解除する。
         */
        isRecordingRef.current = false;
        recordingSessionIdRef.current = null;

        setActiveRecordingSessionId(null);
        setRecordingStartedAt(null);
        setIsRecording(false);

        startLocationRef.current = null;
        lastSavedLocationRef.current = null;
        setDistanceFromStartMeters(null);

        try {
            /*
             * 共有先が残っている場合、
             * backgroundLocationService側では追跡を停止せず、
             * isRecordingだけfalseへ変更する。
             */
            await stopBackgroundLocationRecording();
        } catch (error) {
            console.error("Stop background location recording error:", error);
        }

        if (normalizedLiveShareOwnerValues.length > 0) {
            /*
             * 同じLiveLocationレコードを非記録中の共有状態へ更新する。
             */
            if (stopLocation) {
                await updateLiveLocation(stopLocation);
            } else {
                try {
                    const currentLocation =
                        await Location.getCurrentPositionAsync({
                            accuracy: Location.Accuracy.Balanced,
                        });

                    await updateLiveLocation(currentLocation);
                } catch (error) {
                    console.error(
                        "Update shared location after stop error:",
                        error,
                    );
                }
            }

            try {
                await ensureForegroundLocationWatcher();
            } catch (error) {
                console.error(
                    "Keep foreground sharing after stop error:",
                    error,
                );
            }
        } else {
            subscriptionRef.current?.remove();
            subscriptionRef.current = null;

            liveLocationIdRef.current = null;
            recordingUserIdRef.current = null;
        }

        return finishedSessionId;
    }, [
        saveLocationLog,
        updateLiveLocation,
        normalizedLiveShareOwnerValues,
        ensureForegroundLocationWatcher,
    ]);

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
        let mounted = true;

        const restore = async () => {
            try {
                await restoreRecordingState();
            } finally {
                if (mounted) {
                    setHasRestoredTrackingState(true);
                }
            }
        };

        void restore();

        return () => {
            mounted = false;
        };
    }, [restoreRecordingState]);

    /*
     * 共有先・記録間隔・距離間隔の変更を、
     * Foreground/Backgroundの位置追跡状態へ反映する。
     */
    useEffect(() => {
        if (!hasRestoredTrackingState) {
            return;
        }

        if (isSyncingLiveSharingRef.current) {
            return;
        }

        let cancelled = false;

        const syncLiveSharing = async () => {
            isSyncingLiveSharingRef.current = true;

            try {
                const isCurrentlyRecording = isRecordingRef.current;

                if (normalizedLiveShareOwnerValues.length === 0) {
                    await deactivateLiveLocation();

                    if (isCurrentlyRecording) {
                        await updateBackgroundLocationTrackingState({
                            isRecording: true,
                            recordingSessionId: recordingSessionIdRef.current,
                            liveShareOwnerValues: [],
                            liveLocationId: null,
                        });
                        return;
                    }

                    subscriptionRef.current?.remove();
                    subscriptionRef.current = null;

                    await stopBackgroundLocationTracking();

                    recordingUserIdRef.current = null;
                    liveLocationIdRef.current = null;
                    return;
                }

                let userId = recordingUserIdRef.current;

                if (!userId) {
                    const currentUser = await getCurrentUser();
                    userId = currentUser.userId;
                    recordingUserIdRef.current = userId;
                }

                if (isCurrentlyRecording) {
                    await updateBackgroundLocationTrackingState({
                        isRecording: true,
                        recordingSessionId: recordingSessionIdRef.current,
                        liveShareOwnerValues: normalizedLiveShareOwnerValues,
                        liveLocationId: liveLocationIdRef.current,
                    });
                } else {
                    await ensureBackgroundLocationPermission(userId, null);

                    await startBackgroundLocationTracking({
                        userId,
                        isRecording: false,
                        recordingSessionId: null,
                        startedAt: null,
                        intervalMs,
                        distanceMeters,
                        liveShareOwnerValues: normalizedLiveShareOwnerValues,
                        liveLocationId: liveLocationIdRef.current,
                        lastSavedLocation: null,
                    });
                }

                await ensureForegroundLocationWatcher();

                const currentLocation = await Location.getCurrentPositionAsync({
                    accuracy: Location.Accuracy.Balanced,
                });

                if (!cancelled) {
                    await updateLiveLocation(currentLocation);
                }
            } catch (error) {
                console.error("Sync live sharing error:", error);

                if (!isBackgroundLocationPermissionError(error)) {
                    Alert.alert(
                        "現在地共有エラー",
                        "リアルタイム共有を開始できませんでした。位置情報の権限設定を確認してください。",
                    );
                }
            } finally {
                isSyncingLiveSharingRef.current = false;
            }
        };

        void syncLiveSharing();

        return () => {
            cancelled = true;
        };
    }, [
        hasRestoredTrackingState,
        intervalMs,
        distanceMeters,
        normalizedLiveShareOwnerValues,
        ensureForegroundLocationWatcher,
        updateLiveLocation,
        deactivateLiveLocation,
    ]);

    return {
        isRecording,
        recordingStartedAt,
        activeRecordingSessionId,
        distanceFromStartMeters,
        startRecording,
        stopRecording,
    };
}

function createLocationDuplicateKey(
    latitude: number,
    longitude: number,
    recordedAtMs: number,
) {
    return [recordedAtMs, latitude.toFixed(7), longitude.toFixed(7)].join(":");
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
