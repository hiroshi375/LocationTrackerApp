// src/tasks/backgroundLocationTask.ts

import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetchAuthSession } from "aws-amplify/auth";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import {
    ENABLE_LOCATION_SQLITE_MIRROR,
    ENABLE_LOCATION_SQLITE_QUEUE_UPLOAD,
    KEEP_DIRECT_LOCATION_LOG_SAVE,
} from "../config/locationQueueFeatureFlags";

import { client } from "../lib/client";
import {
    getErrorMessage,
    saveBackgroundLocationDebugLog,
} from "../services/backgroundLocationDebugLogService";
import {
    acquireLocationSaveLock,
    createLocationLogId,
    createLocationSaveLockScopeKey,
    createLocationUniqueKey,
    isDuplicateLocationCreateError,
    releaseLocationSaveLock,
    type LocationSaveLock,
} from "../services/locationLogDeduplicationService";
import { incrementRecordingContinuationPointCount } from "../services/recordingContinuationService";
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

/**
 * バックグラウンド位置タスクが実際に呼び出された時刻を保存するキー。
 *
 * タスク登録状態ではなく、OSからタスクコールバックが配送されたことを
 * 確認するために使用する。
 */
export const BACKGROUND_LOCATION_TASK_HEARTBEAT_KEY =
    "location-tracker-background-location-task-heartbeat";

export type BackgroundLocationTaskHeartbeat = {
    /**
     * タスクコールバックが開始された端末時刻。
     */
    firedAt: number;
    /**
     * firedAtのISO形式。
     * ログ確認をしやすくするため保持する。
     */
    taskFiredAt: string;
    /**
     * OSから渡された位置情報件数。
     */
    locationsLength: number;
    /**
     * タスク実行時点の記録セッションID。
     *
     * 状態取得前や非記録中の場合はnull。
     */
    recordingSessionId: string | null;
    /**
     * タスク実行時点で自動記録中だったか。
     */
    isRecording: boolean;
    /**
     * タスク実行時点のユーザーID。
     *
     * 状態取得前や状態不明の場合はnull。
     */
    userId: string | null;
    /**
     * TaskManagerからエラーが渡されたか。
     */
    hasTaskError: boolean;
};

/*
 * BackgroundLocationDebugLog の保存を一括で制御する。
 *
 * false:
 *   DynamoDB の BackgroundLocationDebugLog に新しいレコードを作成しない。
 *
 * 再調査が必要になった場合だけ、一時的に true に戻す。
 */
const ENABLE_BACKGROUND_LOCATION_DEBUG_LOG = true;

/*
 * 同一LocationLog IDに対するcreateの並行実行を防止する。
 *
 * Promise.raceのtimeout後も、元のGraphQL Promiseは継続する可能性がある。
 * そのためtimeout時には削除せず、
 * 元のcreate Promise自体がresolve/rejectした時だけ削除する。
 *
 * backgroundLocationTask全体を直列化するものではない。
 */
const inFlightLocationLogCreateIds = new Set<string>();

type BackgroundRecordingState = {
    userId: string;

    isRecording: boolean;
    recordingSessionId?: string | null;
    startedAt?: string | null;

    liveShareOwnerValues: string[];
    liveLocationId?: string | null;

    lastSavedLocation?: {
        latitude: number;
        longitude: number;
        recordedAt: number;
    } | null;

    intervalMs: number;
    distanceMeters: number;
};

type BackgroundLocationSkipReason =
    | "invalidCoordinate"
    | "lowAccuracy"
    | "abnormalSpeed"
    | "inProgressDuplicate"
    | "exactDuplicate"
    | "nearDuplicate"
    | "saveConditionNotMet";

type SaveBackgroundLocationResult = {
    saved: boolean;
    nextState: BackgroundRecordingState;
    skippedReason?: BackgroundLocationSkipReason;
    errorMessage?: string;
};

type UpdateBackgroundLiveLocationResult = {
    nextState: BackgroundRecordingState;

    /*
     * 共有先がなく、更新処理自体を実行しなかった場合はfalse。
     */
    attempted: boolean;

    /*
     * createまたはupdateが正常終了した場合はtrue。
     * attempted=falseの場合もfalse。
     */
    succeeded: boolean;

    /*
     * create/updateのどちらを試したか。
     */
    operation: "none" | "create" | "update";

    /*
     * エラー時のメッセージ。
     */
    errorMessage?: string;

    /*
     * タイムアウトだったか。
     */
    timedOut: boolean;

    /*
     * LiveLocation ID。
     * create成功時は新しく作られたID。
     */
    liveLocationId?: string | null;
};

type BackgroundLocationProcessingTimings = {
    lockAcquireDurationMs: number;
    preCreateLookupDurationMs: number;
    locationLogCreateDurationMs: number;
    stateUpdateDurationMs: number;
    continuationUpdateDurationMs: number;

    lockAcquireCount: number;
    preCreateLookupCount: number;
    locationLogCreateCount: number;
    stateUpdateCount: number;
    continuationUpdateCount: number;

    lockAcquireMaxDurationMs: number;
    preCreateLookupMaxDurationMs: number;
    locationLogCreateMaxDurationMs: number;
    stateUpdateMaxDurationMs: number;
    continuationUpdateMaxDurationMs: number;
};

type BackgroundAuthSessionResult = {
    available: boolean;
    refreshed: boolean;
    hasIdToken: boolean;
    hasAccessToken: boolean;
    errorMessage?: string;
};

function createBackgroundLocationProcessingTimings(): BackgroundLocationProcessingTimings {
    return {
        lockAcquireDurationMs: 0,
        preCreateLookupDurationMs: 0,
        locationLogCreateDurationMs: 0,
        stateUpdateDurationMs: 0,
        continuationUpdateDurationMs: 0,

        lockAcquireCount: 0,
        preCreateLookupCount: 0,
        locationLogCreateCount: 0,
        stateUpdateCount: 0,
        continuationUpdateCount: 0,

        lockAcquireMaxDurationMs: 0,
        preCreateLookupMaxDurationMs: 0,
        locationLogCreateMaxDurationMs: 0,
        stateUpdateMaxDurationMs: 0,
        continuationUpdateMaxDurationMs: 0,
    };
}

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

/**
 * バックグラウンド位置タスクの実行記録をAsyncStorageへ保存する。
 *
 * heartbeat保存失敗によって既存のLocationLog処理を停止させないため、
 * 例外はこの関数内で処理する。
 */
async function safeSaveBackgroundLocationTaskHeartbeat(
    heartbeat: BackgroundLocationTaskHeartbeat,
): Promise<void> {
    try {
        await AsyncStorage.setItem(
            BACKGROUND_LOCATION_TASK_HEARTBEAT_KEY,
            JSON.stringify(heartbeat),
        );
    } catch (heartbeatError) {
        console.error(
            "Save background location task heartbeat error:",
            heartbeatError,
        );
    }
}

function isUnauthorizedError(error: unknown): boolean {
    let text: string;

    if (typeof error === "string") {
        text = error;
    } else {
        try {
            text = JSON.stringify(error);
        } catch {
            text = String(error);
        }
    }

    const normalizedText = text.toLowerCase();

    return (
        normalizedText.includes("unauthorized") ||
        normalizedText.includes("not authorized") ||
        normalizedText.includes("unauthenticated") ||
        normalizedText.includes("401")
    );
}

const SQLITE_MIRROR_TIMEOUT_MS = 5_000;

/**
 * バックグラウンドでのLiveLocation作成・更新の最大待機時間。
 *
 * タイムアウトしても開始済み通信はキャンセルされないため、
 * タイムアウト時は次回の位置イベントで再試行する。
 */
const LIVE_LOCATION_UPDATE_TIMEOUT_MS = 5_000;

