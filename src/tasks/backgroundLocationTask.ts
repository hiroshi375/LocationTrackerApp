// src/tasks/backgroundLocationTask.ts

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

import { client } from "../lib/client";
import {
    getErrorMessage,
    saveBackgroundLocationDebugLog,
} from "../services/backgroundLocationDebugLogService";
import { deduplicateLocationBatch } from "../services/locationLogDeduplicationService";
import {
    enqueuePendingLocationLog,
    flushPendingLocationLogs,
} from "../services/locationLogPendingQueueService";
import {
    calculateDistanceMeters,
    calculateSpeedMetersPerSecond,
    isAbnormalSpeedLocation,
    isExactDuplicateLocation,
    isLowAccuracyLocation,
    isNearDuplicateLocation,
} from "../utils/locationDuplicate";

export const BACKGROUND_LOCATION_TASK_NAME =
    "location-tracker-background-location-task";

export const BACKGROUND_RECORDING_STATE_KEY =
    "location-tracker-background-recording-state";

/*
 * BackgroundLocationDebugLog の保存を一括で制御する。
 * 実際に保存するイベントは backgroundLocationDebugLogService 側でも制御する。
 */
const ENABLE_BACKGROUND_LOCATION_DEBUG_LOG = true;

const BACKGROUND_FLUSH_MAX_ITEMS = 3;
const BACKGROUND_FLUSH_TIME_BUDGET_MS = 4_000;
const BACKGROUND_TASK_HEALTH_LOG_STORAGE_KEY =
    "location-tracker-background-task-health-log-last-at";
const BACKGROUND_TASK_HEALTH_LOG_INTERVAL_MS = 5 * 60 * 1000;

type SavedLocation = {
    latitude: number;
    longitude: number;
    recordedAt: number;
    accuracy?: number | null;
};

type BackgroundRecordingState = {
    userId: string;

    isRecording: boolean;
    recordingSessionId?: string | null;
    startedAt?: string | null;

    liveShareOwnerValues: string[];
    liveLocationId?: string | null;

    /*
     * クラウド保存済みだけでなく、端末内の未送信キューへ受け付けた最新地点も含む。
     * ネットワーク遅延中でも保存間隔判定を継続するために使用する。
     */
    lastSavedLocation?: SavedLocation | null;

    /*
     * foreground復帰後などに古いbackground地点が後追いで届いた場合の、
     * 古い時系列内での保存間隔判定用基準地点。
     */
    lastOutOfOrderLocation?: SavedLocation | null;

    intervalMs: number;
    distanceMeters: number;
};

type BackgroundLocationSkipReason =
    | "invalidCoordinate"
    | "lowAccuracy"
    | "abnormalSpeed"
    | "exactDuplicate"
    | "nearDuplicate"
    | "saveConditionNotMet";

type CaptureBackgroundLocationResult = {
    captured: boolean;
    nextState: BackgroundRecordingState;
    skippedReason?: BackgroundLocationSkipReason;
    errorMessage?: string;
};

type BackgroundDebugLogInput = Parameters<
    typeof saveBackgroundLocationDebugLog
>[0];

async function safeSaveBackgroundLocationDebugLog(
    input: BackgroundDebugLogInput,
): Promise<void> {
    if (!ENABLE_BACKGROUND_LOCATION_DEBUG_LOG) {
        return;
    }

    try {
        await saveBackgroundLocationDebugLog(input);
    } catch (debugLogError) {
        console.error(
            "Failed to save background location debug log:",
            debugLogError,
        );
    }
}

type BackgroundTaskInput = {
    data?: unknown;
    error?: unknown;
};

type BackgroundTaskIngestResult = {
    state: BackgroundRecordingState;
    latestLocation: Location.LocationObject | null;
    locationsLength: number;
    uniqueLocationsLength: number;
    capturedCount: number;
    captureFailureCount: number;
    skippedCount: number;
    invalidCoordinateSkippedCount: number;
    lowAccuracySkippedCount: number;
    abnormalSpeedSkippedCount: number;
    exactDuplicateSkippedCount: number;
    nearDuplicateSkippedCount: number;
    saveConditionSkippedCount: number;
    taskFiredAt: string;
};

