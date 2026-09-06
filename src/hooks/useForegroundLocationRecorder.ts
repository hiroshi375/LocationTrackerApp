import { getCurrentUser } from "aws-amplify/auth";
import * as Location from "expo-location";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState } from "react-native";

import * as Battery from "expo-battery";
import { client } from "../lib/client";
import {
    ensureBackgroundLocationPermission,
    getBackgroundRecordingStatus,
    isBackgroundLocationDisclosureDeclined,
    isBackgroundLocationPermissionError,
    isForegroundLocationPermissionError,
    startBackgroundLocationRecording,
    stopBackgroundLocationRecording,
    updateBackgroundRecordingLiveLocationId,
    updateForegroundLastSavedLocation,
    verifyAndRecoverBackgroundLocationRecording,
} from "../services/backgroundLocationService";
import {
    acquireLocationSaveLock,
    createLocationLogId,
    createLocationSaveLockScopeKey,
    createLocationUniqueKey,
    isDuplicateLocationCreateError,
    releaseLocationSaveLock,
} from "../services/locationLogDeduplicationService";
import {
    confirmRecordingContinuation,
    evaluateRecordingContinuation,
    initializeRecordingContinuationState,
    markRecordingContinuationAutoStopped,
    pauseRecordingContinuationConfirmation,
    type RecordingContinuationState,
} from "../services/recordingContinuationService";
import {
    calculateDistanceMeters,
    isExactDuplicateLocation,
    isNearDuplicateLocation,
} from "../utils/locationDuplicate";
import type { SubscriptionTier } from "../config/subscriptionPlan";
import {
    clearRecordingPlanLimitState,
    evaluateRecordingPlanDurationLimit,
    getRecordingPlanLimitState,
    initializeRecordingPlanLimitState,
    releaseRecordingPlanPointReservation,
    reserveRecordingPlanPoint,
    type RecordingPlanLimitReason,
} from "../services/recordingPlanLimitService";

type SavedLocation = {
    latitude: number;
    longitude: number;
    recordedAt: number;
};

type RecorderOptions = {
    intervalMs: number;
    distanceMeters: number;
    liveShareOwnerValues?: string[];
    subscriptionTier: SubscriptionTier;
};

type StopRecordingOptions = {
    skipFinalLocationSave?: boolean;
};

export type RecordingPlanLimitAutoStopReason =
    | "FREE_PLAN_DURATION_LIMIT"
    | "FREE_PLAN_POINT_LIMIT";

export type RecordingPlanLimitAutoStop = {
    recordingSessionId: string;
    reason: RecordingPlanLimitAutoStopReason;
};

type LiveLocationMutationResult = {
    data?: {
        id?: string | null;
    } | null;
    errors?: unknown;
};

const FOREGROUND_LOCATION_SAMPLE_INTERVAL_MS = 5_000;

function getForegroundLocationSampleIntervalMs(intervalMs: number): number {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        return FOREGROUND_LOCATION_SAMPLE_INTERVAL_MS;
    }

    return Math.min(intervalMs, FOREGROUND_LOCATION_SAMPLE_INTERVAL_MS);
}