/**
 * LocationLog.create() 1回あたりの最大待機時間。
 *
 * タイムアウトしても、開始済みの通信自体をキャンセルするわけではない。
 * そのため、決定的IDによる重複防止を前提とする。
 */
const LOCATION_LOG_CREATE_TIMEOUT_MS = 10_000;

/**
 * バックグラウンド処理開始前の通常認証取得の最大待機時間。
 */
const AUTH_SESSION_FETCH_TIMEOUT_MS = 8_000;

/**
 * 認証セッション強制更新の最大待機時間。
 */
const AUTH_SESSION_REFRESH_TIMEOUT_MS = 10_000;

class OperationTimeoutError extends Error {
    readonly operationName: string;
    readonly timeoutMs: number;

    constructor(operationName: string, timeoutMs: number) {
        super(`${operationName} timed out after ${timeoutMs}ms.`);

        this.name = "OperationTimeoutError";
        this.operationName = operationName;
        this.timeoutMs = timeoutMs;
    }
}

function isOperationTimeoutError(
    error: unknown,
): error is OperationTimeoutError {
    return error instanceof OperationTimeoutError;
}

async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operationName: string,
): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new OperationTimeoutError(operationName, timeoutMs));
        }, timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
    }
}

class LocationLogCreateAlreadyInFlightError extends Error {
    readonly locationLogId: string;

    constructor(locationLogId: string) {
        super(`LocationLog.create is already in flight: ${locationLogId}`);

        this.name = "LocationLogCreateAlreadyInFlightError";
        this.locationLogId = locationLogId;
    }
}

function isLocationLogCreateAlreadyInFlightError(
    error: unknown,
): error is LocationLogCreateAlreadyInFlightError {
    return error instanceof LocationLogCreateAlreadyInFlightError;
}

async function prepareBackgroundAuthSession(): Promise<BackgroundAuthSessionResult> {
    try {
        /*
         * 通常の認証セッション取得にもタイムアウトを設定する。
         *
         * 有効期限切れの場合は、Amplifyがrefresh tokenを利用できれば
         * 通常取得の中でセッション更新が行われる。
         */
        let session = await withTimeout(
            fetchAuthSession(),
            AUTH_SESSION_FETCH_TIMEOUT_MS,
            "Background auth session fetch",
        );

        let hasIdToken = Boolean(session.tokens?.idToken);
        let hasAccessToken = Boolean(session.tokens?.accessToken);

        if (hasIdToken && hasAccessToken) {
            return {
                available: true,
                refreshed: false,
                hasIdToken,
                hasAccessToken,
            };
        }

        /*
         * トークンが取得できなかった場合だけ、
         * 1回限定で強制更新する。
         */
        session = await withTimeout(
            fetchAuthSession({
                forceRefresh: true,
            }),
            AUTH_SESSION_REFRESH_TIMEOUT_MS,
            "Background auth session force refresh",
        );

        hasIdToken = Boolean(session.tokens?.idToken);
        hasAccessToken = Boolean(session.tokens?.accessToken);

        return {
            available: hasIdToken && hasAccessToken,
            refreshed: true,
            hasIdToken,
            hasAccessToken,
        };
    } catch (error) {
        const errorMessage = getErrorMessage(error);

        console.error("Prepare background auth session error:", error);

        return {
            available: false,
            refreshed: false,
            hasIdToken: false,
            hasAccessToken: false,
            errorMessage,
        };
    }
}

type LocationLogCreateInput = {
    id: string;
    userId: string;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    recordedAt: string;
    memo: string;
    recordingSessionId: string;
    source: string;
    sharedOwners?: string[];
    locationUniqueKey: string;
};

type LiveLocationMutationResult = {
    data?: {
        id?: string | null;
    } | null;
    errors?: unknown;
};

type LocationLogCreateWithAuthRetryResult = {
    result: any;
    authRefreshAttempted: boolean;
    authRefreshSucceeded: boolean;
};

async function createLocationLogWithAuthRetry(
    input: LocationLogCreateInput,
): Promise<LocationLogCreateWithAuthRetryResult> {
    let firstResult: any;

    try {
        firstResult = await createLocationLogSingleFlight(
            input,
            "Background LocationLog.create",
        );
    } catch (error) {
        /*
         * タイムアウトは認証エラーではないため、そのまま呼び出し元へ返す。
         *
         * タイムアウト後も内部通信が遅れて成功する可能性があるが、
         * LocationLogでは決定的IDを使用しているため、
         * 次回再送時は重複として安全に処理できる。
         */
        if (isOperationTimeoutError(error)) {
            throw error;
        }

        if (!isUnauthorizedError(error)) {
            throw error;
        }

        try {
            await withTimeout(
                fetchAuthSession({
                    forceRefresh: true,
                }),
                AUTH_SESSION_REFRESH_TIMEOUT_MS,
                "Background auth force refresh",
            );
        } catch (refreshError) {
            console.error(
                "Background auth force refresh failed:",
                refreshError,
            );

            throw refreshError;
        }

        const retryResult = await createLocationLogSingleFlight(
            input,
            "Background LocationLog.create retry",
        );

        return {
            result: retryResult,
            authRefreshAttempted: true,
            authRefreshSucceeded: true,
        };
    }

    if (!firstResult.errors || !isUnauthorizedError(firstResult.errors)) {
        return {
            result: firstResult,
            authRefreshAttempted: false,
            authRefreshSucceeded: false,
        };
    }

    try {
        await withTimeout(
            fetchAuthSession({
                forceRefresh: true,
            }),
            AUTH_SESSION_REFRESH_TIMEOUT_MS,
            "Background auth force refresh",
        );
    } catch (refreshError) {
        console.error("Background auth force refresh failed:", refreshError);

        /*
         * 最初のUnauthorized結果は取得できているため、
         * 従来どおり呼び出し元へ返す。
         */
        return {
            result: firstResult,
            authRefreshAttempted: true,
            authRefreshSucceeded: false,
        };
    }

    const retryResult = await createLocationLogSingleFlight(
        input,
        "Background LocationLog.create retry",
    );

    return {
        result: retryResult,
        authRefreshAttempted: true,
        authRefreshSucceeded: true,
    };
}

async function createLocationLogSingleFlight(
    input: LocationLogCreateInput,
    operationName: string,
): Promise<any> {
    const locationLogId = input.id;

    if (inFlightLocationLogCreateIds.has(locationLogId)) {
        throw new LocationLogCreateAlreadyInFlightError(locationLogId);
    }

    /*
     * create開始前に登録する。
     * JavaScriptはこの区間では同期的に実行されるため、
     * 同一runtime内で同じIDが同時に登録されることを防げる。
     */
    inFlightLocationLogCreateIds.add(locationLogId);

    /*
     * 重要：
     * withTimeout()より前に、生のPromiseを保持する。
     */
    let rawCreatePromise: Promise<any>;

    try {
        rawCreatePromise = client.models.LocationLog.create(input);
    } catch (error) {
        inFlightLocationLogCreateIds.delete(locationLogId);
        throw error;
    }

    /*
     * timeoutではなく、
     * 生のGraphQL Promiseが本当に完了した時だけ解除する。
     */
    void rawCreatePromise.then(
        () => {
            inFlightLocationLogCreateIds.delete(locationLogId);
        },
        () => {
            inFlightLocationLogCreateIds.delete(locationLogId);
        },
    );

    /*
     * 呼び出し元を無期限に待たせないためのtimeout。
     *
     * timeoutしてもinFlightはここでは削除しない。
     */
    return await withTimeout(
        rawCreatePromise,
        LOCATION_LOG_CREATE_TIMEOUT_MS,
        operationName,
    );
}

