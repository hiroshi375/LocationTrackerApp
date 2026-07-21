import { getCurrentUser } from "aws-amplify/auth";
import * as Location from "expo-location";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Platform } from "react-native";

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
    acquireLocationSaveLock,
    createLocationSaveLockScopeKey,
    releaseLocationSaveLock,
} from "../services/locationLogDeduplicationService";
import {
    enqueuePendingLocationLog,
    flushPendingLocationLogs,
} from "../services/locationLogPendingQueueService";
import {
    type RecordingContinuationState,
    clearRecordingContinuationState,
    confirmRecordingContinuation,
    evaluateRecordingContinuation,
    getRecordingContinuationState,
    incrementRecordingContinuationPointCount,
    markRecordingContinuationAutoStopped,
} from "../services/recordingContinuationService";
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
    const recordingSessionIdRef = useRef<string | null>(null);
    const liveLocationIdRef = useRef<string | null>(null);
    const recordingUserIdRef = useRef<string | null>(null);
    const [hasRestoredTrackingState, setHasRestoredTrackingState] =
        useState(false);

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

    // 位置を端末内の未送信キューへ保存する関数
    const saveLocationLog = useCallback(
        async (
            location: Location.LocationObject,
            forceSave: boolean = false,
        ): Promise<boolean> => {
            /*
             * LocationLogは自動記録中だけ保存する。
             * 現在地共有のみの場合はLiveLocationだけを更新する。
             */
            const recordingSessionId = recordingSessionIdRef.current;

            if (!isRecordingRef.current || !recordingSessionId) {
                return false;
            }

            const latitude = location.coords.latitude;
            const longitude = location.coords.longitude;

            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                return false;
            }

            const recordedAtMs =
                typeof location.timestamp === "number" &&
                Number.isFinite(location.timestamp)
                    ? location.timestamp
                    : Date.now();

            const recordedAt = new Date(recordedAtMs).toISOString();
            const accuracy = location.coords.accuracy ?? null;

            if (isLowAccuracyLocation(accuracy)) {
                void safeSaveBackgroundLocationDebugLog({
                    userId: recordingUserIdRef.current,
                    recordingSessionId,
                    eventName: "foregroundLocationLogSkippedLowAccuracy",
                    details: {
                        recordedAt,
                        latitude,
                        longitude,
                        accuracy,
                    },
                });

                return false;
            }

            updateDistanceFromStart(location);

            const userId = recordingUserIdRef.current;

            if (!userId) {
                console.error(
                    "Skip foreground LocationLog enqueue: userId is missing",
                );

                void safeSaveBackgroundLocationDebugLog({
                    userId: null,
                    recordingSessionId,
                    eventName: "foregroundLocationLogSkippedNoUserId",
                    details: {
                        recordedAt,
                        latitude,
                        longitude,
                    },
                });

                return false;
            }

            const lockScopeKey = createLocationSaveLockScopeKey(
                userId,
                recordingSessionId,
            );
            const lock = await acquireLocationSaveLock(lockScopeKey);

            if (!lock) {
                void safeSaveBackgroundLocationDebugLog({
                    userId,
                    recordingSessionId,
                    eventName: "foregroundLocationLogLockUnavailable",
                    details: {
                        recordedAt,
                        latitude,
                        longitude,
                    },
                });

                return false;
            }

            try {
                /*
                 * ロック取得後に共有状態を再取得し、
                 * background側が直前に端末内キューへ受け付けた地点も反映する。
                 */
                const { state } = await getBackgroundRecordingStatus();

                if (
                    !isRecordingRef.current ||
                    recordingSessionIdRef.current !== recordingSessionId ||
                    !state?.isRecording ||
                    state.recordingSessionId !== recordingSessionId
                ) {
                    return false;
                }

                const latestLastSavedLocation =
                    state.lastSavedLocation ??
                    lastSavedLocationRef.current ??
                    null;

                if (
                    !forceSave &&
                    isAbnormalSpeedLocation(
                        latestLastSavedLocation,
                        latitude,
                        longitude,
                        recordedAtMs,
                    )
                ) {
                    const speedMetersPerSecond = calculateSpeedMetersPerSecond(
                        latestLastSavedLocation,
                        latitude,
                        longitude,
                        recordedAtMs,
                    );

                    void safeSaveBackgroundLocationDebugLog({
                        userId,
                        recordingSessionId,
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

                    return false;
                }

                /*
                 * 開始・停止地点のforceSaveでは、状態に先行設定された
                 * lastSavedLocationによって自分自身を除外しない。
                 * 端末内キューとDynamoDBの決定的idで完全重複を防止する。
                 */
                if (
                    !forceSave &&
                    (isExactDuplicateLocation(
                        latestLastSavedLocation,
                        latitude,
                        longitude,
                        recordedAtMs,
                    ) ||
                        isNearDuplicateLocation(
                            latestLastSavedLocation,
                            latitude,
                            longitude,
                            recordedAtMs,
                        ))
                ) {
                    return false;
                }

                if (
                    !forceSave &&
                    !shouldSaveLocationFromSavedLocation(
                        latestLastSavedLocation,
                        latitude,
                        longitude,
                        recordedAtMs,
                        intervalMs,
                        distanceMeters,
                    )
                ) {
                    return false;
                }

                const batterySnapshot = await getBatterySnapshot();

                const sharedOwners =
                    normalizedLiveShareOwnerValues.length > 0
                        ? normalizedLiveShareOwnerValues
                        : undefined;

                /*
                 * ネットワーク通信より先にAsyncStorageへ保存する。
                 * background/通信停止中でも、受信済み地点を失わない。
                 */
                const enqueueResult = await enqueuePendingLocationLog({
                    userId,
                    recordingSessionId,
                    latitude,
                    longitude,
                    accuracy,
                    recordedAt,
                    source: "foreground",
                    sharedOwners,
                    batteryLevel: batterySnapshot.batteryLevel,
                    batteryState: batterySnapshot.batteryState,
                    lowPowerMode: batterySnapshot.lowPowerMode,
                });

                const nextSavedLocation = {
                    latitude,
                    longitude,
                    recordedAt: recordedAtMs,
                };

                /*
                 * クラウド同期完了を待たず、保存判定基準を更新する。
                 * 未送信データは端末内キューに残るため、通信復旧後に再送される。
                 */
                lastSavedLocationRef.current = nextSavedLocation;

                await updateBackgroundRecordingLastSavedLocation(
                    nextSavedLocation,
                );

                if (enqueueResult.enqueued) {
                    const continuationEvaluation =
                        await incrementRecordingContinuationPointCount(
                            recordingSessionId,
                        );

                    if (continuationEvaluation.shouldShowConfirmation) {
                        setContinuationPrompt(continuationEvaluation.state);
                    }
                }

                /*
                 * Foreground中は同期を試すが、位置受付処理はネットワークを待たない。
                 */
                void flushPendingLocationLogs({
                    recordingSessionId,
                    maxItems: 20,
                    timeBudgetMs: 8_000,
                }).then((flushResult) => {
                    if (flushResult.failedCount > 0) {
                        void safeSaveBackgroundLocationDebugLog({
                            userId,
                            recordingSessionId,
                            eventName:
                                "foregroundLocationPendingQueueFlushFailed",
                            errorMessage: flushResult.lastErrorMessage ?? null,
                            details: {
                                attemptedCount: flushResult.attemptedCount,
                                syncedCount: flushResult.syncedCount,
                                duplicateCount: flushResult.duplicateCount,
                                failedCount: flushResult.failedCount,
                                remainingCount: flushResult.remainingCount,
                                timedOut: flushResult.timedOut,
                            },
                        });
                    }
                });

                console.log("Auto location queued:", {
                    latitude,
                    longitude,
                    recordedAt,
                    enqueued: enqueueResult.enqueued,
                    queueLength: enqueueResult.queueLength,
                });

                return true;
            } catch (error) {
                console.error("Auto LocationLog enqueue error:", error);

                void safeSaveBackgroundLocationDebugLog({
                    userId,
                    recordingSessionId,
                    eventName: "foregroundLocationLogUnexpectedError",
                    errorMessage: getErrorMessage(error),
                    details: {
                        recordedAt,
                        latitude,
                        longitude,
                        accuracy,
                        forceSave,
                        errorName:
                            error instanceof Error ? error.name : typeof error,
                        errorStack:
                            error instanceof Error
                                ? (error.stack ?? null)
                                : null,
                    },
                });

                return false;
            } finally {
                await releaseLocationSaveLock(lock);
            }
        },
        [
            intervalMs,
            distanceMeters,
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
             * LocationLogの端末内保存を最優先する。
             * LiveLocation通信が停止してもLocationLog受付を止めない。
             */
            await saveLocationLog(location);

            /*
             * LiveLocationは自動記録状態に関係なく更新する。
             * 共有先が0人の場合、updateLiveLocation内で何もしない。
             */
            void updateLiveLocation(location);
        },
        [saveLocationLog, updateLiveLocation],
    );

    const ensureForegroundLocationWatcher = useCallback(async () => {
        if (subscriptionRef.current) {
            return;
        }

        const nativeDistanceInterval =
            Platform.OS === "ios"
                ? Math.min(distanceMeters, 5)
                : distanceMeters;

        const subscription = await Location.watchPositionAsync(
            {
                accuracy: Location.Accuracy.High,
                timeInterval: intervalMs,
                distanceInterval: nativeDistanceInterval,
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
            }

            try {
                await ensureForegroundLocationWatcher();
            } catch (watchError) {
                console.error("Restore foreground watcher error:", watchError);
            }

            void flushPendingLocationLogs({
                force: true,
                recordingSessionId:
                    state.isRecording && state.recordingSessionId
                        ? state.recordingSessionId
                        : null,
                maxItems: 200,
                timeBudgetMs: 15_000,
            });
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
            setContinuationPrompt(null);
            setAutoStoppedSessionId(null);
            isRecordingRef.current = true;

            setActiveRecordingSessionId(newSessionId);
            lastSavedLocationRef.current = null;

            const startedAt = new Date().toISOString();
            setRecordingStartedAt(startedAt);

            let currentLocation: Location.LocationObject;

            try {
                currentLocation = await Location.getCurrentPositionAsync({
                    accuracy: Location.Accuracy.High,
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
                    lastSavedLocation: null,
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

            const initialLocationAccepted = await saveLocationLog(
                currentLocation,
                true,
            );

            if (!initialLocationAccepted) {
                try {
                    await stopBackgroundLocationRecording();
                } catch (stopError) {
                    console.error(
                        "Stop background after initial location failure:",
                        stopError,
                    );
                }

                resetAutomaticRecordingState();

                Alert.alert(
                    "自動記録を開始できませんでした",
                    "最初の位置情報を端末へ保存できなかったため、自動記録を停止しました。位置情報サービスと端末の空き容量を確認して、もう一度開始してください。",
                );
                return;
            }

            void updateLiveLocation(currentLocation);
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
    const stopRecording = useCallback(
        async (
            reason: "MANUAL" | "AUTO" = "MANUAL",
        ): Promise<string | null> => {
            const finishedSessionId = recordingSessionIdRef.current;

            let stopLocation: Location.LocationObject | null = null;

            /*
             * 自動記録状態を解除する前に最終地点を保存する。
             */
            if (reason === "MANUAL" && recordingSessionIdRef.current) {
                try {
                    stopLocation = await Location.getCurrentPositionAsync({
                        accuracy: Location.Accuracy.Balanced,
                    });

                    await saveLocationLog(stopLocation, true);
                    void updateLiveLocation(stopLocation);
                } catch (error) {
                    console.error("Save stop location error:", error);
                }
            }

            /*
             * 停止前に、このセッションの未送信LocationLogを可能な範囲で同期する。
             * 失敗しても端末内キューには残り、次回foreground復帰時に再送される。
             */
            if (finishedSessionId) {
                const flushResult = await flushPendingLocationLogs({
                    force: true,
                    recordingSessionId: finishedSessionId,
                    maxItems: 200,
                    timeBudgetMs: 10_000,
                });

                if (flushResult.failedCount > 0) {
                    void safeSaveBackgroundLocationDebugLog({
                        userId: recordingUserIdRef.current,
                        recordingSessionId: finishedSessionId,
                        eventName: "stopRecordingPendingQueueFlushFailed",
                        errorMessage: flushResult.lastErrorMessage ?? null,
                        details: {
                            attemptedCount: flushResult.attemptedCount,
                            syncedCount: flushResult.syncedCount,
                            duplicateCount: flushResult.duplicateCount,
                            failedCount: flushResult.failedCount,
                            remainingCount: flushResult.remainingCount,
                            timedOut: flushResult.timedOut,
                        },
                    });
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
                console.error(
                    "Stop background location recording error:",
                    error,
                );
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

            if (finishedSessionId) {
                if (reason === "AUTO") {
                    await markRecordingContinuationAutoStopped(
                        finishedSessionId,
                    );
                    setAutoStoppedSessionId(finishedSessionId);
                } else {
                    await clearRecordingContinuationState(finishedSessionId);
                }
            }

            setContinuationPrompt(null);

            return finishedSessionId;
        },
        [
            saveLocationLog,
            updateLiveLocation,
            normalizedLiveShareOwnerValues,
            ensureForegroundLocationWatcher,
        ],
    );

    const confirmContinuation = useCallback(async () => {
        const recordingSessionId = recordingSessionIdRef.current;

        if (!recordingSessionId) {
            return;
        }

        await confirmRecordingContinuation(recordingSessionId);
        setContinuationPrompt(null);
    }, []);

    const clearAutoStoppedSession = useCallback(async () => {
        const sessionId = autoStoppedSessionId;

        if (sessionId) {
            await clearRecordingContinuationState(sessionId);
        }

        setAutoStoppedSessionId(null);
    }, [autoStoppedSessionId]);

    useEffect(() => {
        if (!hasRestoredTrackingState) {
            return;
        }

        let cancelled = false;
        let stoppingForTimeout = false;

        const checkContinuation = async () => {
            try {
                const continuationState = await getRecordingContinuationState();

                if (cancelled || !continuationState) {
                    return;
                }

                if (continuationState.autoStoppedAt) {
                    if (isRecordingRef.current) {
                        isRecordingRef.current = false;
                        recordingSessionIdRef.current = null;
                        setIsRecording(false);
                        setRecordingStartedAt(null);
                        setActiveRecordingSessionId(null);
                    }

                    setContinuationPrompt(null);
                    setAutoStoppedSessionId(
                        continuationState.recordingSessionId,
                    );
                    return;
                }

                const recordingSessionId = recordingSessionIdRef.current;

                if (!isRecordingRef.current || !recordingSessionId) {
                    return;
                }

                const evaluation =
                    await evaluateRecordingContinuation(recordingSessionId);

                if (cancelled) {
                    return;
                }

                if (evaluation.isDeadlineExpired && !stoppingForTimeout) {
                    stoppingForTimeout = true;
                    await stopRecording("AUTO");
                    return;
                }

                setContinuationPrompt(
                    evaluation.shouldShowConfirmation ? evaluation.state : null,
                );
            } catch (error) {
                console.error("Check recording continuation error:", error);
            }
        };

        void checkContinuation();
        const timerId = setInterval(() => {
            void checkContinuation();
        }, 1000);

        return () => {
            cancelled = true;
            clearInterval(timerId);
        };
    }, [hasRestoredTrackingState, stopRecording]);

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

                if (nextState === "active") {
                    /*
                     * background中に端末へ蓄積したLocationLogを、
                     * foreground復帰直後に時刻順で再送する。
                     */
                    void flushPendingLocationLogs({
                        force: true,
                        recordingSessionId: recordingSessionIdRef.current,
                        maxItems: 200,
                        timeBudgetMs: 15_000,
                    });
                }
            },
        );

        return () => {
            subscription.remove();
        };
    }, []);

    useEffect(() => {
        /*
         * 前回終了時・通信断時に残った未送信LocationLogを、
         * 記録状態の有無に関係なくアプリ起動時に再送する。
         */
        void flushPendingLocationLogs({
            force: true,
            maxItems: 500,
            timeBudgetMs: 20_000,
        });
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
        continuationPrompt,
        autoStoppedSessionId,
        startRecording,
        stopRecording,
        confirmContinuation,
        clearAutoStoppedSession,
    };
}

function shouldSaveLocationFromSavedLocation(
    lastSavedLocation: SavedLocation | null,
    latitude: number,
    longitude: number,
    recordedAtMs: number,
    intervalMs: number,
    distanceMeters: number,
) {
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
        Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 30_000;

    const configuredDistanceMeters =
        Number.isFinite(distanceMeters) && distanceMeters > 0
            ? distanceMeters
            : 50;

    return (
        elapsedMs >= configuredIntervalMs ||
        distance >= configuredDistanceMeters
    );
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