export function useForegroundLocationRecorder({
    intervalMs,
    distanceMeters,
    liveShareOwnerValues = [],
    subscriptionTier,
}: RecorderOptions) {
    const [isRecording, setIsRecording] = useState(false);
    const [recordingStartedAt, setRecordingStartedAt] = useState<string | null>(
        null,
    );

    const lastSavedLocationRef = useRef<SavedLocation | null>(null);
    const savingLocationKeyRef = useRef<string | null>(null);
    const foregroundSaveRunningRef = useRef(false);
    const recordingSessionIdRef = useRef<string | null>(null);
    const recordingUserIdRef = useRef<string | null>(null);
    const liveLocationIdRef = useRef<string | null>(null);
    const foregroundQueueDrainRunningRef = useRef(false);
    const isRecordingRef = useRef(false);

    const recordingSubscriptionRef =
        useRef<Location.LocationSubscription | null>(null);

    const liveSharingSubscriptionRef =
        useRef<Location.LocationSubscription | null>(null);

    const [continuationPrompt, setContinuationPrompt] =
        useState<RecordingContinuationState | null>(null);

    const [autoStoppedSessionId, setAutoStoppedSessionId] = useState<
        string | null
    >(null);
    const [activeRecordingSessionId, setActiveRecordingSessionId] = useState<
        string | null
    >(null);
    const [planLimitAutoStop, setPlanLimitAutoStop] =
        useState<RecordingPlanLimitAutoStop | null>(null);

    const [pendingPlanLimitStop, setPendingPlanLimitStop] = useState<{
        recordingSessionId: string;
        reason: RecordingPlanLimitReason;
    } | null>(null);

    const startLocationRef = useRef<{
        latitude: number;
        longitude: number;
    } | null>(null);

    const appStateRef = useRef(AppState.currentState);

    const [distanceFromStartMeters, setDistanceFromStartMeters] = useState<
        number | null
    >(null);

    const normalizedLiveShareOwnerValues = useMemo(() => {
        return Array.from(new Set(liveShareOwnerValues.filter(Boolean)));
    }, [liveShareOwnerValues]);

    const getLatestSavedLocation = useCallback(
        (
            foregroundLocation: SavedLocation | null,
            backgroundLocation: SavedLocation | null,
        ): SavedLocation | null => {
            if (!foregroundLocation) {
                return backgroundLocation;
            }

            if (!backgroundLocation) {
                return foregroundLocation;
            }

            return backgroundLocation.recordedAt > foregroundLocation.recordedAt
                ? backgroundLocation
                : foregroundLocation;
        },
        [],
    );

    // 位置を保存すべきか判定する関数
    const shouldSaveLocation = useCallback(
        (
            latitude: number,
            longitude: number,
            recordedAtMs: number,
            baselineLocation: SavedLocation | null,
        ) => {
            if (!baselineLocation) {
                return true;
            }

            const elapsedMs = recordedAtMs - baselineLocation.recordedAt;

            if (elapsedMs <= 0) {
                return false;
            }

            const distance = calculateDistanceMeters(
                baselineLocation.latitude,
                baselineLocation.longitude,
                latitude,
                longitude,
            );

            /*
             * 保存条件は従来と同じ。
             *
             * 指定時間以上経過
             * OR
             * 指定距離以上移動
             */
            return elapsedMs >= intervalMs || distance >= distanceMeters;
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

            const isCurrentlyRecording = isRecordingRef.current;

            const recordingSessionId = isCurrentlyRecording
                ? recordingSessionIdRef.current
                : null;

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
                    isRecording: isCurrentlyRecording,
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

            /*
             * Foreground LocationLog保存処理を完全に直列化する。
             *
             * native側は最大5秒ごとにcallbackするため、
             * 前回LocationLog.create()が終わっていない間に
             * 次の地点が保存判定へ入らないようにする。
             */
            if (foregroundSaveRunningRef.current) {
                console.log(
                    "Skip foreground location while previous save is running:",
                    {
                        latitude,
                        longitude,
                        recordedAt,
                    },
                );

                return;
            }

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

            let baselineLocation = lastSavedLocationRef.current;

            if (!forceSave) {
                try {
                    const { state } = await getBackgroundRecordingStatus();

                    const backgroundLastSavedLocation =
                        state?.lastSavedLocation ?? null;

                    /*
                     * FG/BGのうち、新しい保存地点を
                     * 次回保存判定の共通基準にする。
                     */
                    baselineLocation = getLatestSavedLocation(
                        lastSavedLocationRef.current,
                        backgroundLastSavedLocation,
                    );

                    if (
                        isExactDuplicateLocation(
                            baselineLocation,
                            latitude,
                            longitude,
                            recordedAtMs,
                        ) ||
                        isNearDuplicateLocation(
                            baselineLocation,
                            latitude,
                            longitude,
                            recordedAtMs,
                        )
                    ) {
                        console.log(
                            "Skip duplicate foreground location by latest saved state:",
                            {
                                latitude,
                                longitude,
                                recordedAt,
                                baselineRecordedAt:
                                    baselineLocation?.recordedAt ?? null,
                            },
                        );

                        return;
                    }
                } catch (error) {
                    console.error(
                        "Check background saved location error:",
                        error,
                    );

                    /*
                     * Background stateの取得に失敗しても、
                     * Foreground側の最終保存地点を使って
                     * 従来どおり判定する。
                     */
                    baselineLocation = lastSavedLocationRef.current;
                }
            }

            if (
                !forceSave &&
                !shouldSaveLocation(
                    latitude,
                    longitude,
                    recordedAtMs,
                    baselineLocation,
                )
            ) {
                console.log("Skip foreground location by save condition:", {
                    latitude,
                    longitude,
                    recordedAt,
                    baselineRecordedAt: baselineLocation?.recordedAt ?? null,
                    intervalMs,
                    distanceMeters,
                });

                return;
            }

            try {
                /*
                 * ここからLocationLog.create完了まで、
                 * 別のForeground callbackを保存処理へ入れない。
                 */
                foregroundSaveRunningRef.current = true;
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

                /*
                 * Foreground / Background / SQLite再送の
                 * LocationLog保存とポイント上限判定を
                 * 同じセッション単位で排他する。
                 *
                 * これにより、999ポイントの状態から
                 * FGとBGが同時に1000件目を確保することを防ぐ。
                 */
                const lockScopeKey = createLocationSaveLockScopeKey(
                    currentUser.userId,
                    recordingSessionId,
                );

                const lock = await acquireLocationSaveLock(lockScopeKey);

                if (!lock) {
                    console.log(
                        "[SubscriptionPlanLimit] Skip foreground save because location save lock is busy:",
                        {
                            recordingSessionId,
                            locationLogId,
                            recordedAt,
                        },
                    );

                    return;
                }

                /*
                 * 今回のLocationLog IDを新しくポイント枠として予約したか。
                 *
                 * 明示的なcreate失敗時だけreservationを戻すために保持する。
                 */
                let reservationCreated = false;

                /*
                 * 今回の地点を予約したことで1000ポイントへ到達したか。
                 *
                 * trueの場合でも1000件目そのものは保存する。
                 * 保存成功後に自動停止を要求する。
                 */
                let reservationReachedLimit = false;

                try {
                    const reservation = await reserveRecordingPlanPoint(
                        recordingSessionId,
                        locationLogId,
                        recordedAtMs,
                    );

                    /*
                     * 2時間上限、または既に1000ポイント到達済みの場合。
                     *
                     * この地点はLocationLog.create()へ進めない。
                     */
                    if (!reservation.allowed) {
                        console.log(
                            "[SubscriptionPlanLimit] Foreground save blocked:",
                            {
                                recordingSessionId,
                                locationLogId,
                                recordedAt,
                                reason: reservation.reason,
                                reservedPointCount:
                                    reservation.state?.reservedLocationLogIds
                                        .length ?? null,
                            },
                        );

                        setPendingPlanLimitStop({
                            recordingSessionId,
                            reason: reservation.reason ?? "POINTS",
                        });

                        return;
                    }

                    reservationCreated = !reservation.alreadyReserved;

                    reservationReachedLimit =
                        reservation.reachedByThisReservation;

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
                         * 同じ決定的IDが既に存在する場合。
                         *
                         * Cloud上では既に1ポイントとして存在しているので、
                         * reservationは解除しない。
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

                            /*
                             * この予約によって1000ポイントへ到達している場合、
                             * duplicateであってもCloud上には地点が存在するため
                             * 上限到達として停止する。
                             */
                            if (reservationReachedLimit) {
                                setPendingPlanLimitStop({
                                    recordingSessionId,
                                    reason: "POINTS",
                                });
                            }

                            return;
                        }

                        /*
                         * result.errorsとして明示的にcreate失敗した場合は、
                         * Cloudへ保存されなかったと判断できるため、
                         * 今回新規取得したポイント枠を戻す。
                         */
                        if (reservationCreated) {
                            try {
                                await releaseRecordingPlanPointReservation(
                                    recordingSessionId,
                                    locationLogId,
                                );
                            } catch (reservationReleaseError) {
                                console.error(
                                    "[SubscriptionPlanLimit] Release foreground reservation error:",
                                    reservationReleaseError,
                                );
                            }
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

                    await updateForegroundLastSavedLocation(nextSavedLocation);

                    console.log("Auto location saved:", {
                        latitude,
                        longitude,
                        recordedAt,
                    });

                    /*
                     * 1000件目そのものは保存済み。
                     *
                     * この地点の保存によってポイント上限へ到達した場合、
                     * これ以降のLocationLogを保存させないため、
                     * 記録停止処理を要求する。
                     */
                    if (reservationReachedLimit) {
                        console.log(
                            "[SubscriptionPlanLimit] Foreground point limit reached:",
                            {
                                recordingSessionId,
                                locationLogId,
                                recordedAt,
                                reason: "POINTS",
                            },
                        );

                        setPendingPlanLimitStop({
                            recordingSessionId,
                            reason: "POINTS",
                        });
                    }
                } catch (error) {
                    /*
                     * throwされた例外の場合、
                     * 通信結果が不明なケースがあり得る。
                     *
                     * 例えばtimeout後にCloud側ではcreate成功している可能性がある。
                     * ここでreservationを戻すと1001件目を許してしまう可能性があるため、
                     * reservationは維持する。
                     */
                    if (isDuplicateLocationCreateError(error)) {
                        console.log(
                            "Skip duplicate foreground LocationLog exception by deterministic id:",
                            {
                                locationLogId,
                                recordingSessionId,
                                recordedAt,
                                latitude,
                                longitude,
                            },
                        );

                        if (reservationReachedLimit) {
                            setPendingPlanLimitStop({
                                recordingSessionId,
                                reason: "POINTS",
                            });
                        }

                        return;
                    }

                    console.error("Auto LocationLog create error:", error);
                } finally {
                    /*
                     * Phase 3用reservationとは別物。
                     *
                     * LocationLog保存処理そのものの排他ロックは
                     * 成功・失敗・returnのどの経路でも必ず解除する。
                     */
                    try {
                        await releaseLocationSaveLock(lock);
                    } catch (releaseError) {
                        console.error(
                            "Release foreground location save lock error:",
                            releaseError,
                        );
                    }
                }
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

                foregroundSaveRunningRef.current = false;
            }
        },
        [
            shouldSaveLocation,
            getLatestSavedLocation,
            updateDistanceFromStart,
            normalizedLiveShareOwnerValues,
            intervalMs,
            distanceMeters,
        ],
    );

    /**
     * Foreground位置監視を登録する。
     *
     * forceRestart=trueの場合だけ既存watcherを破棄して再登録する。
     *
     * 位置取得条件・保存条件は従来と同じ。
     */
    const ensureForegroundRecordingWatcher = useCallback(
        async (forceRestart: boolean = false): Promise<boolean> => {
            if (!recordingSessionIdRef.current) {
                return false;
            }

            if (forceRestart) {
                recordingSubscriptionRef.current?.remove();
                recordingSubscriptionRef.current = null;
            }

            if (recordingSubscriptionRef.current) {
                return true;
            }

            try {
                const subscription = await Location.watchPositionAsync(
                    {
                        accuracy: Location.Accuracy.BestForNavigation,

                        /*
                         * 現在と同じ位置取得方法を維持する。
                         */
                        timeInterval:
                            getForegroundLocationSampleIntervalMs(intervalMs),

                        distanceInterval: 0,
                    },
                    async (location) => {
                        if (appStateRef.current !== "active") {
                            return;
                        }

                        await saveLocationLog(location);
                    },
                );

                recordingSubscriptionRef.current = subscription;

                console.log("Foreground recording watcher registered:", {
                    recordingSessionId: recordingSessionIdRef.current,
                    forceRestart,
                });

                return true;
            } catch (error) {
                console.error(
                    "Foreground recording watcher registration error:",
                    error,
                );

                return false;
            }
        },
        [intervalMs, saveLocationLog],
    );

    const resetRecordingState = useCallback(() => {
        recordingSubscriptionRef.current?.remove();
        recordingSubscriptionRef.current = null;

        if (normalizedLiveShareOwnerValues.length === 0) {
            liveLocationIdRef.current = null;
        }
        recordingSessionIdRef.current = null;
        recordingUserIdRef.current = null;
        startLocationRef.current = null;
        lastSavedLocationRef.current = null;
        isRecordingRef.current = false;

        setActiveRecordingSessionId(null);
        setRecordingStartedAt(null);
        setDistanceFromStartMeters(null);
        setIsRecording(false);
    }, [normalizedLiveShareOwnerValues]);

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
            recordingUserIdRef.current = state.userId;
            liveLocationIdRef.current = state.liveLocationId ?? null;
            lastSavedLocationRef.current = state.lastSavedLocation ?? null;
            isRecordingRef.current = true;
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
        if (
            isRecording ||
            recordingSubscriptionRef.current ||
            isStartingRef.current
        ) {
            return;
        }

        isStartingRef.current = true;

        try {
            try {
                await ensureBackgroundLocationPermission();
            } catch (error) {
                const isExpectedPermissionResult =
                    isBackgroundLocationDisclosureDeclined(error) ||
                    isForegroundLocationPermissionError(error) ||
                    isBackgroundLocationPermissionError(error);

                if (isExpectedPermissionResult) {
                    /*
                     * 事前説明のキャンセルや権限拒否は、
                     * LocationHomeScreen側で判定するため呼び出し元へ返す。
                     */
                    throw error;
                }

                console.error("Location permission error:", error);

                /*
                 * 画面側でエラーを表示するため、
                 * このフック内ではAlertを表示しない。
                 */
                throw error;
            }

            const newSessionId = createRecordingSessionId();

            recordingSessionIdRef.current = newSessionId;
            isRecordingRef.current = true;

            setContinuationPrompt(null);
            setAutoStoppedSessionId(null);
            setPlanLimitAutoStop(null);

            setActiveRecordingSessionId(newSessionId);
            lastSavedLocationRef.current = null;

            const startedAt = new Date().toISOString();

            try {
                await initializeRecordingContinuationState(
                    newSessionId,
                    startedAt,
                );

                await initializeRecordingPlanLimitState(
                    newSessionId,
                    startedAt,
                    subscriptionTier,
                );
            } catch (error) {
                /*
                 * Plan Limit stateの初期化途中で失敗した場合でも、
                 * 部分的にAsyncStorageへ残っている可能性を考慮して削除する。
                 */
                try {
                    await clearRecordingPlanLimitState(newSessionId);
                } catch (planLimitCleanupError) {
                    console.error(
                        "[SubscriptionPlanLimit] Clear plan limit state after initialization failure error:",
                        planLimitCleanupError,
                    );
                }

                resetRecordingState();

                console.error(
                    "[SubscriptionPlanLimit] Initialize recording state error:",
                    error,
                );

                throw error;
            }

            setRecordingStartedAt(startedAt);

            let currentLocation: Location.LocationObject;

            try {
                currentLocation = await Location.getCurrentPositionAsync({
                    accuracy: Location.Accuracy.Balanced,
                });
            } catch (error) {
                /*
                 * recordingPlanLimitStateはすでに初期化済みなので、
                 * 記録開始に失敗した場合は残さない。
                 */
                try {
                    await clearRecordingPlanLimitState(newSessionId);
                } catch (planLimitCleanupError) {
                    console.error(
                        "[SubscriptionPlanLimit] Clear plan limit state after current location failure error:",
                        planLimitCleanupError,
                    );
                }

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
                recordingUserIdRef.current = currentUser.userId;

                await startBackgroundLocationRecording({
                    userId: currentUser.userId,
                    recordingSessionId: newSessionId,
                    startedAt,
                    recordingExpiresAt: null,
                    intervalMs,
                    distanceMeters,
                    liveShareOwnerValues: normalizedLiveShareOwnerValues,
                    liveLocationId: liveLocationIdRef.current,
                    lastSavedLocation: {
                        latitude: currentLocation.coords.latitude,
                        longitude: currentLocation.coords.longitude,
                        recordedAt: currentLocationRecordedAtMs,
                    },
                });
            } catch (error) {
                /*
                 * Background開始が途中まで成功している可能性があるため、
                 * まずBackground側を停止する。
                 */
                try {
                    await stopBackgroundLocationRecording();
                } catch (stopError) {
                    console.error(
                        "Stop background after start error:",
                        stopError,
                    );
                }

                /*
                 * startRecording開始時に作成した
                 * Phase 3のPlan Limit stateも削除する。
                 */
                try {
                    await clearRecordingPlanLimitState(newSessionId);
                } catch (planLimitCleanupError) {
                    console.error(
                        "[SubscriptionPlanLimit] Clear plan limit state after background start failure error:",
                        planLimitCleanupError,
                    );
                }

                resetRecordingState();

                const isExpectedPermissionResult =
                    isBackgroundLocationDisclosureDeclined(error) ||
                    isForegroundLocationPermissionError(error) ||
                    isBackgroundLocationPermissionError(error);

                if (isExpectedPermissionResult) {
                    throw error;
                }

                console.error(
                    "Start background location recording error:",
                    error,
                );

                throw error;
            }

            const foregroundWatcherStarted =
                await ensureForegroundRecordingWatcher(false);

            if (!foregroundWatcherStarted) {
                console.error(
                    "Foreground recording watcher could not be started.",
                );
            }

            isRecordingRef.current = true;
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
        ensureForegroundRecordingWatcher,
        subscriptionTier,
    ]);

    const locationHealthCheckRunningRef = useRef(false);

    const verifyAndRecoverLocationRecording = useCallback(
        async (reason: "periodic" | "returnedToForeground"): Promise<void> => {
            if (locationHealthCheckRunningRef.current) {
                return;
            }

            if (!isRecordingRef.current || !recordingSessionIdRef.current) {
                return;
            }

            /*
             * Android background中にJS timerが停止していて、
             * activeへ戻った瞬間に呼ばれた場合も、
             * health checkはforegroundで実行する。
             */
            if (AppState.currentState !== "active") {
                return;
            }

            locationHealthCheckRunningRef.current = true;

            try {
                const result =
                    await verifyAndRecoverBackgroundLocationRecording();

                console.log("Location recording health check completed:", {
                    triggerReason: reason,
                    recordingSessionId: recordingSessionIdRef.current,
                    ...result,
                });

                if (!result.permissionGranted) {
                    /*
                     * 権限が本当に失われている場合だけ、
                     * アプリ側で勝手に再許可はできない。
                     *
                     * ここでは再登録を行わない。
                     */
                    return;
                }

                /*
                 * foregroundへ復帰した場合は、
                 * foreground側の位置watcherを確実に再登録する。
                 *
                 * Background taskのhealth checkは診断専用とし、
                 * ここからBackground taskの再起動は行わない。
                 */
                if (reason === "returnedToForeground") {
                    await ensureForegroundRecordingWatcher(true);
                }
            } catch (error) {
                console.error("Location recording health check error:", error);
            } finally {
                locationHealthCheckRunningRef.current = false;
            }
        },
        [ensureForegroundRecordingWatcher],
    );

    const drainSQLiteQueueOnForeground =
        useCallback(async (): Promise<void> => {
            if (foregroundQueueDrainRunningRef.current) {
                return;
            }

            const recordingSessionId = recordingSessionIdRef.current;

            const userId = recordingUserIdRef.current;

            if (!recordingSessionId || !userId) {
                return;
            }

            foregroundQueueDrainRunningRef.current = true;

            try {
                const { drainLocationQueueRepeatedly } =
                    await import("../services/locationQueueUploadService");

                const result = await drainLocationQueueRepeatedly({
                    userId,
                    recordingSessionId,
                    intervalMs,
                    distanceMeters,
                    fallbackSharedOwners: normalizedLiveShareOwnerValues,

                    /*
                     * foregroundではbackground callbackより積極的に回収する。
                     */
                    maxItems: 10,
                    maxIterations: 50,
                });

                console.log("Foreground SQLite queue drain completed:", {
                    recordingSessionId,
                    ...result,
                });

                /*
                 * SQLite再送によってFreeプラン上限へ到達した場合。
                 *
                 * ここではstopRecording()を直接呼ばず、
                 * 既存のpendingPlanLimitStopへ停止要求を渡す。
                 */
                if (result.stopReason === "planLimitReached") {
                    try {
                        const planLimitState =
                            await getRecordingPlanLimitState();

                        const reason: RecordingPlanLimitReason =
                            planLimitState?.limitReachedReason ?? "POINTS";

                        console.log(
                            "[SubscriptionPlanLimit] Foreground SQLite drain requested stop:",
                            {
                                recordingSessionId,
                                reason,
                                reservedPointCount:
                                    planLimitState?.reservedLocationLogIds
                                        .length ?? null,
                            },
                        );

                        setPendingPlanLimitStop({
                            recordingSessionId,
                            reason,
                        });
                    } catch (planLimitError) {
                        /*
                         * plan state取得に失敗しても、
                         * stopReason自体がplanLimitReachedなので停止は行う。
                         *
                         * reasonを特定できない場合はPOINTSをfallbackとする。
                         */
                        console.error(
                            "[SubscriptionPlanLimit] Read plan limit state after SQLite drain error:",
                            planLimitError,
                        );

                        setPendingPlanLimitStop({
                            recordingSessionId,
                            reason: "POINTS",
                        });
                    }

                    return;
                }

                const {
                    cleanupProcessedLocationQueue,
                    getLocationQueueStatusSummary,
                } = await import("../services/locationLocationQueueService");

                const summary = await getLocationQueueStatusSummary({
                    userId,
                    recordingSessionId,
                });

                console.log("Foreground SQLite queue summary:", {
                    recordingSessionId,
                    ...summary,
                });

                const cleanupResult = await cleanupProcessedLocationQueue({
                    retentionDays: 7,
                });

                if (cleanupResult.deletedCount > 0) {
                    console.log(
                        "Foreground SQLite queue cleanup completed:",
                        cleanupResult,
                    );
                }
            } catch (error) {
                /*
                 * foreground復帰時のキュー送信に失敗しても、
                 * 自動記録自体は止めない。
                 */
                console.error("Foreground SQLite queue drain error:", error);
            } finally {
                foregroundQueueDrainRunningRef.current = false;
            }
        }, [intervalMs, distanceMeters, normalizedLiveShareOwnerValues]);

    const drainSQLiteQueueBeforeStop = useCallback(
        async (input: {
            userId: string;
            recordingSessionId: string;
        }): Promise<void> => {
            try {
                const { drainLocationQueueRepeatedly } =
                    await import("../services/locationQueueUploadService");

                /*
                 * 最終地点のSQLite投入直後でも処理できるよう、
                 * 停止処理では通常より多く繰り返す。
                 *
                 * ただし現在のキュー取得には60秒条件があるため、
                 * 後述のforceIncludeRecentが必要。
                 */
                const result = await drainLocationQueueRepeatedly({
                    userId: input.userId,
                    recordingSessionId: input.recordingSessionId,
                    intervalMs,
                    distanceMeters,
                    fallbackSharedOwners: normalizedLiveShareOwnerValues,

                    maxItems: 10,
                    maxIterations: 50,

                    forceIncludeRecent: true,
                });

                console.log("Stop SQLite queue drain completed:", {
                    recordingSessionId: input.recordingSessionId,
                    ...result,
                });

                const {
                    cleanupProcessedLocationQueue,
                    getLocationQueueStatusSummary,
                } = await import("../services/locationLocationQueueService");

                const summary = await getLocationQueueStatusSummary({
                    userId: input.userId,
                    recordingSessionId: input.recordingSessionId,
                });

                console.log("Stop SQLite queue summary:", {
                    recordingSessionId: input.recordingSessionId,
                    ...summary,
                });

                await cleanupProcessedLocationQueue({
                    retentionDays: 7,
                });
            } catch (error) {
                /*
                 * キュー送信に失敗しても、
                 * ユーザーの停止操作自体は完了させる。
                 * pendingはSQLiteに残り、次回再送可能。
                 */
                console.error("Stop SQLite queue drain error:", error);
            }
        },
        [intervalMs, distanceMeters, normalizedLiveShareOwnerValues],
    );

    // 記録停止関数
    const stopRecording = useCallback(
        async (options: StopRecordingOptions = {}): Promise<string | null> => {
            /*
             * 後続処理でrefをnullにしても使用できるよう、
             * 停止対象のセッション情報を最初に退避する。
             */
            const finishedSessionId = recordingSessionIdRef.current;

            const finishedUserId = recordingUserIdRef.current;

            /*
             * foregroundの位置監視を先に止める。
             * これ以降、新しいforeground callbackを発生させない。
             */
            recordingSubscriptionRef.current?.remove();
            recordingSubscriptionRef.current = null;

            /*
             * background側の記録状態を解除する前に、
             * 最終地点を保存する。
             */
            if (!options.skipFinalLocationSave && finishedSessionId) {
                try {
                    const currentLocation =
                        await Location.getCurrentPositionAsync({
                            accuracy: Location.Accuracy.Balanced,
                        });

                    await updateLiveLocation(currentLocation);

                    await saveLocationLog(currentLocation, true);
                } catch (error) {
                    /*
                     * 最終地点の取得・保存に失敗しても、
                     * 停止処理とSQLiteキュー送信は継続する。
                     */
                    console.error("Save stop location error:", error);
                }
            }

            /*
             * セッション情報を解除する前に、
             * SQLiteのpendingキューを送信する。
             *
             * 停止時はforceIncludeRecent=trueで、
             * 60秒未満の最新地点も送信対象にする。
             */
            if (finishedSessionId && finishedUserId) {
                try {
                    await drainSQLiteQueueBeforeStop({
                        userId: finishedUserId,
                        recordingSessionId: finishedSessionId,
                    });
                } catch (error) {
                    /*
                     * SQLite送信に失敗しても停止操作は完了させる。
                     * 未送信行はpendingのままSQLiteへ残る。
                     */
                    console.error(
                        "Drain SQLite queue before stop error:",
                        error,
                    );
                }
            }

            /*
             * 最終地点保存とSQLiteキュー送信が終わった後に、
             * background側の記録状態を解除する。
             */
            const shouldContinueLiveSharing =
                normalizedLiveShareOwnerValues.length > 0;

            try {
                await stopBackgroundLocationRecording({
                    continueLiveSharing: shouldContinueLiveSharing,
                });
            } catch (error) {
                console.error(
                    "Stop background location recording error:",
                    error,
                );
            }

            /*
             * LiveLocationを記録停止状態へ更新する。
             */
            if (liveLocationIdRef.current) {
                try {
                    const shouldContinueLiveSharing =
                        normalizedLiveShareOwnerValues.length > 0;

                    const result = await client.models.LiveLocation.update({
                        id: liveLocationIdRef.current,
                        isActive: shouldContinueLiveSharing,
                        isRecording: false,
                        recordingSessionId: null,
                        updatedAt: new Date().toISOString(),
                        sharedOwners: normalizedLiveShareOwnerValues,
                    });

                    if (result.errors) {
                        console.error(
                            "LiveLocation stop update errors:",
                            result.errors,
                        );
                    }
                } catch (error) {
                    console.error("LiveLocation stop update error:", error);
                }
            }

            /*
             * すべての停止処理が終わった後にrefを解除する。
             */
            if (normalizedLiveShareOwnerValues.length === 0) {
                liveLocationIdRef.current = null;
            }

            /*
             * Phase 3の記録単位プラン制限stateを、
             * 停止処理の最後に解除する。
             *
             * SQLite pending drainより前に消してしまうと、
             * 停止時のSQLite再送が
             * 2時間 / 1000ポイント制限を認識できなくなるため、
             * 必ずdrain・Background停止・LiveLocation更新の後で実行する。
             */
            if (finishedSessionId) {
                try {
                    await clearRecordingPlanLimitState(finishedSessionId);
                } catch (error) {
                    console.error(
                        "[SubscriptionPlanLimit] Clear recording plan limit state error:",
                        error,
                    );
                }
            }

            recordingSessionIdRef.current = null;
            recordingUserIdRef.current = null;
            isRecordingRef.current = false;

            setActiveRecordingSessionId(null);
            setRecordingStartedAt(null);
            setIsRecording(false);

            startLocationRef.current = null;
            lastSavedLocationRef.current = null;
            setDistanceFromStartMeters(null);

            return finishedSessionId;
        },
        [
            saveLocationLog,
            updateLiveLocation,
            drainSQLiteQueueBeforeStop,
            normalizedLiveShareOwnerValues,
        ],
    );

    useEffect(() => {
        if (!pendingPlanLimitStop) {
            return;
        }

        /*
         * 古いセッションの停止要求なら無視する。
         */
        if (
            recordingSessionIdRef.current !==
            pendingPlanLimitStop.recordingSessionId
        ) {
            setPendingPlanLimitStop(null);
            return;
        }

        let cancelled = false;

        const stopByPlanLimit = async (): Promise<void> => {
            const { recordingSessionId, reason } = pendingPlanLimitStop;

            /*
             * 同じ停止要求を再処理しないよう先にクリアする。
             */
            setPendingPlanLimitStop(null);

            console.log(
                "[SubscriptionPlanLimit] Stop recording by plan limit:",
                {
                    recordingSessionId,
                    reason,
                },
            );

            /*
             * 上限到達後に最終地点を追加保存すると
             * 1001件目になる可能性があるため、
             * final LocationLogは保存しない。
             */
            const finishedSessionId = await stopRecording({
                skipFinalLocationSave: true,
            });

            if (cancelled) {
                return;
            }

            if (!finishedSessionId) {
                return;
            }

            const autoStopReason: RecordingPlanLimitAutoStopReason =
                reason === "DURATION"
                    ? "FREE_PLAN_DURATION_LIMIT"
                    : "FREE_PLAN_POINT_LIMIT";

            setPlanLimitAutoStop({
                recordingSessionId: finishedSessionId,
                reason: autoStopReason,
            });

            console.log("[SubscriptionPlanLimit] Recording stopped:", {
                recordingSessionId: finishedSessionId,
                reason,
            });
        };

        void stopByPlanLimit();

        return () => {
            cancelled = true;
        };
    }, [pendingPlanLimitStop, stopRecording]);

    /*
     * Phase 3:
     * 現在の記録セッションがFree/Premiumプランの
     * 1アクティビティ上限へ到達していないか確認する。
     *
     * true:
     *   上限到達を検知し、停止要求をpendingPlanLimitStopへ渡した。
     *
     * false:
     *   上限未到達、または確認できなかった。
     */
    const checkRecordingPlanLimit = useCallback(async (): Promise<boolean> => {
        const recordingSessionId = recordingSessionIdRef.current;

        if (!recordingSessionId) {
            return false;
        }

        /*
         * React state更新直後などに古いcallbackが動いても、
         * 記録終了済みなら何もしない。
         */
        if (!isRecordingRef.current) {
            return false;
        }

        /*
         * Foreground側から実際の停止処理へつなぐため、
         * このチェックはForegroundでのみ行う。
         *
         * Background中の上限判定そのものは
         * backgroundLocationTask / SQLite側で行う。
         */
        if (AppState.currentState !== "active") {
            return false;
        }

        try {
            /*
             * LocationLogが1件も保存されていなくても、
             * 経過時間だけで2時間上限を検知できるようにする。
             */
            const durationLimitReason =
                await evaluateRecordingPlanDurationLimit(
                    recordingSessionId,
                    Date.now(),
                );

            if (durationLimitReason === "DURATION") {
                console.log(
                    "[SubscriptionPlanLimit] Foreground duration limit reached:",
                    {
                        recordingSessionId,
                        reason: "DURATION",
                    },
                );

                setPendingPlanLimitStop({
                    recordingSessionId,
                    reason: "DURATION",
                });

                return true;
            }

            /*
             * Background / SQLite側ですでに上限到達していた場合を確認する。
             *
             * Foreground復帰時にはReact側のisRecordingが
             * trueのまま残っている可能性があるため、
             * 永続化されたPlan Limit stateを確認する。
             */
            const planLimitState = await getRecordingPlanLimitState();

            if (
                !planLimitState ||
                planLimitState.recordingSessionId !== recordingSessionId
            ) {
                return false;
            }

            const limitReachedReason = planLimitState.limitReachedReason;

            if (!limitReachedReason) {
                return false;
            }

            console.log(
                "[SubscriptionPlanLimit] Persisted plan limit reached:",
                {
                    recordingSessionId,
                    reason: limitReachedReason,
                    reservedPointCount:
                        planLimitState.reservedLocationLogIds.length,
                },
            );

            setPendingPlanLimitStop({
                recordingSessionId,
                reason: limitReachedReason,
            });

            return true;
        } catch (error) {
            console.error(
                "[SubscriptionPlanLimit] Check recording plan limit error:",
                error,
            );

            return false;
        }
    }, []);

    // ここに追加
    const checkRecordingContinuation = useCallback(async (): Promise<void> => {
        const recordingSessionId = recordingSessionIdRef.current;

        if (!recordingSessionId) {
            return;
        }

        /*
         * 継続確認の3分タイムアウトは、
         * ユーザーが確認UIを見られるforegroundでのみ開始する。
         */
        if (AppState.currentState !== "active") {
            return;
        }

        try {
            const evaluation = await evaluateRecordingContinuation(
                recordingSessionId,
                Date.now(),
                {
                    startConfirmationTimeout: true,
                },
            );

            /*
             * 期限切れを先に判定する。
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

    const clearPlanLimitAutoStop = useCallback(async (): Promise<void> => {
        setPlanLimitAutoStop(null);
    }, []);

    useEffect(() => {
        isRecordingRef.current = isRecording;
    }, [isRecording]);

    useEffect(() => {
        let cancelled = false;

        const startLiveSharingWatcher = async () => {
            if (normalizedLiveShareOwnerValues.length === 0) {
                liveSharingSubscriptionRef.current?.remove();
                liveSharingSubscriptionRef.current = null;
                return;
            }

            if (liveSharingSubscriptionRef.current) {
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
                    },
                );

                if (cancelled) {
                    subscription.remove();
                    return;
                }

                liveSharingSubscriptionRef.current = subscription;

                const currentLocation = await Location.getCurrentPositionAsync({
                    accuracy: Location.Accuracy.Balanced,
                });

                await updateLiveLocation(currentLocation);
            } catch (error) {
                console.error(
                    "Start foreground live sharing watcher error:",
                    error,
                );
            }
        };

        void startLiveSharingWatcher();

        return () => {
            cancelled = true;

            liveSharingSubscriptionRef.current?.remove();
            liveSharingSubscriptionRef.current = null;
        };
    }, [
        normalizedLiveShareOwnerValues,
        intervalMs,
        distanceMeters,
        updateLiveLocation,
    ]);

    useEffect(() => {
        return () => {
            recordingSubscriptionRef.current?.remove();
            recordingSubscriptionRef.current = null;
        };
    }, []);

    useEffect(() => {
        const subscription = AppState.addEventListener(
            "change",
            (nextState) => {
                const previousState = appStateRef.current;

                appStateRef.current = nextState;

                /*
                 * ForegroundからBackgroundへ移行した場合。
                 *
                 * 継続確認の3分タイムアウトは、
                 * ユーザーがダイアログを確認できないBackground中には
                 * 進めない。
                 *
                 * そのため、Foregroundを離れた時点で
                 * confirmation期限を解除する。
                 */
                const leftForeground =
                    previousState === "active" && nextState !== "active";

                if (leftForeground) {
                    const recordingSessionId = recordingSessionIdRef.current;

                    if (recordingSessionId) {
                        void pauseRecordingContinuationConfirmation(
                            recordingSessionId,
                        );

                        setContinuationPrompt(null);
                    }

                    return;
                }

                /*
                 * Background等からForegroundへ戻った場合。
                 */
                const returnedToForeground =
                    previousState !== "active" && nextState === "active";

                if (!returnedToForeground) {
                    return;
                }

                if (!recordingSessionIdRef.current) {
                    return;
                }

                /*
                 * Foregroundへ戻った時点で、
                 * Free/Premiumプランの記録上限を最優先で確認する。
                 *
                 * Background中に2時間 / 1000ポイント上限へ
                 * 到達していた場合は、
                 * 通常のhealth checkや継続確認より先に停止要求へ進める。
                 */
                void (async () => {
                    const planLimitReached = await checkRecordingPlanLimit();

                    if (planLimitReached) {
                        return;
                    }

                    /*
                     * プラン上限未到達の場合のみ、
                     * 従来の位置取得health checkを実行する。
                     */
                    void verifyAndRecoverLocationRecording(
                        "returnedToForeground",
                    );

                    /*
                     * SQLite pending回収を実行する。
                     *
                     * SQLite再送中に上限へ到達した場合は、
                     * drainSQLiteQueueOnForeground()自身が
                     * pendingPlanLimitStopを設定する。
                     */
                    void drainSQLiteQueueOnForeground();

                    /*
                     * 1時間継続確認はPlan上限より後に評価する。
                     */
                    void checkRecordingContinuation();
                })();
            },
        );

        return () => {
            subscription.remove();
        };
    }, [
        drainSQLiteQueueOnForeground,
        verifyAndRecoverLocationRecording,
        checkRecordingContinuation,
        checkRecordingPlanLimit,
    ]);

    useEffect(() => {
        if (!isRecording) {
            return;
        }

        /*
         * 記録中、foregroundにいる間だけheartbeatを継続確認する。
         *
         * Androidでアプリが完全にbackgroundになると
         * JS timer自体が止まる可能性があるため、
         * foreground復帰時のAppState health checkも併用する。
         */
        const timerId = setInterval(() => {
            if (AppState.currentState !== "active") {
                return;
            }

            void verifyAndRecoverLocationRecording("periodic");
        }, 30_000);

        return () => {
            clearInterval(timerId);
        };
    }, [isRecording, verifyAndRecoverLocationRecording]);

    useEffect(() => {
        if (!isRecording) {
            return;
        }

        /*
         * Foregroundで自動記録中の場合、
         * SQLite pendingを定期的にLocationLogへ反映する。
         *
         * drainLocationQueueSafely側で多重実行防止されているため、
         * Background側のdrainと競合した場合はalreadyRunningで安全に終了する。
         */
        const timerId = setInterval(() => {
            if (AppState.currentState !== "active") {
                return;
            }

            void drainSQLiteQueueOnForeground();
        }, 30_000);

        return () => {
            clearInterval(timerId);
        };
    }, [isRecording, drainSQLiteQueueOnForeground]);

    // ここに追加
    useEffect(() => {
        if (!isRecording) {
            return;
        }

        /*
         * Plan Limitを先に確認し、
         * 上限未到達の場合だけ1時間継続確認へ進む。
         *
         * この順序にすることで、
         * Freeプランの2時間 / 1000ポイント制限を
         * 継続確認より優先する。
         */
        const runRecordingLimitChecks = async (): Promise<void> => {
            if (AppState.currentState !== "active") {
                return;
            }

            const planLimitReached = await checkRecordingPlanLimit();

            if (planLimitReached) {
                return;
            }

            await checkRecordingContinuation();
        };

        /*
         * 記録開始・復元直後にも一度確認する。
         */
        void runRecordingLimitChecks();

        /*
         * Foreground中は30秒ごとに確認する。
         *
         * LocationLogが保存されていなくても、
         * このタイマーによって2時間上限を検知できる。
         */
        const timerId = setInterval(() => {
            void runRecordingLimitChecks();
        }, 30_000);

        return () => {
            clearInterval(timerId);
        };
    }, [isRecording, checkRecordingPlanLimit, checkRecordingContinuation]);

    useEffect(() => {
        if (!isRecording) {
            return;
        }

        if (!recordingSessionIdRef.current) {
            return;
        }

        if (AppState.currentState !== "active") {
            return;
        }

        /*
         * アプリ再起動などでbackground記録状態を復元した場合、
         * Foreground watcherはJavaScript側に残っていないため再登録する。
         *
         * 既にwatcherが存在する場合は
         * ensureForegroundRecordingWatcher(false) 内で何もしない。
         */
        void ensureForegroundRecordingWatcher(false);
    }, [isRecording, ensureForegroundRecordingWatcher]);

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

        /*
         * Freeプラン上限による自動停止情報。
         */
        planLimitAutoStop,

        startRecording,
        stopRecording,

        confirmContinuation,
        clearAutoStoppedSession,
        clearPlanLimitAutoStop,
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