/*
 * 直列化するのは、AsyncStorageへの取り込み処理だけに限定する。
 * LocationLogのクラウド同期・LiveLocation更新・DebugLog作成は、
 * 後続の位置コールバックを待たせない。
 */
let backgroundLocationIngestQueue: Promise<void> = Promise.resolve();

TaskManager.defineTask(BACKGROUND_LOCATION_TASK_NAME, ({ data, error }) => {
    const ingestPromise = backgroundLocationIngestQueue
        .catch((queueError) => {
            console.error(
                "Previous background location ingest queue error:",
                queueError,
            );
        })
        .then(() =>
            ingestBackgroundLocationTask({
                data,
                error,
            }),
        );

    backgroundLocationIngestQueue = ingestPromise.then(
        () => undefined,
        () => undefined,
    );

    return ingestPromise.then(async (ingestResult) => {
        if (!ingestResult) {
            return;
        }

        if (ingestResult.latestLocation) {
            scheduleBackgroundLiveLocationUpdate(
                ingestResult.latestLocation,
                ingestResult.state,
                ingestResult.taskFiredAt,
            );
        }

        /*
         * background実行中にもクラウド同期を試すが、最大4秒で処理を返す。
         * 同期に失敗・タイムアウトしても位置情報はAsyncStorageに残り、
         * 次回callbackまたはforeground復帰時に再送される。
         */
        const flushResult = await flushPendingLocationLogs({
            recordingSessionId: ingestResult.state.recordingSessionId ?? null,
            maxItems: BACKGROUND_FLUSH_MAX_ITEMS,
            timeBudgetMs: BACKGROUND_FLUSH_TIME_BUDGET_MS,
        });

        void maybeSaveBackgroundTaskHealthLog(
            ingestResult,
            flushResult.remainingCount,
        );

        if (flushResult.failedCount > 0) {
            void safeSaveBackgroundLocationDebugLog({
                userId: ingestResult.state.userId,
                recordingSessionId:
                    ingestResult.state.recordingSessionId ?? null,
                eventName: "backgroundLocationPendingQueueFlushFailed",
                taskFiredAt: ingestResult.taskFiredAt,
                errorMessage: flushResult.lastErrorMessage ?? null,
                details: {
                    attemptedCount: flushResult.attemptedCount,
                    syncedCount: flushResult.syncedCount,
                    duplicateCount: flushResult.duplicateCount,
                    failedCount: flushResult.failedCount,
                    remainingCount: flushResult.remainingCount,
                    timedOut: flushResult.timedOut,
                    skippedByCooldown: flushResult.skippedByCooldown,
                },
            });
        }
    });
});