TaskManager.defineTask(
    BACKGROUND_LOCATION_TASK_NAME,
    async ({ data, error }) => {
        const taskStartedAtMs = Date.now();
        const taskFiredAt = new Date(taskStartedAtMs).toISOString();

        /*
         * 後続処理より前に、OSから渡された地点数を取得する。
         *
         * LocationLog保存や認証処理でエラーが発生した場合でも、
         * タスク自体が呼び出されたことをheartbeatで確認できるようにする。
         */
        const receivedLocations = (
            data as {
                locations?: Location.LocationObject[];
            }
        )?.locations;

        let locationsLength = receivedLocations?.length ?? 0;
        let saveSuccessCount = 0;
        let saveFailureCount = 0;

        let liveLocationUpdateAttempted = false;
        let liveLocationUpdateSucceeded = false;
        let liveLocationUpdateTimedOut = false;

        let liveLocationUpdateOperation: "none" | "create" | "update" = "none";

        let liveLocationUpdateErrorMessage: string | null = null;
        let liveLocationUpdatedId: string | null = null;

        let sqliteMirrorAttempted = false;
        let sqliteMirrorSucceeded = false;
        let sqliteMirrorDurationMs = 0;
        let sqliteMirrorInsertedCount = 0;
        let sqliteMirrorDuplicateCount = 0;
        let sqliteMirrorInvalidCount = 0;
        let sqliteMirrorQueueCount: number | null = null;
        let sqliteMirrorErrorMessage: string | null = null;
        let sqliteQueueUploadAttempted = false;
        let sqliteQueueUploadSucceeded = false;
        let sqliteQueueUploadDurationMs = 0;
        let sqliteQueueUploadPendingCount = 0;
        let sqliteQueueUploadProcessedCount = 0;
        let sqliteQueueUploadSentCount = 0;
        let sqliteQueueUploadDuplicateCount = 0;
        let sqliteQueueUploadSkippedCount = 0;
        let sqliteQueueUploadFailedCount = 0;
        let sqliteQueueUploadTimedOutCount = 0;
        let sqliteQueueUploadStopReason: string | null = null;
        let sqliteQueueUploadErrorMessage: string | null = null;
        let sqliteQueueTotalCount: number | null = null;
        let sqliteQueuePendingCount: number | null = null;
        let sqliteQueueSentStatusCount: number | null = null;
        let sqliteQueueDuplicateStatusCount: number | null = null;
        let sqliteQueueSkippedStatusCount: number | null = null;
        let sqliteQueueFailedPendingCount: number | null = null;
        let sqliteQueueOldestPendingRecordedAt: string | null = null;
        let sqliteQueueLatestPendingRecordedAt: string | null = null;
        let sqliteQueueSummaryErrorMessage: string | null = null;

        let invalidCoordinateSkippedCount = 0;
        let lowAccuracySkippedCount = 0;
        let abnormalSpeedSkippedCount = 0;
        let inProgressDuplicateSkippedCount = 0;
        let exactDuplicateSkippedCount = 0;
        let nearDuplicateSkippedCount = 0;
        let saveConditionSkippedCount = 0;

        let firstRecordedAt: string | null = null;
        let latestRecordedAt: string | null = null;

        const processingTimings = createBackgroundLocationProcessingTimings();

        let backgroundAuthSession: BackgroundAuthSessionResult | null = null;

        let backgroundAuthSessionDurationMs = 0;

        try {
            const state = await getBackgroundRecordingState();

            /*
             * LocationLog保存、SQLite処理、認証処理などより前にheartbeatを保存する。
             *
             * これにより、後続処理が失敗しても、
             * バックグラウンドタスク自体が起動したことを判定できる。
             */
            await safeSaveBackgroundLocationTaskHeartbeat({
                firedAt: taskStartedAtMs,
                taskFiredAt,
                locationsLength,
                recordingSessionId: state?.recordingSessionId ?? null,
                isRecording: state?.isRecording === true,
                userId: state?.userId ?? null,
                hasTaskError: Boolean(error),
            });

            /*
             * TaskManagerからerrorが渡された場合は、
             * LocationLog処理へ進まず異常ログを1件だけ保存する。
             */
            if (error) {
                await safeSaveBackgroundLocationDebugLog({
                    userId: state?.userId ?? null,
                    recordingSessionId: state?.recordingSessionId ?? null,
                    eventName: "backgroundLocationTaskError",
                    taskFiredAt,
                    locationsLength,
                    saveSuccessCount,
                    saveFailureCount: 1,
                    errorMessage: getErrorMessage(error),
                    details: {
                        processingDurationMs: Date.now() - taskStartedAtMs,
                    },
                });

                console.error("Background location task error:", error);
                return;
            }

            const locations = receivedLocations;

            /*
             * 位置情報が0件の場合も、バッチ結果として1件だけ保存する。
             */
            if (!locations || locations.length === 0) {
                await safeSaveBackgroundLocationDebugLog({
                    userId: state?.userId ?? null,
                    recordingSessionId: state?.recordingSessionId ?? null,
                    eventName: "backgroundLocationBatchProcessed",
                    taskFiredAt,
                    locationsLength: 0,
                    saveSuccessCount: 0,
                    saveFailureCount: 0,
                    skippedCount: 0,
                    invalidCoordinateSkippedCount: 0,
                    lowAccuracySkippedCount: 0,
                    abnormalSpeedSkippedCount: 0,
                    inProgressDuplicateSkippedCount: 0,
                    exactDuplicateSkippedCount: 0,
                    nearDuplicateSkippedCount: 0,
                    saveConditionSkippedCount: 0,
                    details: {
                        batchStatus: "noLocations",
                        processingDurationMs: Date.now() - taskStartedAtMs,
                        firstRecordedAt: null,
                        latestRecordedAt: null,
                    },
                });

                return;
            }

            /*
             * 記録状態がない場合も、受信した地点数を残して終了する。
             */
            const activeRecordingSessionId =
                state?.isRecording === true && state.recordingSessionId
                    ? state.recordingSessionId
                    : null;

            const hasLiveSharing =
                (state?.liveShareOwnerValues?.length ?? 0) > 0;

            if (
                !state?.userId ||
                (!activeRecordingSessionId && !hasLiveSharing)
            ) {
                await safeSaveBackgroundLocationDebugLog({
                    userId: state?.userId ?? null,
                    recordingSessionId: state?.recordingSessionId ?? null,
                    eventName: "backgroundLocationBatchProcessed",
                    taskFiredAt,
                    locationsLength,
                    saveSuccessCount: 0,
                    saveFailureCount: 0,
                    skippedCount: locationsLength,
                    invalidCoordinateSkippedCount: 0,
                    lowAccuracySkippedCount: 0,
                    abnormalSpeedSkippedCount: 0,
                    inProgressDuplicateSkippedCount: 0,
                    exactDuplicateSkippedCount: 0,
                    nearDuplicateSkippedCount: 0,
                    saveConditionSkippedCount: 0,
                    details: {
                        batchStatus: "backgroundStateUnavailable",
                        processingDurationMs: Date.now() - taskStartedAtMs,
                        hasState: Boolean(state),
                        hasUserId: Boolean(state?.userId),
                        isRecording: state?.isRecording ?? false,
                        hasRecordingSessionId: Boolean(
                            state?.recordingSessionId,
                        ),
                        hasLiveSharing,
                        liveShareOwnerCount:
                            state?.liveShareOwnerValues?.length ?? 0,
                    },
                });

                console.log(
                    "Background recording or live sharing state not found.",
                );

                return;
            }

            /*
             * 第1段階：
             * OSから受信した全地点を、既存保存判定より前にSQLiteへ複製する。
             *
             * SQLite保存結果にかかわらず、
             * この後の既存LocationLog直接保存処理は必ず継続する。
             */
            if (ENABLE_LOCATION_SQLITE_MIRROR && activeRecordingSessionId) {
                sqliteMirrorAttempted = true;

                const sqliteMirrorStartedAtMs = Date.now();

                try {
                    const { enqueueLocationBatchForAudit } =
                        await import("../services/locationLocationQueueService");

                    const sqliteResult = await withTimeout(
                        enqueueLocationBatchForAudit({
                            userId: state.userId,
                            recordingSessionId: activeRecordingSessionId,
                            source: "background",
                            locations,
                            receivedAt: taskFiredAt,
                            sharedOwners: state.liveShareOwnerValues,
                        }),
                        SQLITE_MIRROR_TIMEOUT_MS,
                        "Background SQLite location mirror",
                    );

                    sqliteMirrorSucceeded = true;
                    sqliteMirrorInsertedCount = sqliteResult.insertedCount;
                    sqliteMirrorDuplicateCount = sqliteResult.duplicateCount;
                    sqliteMirrorInvalidCount = sqliteResult.invalidCount;
                    sqliteMirrorQueueCount = sqliteResult.queueCount;

                    console.log(
                        "Background SQLite location mirror completed:",
                        {
                            recordingSessionId: state.recordingSessionId,
                            receivedCount: sqliteResult.receivedCount,
                            insertedCount: sqliteResult.insertedCount,
                            duplicateCount: sqliteResult.duplicateCount,
                            invalidCount: sqliteResult.invalidCount,
                            queueCount: sqliteResult.queueCount,
                        },
                    );
                } catch (sqliteError) {
                    sqliteMirrorErrorMessage = getErrorMessage(sqliteError);

                    /*
                     * 最重要：
                     * SQLite失敗時もreturnしない。
                     * 既存のLocationLog.create経路をそのまま継続する。
                     */
                    console.error(
                        "Background SQLite location mirror failed. Continue direct LocationLog save:",
                        sqliteError,
                    );
                } finally {
                    sqliteMirrorDurationMs =
                        Date.now() - sqliteMirrorStartedAtMs;
                }
            }

            if (activeRecordingSessionId) {
                try {
                    const {
                        getLocationQueueStatusSummary,
                        cleanupProcessedLocationQueue,
                    } =
                        await import("../services/locationLocationQueueService");

                    const queueSummary = await getLocationQueueStatusSummary({
                        userId: state.userId,
                        recordingSessionId: activeRecordingSessionId,
                    });

                    sqliteQueueTotalCount = queueSummary.totalCount;
                    sqliteQueuePendingCount = queueSummary.pendingCount;
                    sqliteQueueSentStatusCount = queueSummary.sentCount;
                    sqliteQueueDuplicateStatusCount =
                        queueSummary.duplicateCount;
                    sqliteQueueSkippedStatusCount = queueSummary.skippedCount;
                    sqliteQueueFailedPendingCount =
                        queueSummary.failedPendingCount;
                    sqliteQueueOldestPendingRecordedAt =
                        queueSummary.oldestPendingRecordedAt;
                    sqliteQueueLatestPendingRecordedAt =
                        queueSummary.latestPendingRecordedAt;

                    const cleanupResult = await cleanupProcessedLocationQueue({
                        retentionDays: 7,
                    });

                    if (cleanupResult.deletedCount > 0) {
                        console.log(
                            "Background SQLite queue cleanup completed:",
                            cleanupResult,
                        );
                    }
                } catch (queueSummaryError) {
                    sqliteQueueSummaryErrorMessage =
                        getErrorMessage(queueSummaryError);

                    console.error(
                        "Read background SQLite queue summary error:",
                        queueSummaryError,
                    );
                }
            }

            const backgroundAuthSessionStartedAtMs = Date.now();

            backgroundAuthSession = await prepareBackgroundAuthSession();

            backgroundAuthSessionDurationMs =
                Date.now() - backgroundAuthSessionStartedAtMs;

            if (!backgroundAuthSession.available) {
                console.warn(
                    "Background auth session is not available before cloud location processing:",
                    {
                        recordingSessionId: state.recordingSessionId,
                        durationMs: backgroundAuthSessionDurationMs,
                        refreshed: backgroundAuthSession.refreshed,
                        hasIdToken: backgroundAuthSession.hasIdToken,
                        hasAccessToken: backgroundAuthSession.hasAccessToken,
                        errorMessage:
                            backgroundAuthSession.errorMessage ?? null,
                        isRecording: state.isRecording,
                        hasLiveSharing,
                    },
                );
            }
            /*
             * OSから渡された地点を時刻順に処理する。
             * 現在の保存方式を維持するため、並列処理にはしない。
             */
            const sortedLocations = [...locations].sort((a, b) => {
                return getLocationRecordedAtMs(a) - getLocationRecordedAtMs(b);
            });

            firstRecordedAt = new Date(
                getLocationRecordedAtMs(sortedLocations[0]),
            ).toISOString();

            latestRecordedAt = new Date(
                getLocationRecordedAtMs(
                    sortedLocations[sortedLocations.length - 1],
                ),
            ).toISOString();

            let currentState = state;

            /*
             * 最優先：
             * 今回OSから受信したLocationLogを先に保存する。
             *
             * LiveLocation更新がAndroidバックグラウンドで長時間停止しても、
             * 新しいLocationLogの保存を巻き込まないようにする。
             */
            if (
                KEEP_DIRECT_LOCATION_LOG_SAVE &&
                currentState.isRecording &&
                currentState.recordingSessionId
            ) {
                for (const location of sortedLocations) {
                    const result = await saveBackgroundLocation(
                        location,
                        currentState,
                        taskFiredAt,
                        processingTimings,
                    );

                    if (result.saved) {
                        saveSuccessCount += 1;
                    }

                    if (result.errorMessage) {
                        saveFailureCount += 1;
                    }

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

                        case "inProgressDuplicate":
                            inProgressDuplicateSkippedCount += 1;
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

                        case undefined:
                            break;

                        default: {
                            const exhaustiveCheck: never = result.skippedReason;

                            console.warn(
                                "Unknown background location skip reason:",
                                exhaustiveCheck,
                            );
                        }
                    }

                    currentState = result.nextState;
                }
            }

            /*
             * LocationLog保存完了後にLiveLocationを更新する。
             *
             * 現在地共有の機能自体は変更せず、
             * 実行順序だけLocationLogの後ろへ移動する。
             */
            const latestLocation = sortedLocations[sortedLocations.length - 1];

            if (
                latestLocation &&
                currentState.liveShareOwnerValues.length > 0
            ) {
                const liveLocationResult = await updateBackgroundLiveLocation(
                    latestLocation,
                    currentState,
                    taskFiredAt,
                );

                currentState = liveLocationResult.nextState;

                liveLocationUpdateAttempted = liveLocationResult.attempted;

                liveLocationUpdateSucceeded = liveLocationResult.succeeded;

                liveLocationUpdateTimedOut = liveLocationResult.timedOut;

                liveLocationUpdateOperation = liveLocationResult.operation;

                liveLocationUpdateErrorMessage =
                    liveLocationResult.errorMessage ?? null;

                liveLocationUpdatedId =
                    liveLocationResult.liveLocationId ?? null;
            }

            if (
                ENABLE_LOCATION_SQLITE_QUEUE_UPLOAD &&
                activeRecordingSessionId
            ) {
                sqliteQueueUploadAttempted = true;

                const queueUploadStartedAtMs = Date.now();

                try {
                    const { drainLocationQueueSafely } =
                        await import("../services/locationQueueUploadService");

                    const uploadResult = await drainLocationQueueSafely({
                        userId: state.userId,
                        recordingSessionId: activeRecordingSessionId,
                        intervalMs: state.intervalMs,
                        distanceMeters: state.distanceMeters,
                        fallbackSharedOwners: state.liveShareOwnerValues,
                    });

                    sqliteQueueUploadSucceeded =
                        uploadResult.failedCount === 0 &&
                        uploadResult.timedOutCount === 0 &&
                        uploadResult.stopReason !== "alreadyRunning";

                    sqliteQueueUploadPendingCount = uploadResult.pendingCount;

                    sqliteQueueUploadProcessedCount =
                        uploadResult.processedCount;

                    sqliteQueueUploadSentCount = uploadResult.sentCount;

                    sqliteQueueUploadDuplicateCount =
                        uploadResult.duplicateCount;

                    sqliteQueueUploadSkippedCount = uploadResult.skippedCount;

                    sqliteQueueUploadFailedCount = uploadResult.failedCount;

                    sqliteQueueUploadTimedOutCount = uploadResult.timedOutCount;

                    sqliteQueueUploadStopReason = uploadResult.stopReason;

                    console.log("SQLite location queue upload completed:", {
                        recordingSessionId: state.recordingSessionId,
                        ...uploadResult,
                    });
                } catch (queueUploadError) {
                    sqliteQueueUploadErrorMessage =
                        getErrorMessage(queueUploadError);

                    console.error(
                        "SQLite location queue upload failed. Continue direct LocationLog save:",
                        queueUploadError,
                    );
                } finally {
                    sqliteQueueUploadDurationMs =
                        Date.now() - queueUploadStartedAtMs;
                }
            }

            const skippedCount =
                invalidCoordinateSkippedCount +
                lowAccuracySkippedCount +
                abnormalSpeedSkippedCount +
                inProgressDuplicateSkippedCount +
                exactDuplicateSkippedCount +
                nearDuplicateSkippedCount +
                saveConditionSkippedCount;

            const batchDebugLogStartedAt = new Date().toISOString();
            /*
             * LocationLog処理がすべて終わった後に、
             * バッチ全体のサマリを1件だけ保存する。
             *
             * デバッグログ保存関数内で例外は握りつぶされるため、
             * デバッグログ失敗がLocationLog処理を失敗させることはない。
             */
            await safeSaveBackgroundLocationDebugLog({
                userId: state.userId,
                recordingSessionId: state.recordingSessionId,
                eventName: "backgroundLocationBatchProcessed",
                taskFiredAt,
                locationsLength,
                saveSuccessCount,
                saveFailureCount,
                skippedCount,
                invalidCoordinateSkippedCount,
                lowAccuracySkippedCount,
                abnormalSpeedSkippedCount,
                inProgressDuplicateSkippedCount,
                exactDuplicateSkippedCount,
                nearDuplicateSkippedCount,
                saveConditionSkippedCount,
                details: {
                    batchStatus:
                        saveFailureCount > 0
                            ? "completedWithErrors"
                            : "completed",

                    /*
                     * バッチ結果ログの保存開始直前までの処理時間。
                     * このBackgroundLocationDebugLog自体の保存時間は含まれない。
                     */
                    processingDurationMs: Date.now() - taskStartedAtMs,

                    sqliteMirrorEnabled: ENABLE_LOCATION_SQLITE_MIRROR,
                    sqliteMirrorAttempted,
                    sqliteMirrorSucceeded,
                    sqliteMirrorDurationMs,
                    sqliteMirrorInsertedCount,
                    sqliteMirrorDuplicateCount,
                    sqliteMirrorInvalidCount,
                    sqliteMirrorQueueCount,
                    sqliteMirrorErrorMessage,
                    sqliteQueueUploadEnabled:
                        ENABLE_LOCATION_SQLITE_QUEUE_UPLOAD,

                    keepDirectLocationLogSave: KEEP_DIRECT_LOCATION_LOG_SAVE,

                    sqliteQueueUploadAttempted,
                    sqliteQueueUploadSucceeded,
                    sqliteQueueUploadDurationMs,
                    sqliteQueueUploadPendingCount,
                    sqliteQueueUploadProcessedCount,
                    sqliteQueueUploadSentCount,
                    sqliteQueueUploadDuplicateCount,
                    sqliteQueueUploadSkippedCount,
                    sqliteQueueUploadFailedCount,
                    sqliteQueueUploadTimedOutCount,
                    sqliteQueueUploadStopReason,
                    sqliteQueueUploadErrorMessage,
                    sqliteQueueTotalCount,
                    sqliteQueuePendingCount,
                    sqliteQueueSentStatusCount,
                    sqliteQueueDuplicateStatusCount,
                    sqliteQueueSkippedStatusCount,
                    sqliteQueueFailedPendingCount,
                    sqliteQueueOldestPendingRecordedAt,
                    sqliteQueueLatestPendingRecordedAt,
                    sqliteQueueSummaryErrorMessage,

                    backgroundAuthSessionDurationMs,

                    backgroundAuthSessionAvailable:
                        backgroundAuthSession?.available ?? null,

                    backgroundAuthSessionRefreshed:
                        backgroundAuthSession?.refreshed ?? null,

                    backgroundAuthSessionHasIdToken:
                        backgroundAuthSession?.hasIdToken ?? null,

                    backgroundAuthSessionHasAccessToken:
                        backgroundAuthSession?.hasAccessToken ?? null,

                    backgroundAuthSessionErrorMessage:
                        backgroundAuthSession?.errorMessage ?? null,

                    batchDebugLogStartedAt,

                    firstRecordedAt,
                    latestRecordedAt,
                    intervalMs: state.intervalMs,
                    distanceMeters: state.distanceMeters,
                    isRecording: state.isRecording,

                    hasLiveShareOwners:
                        (state.liveShareOwnerValues?.length ?? 0) > 0,

                    liveShareOwnerCount:
                        state.liveShareOwnerValues?.length ?? 0,

                    /*
                     * LiveLocation更新結果
                     */
                    liveLocationUpdateAttempted,
                    liveLocationUpdateSucceeded,
                    liveLocationUpdateTimedOut,
                    liveLocationUpdateOperation,
                    liveLocationUpdateErrorMessage,
                    liveLocationUpdatedId,

                    /*
                     * 各処理のバッチ内合計時間
                     */
                    lockAcquireDurationMs:
                        processingTimings.lockAcquireDurationMs,

                    preCreateLookupDurationMs:
                        processingTimings.preCreateLookupDurationMs,

                    locationLogCreateDurationMs:
                        processingTimings.locationLogCreateDurationMs,

                    stateUpdateDurationMs:
                        processingTimings.stateUpdateDurationMs,

                    continuationUpdateDurationMs:
                        processingTimings.continuationUpdateDurationMs,

                    /*
                     * 各処理の実行回数
                     */
                    lockAcquireCount: processingTimings.lockAcquireCount,

                    preCreateLookupCount:
                        processingTimings.preCreateLookupCount,

                    locationLogCreateCount:
                        processingTimings.locationLogCreateCount,

                    stateUpdateCount: processingTimings.stateUpdateCount,

                    continuationUpdateCount:
                        processingTimings.continuationUpdateCount,

                    /*
                     * 各処理の1回あたり最大時間
                     */
                    lockAcquireMaxDurationMs:
                        processingTimings.lockAcquireMaxDurationMs,

                    preCreateLookupMaxDurationMs:
                        processingTimings.preCreateLookupMaxDurationMs,

                    locationLogCreateMaxDurationMs:
                        processingTimings.locationLogCreateMaxDurationMs,

                    stateUpdateMaxDurationMs:
                        processingTimings.stateUpdateMaxDurationMs,

                    continuationUpdateMaxDurationMs:
                        processingTimings.continuationUpdateMaxDurationMs,
                },
            });
        } catch (taskError) {
            /*
             * 予期しない例外でも、ここまでの集計値を1件にまとめる。
             */
            await safeSaveBackgroundLocationDebugLog({
                eventName: "backgroundLocationTaskUnexpectedError",
                taskFiredAt,
                locationsLength,
                saveSuccessCount,
                saveFailureCount: saveFailureCount + 1,
                skippedCount:
                    invalidCoordinateSkippedCount +
                    lowAccuracySkippedCount +
                    abnormalSpeedSkippedCount +
                    inProgressDuplicateSkippedCount +
                    exactDuplicateSkippedCount +
                    nearDuplicateSkippedCount +
                    saveConditionSkippedCount,
                invalidCoordinateSkippedCount,
                lowAccuracySkippedCount,
                abnormalSpeedSkippedCount,
                inProgressDuplicateSkippedCount,
                exactDuplicateSkippedCount,
                nearDuplicateSkippedCount,
                saveConditionSkippedCount,
                errorMessage: getErrorMessage(taskError),
                details: {
                    batchStatus: "unexpectedError",

                    processingDurationMs: Date.now() - taskStartedAtMs,
                    /*
                     * LiveLocation更新結果
                     */
                    liveLocationUpdateAttempted,
                    liveLocationUpdateSucceeded,
                    liveLocationUpdateTimedOut,
                    liveLocationUpdateOperation,
                    liveLocationUpdateErrorMessage,
                    liveLocationUpdatedId,
                    /*
                     * SQLite複製保存の状態。
                     *
                     * SQLite処理中または処理後に予期しない例外が発生した場合でも、
                     * どこまでSQLite保存できていたかを確認できるようにする。
                     */
                    sqliteMirrorEnabled: ENABLE_LOCATION_SQLITE_MIRROR,
                    sqliteMirrorAttempted,
                    sqliteMirrorSucceeded,
                    sqliteMirrorDurationMs,
                    sqliteMirrorInsertedCount,
                    sqliteMirrorDuplicateCount,
                    sqliteMirrorInvalidCount,
                    sqliteMirrorQueueCount,
                    sqliteMirrorErrorMessage,
                    sqliteQueueUploadEnabled:
                        ENABLE_LOCATION_SQLITE_QUEUE_UPLOAD,

                    keepDirectLocationLogSave: KEEP_DIRECT_LOCATION_LOG_SAVE,

                    sqliteQueueUploadAttempted,
                    sqliteQueueUploadSucceeded,
                    sqliteQueueUploadDurationMs,
                    sqliteQueueUploadPendingCount,
                    sqliteQueueUploadProcessedCount,
                    sqliteQueueUploadSentCount,
                    sqliteQueueUploadDuplicateCount,
                    sqliteQueueUploadSkippedCount,
                    sqliteQueueUploadFailedCount,
                    sqliteQueueUploadTimedOutCount,
                    sqliteQueueUploadStopReason,
                    sqliteQueueUploadErrorMessage,

                    sqliteQueueTotalCount,
                    sqliteQueuePendingCount,
                    sqliteQueueSentStatusCount,
                    sqliteQueueDuplicateStatusCount,
                    sqliteQueueSkippedStatusCount,
                    sqliteQueueFailedPendingCount,
                    sqliteQueueOldestPendingRecordedAt,
                    sqliteQueueLatestPendingRecordedAt,
                    sqliteQueueSummaryErrorMessage,

                    batchDebugLogStartedAt: new Date().toISOString(),

                    firstRecordedAt,
                    latestRecordedAt,

                    lockAcquireDurationMs:
                        processingTimings.lockAcquireDurationMs,

                    preCreateLookupDurationMs:
                        processingTimings.preCreateLookupDurationMs,

                    locationLogCreateDurationMs:
                        processingTimings.locationLogCreateDurationMs,

                    stateUpdateDurationMs:
                        processingTimings.stateUpdateDurationMs,

                    continuationUpdateDurationMs:
                        processingTimings.continuationUpdateDurationMs,

                    lockAcquireCount: processingTimings.lockAcquireCount,

                    preCreateLookupCount:
                        processingTimings.preCreateLookupCount,

                    locationLogCreateCount:
                        processingTimings.locationLogCreateCount,

                    stateUpdateCount: processingTimings.stateUpdateCount,

                    continuationUpdateCount:
                        processingTimings.continuationUpdateCount,

                    lockAcquireMaxDurationMs:
                        processingTimings.lockAcquireMaxDurationMs,

                    preCreateLookupMaxDurationMs:
                        processingTimings.preCreateLookupMaxDurationMs,

                    locationLogCreateMaxDurationMs:
                        processingTimings.locationLogCreateMaxDurationMs,

                    stateUpdateMaxDurationMs:
                        processingTimings.stateUpdateMaxDurationMs,

                    continuationUpdateMaxDurationMs:
                        processingTimings.continuationUpdateMaxDurationMs,
                },
            });

            console.error(
                "Background location task unexpected error:",
                taskError,
            );
        }
    },
);

