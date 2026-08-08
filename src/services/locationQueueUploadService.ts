import { fetchAuthSession } from "aws-amplify/auth";

import {
    SQLITE_QUEUE_CREATE_TIMEOUT_MS,
    SQLITE_QUEUE_UPLOAD_MAX_ITEMS,
    SQLITE_QUEUE_UPLOAD_MIN_AGE_MS,
    SQLITE_QUEUE_UPLOAD_TIME_BUDGET_MS,
} from "../config/locationQueueFeatureFlags";
import { client } from "../lib/client";
import {
    calculateDistanceMeters,
    isAbnormalSpeedLocation,
    isExactDuplicateLocation,
    isLowAccuracyLocation,
    isNearDuplicateLocation,
} from "../utils/locationDuplicate";
import {
    getLatestAcceptedLocationQueueRow,
    getLocationQueueStatusSummary,
    getPendingLocationQueueRows,
    markLocationQueueRowDuplicate,
    markLocationQueueRowFailed,
    markLocationQueueRowSent,
    markLocationQueueRowSkipped,
    type PendingLocationQueueRow,
} from "./locationLocationQueueService";
import {
    createLocationLogId,
    isDuplicateLocationCreateError,
} from "./locationLogDeduplicationService";
import { incrementRecordingContinuationPointCount } from "./recordingContinuationService";

type DrainLocationQueueInput = {
    userId: string;
    recordingSessionId: string;
    intervalMs: number;
    distanceMeters: number;
    fallbackSharedOwners?: string[];
    forceIncludeRecent?: boolean;
};

export type DrainLocationQueueResult = {
    pendingCount: number;
    processedCount: number;
    sentCount: number;
    duplicateCount: number;
    skippedCount: number;
    failedCount: number;
    timedOutCount: number;
    durationMs: number;
    stopReason:
        | "empty"
        | "completed"
        | "alreadyRunning"
        | "timeBudgetExceeded"
        | "createTimedOut"
        | "createFailed";
};

export type DrainLocationQueueRepeatedResult = {
    iterationCount: number;
    processedCount: number;
    sentCount: number;
    duplicateCount: number;
    skippedCount: number;
    failedCount: number;
    timedOutCount: number;
    remainingPendingCount: number | null;
    stopReason:
        | "empty"
        | "completed"
        | "alreadyRunning"
        | "timeBudgetExceeded"
        | "createTimedOut"
        | "createFailed"
        | "maxIterationsReached";
};

type AcceptedLocation = {
    latitude: number;
    longitude: number;
    recordedAt: number;
};

/**
 * この時間を超えて継続しているキュー処理は、
 * Androidバックグラウンド停止などによる古い処理とみなす。
 *
 * 古いPromise自体はキャンセルできないため、
 * 新しいキュー処理を許可するためのロック失効時間として使用する。
 */
const SQLITE_QUEUE_DRAIN_STALE_LOCK_MS = 30_000;

/**
 * 認証セッション強制更新の最大待機時間。
 */
const SQLITE_QUEUE_AUTH_REFRESH_TIMEOUT_MS = 8_000;

/**
 * 全体時間予算の残りがこの値以下なら、
 * 新しいLocationLog.createを開始しない。
 */
const SQLITE_QUEUE_MIN_CREATE_TIMEOUT_MS = 1_000;

class QueueOperationTimeoutError extends Error {
    readonly operationName: string;
    readonly timeoutMs: number;

    constructor(operationName: string, timeoutMs: number) {
        super(`${operationName} timed out after ${timeoutMs}ms.`);

        this.name = "QueueOperationTimeoutError";
        this.operationName = operationName;
        this.timeoutMs = timeoutMs;
    }
}

function isQueueOperationTimeoutError(
    error: unknown,
): error is QueueOperationTimeoutError {
    return error instanceof QueueOperationTimeoutError;
}

type DrainQueueState = {
    promise: Promise<DrainLocationQueueResult>;
    startedAtMs: number;
    executionId: number;
};