async function ingestBackgroundLocationTask({
    data,
    error,
}: BackgroundTaskInput): Promise<BackgroundTaskIngestResult | null> {
    const taskFiredAt = new Date().toISOString();

    const state = await getBackgroundRecordingState();

    const stateDebugInfo = {
        userId: state?.userId ?? null,
        recordingSessionId: state?.recordingSessionId ?? null,
        hasState: Boolean(state),
        isRecording: state?.isRecording ?? null,
        hasRecordingSessionId: Boolean(state?.recordingSessionId),
        sharedOwnersCount: state?.liveShareOwnerValues?.length ?? 0,
    };

    if (!isValidBackgroundRecordingState(state)) {
        console.log(
            "Background recording state not found. Skip background task.",
        );

        void safeSaveBackgroundLocationDebugLog({
            userId: stateDebugInfo.userId,
            recordingSessionId: stateDebugInfo.recordingSessionId,
            eventName: "backgroundLocationTaskSkippedInvalidState",
            taskFiredAt,
            details: stateDebugInfo,
        });

        return null;
    }

    if (error) {
        void safeSaveBackgroundLocationDebugLog({
            userId: state.userId,
            recordingSessionId: state.recordingSessionId,
            eventName: "backgroundLocationTaskError",
            taskFiredAt,
            errorMessage: getErrorMessage(error),
        });

        console.error("Background location task error:", error);
        return null;
    }

    const locations = (
        data as { locations?: Location.LocationObject[] } | undefined
    )?.locations;

    const locationsLength = locations?.length ?? 0;

    if (!locations || locations.length === 0) {
        void safeSaveBackgroundLocationDebugLog({
            userId: state.userId,
            recordingSessionId: state.recordingSessionId,
            eventName: "backgroundLocationTaskSkippedNoLocations",
            taskFiredAt,
            locationsLength,
            skippedCount: 1,
        });

        return null;
    }

    const sortedLocations = [...locations].sort((left, right) => {
        return getLocationTimestamp(left) - getLocationTimestamp(right);
    });

    const uniqueLocations = deduplicateLocationBatch(sortedLocations);

    let currentState = state;
    let capturedCount = 0;
    let captureFailureCount = 0;
    let skippedCount = 0;
    let invalidCoordinateSkippedCount = 0;
    let lowAccuracySkippedCount = 0;
    let abnormalSpeedSkippedCount = 0;
    let exactDuplicateSkippedCount = 0;
    let nearDuplicateSkippedCount = 0;
    let saveConditionSkippedCount = 0;

    for (const location of uniqueLocations) {
        if (!currentState.isRecording || !currentState.recordingSessionId) {
            continue;
        }

        const result = await captureBackgroundLocation(
            location,
            currentState,
            taskFiredAt,
        );

        currentState = result.nextState;

        if (result.captured) {
            capturedCount += 1;
        }

        if (result.errorMessage) {
            captureFailureCount += 1;
        }

        if (result.skippedReason) {
            skippedCount += 1;

            switch (result.skippedReason) {
                case "invalidCoordinate":
                    invalidCoordinateSkippedCount += 1;
                    break;
                case "lowAccuracy":
                    lowAccuracySkippedCount += 1;
                    break;
                case "abnormalSpeed":
                    abnormalSpeedSkippedCount += 1;
                    break;
                case "exactDuplicate":
                    exactDuplicateSkippedCount += 1;
                    break;
                case "nearDuplicate":
                    nearDuplicateSkippedCount += 1;
                    break;
                case "saveConditionNotMet":
                    saveConditionSkippedCount += 1;
                    break;
            }
        }
    }

    currentState = await persistCaptureProgress(currentState);

    const latestLocation = uniqueLocations[uniqueLocations.length - 1] ?? null;

    /*
     * 通常callbackごとのFired/Completedログは保存しない。
     * DebugLogのネットワーク書き込みがLocationLog処理を圧迫しないよう、
     * 異常時だけbackgroundLocationDebugLogServiceで保存する。
     */
    return {
        state: currentState,
        latestLocation,
        locationsLength,
        uniqueLocationsLength: uniqueLocations.length,
        capturedCount,
        captureFailureCount,
        skippedCount,
        invalidCoordinateSkippedCount,
        lowAccuracySkippedCount,
        abnormalSpeedSkippedCount,
        exactDuplicateSkippedCount,
        nearDuplicateSkippedCount,
        saveConditionSkippedCount,
        taskFiredAt,
    };
}

async function maybeSaveBackgroundTaskHealthLog(
    ingestResult: BackgroundTaskIngestResult,
    pendingQueueCount: number,
): Promise<void> {
    try {
        const nowMs = Date.now();
        const rawLastLoggedAt = await AsyncStorage.getItem(
            BACKGROUND_TASK_HEALTH_LOG_STORAGE_KEY,
        );
        const lastLoggedAtMs = rawLastLoggedAt ? Number(rawLastLoggedAt) : 0;

        if (
            Number.isFinite(lastLoggedAtMs) &&
            nowMs - lastLoggedAtMs < BACKGROUND_TASK_HEALTH_LOG_INTERVAL_MS
        ) {
            return;
        }

        await AsyncStorage.setItem(
            BACKGROUND_TASK_HEALTH_LOG_STORAGE_KEY,
            String(nowMs),
        );

        void safeSaveBackgroundLocationDebugLog({
            userId: ingestResult.state.userId,
            recordingSessionId: ingestResult.state.recordingSessionId ?? null,
            eventName: "backgroundLocationTaskHealthSummary",
            taskFiredAt: ingestResult.taskFiredAt,
            locationsLength: ingestResult.locationsLength,
            saveSuccessCount: ingestResult.capturedCount,
            saveFailureCount: ingestResult.captureFailureCount,
            skippedCount: ingestResult.skippedCount,
            invalidCoordinateSkippedCount:
                ingestResult.invalidCoordinateSkippedCount,
            lowAccuracySkippedCount: ingestResult.lowAccuracySkippedCount,
            abnormalSpeedSkippedCount: ingestResult.abnormalSpeedSkippedCount,
            exactDuplicateSkippedCount: ingestResult.exactDuplicateSkippedCount,
            nearDuplicateSkippedCount: ingestResult.nearDuplicateSkippedCount,
            saveConditionSkippedCount: ingestResult.saveConditionSkippedCount,
            details: {
                uniqueLocationsLength: ingestResult.uniqueLocationsLength,
                pendingQueueCount,
                intervalMs: ingestResult.state.intervalMs,
                distanceMeters: ingestResult.state.distanceMeters,
                isRecording: ingestResult.state.isRecording,
                sharedOwnersCount:
                    ingestResult.state.liveShareOwnerValues.length,
            },
        });
    } catch (error) {
        console.error("Save background task health log marker error:", error);
    }
}

