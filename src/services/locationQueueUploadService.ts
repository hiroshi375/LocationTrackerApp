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

type AcceptedLocation = {
    latitude: number;
    longitude: number;
    recordedAt: number;
};

let drainQueuePromise: Promise<DrainLocationQueueResult> | null = null;

/**
 * 同一JSプロセス内でSQLiteキュー送信を直列化する。
 */
export async function drainLocationQueueSafely(
    input: DrainLocationQueueInput,
): Promise<DrainLocationQueueResult> {
    if (drainQueuePromise) {
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

    drainQueuePromise = drainLocationQueue(input).finally(() => {
        drainQueuePromise = null;
    });

    return drainQueuePromise;
}

async function drainLocationQueue(
    input: DrainLocationQueueInput,
): Promise<DrainLocationQueueResult> {
    const startedAtMs = Date.now();

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
        olderThanMs: Date.now() - SQLITE_QUEUE_UPLOAD_MIN_AGE_MS,
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
        if (Date.now() - startedAtMs >= SQLITE_QUEUE_UPLOAD_TIME_BUDGET_MS) {
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
            const createResult = await withTimeout(
                createLocationLogWithAuthRetry({
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
                }),
                SQLITE_QUEUE_CREATE_TIMEOUT_MS,
                "SQLite queue LocationLog.create",
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

            if (isTimeoutError(error)) {
                timedOutCount += 1;
                stopReason = "createTimedOut";
            } else {
                stopReason = "createFailed";
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

async function createLocationLogWithAuthRetry(input: {
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
}): Promise<any> {
    let firstResult: any;

    try {
        firstResult = await client.models.LocationLog.create(input);
    } catch (error) {
        if (!isUnauthorizedError(error)) {
            throw error;
        }

        await fetchAuthSession({
            forceRefresh: true,
        });

        return client.models.LocationLog.create(input);
    }

    if (!firstResult.errors || !isUnauthorizedError(firstResult.errors)) {
        return firstResult;
    }

    await fetchAuthSession({
        forceRefresh: true,
    });

    return client.models.LocationLog.create(input);
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

function isTimeoutError(error: unknown): boolean {
    return stringifyError(error).includes(
        "SQLite queue LocationLog.create timed out",
    );
}

async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operationName: string,
): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(
                        new Error(
                            `${operationName} timed out after ${timeoutMs}ms.`,
                        ),
                    );
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
    }
}