let drainQueueState: DrainQueueState | null = null;
let nextDrainExecutionId = 1;

/**
 * 同一JSプロセス内でSQLiteキュー送信を直列化する。
 *
 * ただし、一定時間を超えて残っているロックは、
 * Androidバックグラウンド停止などによる古い処理とみなし失効させる。
 */
export async function drainLocationQueueSafely(
    input: DrainLocationQueueInput,
): Promise<DrainLocationQueueResult> {
    const nowMs = Date.now();

    if (drainQueueState) {
        const runningDurationMs = nowMs - drainQueueState.startedAtMs;

        if (runningDurationMs < SQLITE_QUEUE_DRAIN_STALE_LOCK_MS) {
            return {
                pendingCount: 0,
                processedCount: 0,
                sentCount: 0,
                duplicateCount: 0,
                skippedCount: 0,
                failedCount: 0,
                timedOutCount: 0,
                durationMs: 0,
                stopReason: "alreadyRunning",
            };
        }

        console.warn("Expire stale SQLite queue drain lock:", {
            runningDurationMs,
            staleLockMs: SQLITE_QUEUE_DRAIN_STALE_LOCK_MS,
            executionId: drainQueueState.executionId,
            recordingSessionId: input.recordingSessionId,
        });

        /*
         * 古いPromise自体はキャンセルできない。
         *
         * ロックだけを失効させて、後続のキュー処理を許可する。
         * 決定的LocationLog.idにより重複作成は防止する。
         */
        drainQueueState = null;
    }

    const executionId = nextDrainExecutionId;
    nextDrainExecutionId += 1;

    const currentPromise = drainLocationQueue(input);

    drainQueueState = {
        promise: currentPromise,
        startedAtMs: nowMs,
        executionId,
    };

    try {
        return await currentPromise;
    } finally {
        /*
         * 古い処理が後から完了しても、
         * 新しい処理のロックを解除しないようexecutionIdを比較する。
         */
        if (drainQueueState?.executionId === executionId) {
            drainQueueState = null;
        }
    }
}