async function captureBackgroundLocation(
    location: Location.LocationObject,
    state: BackgroundRecordingState,
    taskFiredAt: string,
): Promise<CaptureBackgroundLocationResult> {
    const latitude = location.coords.latitude;
    const longitude = location.coords.longitude;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return {
            captured: false,
            nextState: state,
            skippedReason: "invalidCoordinate",
        };
    }

    const recordedAtMs = getLocationTimestamp(location);
    const recordedAt = new Date(recordedAtMs).toISOString();
    const accuracy = location.coords.accuracy ?? null;
    const recordingSessionId = state.recordingSessionId;

    if (!recordingSessionId) {
        return {
            captured: false,
            nextState: state,
            errorMessage: "recordingSessionId is missing.",
        };
    }

    if (isLowAccuracyLocation(accuracy)) {
        void safeSaveBackgroundLocationDebugLog({
            userId: state.userId,
            recordingSessionId,
            eventName: "backgroundLocationLogSkippedLowAccuracy",
            taskFiredAt,
            details: {
                recordedAt,
                latitude,
                longitude,
                accuracy,
            },
        });

        return {
            captured: false,
            nextState: state,
            skippedReason: "lowAccuracy",
        };
    }

    const latestAcceptedLocation = state.lastSavedLocation ?? null;
    const isOutOfOrder = Boolean(
        latestAcceptedLocation &&
        recordedAtMs <= latestAcceptedLocation.recordedAt,
    );

    let comparisonLocation = isOutOfOrder
        ? (state.lastOutOfOrderLocation ?? null)
        : latestAcceptedLocation;

    /*
     * さらに古い時系列のバッチが届いた場合は、
     * そのバッチの先頭を新しい比較基準として受け付ける。
     */
    if (comparisonLocation && recordedAtMs <= comparisonLocation.recordedAt) {
        comparisonLocation = null;
    }

    if (
        isAbnormalSpeedLocation(
            comparisonLocation,
            latitude,
            longitude,
            recordedAtMs,
        )
    ) {
        const speedMetersPerSecond = calculateSpeedMetersPerSecond(
            comparisonLocation,
            latitude,
            longitude,
            recordedAtMs,
        );

        void safeSaveBackgroundLocationDebugLog({
            userId: state.userId,
            recordingSessionId,
            eventName: "backgroundLocationLogSkippedAbnormalSpeed",
            taskFiredAt,
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
                isOutOfOrder,
            },
        });

        return {
            captured: false,
            nextState: state,
            skippedReason: "abnormalSpeed",
        };
    }

    if (
        isExactDuplicateLocation(
            comparisonLocation,
            latitude,
            longitude,
            recordedAtMs,
        )
    ) {
        return {
            captured: false,
            nextState: state,
            skippedReason: "exactDuplicate",
        };
    }

    if (
        isNearDuplicateLocation(
            comparisonLocation,
            latitude,
            longitude,
            recordedAtMs,
        )
    ) {
        return {
            captured: false,
            nextState: state,
            skippedReason: "nearDuplicate",
        };
    }

    const saveCondition = evaluateLocationSaveCondition(
        latitude,
        longitude,
        recordedAtMs,
        comparisonLocation,
        state.intervalMs,
        state.distanceMeters,
    );

    if (!saveCondition.shouldSave) {
        return {
            captured: false,
            nextState: state,
            skippedReason: "saveConditionNotMet",
        };
    }

    try {
        const enqueueResult = await enqueuePendingLocationLog({
            userId: state.userId,
            recordingSessionId,
            latitude,
            longitude,
            accuracy,
            recordedAt,
            source: "background",
            sharedOwners: state.liveShareOwnerValues,
        });

        if (!enqueueResult.enqueued) {
            return {
                captured: false,
                nextState: state,
                skippedReason: "exactDuplicate",
            };
        }

        const acceptedLocation: SavedLocation = {
            latitude,
            longitude,
            recordedAt: recordedAtMs,
            accuracy,
        };

        const nextState: BackgroundRecordingState = isOutOfOrder
            ? {
                  ...state,
                  lastOutOfOrderLocation: acceptedLocation,
              }
            : {
                  ...state,
                  lastSavedLocation: acceptedLocation,
                  lastOutOfOrderLocation: null,
              };

        return {
            captured: true,
            nextState,
        };
    } catch (queueError) {
        const errorMessage = getErrorMessage(queueError);

        console.error("Enqueue background LocationLog error:", queueError);

        void safeSaveBackgroundLocationDebugLog({
            userId: state.userId,
            recordingSessionId,
            eventName: "backgroundLocationPendingQueueEnqueueFailed",
            taskFiredAt,
            errorMessage,
            details: {
                recordedAt,
                latitude,
                longitude,
                accuracy,
                isOutOfOrder,
            },
        });

        return {
            captured: false,
            nextState: state,
            errorMessage,
        };
    }
}

