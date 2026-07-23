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
    acquireLocationSaveLock,
    createLocationLogId,
    createLocationSaveLockScopeKey,
    createLocationUniqueKey,
    isDuplicateLocationCreateError,
    isLocationLogAlreadySaved,
    releaseLocationSaveLock,
} from "../services/locationLogDeduplicationService";
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
            const recordingSessionId = recordingSessionIdRef.current;

            if (!isRecordingRef.current || !recordingSessionId) {
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
                    recordingSessionId,
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

            updateDistanceFromStart(location);

            const userId = recordingUserIdRef.current;

            if (!userId) {
                console.error(
                    "Skip foreground LocationLog create: userId is missing",
                );

                await saveBackgroundLocationDebugLog({
                    userId: null,
                    recordingSessionId,
                    eventName: "foregroundLocationLogSkippedNoUserId",
                    details: {
                        recordedAt,
                        latitude,
                        longitude,
                    },
                });

                return;
            }

            const lockScopeKey = createLocationSaveLockScopeKey(
                userId,
                recordingSessionId,
            );
            const lock = await acquireLocationSaveLock(lockScopeKey);

            if (!lock) {
                return;
            }

            try {
                /*
                 * ロック取得後に共有状態を再取得し、
                 * background側が直前に保存した地点を反映する。
                 */
                const { state } = await getBackgroundRecordingStatus();

                if (
                    !isRecordingRef.current ||
                    recordingSessionIdRef.current !== recordingSessionId ||
                    !state?.isRecording ||
                    state.recordingSessionId !== recordingSessionId
                ) {
                    return;
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

                    await saveBackgroundLocationDebugLog({
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

                    return;
                }

                /*
                 * 開始・停止地点のforceSaveでは、状態に先行設定された
                 * lastSavedLocationによって自分自身を除外しない。
                 * DBの決定的idによる完全重複防止は常に実施する。
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
                    return;
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
                    return;
                }

                const locationUniqueKey = createLocationUniqueKey({
                    userId,
                    recordingSessionId,
                    recordedAt,
                    latitude,
                    longitude,
                    accuracy,
                });
                const locationLogId = createLocationLogId(locationUniqueKey);

                if (await isLocationLogAlreadySaved(locationLogId)) {
                    return;
                }

                const batterySnapshot = await getBatterySnapshot();

                const sharedOwners =
                    normalizedLiveShareOwnerValues.length > 0
                        ? normalizedLiveShareOwnerValues
                        : undefined;

                const result = await client.models.LocationLog.create({
                    id: locationLogId,
                    userId,
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
                    if (
                        isDuplicateLocationCreateError(result.errors) ||
                        (await isLocationLogAlreadySaved(locationLogId))
                    ) {
                        return;
                    }

                    const errorMessage = getErrorMessage(result.errors);

                    console.error(
                        "Auto LocationLog create errors:",
                        result.errors,
                    );

                    await saveBackgroundLocationDebugLog({
                        userId,
                        recordingSessionId,
                        eventName: "foregroundLocationLogCreateFailed",
                        errorMessage,
                        details: {
                            recordedAt,
                            latitude,
                            longitude,
                            source: "foreground",
                            locationUniqueKey,
                        },
                    });

                    return;
                }

                const nextSavedLocation = {
                    latitude,
                    longitude,
                    recordedAt: recordedAtMs,
                };

                /*
                 * create成功後、ロックを解放する前にforeground refと
                 * AsyncStorageの最終保存位置を両方更新する。
                 */
                lastSavedLocationRef.current = nextSavedLocation;

                await updateBackgroundRecordingLastSavedLocation(
                    nextSavedLocation,
                );

                const continuationEvaluation =
                    await incrementRecordingContinuationPointCount(
                        recordingSessionId,
                    );

                if (continuationEvaluation.shouldShowConfirmation) {
                    setContinuationPrompt(continuationEvaluation.state);
                }

                console.log("Auto location saved:", {
                    latitude,
                    longitude,
                    recordedAt,
                });
            } catch (error) {
                console.error("Auto LocationLog create error:", error);
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

            console.log(
                "[BackgroundLocation] restored task status:",
                hasStarted,
            );

            console.log("[BackgroundLocation] restored recording state:", {
                hasStarted,
                hasState: Boolean(state),
                isRecording: state?.isRecording ?? false,
                recordingSessionId: state?.recordingSessionId ?? null,
                userId: state?.userId ?? null,
                startedAt: state?.startedAt ?? null,
            });

            if (!hasStarted || !state?.userId) {
                console.warn(
                    "[BackgroundLocation] recording state was not restored:",
                    {
                        reason: !hasStarted
                            ? "background task is not started"
                            : "recording state userId is missing",
                        hasStarted,
                        hasState: Boolean(state),
                        isRecording: state?.isRecording ?? false,
                        recordingSessionId: state?.recordingSessionId ?? null,
                        userId: state?.userId ?? null,
                    },
                );
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

                    /*
                     * 権限確認などのawait中に自動記録が開始される可能性があるため、
                     * バックグラウンド状態を直前に再取得する。
                     */
                    const { hasStarted, state: latestBackgroundState } =
                        await getBackgroundRecordingStatus();

                    const latestRecordingSessionId =
                        recordingSessionIdRef.current ??
                        latestBackgroundState?.recordingSessionId ??
                        null;

                    const isRecordingNow =
                        Boolean(latestRecordingSessionId) ||
                        latestBackgroundState?.isRecording === true;

                    if (hasStarted && latestBackgroundState) {
                        /*
                         * 既存タスクが動いている場合は、記録状態を壊さず
                         * 現在地共有に関する項目だけを更新する。
                         */
                        await updateBackgroundLocationTrackingState({
                            liveShareOwnerValues:
                                normalizedLiveShareOwnerValues,
                            liveLocationId: liveLocationIdRef.current,
                        });
                    } else {
                        await startBackgroundLocationTracking({
                            userId,
                            isRecording: isRecordingNow,
                            recordingSessionId: isRecordingNow
                                ? latestRecordingSessionId
                                : null,
                            startedAt: isRecordingNow
                                ? (latestBackgroundState?.startedAt ?? null)
                                : null,
                            intervalMs:
                                latestBackgroundState?.intervalMs ?? intervalMs,
                            distanceMeters:
                                latestBackgroundState?.distanceMeters ??
                                distanceMeters,
                            liveShareOwnerValues:
                                normalizedLiveShareOwnerValues,
                            liveLocationId: liveLocationIdRef.current,
                            lastSavedLocation:
                                latestBackgroundState?.lastSavedLocation ??
                                null,
                        });
                    }
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
        Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60_000;

    const configuredDistanceMeters =
        Number.isFinite(distanceMeters) && distanceMeters > 0
            ? distanceMeters
            : 100;

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