function getLocationRecordedAtMs(location: Location.LocationObject): number {
    if (
        typeof location.timestamp === "number" &&
        Number.isFinite(location.timestamp)
    ) {
        return location.timestamp;
    }

    return Date.now();
}

async function getBackgroundRecordingState(): Promise<BackgroundRecordingState | null> {
    const raw = await AsyncStorage.getItem(BACKGROUND_RECORDING_STATE_KEY);

    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw) as Partial<BackgroundRecordingState>;

        if (typeof parsed.userId !== "string" || parsed.userId.length === 0) {
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

            /*
             * 旧形式のデータにisRecordingがない場合は、
             * recordingSessionIdの有無から判定する。
             */
            isRecording:
                typeof parsed.isRecording === "boolean"
                    ? parsed.isRecording
                    : Boolean(parsed.recordingSessionId),

            recordingSessionId: parsed.recordingSessionId ?? null,

            startedAt: parsed.startedAt ?? null,

            liveShareOwnerValues,

            liveLocationId: parsed.liveLocationId ?? null,

            lastSavedLocation: parsed.lastSavedLocation ?? null,

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

async function setBackgroundRecordingState(state: BackgroundRecordingState) {
    await AsyncStorage.setItem(
        BACKGROUND_RECORDING_STATE_KEY,
        JSON.stringify(state),
    );
}

async function updateBackgroundLiveLocation(
    location: Location.LocationObject,
    state: BackgroundRecordingState,
    taskFiredAt: string,
): Promise<UpdateBackgroundLiveLocationResult> {
    const sharedOwners = Array.from(
        new Set((state.liveShareOwnerValues ?? []).filter(Boolean)),
    );

    if (sharedOwners.length === 0) {
        return {
            nextState: state,
            attempted: false,
            succeeded: false,
            operation: "none",
            timedOut: false,
            liveLocationId: state.liveLocationId ?? null,
        };
    }

    const latitude = location.coords.latitude;
    const longitude = location.coords.longitude;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return {
            nextState: state,
            attempted: false,
            succeeded: false,
            operation: "none",
            timedOut: false,
            errorMessage: "LiveLocation coordinate is invalid.",
            liveLocationId: state.liveLocationId ?? null,
        };
    }

    const isRecording =
        state.isRecording === true && Boolean(state.recordingSessionId);

    const payload = {
        userId: state.userId,
        recordingSessionId: isRecording
            ? (state.recordingSessionId ?? null)
            : null,
        isActive: true,
        isRecording,
        latitude,
        longitude,
        accuracy: location.coords.accuracy ?? null,
        updatedAt: new Date().toISOString(),
        sharedOwners,
    };

    const liveLocationModel = client.models.LiveLocation as any;

    try {
        /*
         * 既存のLiveLocationがある場合は、
         * 同じレコードを更新する。
         */
        if (state.liveLocationId) {
            const result = (await withTimeout(
                liveLocationModel.update({
                    id: state.liveLocationId,
                    ...payload,
                }),
                LIVE_LOCATION_UPDATE_TIMEOUT_MS,
                "Background LiveLocation.update",
            )) as LiveLocationMutationResult;

            if (result.errors) {
                const errorMessage = getErrorMessage(result.errors);

                console.error(
                    "Background LiveLocation update errors:",
                    result.errors,
                );

                await safeSaveBackgroundLocationDebugLog({
                    userId: state.userId,
                    recordingSessionId: state.recordingSessionId ?? null,
                    eventName: "backgroundLiveLocationUpdateFailed",
                    taskFiredAt,
                    errorMessage,
                    details: {
                        liveLocationId: state.liveLocationId,
                        latitude,
                        longitude,
                        isRecording,
                        sharedOwnerCount: sharedOwners.length,
                    },
                });

                return {
                    nextState: state,
                    attempted: true,
                    succeeded: false,
                    operation: "update",
                    timedOut: false,
                    errorMessage,
                    liveLocationId: state.liveLocationId,
                };
            }

            /*
             * update失敗時に新規作成すると、
             * 一時的な通信障害だけで重複レコードが作られるため、
             * 既存IDがある場合は新規作成しない。
             */
            return {
                nextState: state,
                attempted: true,
                succeeded: true,
                operation: "update",
                timedOut: false,
                liveLocationId: state.liveLocationId,
            };
        }

        /*
         * LiveLocation IDがまだない場合だけ新規作成する。
         */
        const result = (await withTimeout(
            liveLocationModel.create(payload),
            LIVE_LOCATION_UPDATE_TIMEOUT_MS,
            "Background LiveLocation.create",
        )) as LiveLocationMutationResult;

        if (result.errors) {
            const errorMessage = getErrorMessage(result.errors);

            console.error(
                "Background LiveLocation create errors:",
                result.errors,
            );

            await safeSaveBackgroundLocationDebugLog({
                userId: state.userId,
                recordingSessionId: state.recordingSessionId ?? null,
                eventName: "backgroundLiveLocationCreateFailed",
                taskFiredAt,
                errorMessage,
                details: {
                    latitude,
                    longitude,
                    isRecording,
                    sharedOwnerCount: sharedOwners.length,
                },
            });

            return {
                nextState: state,
                attempted: true,
                succeeded: false,
                operation: "create",
                timedOut: false,
                errorMessage,
                liveLocationId: null,
            };
        }

        const createdLiveLocationId = result.data?.id ?? null;

        if (!createdLiveLocationId) {
            const errorMessage = "LiveLocation.create completed without an id.";

            return {
                nextState: state,
                attempted: true,
                succeeded: false,
                operation: "create",
                timedOut: false,
                errorMessage,
                liveLocationId: null,
            };
        }

        const nextState: BackgroundRecordingState = {
            ...state,
            liveLocationId: createdLiveLocationId,
        };

        await setBackgroundRecordingState(nextState);

        return {
            nextState,
            attempted: true,
            succeeded: true,
            operation: "create",
            timedOut: false,
            liveLocationId: createdLiveLocationId,
        };
    } catch (error) {
        const errorMessage = getErrorMessage(error);

        const timedOut = isOperationTimeoutError(error);

        const operation: "create" | "update" = state.liveLocationId
            ? "update"
            : "create";

        console.error("Background LiveLocation mutation error:", error);

        await safeSaveBackgroundLocationDebugLog({
            userId: state.userId,
            recordingSessionId: state.recordingSessionId ?? null,
            eventName: timedOut
                ? "backgroundLiveLocationTimedOut"
                : "backgroundLiveLocationUnexpectedError",
            taskFiredAt,
            errorMessage,
            details: {
                liveLocationId: state.liveLocationId ?? null,
                latitude,
                longitude,
                isRecording,
                sharedOwnerCount: sharedOwners.length,
                timeoutMs: timedOut ? error.timeoutMs : null,
                operationName: timedOut ? error.operationName : null,
            },
        });

        return {
            nextState: state,
            attempted: true,
            succeeded: false,
            operation,
            timedOut,
            errorMessage,
            liveLocationId: state.liveLocationId ?? null,
        };
    }
}