async function persistCaptureProgress(
    candidateState: BackgroundRecordingState,
): Promise<BackgroundRecordingState> {
    const latestState = await getBackgroundRecordingState();

    if (
        !latestState ||
        latestState.userId !== candidateState.userId ||
        latestState.recordingSessionId !== candidateState.recordingSessionId
    ) {
        return latestState ?? candidateState;
    }

    const nextLastSavedLocation = selectNewerLocation(
        latestState.lastSavedLocation ?? null,
        candidateState.lastSavedLocation ?? null,
    );

    let nextLastOutOfOrderLocation = selectNewerLocation(
        latestState.lastOutOfOrderLocation ?? null,
        candidateState.lastOutOfOrderLocation ?? null,
    );

    if (
        nextLastSavedLocation &&
        nextLastOutOfOrderLocation &&
        nextLastOutOfOrderLocation.recordedAt >=
            nextLastSavedLocation.recordedAt
    ) {
        nextLastOutOfOrderLocation = null;
    }

    const mergedState: BackgroundRecordingState = {
        ...latestState,
        lastSavedLocation: nextLastSavedLocation,
        lastOutOfOrderLocation: nextLastOutOfOrderLocation,
    };

    await setBackgroundRecordingState(mergedState);
    return mergedState;
}

/*
 * LiveLocation更新はLocationLog取り込みキューから完全に分離する。
 * 1回の更新が長時間待機しても、後続の位置情報は端末内キューへ保存される。
 */
type ScheduledLiveLocationUpdate = {
    location: Location.LocationObject;
    state: BackgroundRecordingState;
    taskFiredAt: string;
};

let latestScheduledLiveLocationUpdate: ScheduledLiveLocationUpdate | null =
    null;
let liveLocationUpdatePromise: Promise<void> | null = null;

function scheduleBackgroundLiveLocationUpdate(
    location: Location.LocationObject,
    state: BackgroundRecordingState,
    taskFiredAt: string,
): void {
    if (state.liveShareOwnerValues.length === 0) {
        return;
    }

    latestScheduledLiveLocationUpdate = {
        location,
        state,
        taskFiredAt,
    };

    if (liveLocationUpdatePromise) {
        return;
    }

    liveLocationUpdatePromise = drainScheduledLiveLocationUpdates().finally(
        () => {
            liveLocationUpdatePromise = null;

            if (latestScheduledLiveLocationUpdate) {
                scheduleBackgroundLiveLocationUpdate(
                    latestScheduledLiveLocationUpdate.location,
                    latestScheduledLiveLocationUpdate.state,
                    latestScheduledLiveLocationUpdate.taskFiredAt,
                );
            }
        },
    );
}

