import { getCurrentUser } from "aws-amplify/auth";
import * as Location from "expo-location";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
    createLocationLogId,
    createLocationUniqueKey,
    isDuplicateLocationCreateError,
} from "../services/locationLogDeduplicationService";
import {
    confirmRecordingContinuation,
    evaluateRecordingContinuation,
    initializeRecordingContinuationState,
    markRecordingContinuationAutoStopped,
    type RecordingContinuationState,
} from "../services/recordingContinuationService";
import {
    calculateDistanceMeters,
    isExactDuplicateLocation,
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

type StopRecordingOptions = {
    skipFinalLocationSave?: boolean;
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

    const [continuationPrompt, setContinuationPrompt] =
        useState<RecordingContinuationState | null>(null);

    const [autoStoppedSessionId, setAutoStoppedSessionId] = useState<
        string | null
    >(null);
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

    const normalizedLiveShareOwnerValues = useMemo(() => {
        return Array.from(new Set(liveShareOwnerValues.filter(Boolean)));
    }, [liveShareOwnerValues]);

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
            if (normalizedLiveShareOwnerValues.length === 0) {
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

                    isActive: true,
                    isRecording: Boolean(recordingSessionId),

                    latitude,
                    longitude,
                    accuracy: location.coords.accuracy ?? null,
                    updatedAt,
                    sharedOwners: normalizedLiveShareOwnerValues,
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

                await updateBackgroundRecordingLiveLocationId(
                    liveLocationIdRef.current,
                );
            } catch (error) {
                console.error("LiveLocation update error:", error);
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
            const latitude = location.coords.latitude;
            const longitude = location.coords.longitude;

            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                return;
            }

            const recordingSessionId = recordingSessionIdRef.current;

            if (!recordingSessionId) {
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

                const currentUser = await getCurrentUser();

                const batterySnapshot = await getBatterySnapshot();

                const sharedOwners =
                    normalizedLiveShareOwnerValues.length > 0
                        ? normalizedLiveShareOwnerValues
                        : undefined;

                const accuracy = location.coords.accuracy ?? null;

                const locationUniqueKey = createLocationUniqueKey({
                    userId: currentUser.userId,
                    recordingSessionId,
                    recordedAt,
                    latitude,
                    longitude,
                    accuracy,
                });

                const locationLogId = createLocationLogId(locationUniqueKey);

                const result = await client.models.LocationLog.create({
                    id: locationLogId,

                    userId: currentUser.userId,
                    latitude,
                    longitude,
                    accuracy,
                    recordedAt,
                    memo: "自動記録",
                    recordingSessionId,
                    source: "foreground",

                    sharedOwners,
                    locationUniqueKey,

                    batteryLevel: batterySnapshot.batteryLevel ?? undefined,
                    batteryState: batterySnapshot.batteryState ?? undefined,
                    lowPowerMode: batterySnapshot.lowPowerMode ?? undefined,
                });

                if (result.errors) {
                    /*
                     * 同じIDがすでに存在する場合は、
                     * foreground/background間の重複を正常に防止できたと判断する。
                     */
                    if (isDuplicateLocationCreateError(result.errors)) {
                        console.log(
                            "Skip duplicate foreground LocationLog by deterministic id:",
                            {
                                locationLogId,
                                recordingSessionId,
                                recordedAt,
                                latitude,
                                longitude,
                            },
                        );

                        return;
                    }

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
                if (isDuplicateLocationCreateError(error)) {
                    console.log(
                        "Skip duplicate foreground LocationLog exception by deterministic id:",
                        {
                            recordingSessionId,
                            recordedAt,
                            latitude,
                            longitude,
                        },
                    );

                    return;
                }

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

            const startedAtMs = state.startedAt
                ? new Date(state.startedAt).getTime()
                : Number.NaN;

            const maxRestoreAgeMs = 12 * 60 * 60 * 1000;

            const isExpired =
                !Number.isFinite(startedAtMs) ||
                Date.now() - startedAtMs > maxRestoreAgeMs;

            if (isExpired) {
                console.warn("Skip expired background recording state:", {
                    recordingSessionId: state.recordingSessionId,
                    startedAt: state.startedAt,
                });

                try {
                    await stopBackgroundLocationRecording();
                } catch (error) {
                    console.error(
                        "Clear expired background recording state error:",
                        error,
                    );
                }

                resetRecordingState();
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
    }, [isRecording, resetRecordingState]);

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

            setContinuationPrompt(null);
            setAutoStoppedSessionId(null);

            setActiveRecordingSessionId(newSessionId);
            lastSavedLocationRef.current = null;

            const startedAt = new Date().toISOString();

            await initializeRecordingContinuationState(newSessionId, startedAt);

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
                    recordingExpiresAt: null,
                    intervalMs,
                    distanceMeters,
                    liveShareOwnerValues: normalizedLiveShareOwnerValues,
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
        normalizedLiveShareOwnerValues,
        resetRecordingState,
    ]);

    // 記録停止関数
    const stopRecording = useCallback(
        async (options: StopRecordingOptions = {}): Promise<string | null> => {
            const finishedSessionId = recordingSessionIdRef.current;

            subscriptionRef.current?.remove();
            subscriptionRef.current = null;

            try {
                await stopBackgroundLocationRecording();
            } catch (error) {
                console.error(
                    "Stop background location recording error:",
                    error,
                );
            }

            if (
                !options.skipFinalLocationSave &&
                recordingSessionIdRef.current
            ) {
                try {
                    const currentLocation =
                        await Location.getCurrentPositionAsync({
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
                        isRecording: false,
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
        },
        [saveLocationLog, updateLiveLocation],
    );

    // ここに追加
    const checkRecordingContinuation = useCallback(async (): Promise<void> => {
        const recordingSessionId = recordingSessionIdRef.current;

        if (!recordingSessionId) {
            return;
        }

        try {
            const evaluation =
                await evaluateRecordingContinuation(recordingSessionId);

            /*
             * 期限切れを先に判定する。
             * shouldShowConfirmationもtrueになる可能性があるため、
             * ダイアログ表示より前に処理する。
             */
            if (evaluation.isDeadlineExpired) {
                const stoppedAt = new Date().toISOString();

                await markRecordingContinuationAutoStopped(
                    recordingSessionId,
                    stoppedAt,
                );

                const finishedSessionId = await stopRecording();

                setContinuationPrompt(null);

                if (finishedSessionId) {
                    setAutoStoppedSessionId(finishedSessionId);
                }

                return;
            }

            if (
                evaluation.shouldShowConfirmation &&
                evaluation.state?.confirmationRequired
            ) {
                setContinuationPrompt(evaluation.state);
                return;
            }

            setContinuationPrompt(null);
        } catch (error) {
            /*
             * 継続確認処理でエラーが発生しても、
             * 位置情報の記録は停止しない。
             */
            console.error("Check recording continuation error:", error);
        }
    }, [stopRecording]);

    const confirmContinuation = useCallback(async (): Promise<void> => {
        const recordingSessionId = recordingSessionIdRef.current;

        if (!recordingSessionId) {
            setContinuationPrompt(null);
            return;
        }

        try {
            await confirmRecordingContinuation(recordingSessionId);
            setContinuationPrompt(null);
        } catch (error) {
            console.error("Confirm recording continuation error:", error);
        }
    }, []);

    const clearAutoStoppedSession = useCallback(async (): Promise<void> => {
        /*
         * 自動停止通知の表示状態だけをクリアする。
         */
        setAutoStoppedSessionId(null);
    }, []);

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
                const previousState = appStateRef.current;
                appStateRef.current = nextState;

                const returnedToForeground =
                    previousState !== "active" && nextState === "active";

                if (returnedToForeground) {
                    void checkRecordingContinuation();
                }
            },
        );

        return () => {
            subscription.remove();
        };
    }, [checkRecordingContinuation]);

    // ここに追加
    useEffect(() => {
        if (!isRecording) {
            return;
        }

        /*
         * 記録開始・復元直後にも一度確認する。
         */
        void checkRecordingContinuation();

        /*
         * アプリがforegroundで動作している間だけ、
         * 30秒ごとに継続確認条件と期限切れを確認する。
         */
        const timerId = setInterval(() => {
            void checkRecordingContinuation();
        }, 30_000);

        return () => {
            clearInterval(timerId);
        };
    }, [isRecording, checkRecordingContinuation]);

    useEffect(() => {
        void restoreRecordingState();
    }, [restoreRecordingState]);

    return {
        isRecording,
        recordingStartedAt,
        activeRecordingSessionId,
        distanceFromStartMeters,

        continuationPrompt,
        autoStoppedSessionId,

        startRecording,
        stopRecording,

        confirmContinuation,
        clearAutoStoppedSession,
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