export async function drainLocationQueueRepeatedly(
    input: DrainLocationQueueInput & {
        maxIterations?: number;
    },
): Promise<DrainLocationQueueRepeatedResult> {
    const maxIterations =
        typeof input.maxIterations === "number" &&
        Number.isFinite(input.maxIterations)
            ? Math.max(1, Math.min(Math.trunc(input.maxIterations), 50))
            : 20;

    let iterationCount = 0;
    let processedCount = 0;
    let sentCount = 0;
    let duplicateCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let timedOutCount = 0;

    let stopReason: DrainLocationQueueRepeatedResult["stopReason"] =
        "completed";

    for (let index = 0; index < maxIterations; index += 1) {
        const result = await drainLocationQueueSafely(input);

        iterationCount += 1;
        processedCount += result.processedCount;
        sentCount += result.sentCount;
        duplicateCount += result.duplicateCount;
        skippedCount += result.skippedCount;
        failedCount += result.failedCount;
        timedOutCount += result.timedOutCount;

        if (result.stopReason === "empty") {
            stopReason = "empty";
            break;
        }

        if (
            result.stopReason === "alreadyRunning" ||
            result.stopReason === "createFailed" ||
            result.stopReason === "createTimedOut"
        ) {
            stopReason = result.stopReason;
            break;
        }

        /*
         * 取得件数が上限未満なら、
         * その時点で対象キューをほぼ処理し終えたと判断する。
         */
        if (result.pendingCount < SQLITE_QUEUE_UPLOAD_MAX_ITEMS) {
            stopReason = "completed";
            break;
        }

        if (index === maxIterations - 1) {
            stopReason = "maxIterationsReached";
        }

        /*
         * UIスレッドを長時間連続占有しないよう、
         * 次のキュー処理まで少し待つ。
         */
        await delay(100);
    }

    let remainingPendingCount: number | null = null;

    try {
        const summary = await getLocationQueueStatusSummary({
            userId: input.userId,
            recordingSessionId: input.recordingSessionId,
        });

        remainingPendingCount = summary.pendingCount;
    } catch (error) {
        console.error("Read remaining SQLite queue count error:", error);
    }

    return {
        iterationCount,
        processedCount,
        sentCount,
        duplicateCount,
        skippedCount,
        failedCount,
        timedOutCount,
        remainingPendingCount,
        stopReason,
    };
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

async function drainLocationQueue(
    input: DrainLocationQueueInput,
): Promise<DrainLocationQueueResult> {
    const startedAtMs = Date.now();

    const deadlineAtMs = startedAtMs + SQLITE_QUEUE_UPLOAD_TIME_BUDGET_MS;

    let processedCount = 0;
    let sentCount = 0;
    let duplicateCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let timedOutCount = 0;

    let stopReason: DrainLocationQueueResult["stopReason"] = "completed";

    const pendingRows = await getPendingLocationQueueRows({
        userId: input.userId,
        recordingSessionId: input.recordingSessionId,
        olderThanMs: input.forceIncludeRecent
            ? Date.now()
            : Date.now() - SQLITE_QUEUE_UPLOAD_MIN_AGE_MS,
        limit: SQLITE_QUEUE_UPLOAD_MAX_ITEMS,
    });

    if (pendingRows.length === 0) {
        return {
            pendingCount: 0,
            processedCount: 0,
            sentCount: 0,
            duplicateCount: 0,
            skippedCount: 0,
            failedCount: 0,
            timedOutCount: 0,
            durationMs: Date.now() - startedAtMs,
            stopReason: "empty",
        };
    }

    const latestAccepted = await getLatestAcceptedLocationQueueRow({
        userId: input.userId,
        recordingSessionId: input.recordingSessionId,
    });

    let lastAcceptedLocation: AcceptedLocation | null = latestAccepted
        ? {
              latitude: latestAccepted.latitude,
              longitude: latestAccepted.longitude,
              recordedAt: latestAccepted.recorded_at_ms,
          }
        : null;

    for (const row of pendingRows) {
        if (Date.now() >= deadlineAtMs) {
            stopReason = "timeBudgetExceeded";
            break;
        }

        processedCount += 1;

        const skipReason = evaluateQueueLocationSkipReason(
            row,
            lastAcceptedLocation,
            input.intervalMs,
            input.distanceMeters,
        );

        if (skipReason) {
            await markLocationQueueRowSkipped(row.location_log_id, skipReason);

            skippedCount += 1;
            continue;
        }

        const sharedOwners = resolveSharedOwners(
            row.shared_owners_json,
            input.fallbackSharedOwners,
        );

        try {
            const remainingBudgetMs = deadlineAtMs - Date.now();

            if (remainingBudgetMs <= SQLITE_QUEUE_MIN_CREATE_TIMEOUT_MS) {
                stopReason = "timeBudgetExceeded";
                break;
            }

            const createTimeoutMs = Math.min(
                SQLITE_QUEUE_CREATE_TIMEOUT_MS,
                remainingBudgetMs,
            );

            const createResult = await createLocationLogWithAuthRetry(
                {
                    id:
                        row.location_log_id ||
                        createLocationLogId(row.location_unique_key),
                    userId: row.user_id,
                    latitude: row.latitude,
                    longitude: row.longitude,
                    accuracy: row.accuracy,
                    recordedAt: row.recorded_at,
                    memo: "自動記録",
                    recordingSessionId: row.recording_session_id,
                    source: row.source,
                    sharedOwners,
                    locationUniqueKey: row.location_unique_key,
                },
                createTimeoutMs,
                deadlineAtMs,
            );

            if (createResult.errors) {
                if (isDuplicateLocationCreateError(createResult.errors)) {
                    await markLocationQueueRowDuplicate(row.location_log_id);

                    duplicateCount += 1;

                    lastAcceptedLocation = toAcceptedLocation(row);
                    continue;
                }

                const errorMessage = stringifyError(createResult.errors);

                await markLocationQueueRowFailed(
                    row.location_log_id,
                    errorMessage,
                );

                failedCount += 1;
                stopReason = "createFailed";
                break;
            }

            /*
             * create成功後だけsentにする。
             */
            await markLocationQueueRowSent(row.location_log_id);

            sentCount += 1;
            lastAcceptedLocation = toAcceptedLocation(row);

            /*
             * LocationLogは既に作成済みなので、
             * 継続件数更新に失敗してもキューをpendingへ戻さない。
             */
            try {
                await incrementRecordingContinuationPointCount(
                    row.recording_session_id,
                );
            } catch (continuationError) {
                console.error(
                    "SQLite queue continuation update failed:",
                    continuationError,
                );
            }
        } catch (error) {
            if (isDuplicateLocationCreateError(error)) {
                await markLocationQueueRowDuplicate(row.location_log_id);

                duplicateCount += 1;
                lastAcceptedLocation = toAcceptedLocation(row);
                continue;
            }

            const errorMessage = stringifyError(error);

            await markLocationQueueRowFailed(row.location_log_id, errorMessage);

            failedCount += 1;

            if (isQueueOperationTimeoutError(error)) {
                timedOutCount += 1;
                stopReason = "createTimedOut";

                console.warn("SQLite queue LocationLog create timed out:", {
                    locationLogId: row.location_log_id,
                    locationUniqueKey: row.location_unique_key,
                    recordingSessionId: row.recording_session_id,
                    recordedAt: row.recorded_at,
                    operationName: error.operationName,
                    timeoutMs: error.timeoutMs,
                    sendAttemptCount: row.send_attempt_count + 1,
                });
            } else {
                stopReason = "createFailed";

                console.error("SQLite queue LocationLog create failed:", {
                    locationLogId: row.location_log_id,
                    locationUniqueKey: row.location_unique_key,
                    recordingSessionId: row.recording_session_id,
                    recordedAt: row.recorded_at,
                    errorMessage,
                    sendAttemptCount: row.send_attempt_count + 1,
                });
            }

            /*
             * 通信障害時に続けてcreateを連打しない。
             */
            break;
        }
    }

    return {
        pendingCount: pendingRows.length,
        processedCount,
        sentCount,
        duplicateCount,
        skippedCount,
        failedCount,
        timedOutCount,
        durationMs: Date.now() - startedAtMs,
        stopReason,
    };
}

function evaluateQueueLocationSkipReason(
    row: PendingLocationQueueRow,
    lastAcceptedLocation: AcceptedLocation | null,
    intervalMs: number,
    distanceMeters: number,
): string | null {
    if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) {
        return "invalidCoordinate";
    }

    if (isLowAccuracyLocation(row.accuracy)) {
        return "lowAccuracy";
    }

    if (!lastAcceptedLocation) {
        return null;
    }

    if (
        isAbnormalSpeedLocation(
            lastAcceptedLocation,
            row.latitude,
            row.longitude,
            row.recorded_at_ms,
        )
    ) {
        return "abnormalSpeed";
    }

    if (
        isExactDuplicateLocation(
            lastAcceptedLocation,
            row.latitude,
            row.longitude,
            row.recorded_at_ms,
        )
    ) {
        return "exactDuplicate";
    }

    if (
        isNearDuplicateLocation(
            lastAcceptedLocation,
            row.latitude,
            row.longitude,
            row.recorded_at_ms,
        )
    ) {
        return "nearDuplicate";
    }

    const elapsedMs = row.recorded_at_ms - lastAcceptedLocation.recordedAt;

    if (elapsedMs <= 0) {
        return "nonIncreasingRecordedAt";
    }

    const distance = calculateDistanceMeters(
        lastAcceptedLocation.latitude,
        lastAcceptedLocation.longitude,
        row.latitude,
        row.longitude,
    );

    if (elapsedMs >= intervalMs || distance >= distanceMeters) {
        return null;
    }

    return "saveConditionNotMet";
}