async function drainScheduledLiveLocationUpdates(): Promise<void> {
    while (latestScheduledLiveLocationUpdate) {
        const scheduledUpdate = latestScheduledLiveLocationUpdate;
        latestScheduledLiveLocationUpdate = null;

        try {
            await updateBackgroundLiveLocationState(
                scheduledUpdate.location,
                scheduledUpdate.state,
                scheduledUpdate.taskFiredAt,
            );
        } catch (error) {
            console.error("Background LiveLocation update error:", error);

            void safeSaveBackgroundLocationDebugLog({
                userId: scheduledUpdate.state.userId,
                recordingSessionId:
                    scheduledUpdate.state.recordingSessionId ?? null,
                eventName: "backgroundLiveLocationUnexpectedError",
                taskFiredAt: scheduledUpdate.taskFiredAt,
                errorMessage: getErrorMessage(error),
            });
        }
    }
}

async function updateBackgroundLiveLocationState(
    location: Location.LocationObject,
    state: BackgroundRecordingState,
    taskFiredAt: string,
): Promise<void> {
    const sharedOwners = Array.from(
        new Set((state.liveShareOwnerValues ?? []).filter(Boolean)),
    );

    if (sharedOwners.length === 0) {
        return;
    }

    const latitude = location.coords.latitude;
    const longitude = location.coords.longitude;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return;
    }

    const liveLocationModel = client.models.LiveLocation as any;

    const payload = {
        userId: state.userId,
        recordingSessionId: state.isRecording
            ? (state.recordingSessionId ?? null)
            : null,
        isRecording: state.isRecording,
        latitude,
        longitude,
        accuracy: location.coords.accuracy ?? null,
        updatedAt: new Date().toISOString(),
        isActive: true,
        sharedOwners,
    };

    let liveLocationId = state.liveLocationId ?? null;

    if (liveLocationId) {
        const result = await liveLocationModel.update({
            id: liveLocationId,
            ...payload,
        });

        if (result.errors) {
            void safeSaveBackgroundLocationDebugLog({
                userId: state.userId,
                recordingSessionId: state.recordingSessionId ?? null,
                eventName: "backgroundLiveLocationUpdateFailed",
                taskFiredAt,
                errorMessage: getErrorMessage(result.errors),
            });

            return;
        }
    } else {
        const result = await liveLocationModel.create(payload);

        if (result.errors) {
            void safeSaveBackgroundLocationDebugLog({
                userId: state.userId,
                recordingSessionId: state.recordingSessionId ?? null,
                eventName: "backgroundLiveLocationCreateFailed",
                taskFiredAt,
                errorMessage: getErrorMessage(result.errors),
            });

            return;
        }

        liveLocationId = result.data?.id ?? null;
    }

    if (!liveLocationId) {
        return;
    }

    /*
     * 古いstate全体を書き戻すと、直後に受け付けたlastSavedLocationを
     * 巻き戻す可能性がある。最新stateを読み、liveLocationIdだけをマージする。
     */
    const latestState = await getBackgroundRecordingState();

    if (!latestState || latestState.userId !== state.userId) {
        return;
    }

    await setBackgroundRecordingState({
        ...latestState,
        liveLocationId,
    });
}