async function saveBackgroundLocation(
    location: Location.LocationObject,
    state: BackgroundRecordingState,
    taskFiredAt: string,
    processingTimings: BackgroundLocationProcessingTimings,
): Promise<SaveBackgroundLocationResult> {
    const latitude = location.coords.latitude;
    const longitude = location.coords.longitude;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return {
            saved: false,
            nextState: state,
            skippedReason: "invalidCoordinate",
        };
    }
    const recordedAtMs =
        typeof location.timestamp === "number" &&
        Number.isFinite(location.timestamp)
            ? location.timestamp
            : Date.now();

    const recordedAt = new Date(recordedAtMs).toISOString();
    const accuracy = location.coords.accuracy ?? null;
    const recordingSessionId = state.recordingSessionId;

    if (!recordingSessionId) {
        return {
            saved: false,
            nextState: state,
            errorMessage: "recordingSessionId is missing.",
        };
    }

    if (isLowAccuracyLocation(accuracy)) {
        return {
            saved: false,
            nextState: state,
            skippedReason: "lowAccuracy",
        };
    }

    const lockScopeKey = createLocationSaveLockScopeKey(
        state.userId,
        recordingSessionId,
    );
    const lockAcquireStartedAtMs = Date.now();

    let lock: LocationSaveLock | null;

    try {
        lock = await acquireLocationSaveLock(lockScopeKey);
    } finally {
        const durationMs = Date.now() - lockAcquireStartedAtMs;

        processingTimings.lockAcquireDurationMs += durationMs;

        processingTimings.lockAcquireCount += 1;

        processingTimings.lockAcquireMaxDurationMs = Math.max(
            processingTimings.lockAcquireMaxDurationMs,
            durationMs,
        );
    }

    if (!lock) {
        return {
            saved: false,
            nextState: state,
            skippedReason: "inProgressDuplicate",
        };
    }

    try {
        /*
         * ロック取得後にAsyncStorageを再読込する。
         * foreground側が直前に保存したlastSavedLocationもここで反映する。
         */
        const latestState = await getBackgroundRecordingState();

        if (
            !latestState ||
            !latestState.isRecording ||
            latestState.recordingSessionId !== recordingSessionId
        ) {
            return {
                saved: false,
                nextState: state,
                skippedReason: "saveConditionNotMet",
            };
        }

        const lastSavedLocation = latestState.lastSavedLocation ?? null;

        if (
            isAbnormalSpeedLocation(
                lastSavedLocation,
                latitude,
                longitude,
                recordedAtMs,
            )
        ) {
            const speedMetersPerSecond = calculateSpeedMetersPerSecond(
                lastSavedLocation,
                latitude,
                longitude,
                recordedAtMs,
            );

            await safeSaveBackgroundLocationDebugLog({
                userId: latestState.userId,
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
                },
            });

            return {
                saved: false,
                nextState: latestState,
                skippedReason: "abnormalSpeed",
            };
        }

        if (
            isExactDuplicateLocation(
                lastSavedLocation,
                latitude,
                longitude,
                recordedAtMs,
            )
        ) {
            return {
                saved: false,
                nextState: latestState,
                skippedReason: "exactDuplicate",
            };
        }

        if (
            isNearDuplicateLocation(
                lastSavedLocation,
                latitude,
                longitude,
                recordedAtMs,
            )
        ) {
            return {
                saved: false,
                nextState: latestState,
                skippedReason: "nearDuplicate",
            };
        }

        if (
            !shouldSaveLocation(latitude, longitude, recordedAtMs, latestState)
        ) {
            return {
                saved: false,
                nextState: latestState,
                skippedReason: "saveConditionNotMet",
            };
        }

        const locationUniqueKey = createLocationUniqueKey({
            userId: latestState.userId,
            recordingSessionId,
            recordedAt,
            latitude,
            longitude,
            accuracy,
        });
        const locationLogId = createLocationLogId(locationUniqueKey);

        /*
         * create前のLocationLog.getは実行しない。
         *
         * foreground/backgroundで共通の決定的idを使い、
         * 重複作成はLocationLog.createのエラーで判定する。
         */
        const sharedOwners =
            latestState.liveShareOwnerValues.length > 0
                ? Array.from(
                      new Set(latestState.liveShareOwnerValues.filter(Boolean)),
                  )
                : undefined;

        const locationLogCreateStartedAtMs = Date.now();

        let result: any;

        let authRefreshAttempted = false;
        let authRefreshSucceeded = false;

        try {
            const createResult = await createLocationLogWithAuthRetry({
                id: locationLogId,
                userId: latestState.userId,
                latitude,
                longitude,
                accuracy,
                recordedAt,
                memo: "自動記録",
                recordingSessionId,
                source: "background",
                sharedOwners,
                locationUniqueKey,
            });

            result = createResult.result;

            authRefreshAttempted = createResult.authRefreshAttempted;

            authRefreshSucceeded = createResult.authRefreshSucceeded;
        } finally {
            const durationMs = Date.now() - locationLogCreateStartedAtMs;

            processingTimings.locationLogCreateDurationMs += durationMs;

            processingTimings.locationLogCreateCount += 1;

            processingTimings.locationLogCreateMaxDurationMs = Math.max(
                processingTimings.locationLogCreateMaxDurationMs,
                durationMs,
            );
        }

        if (result.errors) {
            /*
             * 決定的なlocationLogIdによる重複作成だけを、
             * 正常な重複スキップとして扱う。
             *
             * 認証エラー、通信エラー、その他の作成エラーは
             * 重複扱いにせず、従来どおり保存失敗として記録する。
             */
            if (isDuplicateLocationCreateError(result.errors)) {
                return {
                    saved: false,
                    nextState: latestState,
                    skippedReason: "exactDuplicate",
                };
            }

            const errorMessage = getErrorMessage(result.errors);

            console.error(
                "Background LocationLog create errors:",
                result.errors,
            );

            await safeSaveBackgroundLocationDebugLog({
                userId: latestState.userId,
                recordingSessionId,
                eventName: "backgroundLocationLogCreateFailed",
                taskFiredAt,
                errorMessage,
                details: {
                    recordedAt,
                    latitude,
                    longitude,
                    locationUniqueKey,
                    authRefreshAttempted,
                    authRefreshSucceeded,
                    unauthorized: isUnauthorizedError(result.errors),
                },
            });

            return {
                saved: false,
                nextState: latestState,
                errorMessage,
            };
        }

        const nextState: BackgroundRecordingState = {
            ...latestState,
            lastSavedLocation: {
                latitude,
                longitude,
                recordedAt: recordedAtMs,
            },
        };

        /*
         * create成功からロック解放までの間に最終保存位置を更新する。
         */
        const stateUpdateStartedAtMs = Date.now();

        try {
            await setBackgroundRecordingState(nextState);
        } finally {
            const durationMs = Date.now() - stateUpdateStartedAtMs;

            processingTimings.stateUpdateDurationMs += durationMs;

            processingTimings.stateUpdateCount += 1;

            processingTimings.stateUpdateMaxDurationMs = Math.max(
                processingTimings.stateUpdateMaxDurationMs,
                durationMs,
            );
        }

        const continuationUpdateStartedAtMs = Date.now();

        try {
            await incrementRecordingContinuationPointCount(recordingSessionId);
        } finally {
            const durationMs = Date.now() - continuationUpdateStartedAtMs;

            processingTimings.continuationUpdateDurationMs += durationMs;

            processingTimings.continuationUpdateCount += 1;

            processingTimings.continuationUpdateMaxDurationMs = Math.max(
                processingTimings.continuationUpdateMaxDurationMs,
                durationMs,
            );
        }

        return {
            saved: true,
            nextState,
        };
    } catch (error) {
        if (isLocationLogCreateAlreadyInFlightError(error)) {
            console.log("Skip in-flight background LocationLog create:", {
                recordingSessionId,
                recordedAt,
                latitude,
                longitude,
                locationLogId: error.locationLogId,
            });

            return {
                saved: false,
                nextState: state,
                skippedReason: "inProgressDuplicate",
            };
        }

        // ② deterministic ID重複
        if (isDuplicateLocationCreateError(error)) {
            console.log(
                "Skip duplicate background LocationLog exception by deterministic id:",
                {
                    recordingSessionId,
                    recordedAt,
                    latitude,
                    longitude,
                },
            );

            return {
                saved: false,
                nextState: state,
                skippedReason: "exactDuplicate",
            };
        }

        /*
         * LocationLog.create()が重複をresult.errorsではなく
         * 例外としてthrowした場合も、正常な重複スキップとして扱う。
         *
         * errorMessageを返さないため、バッチのsaveFailureCountには
         * 加算されず、exactDuplicateSkippedCountへ加算される。
         */
        if (isOperationTimeoutError(error)) {
            const errorMessage = getErrorMessage(error);

            console.warn("Background LocationLog create timed out:", {
                recordingSessionId,
                recordedAt,
                latitude,
                longitude,
                operationName: error.operationName,
                timeoutMs: error.timeoutMs,
            });

            await safeSaveBackgroundLocationDebugLog({
                userId: state.userId,
                recordingSessionId,
                eventName: "backgroundLocationLogCreateTimedOut",
                taskFiredAt,
                errorMessage,
                details: {
                    recordedAt,
                    latitude,
                    longitude,
                    operationName: error.operationName,
                    timeoutMs: error.timeoutMs,
                    isRecording: state.isRecording,
                    isLiveSharing: state.liveShareOwnerValues.length > 0,
                    sharedOwnersCount: state.liveShareOwnerValues.length,
                },
            });

            /*
             * lastSavedLocationは更新しない。
             *
             * createが実際には遅れて成功する可能性があるため、
             * 次回は同じ決定的IDで再送され、
             * 成功済みなら重複として処理される。
             */
            return {
                saved: false,
                nextState: state,
                errorMessage,
            };
        }

        const errorMessage = getErrorMessage(error);

        console.error("saveBackgroundLocation unexpected error:", error);

        await safeSaveBackgroundLocationDebugLog({
            userId: state.userId,
            recordingSessionId,
            eventName: "saveBackgroundLocationUnexpectedError",
            taskFiredAt,
            errorMessage,
            details: {
                isRecording: state.isRecording,
                isLiveSharing: state.liveShareOwnerValues.length > 0,
                sharedOwnersCount: state.liveShareOwnerValues.length,
                hasLiveLocationId: Boolean(state.liveLocationId),
                errorName: error instanceof Error ? error.name : typeof error,
                errorStack:
                    error instanceof Error ? (error.stack ?? null) : null,
            },
        });

        return {
            saved: false,
            nextState: state,
            errorMessage,
        };
    } finally {
        try {
            await withTimeout(
                releaseLocationSaveLock(lock),
                3_000,
                "Background location save lock release",
            );
        } catch (releaseError) {
            console.error(
                "Release background location save lock failed:",
                releaseError,
            );
        }
    }
}

const DEFAULT_DISTANCE_METERS = 50;
const DEFAULT_INTERVAL_MS = 30_000;

function shouldSaveLocation(
    latitude: number,
    longitude: number,
    recordedAtMs: number,
    state: BackgroundRecordingState,
) {
    const lastSavedLocation = state.lastSavedLocation;

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
        Number.isFinite(state.intervalMs) && state.intervalMs > 0
            ? state.intervalMs
            : DEFAULT_INTERVAL_MS;

    const configuredDistanceMeters =
        Number.isFinite(state.distanceMeters) && state.distanceMeters > 0
            ? state.distanceMeters
            : DEFAULT_DISTANCE_METERS;

    /*
     * 時間間隔と距離間隔のどちらかを満たした場合に保存する。
     */
    if (elapsedMs >= configuredIntervalMs) {
        return true;
    }

    if (distance >= configuredDistanceMeters) {
        return true;
    }

    return false;
}
