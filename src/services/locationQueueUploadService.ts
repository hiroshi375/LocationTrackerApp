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

    /**
     * true の場合は再送クールダウンを無視する。
     * 記録終了時など、残pendingを明示的に掃き出す用途向け。
     */
    forceRetryNow?: boolean;
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
        | "noEligiblePending"
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
        | "noEligiblePending"
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
 * 一度失敗した同一行を即時再送し続けないためのクールダウン。
 *
 * 重要：
 * この条件は失敗行だけを一時的に対象外にする。
 * 後続の未送信行（send_attempt_count = 0）はそのまま処理対象になるため、
 * 先頭1件のタイムアウトで後続地点が詰まることを防ぐ。
 */
const SQLITE_QUEUE_RETRY_COOLDOWN_MS = 15_000;

/**
 * timeout後の再送前に、決定的IDでクラウド存在確認を行う最大待機時間。
 */
const SQLITE_QUEUE_EXISTENCE_CHECK_TIMEOUT_MS = 3_000;

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
    /*
     * 同一JSプロセス内では、実行中Promiseがある限り2本目を開始しない。
     *
     * 以前の「30秒経過でロックだけ失効」は、
     * 古いPromise自体をキャンセルできないため、
     * 実処理が生きたまま新しいdrainを開始する危険がある。
     *
     * 各ネットワーク処理には個別timeout、
     * drain全体には時間予算があるため、
     * ここでは強制失効させず多重実行防止を優先する。
     */
    if (drainQueueState) {
        /*
         * 通常処理では既存drainと競合させない。
         */
        if (!input.forceRetryNow) {
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

        /*
         * 記録停止時(forceRetryNow=true)だけは、
         * 既存drainの終了を待ってから最終flushを行う。
         *
         * 古いPromiseをキャンセルしたり、
         * ロックだけ強制解除したりしない。
         */
        const runningState = drainQueueState;

        try {
            await runningState.promise;
        } catch (error) {
            /*
             * 既存drainが失敗しても、
             * 最終flush自体は続行する。
             */
            console.warn(
                "Existing SQLite queue drain failed before final flush:",
                error,
            );
        }

        /*
         * 既存Promiseが完了済みなら安全にstateを解除する。
         * executionIdを確認して別処理のstateを消さない。
         */
        if (drainQueueState?.executionId === runningState.executionId) {
            drainQueueState = null;
        }
    }

    const executionId = nextDrainExecutionId;
    nextDrainExecutionId += 1;

    const currentPromise = drainLocationQueue(input);

    drainQueueState = {
        promise: currentPromise,
        startedAtMs: Date.now(),
        executionId,
    };

    try {
        return await currentPromise;
    } finally {
        /*
         * 念のためexecutionIdを比較し、
         * 別実行のstateを誤って解除しない。
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

        if (
            result.stopReason === "empty" ||
            result.stopReason === "noEligiblePending"
        ) {
            stopReason = result.stopReason;
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

    /*
     * create timeout後、同じdrainの残り時間でクラウド存在確認する対象。
     * timeoutしたcreateの内部通信が遅れて成功した場合、
     * 次回callbackを待たずSQLiteを確定できる。
     */
    const timedOutRows: PendingLocationQueueRow[] = [];

    let stopReason: DrainLocationQueueResult["stopReason"] = "completed";

    const nowForSelectionMs = Date.now();

    const retryBeforeIso =
        input.forceRetryNow || input.forceIncludeRecent
            ? null
            : new Date(
                  nowForSelectionMs - SQLITE_QUEUE_RETRY_COOLDOWN_MS,
              ).toISOString();

    const pendingRows = await getPendingLocationQueueRows({
        userId: input.userId,
        recordingSessionId: input.recordingSessionId,
        olderThanMs: input.forceIncludeRecent
            ? nowForSelectionMs
            : nowForSelectionMs - SQLITE_QUEUE_UPLOAD_MIN_AGE_MS,
        retryBeforeIso,
        limit: SQLITE_QUEUE_UPLOAD_MAX_ITEMS,
    });

    if (pendingRows.length === 0) {
        /*
         * summaryのpending件数には min-age / retry cooldown 条件がない。
         * そのため「SQLiteにpendingはあるが今は送信対象外」と
         * 「本当にpendingが0」を区別して返す。
         */
        let totalPendingCount = 0;

        try {
            const summary = await getLocationQueueStatusSummary({
                userId: input.userId,
                recordingSessionId: input.recordingSessionId,
            });

            totalPendingCount = summary.pendingCount;
        } catch (error) {
            console.error(
                "Read SQLite queue summary for empty decision failed:",
                error,
            );
        }

        return {
            pendingCount: 0,
            processedCount: 0,
            sentCount: 0,
            duplicateCount: 0,
            skippedCount: 0,
            failedCount: 0,
            timedOutCount: 0,
            durationMs: Date.now() - startedAtMs,
            stopReason: totalPendingCount > 0 ? "noEligiblePending" : "empty",
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

        /*
         * 過去に1回以上送信を試した行は、再create前に決定的IDでクラウドを確認する。
         *
         * create timeoutは「失敗」ではなく、
         * 応答待ちだけがtimeoutして裏側では成功している可能性がある。
         * 既にLocationLogが存在する場合は再createせずduplicateへ確定する。
         */
        if (row.send_attempt_count > 0) {
            const existingLocationLog = await tryGetExistingLocationLog(
                row.location_log_id,
                deadlineAtMs,
            );

            if (existingLocationLog.exists) {
                await markLocationQueueRowDuplicate(row.location_log_id);

                duplicateCount += 1;
                lastAcceptedLocation = toAcceptedLocation(row);

                continue;
            }
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
                timedOutRows.push(row);

                console.warn("SQLite queue LocationLog create timed out:", {
                    locationLogId: row.location_log_id,
                    locationUniqueKey: row.location_unique_key,
                    recordingSessionId: row.recording_session_id,
                    recordedAt: row.recorded_at,
                    operationName: error.operationName,
                    timeoutMs: error.timeoutMs,
                    sendAttemptCount: row.send_attempt_count + 1,
                });

                /*
                 * pendingRowsは今回のsnapshotなので、
                 * このrow自身を同一drain内で再createすることはない。
                 *
                 * 後続rowまで巻き込んで停止させず、時間予算の範囲で処理を継続する。
                 * ネットワーク全体が不調なら次ループ先頭のdeadline判定で速やかに止まる。
                 */
                continue;
            }

            stopReason = "createFailed";

            console.error("SQLite queue LocationLog create failed:", {
                locationLogId: row.location_log_id,
                locationUniqueKey: row.location_unique_key,
                recordingSessionId: row.recording_session_id,
                recordedAt: row.recorded_at,
                errorMessage,
                sendAttemptCount: row.send_attempt_count + 1,
            });

            /*
             * timeout以外の明示的なcreate失敗では、
             * 同種エラーを連打しないためこのdrainを終了する。
             */
            break;
        }
    }

    /*
     * create timeoutした行について、残り時間があれば同一drain内で存在確認する。
     * timeout後の内部通信が遅れて成功していれば、次callbackを待たずpendingを解消する。
     */
    for (const timedOutRow of timedOutRows) {
        if (Date.now() >= deadlineAtMs) {
            break;
        }

        const existingLocationLog = await tryGetExistingLocationLog(
            timedOutRow.location_log_id,
            deadlineAtMs,
        );

        if (!existingLocationLog.exists) {
            continue;
        }

        await markLocationQueueRowDuplicate(timedOutRow.location_log_id);
        duplicateCount += 1;

        /*
         * failedCountは「このdrain終了時点で未解消の失敗件数」として扱う。
         * timedOutCountは診断用にtimeout発生件数を残す。
         */
        failedCount = Math.max(0, failedCount - 1);
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

type ExistingLocationLogCheckResult = {
    exists: boolean;
};

/**
 * 決定的LocationLog.idでクラウド存在確認する。
 *
 * 確認失敗・timeout時は exists=false としてcreate経路へ進む。
 * 「確認できない」ことを「存在しない」と確定はしないが、
 * LocationLogを長時間書き出さないデグレを避けるため、
 * create自体は止めない。
 */
async function tryGetExistingLocationLog(
    locationLogId: string,
    deadlineAtMs: number,
): Promise<ExistingLocationLogCheckResult> {
    try {
        const remainingBudgetMs = deadlineAtMs - Date.now();

        if (remainingBudgetMs <= SQLITE_QUEUE_MIN_CREATE_TIMEOUT_MS) {
            return { exists: false };
        }

        const timeoutMs = Math.min(
            SQLITE_QUEUE_EXISTENCE_CHECK_TIMEOUT_MS,
            remainingBudgetMs,
        );

        const result: any = await withTimeout(
            client.models.LocationLog.get({
                id: locationLogId,
            }),
            timeoutMs,
            "SQLite queue LocationLog.get",
        );

        return {
            exists: Boolean(result.data?.id),
        };
    } catch (error) {
        /*
         * get失敗だけでキュー処理を停止しない。
         * 決定的IDのcreateへ進めば、既存ならduplicateとして安全に収束する。
         */
        console.warn("SQLite queue LocationLog existence check failed:", {
            locationLogId,
            errorMessage: stringifyError(error),
        });

        return { exists: false };
    }
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