async function getBackgroundRecordingState(): Promise<BackgroundRecordingState | null> {
    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw) as Partial<BackgroundRecordingState>;

        if (typeof parsed.userId !== "string" || parsed.userId.length === 0) {
            console.error("Invalid background recording state:", {
                hasUserId: Boolean(parsed.userId),
                isRecording: parsed.isRecording ?? null,
                hasRecordingSessionId: Boolean(parsed.recordingSessionId),
                sharedOwnersCount: Array.isArray(parsed.liveShareOwnerValues)
                    ? parsed.liveShareOwnerValues.length
                    : 0,
            });
            return null;
        }

        const liveShareOwnerValues = Array.isArray(parsed.liveShareOwnerValues)
            ? Array.from(
                  new Set(
                      parsed.liveShareOwnerValues.filter(
                          (value): value is string =>
                              typeof value === "string" && value.length > 0,
                      ),
                  ),
              )
            : [];

        return {
            userId: parsed.userId,
            isRecording:
                typeof parsed.isRecording === "boolean"
                    ? parsed.isRecording
                    : Boolean(parsed.recordingSessionId),
            recordingSessionId: parsed.recordingSessionId ?? null,
            startedAt: parsed.startedAt ?? null,
            liveShareOwnerValues,
            liveLocationId: parsed.liveLocationId ?? null,
            lastSavedLocation: parsed.lastSavedLocation ?? null,
            lastOutOfOrderLocation: parsed.lastOutOfOrderLocation ?? null,
            intervalMs:
                typeof parsed.intervalMs === "number" &&
                Number.isFinite(parsed.intervalMs) &&
                parsed.intervalMs > 0
                    ? parsed.intervalMs
                    : DEFAULT_INTERVAL_MS,
            distanceMeters:
                typeof parsed.distanceMeters === "number" &&
                Number.isFinite(parsed.distanceMeters) &&
                parsed.distanceMeters > 0
                    ? parsed.distanceMeters
                    : DEFAULT_DISTANCE_METERS,
        };
    } catch (error) {
        console.error("Parse background recording state error:", error);
        return null;
    }
}

function isValidBackgroundRecordingState(
    state: BackgroundRecordingState | null,
): state is BackgroundRecordingState {
    if (!state?.userId) {
        return false;
    }

    const isSharing =
        Array.isArray(state.liveShareOwnerValues) &&
        state.liveShareOwnerValues.length > 0;

    const hasRecordingSession =
        state.isRecording && Boolean(state.recordingSessionId);

    return isSharing || hasRecordingSession;
}

async function setBackgroundRecordingState(
    state: BackgroundRecordingState,
): Promise<void> {
    await AsyncStorage.setItem(
        BACKGROUND_RECORDING_STATE_KEY,
        JSON.stringify(state),
    );
}

const DEFAULT_DISTANCE_METERS = 50;
const DEFAULT_INTERVAL_MS = 30_000;

type LocationSaveConditionEvaluation = {
    shouldSave: boolean;
    elapsedMs: number | null;
    distanceFromLastSavedMeters: number | null;
    configuredIntervalMs: number;
    configuredDistanceMeters: number;
};

function evaluateLocationSaveCondition(
    latitude: number,
    longitude: number,
    recordedAtMs: number,
    comparisonLocation: SavedLocation | null,
    intervalMs: number,
    distanceMeters: number,
): LocationSaveConditionEvaluation {
    const configuredIntervalMs =
        Number.isFinite(intervalMs) && intervalMs > 0
            ? intervalMs
            : DEFAULT_INTERVAL_MS;

    const configuredDistanceMeters =
        Number.isFinite(distanceMeters) && distanceMeters > 0
            ? distanceMeters
            : DEFAULT_DISTANCE_METERS;

    if (!comparisonLocation) {
        return {
            shouldSave: true,
            elapsedMs: null,
            distanceFromLastSavedMeters: null,
            configuredIntervalMs,
            configuredDistanceMeters,
        };
    }

    const elapsedMs = recordedAtMs - comparisonLocation.recordedAt;

    if (elapsedMs <= 0) {
        return {
            shouldSave: false,
            elapsedMs,
            distanceFromLastSavedMeters: null,
            configuredIntervalMs,
            configuredDistanceMeters,
        };
    }

    const distanceFromLastSavedMeters = calculateDistanceMeters(
        comparisonLocation.latitude,
        comparisonLocation.longitude,
        latitude,
        longitude,
    );

    return {
        shouldSave:
            elapsedMs >= configuredIntervalMs ||
            distanceFromLastSavedMeters >= configuredDistanceMeters,
        elapsedMs,
        distanceFromLastSavedMeters,
        configuredIntervalMs,
        configuredDistanceMeters,
    };
}

function getLocationTimestamp(location: Location.LocationObject): number {
    return typeof location.timestamp === "number" &&
        Number.isFinite(location.timestamp)
        ? location.timestamp
        : Date.now();
}

function selectNewerLocation(
    left: SavedLocation | null,
    right: SavedLocation | null,
): SavedLocation | null {
    if (!left) {
        return right;
    }

    if (!right) {
        return left;
    }

    return right.recordedAt >= left.recordedAt ? right : left;
}