type QueueLocationLogCreateInput = {
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

async function createLocationLogWithAuthRetry(
    input: QueueLocationLogCreateInput,
    createTimeoutMs: number,
    deadlineAtMs: number,
): Promise<any> {
    let firstResult: any;

    try {
        firstResult = await withTimeout(
            client.models.LocationLog.create(input),
            getRemainingQueueOperationTimeoutMs(deadlineAtMs, createTimeoutMs),
            "SQLite queue LocationLog.create",
        );
    } catch (error) {
        /*
         * createのタイムアウトは認証エラーではないため、
         * 認証更新を実行せず、そのまま呼び出し元へ返す。
         */
        if (isQueueOperationTimeoutError(error)) {
            throw error;
        }

        if (!isUnauthorizedError(error)) {
            throw error;
        }

        await withTimeout(
            fetchAuthSession({
                forceRefresh: true,
            }),
            getRemainingQueueOperationTimeoutMs(
                deadlineAtMs,
                SQLITE_QUEUE_AUTH_REFRESH_TIMEOUT_MS,
            ),
            "SQLite queue auth force refresh",
        );

        return withTimeout(
            client.models.LocationLog.create(input),
            getRemainingQueueOperationTimeoutMs(deadlineAtMs, createTimeoutMs),
            "SQLite queue LocationLog.create retry",
        );
    }

    if (!firstResult.errors || !isUnauthorizedError(firstResult.errors)) {
        return firstResult;
    }

    await withTimeout(
        fetchAuthSession({
            forceRefresh: true,
        }),
        getRemainingQueueOperationTimeoutMs(
            deadlineAtMs,
            SQLITE_QUEUE_AUTH_REFRESH_TIMEOUT_MS,
        ),
        "SQLite queue auth force refresh",
    );

    return withTimeout(
        client.models.LocationLog.create(input),
        getRemainingQueueOperationTimeoutMs(deadlineAtMs, createTimeoutMs),
        "SQLite queue LocationLog.create retry",
    );
}

function getRemainingQueueOperationTimeoutMs(
    deadlineAtMs: number,
    preferredTimeoutMs: number,
): number {
    const remainingMs = deadlineAtMs - Date.now();

    if (remainingMs <= 0) {
        throw new QueueOperationTimeoutError(
            "SQLite queue time budget",
            SQLITE_QUEUE_UPLOAD_TIME_BUDGET_MS,
        );
    }

    return Math.max(1, Math.min(preferredTimeoutMs, remainingMs));
}

function resolveSharedOwners(
    sharedOwnersJson: string | null,
    fallbackSharedOwners?: string[],
): string[] | undefined {
    if (sharedOwnersJson) {
        try {
            const parsed = JSON.parse(sharedOwnersJson);

            if (Array.isArray(parsed)) {
                const values = parsed.filter(
                    (value): value is string =>
                        typeof value === "string" && value.length > 0,
                );

                if (values.length > 0) {
                    return Array.from(new Set(values));
                }
            }
        } catch {
            // fallbackへ進む
        }
    }

    const fallback = fallbackSharedOwners?.filter(Boolean) ?? [];

    return fallback.length > 0 ? Array.from(new Set(fallback)) : undefined;
}

function toAcceptedLocation(row: PendingLocationQueueRow): AcceptedLocation {
    return {
        latitude: row.latitude,
        longitude: row.longitude,
        recordedAt: row.recorded_at_ms,
    };
}

function isUnauthorizedError(error: unknown): boolean {
    const text = stringifyError(error).toLowerCase();

    return (
        text.includes("unauthorized") ||
        text.includes("not authorized") ||
        text.includes("unauthenticated") ||
        text.includes("401")
    );
}

function stringifyError(error: unknown): string {
    if (typeof error === "string") {
        return error;
    }

    try {
        const serialized = JSON.stringify(error);

        return serialized ?? String(error);
    } catch {
        return String(error);
    }
}

async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operationName: string,
): Promise<T> {
    const safeTimeoutMs = Math.max(1, Math.trunc(timeoutMs));

    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(
                new QueueOperationTimeoutError(operationName, safeTimeoutMs),
            );
        }, safeTimeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
    }
}
