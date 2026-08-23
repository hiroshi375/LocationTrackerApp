import * as Location from "expo-location";
import * as SQLite from "expo-sqlite";

import {
    calculateDistanceMeters,
    NEAR_DUPLICATE_DISTANCE_METERS,
    NEAR_DUPLICATE_TIME_MS,
} from "../utils/locationDuplicate";
import {
    createLocationLogId,
    createLocationUniqueKey,
} from "./locationLogDeduplicationService";

const DATABASE_NAME = "location-tracker.db";
const TABLE_NAME = "location_location_queue";
const DATABASE_VERSION = 2;

type LocationQueueSource = "background" | "foreground";

type EnqueueLocationBatchInput = {
    userId: string;
    recordingSessionId: string;
    source: LocationQueueSource;
    locations: Location.LocationObject[];
    receivedAt: string;
    sharedOwners?: string[];
};

export type EnqueueLocationBatchResult = {
    receivedCount: number;
    insertedCount: number;
    duplicateCount: number;
    invalidCount: number;
    queueCount: number | null;
};

type QueueCountRow = {
    count: number;
};

export type LocationQueueStatus = "pending" | "sent" | "duplicate" | "skipped";

export type PendingLocationQueueRow = {
    location_log_id: string;
    location_unique_key: string;
    user_id: string;
    recording_session_id: string;
    source: "background" | "foreground";

    recorded_at: string;
    recorded_at_ms: number;
    received_at: string;

    latitude: number;
    longitude: number;
    accuracy: number | null;
    altitude: number | null;
    altitude_accuracy: number | null;
    heading: number | null;
    speed: number | null;

    queue_status: LocationQueueStatus;
    send_attempt_count: number;
    shared_owners_json: string | null;
};

export type LocationQueueStatusSummary = {
    totalCount: number;
    pendingCount: number;
    sentCount: number;
    duplicateCount: number;
    skippedCount: number;
    failedPendingCount: number;
    oldestPendingRecordedAt: string | null;
    latestPendingRecordedAt: string | null;
};

type LocationQueueStatusSummaryRow = {
    total_count: number;
    pending_count: number;
    sent_count: number;
    duplicate_count: number;
    skipped_count: number;
    failed_pending_count: number;
    oldest_pending_recorded_at: string | null;
    latest_pending_recorded_at: string | null;
};

export type CleanupProcessedLocationQueueResult = {
    deletedCount: number;
    thresholdIso: string;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * DB初期化処理を多重実行しないよう、Promiseを共有する。
 */
async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
    if (!databasePromise) {
        databasePromise = openAndInitializeDatabase().catch((error) => {
            /*
             * 初期化失敗後に次回callbackで再試行できるようにする。
             */
            databasePromise = null;
            throw error;
        });
    }

    return databasePromise;
}

async function openAndInitializeDatabase(): Promise<SQLite.SQLiteDatabase> {
    const db = await SQLite.openDatabaseAsync(DATABASE_NAME);

    await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
            location_log_id TEXT PRIMARY KEY NOT NULL,
            location_unique_key TEXT NOT NULL,
            user_id TEXT NOT NULL,
            recording_session_id TEXT NOT NULL,
            source TEXT NOT NULL,

            recorded_at TEXT NOT NULL,
            recorded_at_ms INTEGER NOT NULL,
            received_at TEXT NOT NULL,

            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            accuracy REAL,
            altitude REAL,
            altitude_accuracy REAL,
            heading REAL,
            speed REAL,

            is_sent INTEGER NOT NULL DEFAULT 0,
            sent_at TEXT,
            send_attempt_count INTEGER NOT NULL DEFAULT 0,
            last_send_attempt_at TEXT,
            last_send_error TEXT,

            queue_status TEXT NOT NULL DEFAULT 'pending',
            processed_at TEXT,
            skip_reason TEXT,
            shared_owners_json TEXT,

            created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS
            idx_location_location_queue_unique_key
        ON ${TABLE_NAME}(location_unique_key);

        CREATE INDEX IF NOT EXISTS
            idx_location_location_queue_session
        ON ${TABLE_NAME}(recording_session_id, recorded_at_ms);
    `);

    /*
     * 既に第1段階のDBが存在する端末では、
     * CREATE TABLE IF NOT EXISTSだけでは新しい列が追加されない。
     */
    await ensureQueueColumn(
        db,
        "queue_status",
        "TEXT NOT NULL DEFAULT 'pending'",
    );
    await ensureQueueColumn(db, "processed_at", "TEXT");
    await ensureQueueColumn(db, "skip_reason", "TEXT");
    await ensureQueueColumn(db, "shared_owners_json", "TEXT");

    await db.execAsync(`
        CREATE INDEX IF NOT EXISTS
            idx_location_location_queue_pending
        ON ${TABLE_NAME}(queue_status, recorded_at_ms);

        PRAGMA user_version = ${DATABASE_VERSION};
    `);

    return db;
}

type TableInfoRow = {
    name: string;
};

async function ensureQueueColumn(
    db: SQLite.SQLiteDatabase,
    columnName: string,
    definition: string,
): Promise<void> {
    const columns = await db.getAllAsync<TableInfoRow>(
        `PRAGMA table_info(${TABLE_NAME})`,
    );

    if (columns.some((column) => column.name === columnName)) {
        return;
    }

    /*
     * columnNameとdefinitionはアプリ内の固定値だけを渡す。
     */
    await db.execAsync(
        `ALTER TABLE ${TABLE_NAME} ADD COLUMN ${columnName} ${definition}`,
    );
}

/**
 * OSから受信した位置情報をSQLiteへ複製する。
 *
 * この関数が失敗しても、呼び出し元は従来のLocationLog.create処理を
 * 必ず継続すること。
 */
export async function enqueueLocationBatchForAudit(
    input: EnqueueLocationBatchInput,
): Promise<EnqueueLocationBatchResult> {
    const db = await getDatabase();

    const sharedOwnersJson =
        input.sharedOwners && input.sharedOwners.length > 0
            ? JSON.stringify(
                  Array.from(new Set(input.sharedOwners.filter(Boolean))),
              )
            : null;

    let insertedCount = 0;
    let duplicateCount = 0;
    let invalidCount = 0;

    /*
     * 1件の不正データやINSERT失敗によって
     * バッチ内の残り地点を失わないよう、地点単位で処理する。
     */
    for (const location of input.locations) {
        const latitude = location.coords.latitude;
        const longitude = location.coords.longitude;

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            invalidCount += 1;
            continue;
        }

        const recordedAtMs =
            typeof location.timestamp === "number" &&
            Number.isFinite(location.timestamp)
                ? location.timestamp
                : Date.now();

        const recordedAt = new Date(recordedAtMs).toISOString();
        const accuracy = normalizeNullableNumber(location.coords.accuracy);

        const locationUniqueKey = createLocationUniqueKey({
            userId: input.userId,
            recordingSessionId: input.recordingSessionId,
            recordedAt,
            latitude,
            longitude,
            accuracy,
        });

        const locationLogId = createLocationLogId(locationUniqueKey);

        try {
            const result = await db.runAsync(
                `
    INSERT OR IGNORE INTO ${TABLE_NAME} (
        location_log_id,
        location_unique_key,
        user_id,
        recording_session_id,
        source,
        recorded_at,
        recorded_at_ms,
        received_at,
        latitude,
        longitude,
        accuracy,
        altitude,
        altitude_accuracy,
        heading,
        speed,
        is_sent,
        queue_status,
        shared_owners_json,
        created_at
    ) VALUES (
        $locationLogId,
        $locationUniqueKey,
        $userId,
        $recordingSessionId,
        $source,
        $recordedAt,
        $recordedAtMs,
        $receivedAt,
        $latitude,
        $longitude,
        $accuracy,
        $altitude,
        $altitudeAccuracy,
        $heading,
        $speed,
        0,
        'pending',
        $sharedOwnersJson,
        $createdAt
    )
    `,
                {
                    $locationLogId: locationLogId,
                    $locationUniqueKey: locationUniqueKey,
                    $userId: input.userId,
                    $recordingSessionId: input.recordingSessionId,
                    $source: input.source,
                    $recordedAt: recordedAt,
                    $recordedAtMs: Math.trunc(recordedAtMs),
                    $receivedAt: input.receivedAt,
                    $latitude: latitude,
                    $longitude: longitude,
                    $accuracy: accuracy,
                    $altitude: normalizeNullableNumber(
                        location.coords.altitude,
                    ),
                    $altitudeAccuracy: normalizeNullableNumber(
                        location.coords.altitudeAccuracy,
                    ),
                    $heading: normalizeNullableNumber(location.coords.heading),
                    $speed: normalizeNullableNumber(location.coords.speed),

                    $sharedOwnersJson: sharedOwnersJson,

                    $createdAt: new Date().toISOString(),
                },
            );

            if (result.changes > 0) {
                insertedCount += 1;
            } else {
                duplicateCount += 1;
            }
        } catch (error) {
            /*
             * 1地点のSQLite失敗で残りの地点まで止めない。
             * 呼び出し元では、バッチ全体のエラーとしてログ出力する。
             */
            console.error("SQLite location mirror insert error:", {
                locationLogId,
                recordedAt,
                error,
            });

            invalidCount += 1;
        }
    }

    let queueCount: number | null = null;

    try {
        const countRow = await db.getFirstAsync<QueueCountRow>(
            `SELECT COUNT(*) AS count FROM ${TABLE_NAME}`,
        );

        queueCount =
            typeof countRow?.count === "number" ? countRow.count : null;
    } catch (error) {
        /*
         * 件数取得失敗は、投入済みデータの成否へ影響させない。
         */
        console.error("SQLite location mirror count error:", error);
    }

    return {
        receivedCount: input.locations.length,
        insertedCount,
        duplicateCount,
        invalidCount,
        queueCount,
    };
}

export async function getPendingLocationQueueRows(input: {
    userId: string;
    recordingSessionId: string;
    olderThanMs: number;
    limit: number;
}): Promise<PendingLocationQueueRow[]> {
    const db = await getDatabase();

    const safeLimit = Math.max(1, Math.min(Math.trunc(input.limit), 100));
    const olderThanMs = Math.trunc(input.olderThanMs);

    return db.getAllAsync<PendingLocationQueueRow>(
        `
        SELECT
            location_log_id,
            location_unique_key,
            user_id,
            recording_session_id,
            source,
            recorded_at,
            recorded_at_ms,
            received_at,
            latitude,
            longitude,
            accuracy,
            altitude,
            altitude_accuracy,
            heading,
            speed,
            queue_status,
            send_attempt_count,
            shared_owners_json
        FROM ${TABLE_NAME}
        WHERE
            queue_status = 'pending'
            AND user_id = $userId
            AND recording_session_id = $recordingSessionId
            AND recorded_at_ms <= $olderThanMs
        ORDER BY recorded_at_ms ASC
        LIMIT $limit
        `,
        {
            $userId: input.userId,
            $recordingSessionId: input.recordingSessionId,
            $olderThanMs: olderThanMs,
            $limit: safeLimit,
        },
    );
}

export async function getLatestAcceptedLocationQueueRow(input: {
    userId: string;
    recordingSessionId: string;
}): Promise<PendingLocationQueueRow | null> {
    const db = await getDatabase();

    const row = await db.getFirstAsync<PendingLocationQueueRow>(
        `
        SELECT
            location_log_id,
            location_unique_key,
            user_id,
            recording_session_id,
            source,
            recorded_at,
            recorded_at_ms,
            received_at,
            latitude,
            longitude,
            accuracy,
            altitude,
            altitude_accuracy,
            heading,
            speed,
            queue_status,
            send_attempt_count,
            shared_owners_json
        FROM ${TABLE_NAME}
        WHERE
            user_id = $userId
            AND recording_session_id = $recordingSessionId
            AND queue_status IN ('sent', 'duplicate')
        ORDER BY recorded_at_ms DESC
        LIMIT 1
        `,
        {
            $userId: input.userId,
            $recordingSessionId: input.recordingSessionId,
        },
    );

    return row ?? null;
}

export async function markLocationQueueRowSent(
    locationLogId: string,
): Promise<void> {
    const db = await getDatabase();
    const now = new Date().toISOString();

    await db.runAsync(
        `
        UPDATE ${TABLE_NAME}
        SET
            queue_status = 'sent',
            is_sent = 1,
            sent_at = $now,
            processed_at = $now,
            last_send_attempt_at = $now,
            last_send_error = NULL,
            skip_reason = NULL,
            send_attempt_count = send_attempt_count + 1
        WHERE
            location_log_id = $locationLogId
            AND queue_status = 'pending'
        `,
        {
            $now: now,
            $locationLogId: locationLogId,
        },
    );
}

export async function markLocationQueueRowDuplicate(
    locationLogId: string,
): Promise<void> {
    const db = await getDatabase();
    const now = new Date().toISOString();

    await db.runAsync(
        `
        UPDATE ${TABLE_NAME}
        SET
            queue_status = 'duplicate',
            is_sent = 0,
            processed_at = $now,
            last_send_attempt_at = $now,
            last_send_error = NULL,
            skip_reason = 'cloudDuplicate',
            send_attempt_count = send_attempt_count + 1
        WHERE
            location_log_id = $locationLogId
            AND queue_status = 'pending'
        `,
        {
            $now: now,
            $locationLogId: locationLogId,
        },
    );
}

export async function markLocationQueueRowSkipped(
    locationLogId: string,
    reason: string,
): Promise<void> {
    const db = await getDatabase();
    const now = new Date().toISOString();

    await db.runAsync(
        `
        UPDATE ${TABLE_NAME}
        SET
            queue_status = 'skipped',
            is_sent = 0,
            processed_at = $now,
            skip_reason = $reason,
            last_send_error = NULL
        WHERE
            location_log_id = $locationLogId
            AND queue_status = 'pending'
        `,
        {
            $now: now,
            $reason: reason,
            $locationLogId: locationLogId,
        },
    );
}

/**
 * 送信失敗情報を記録する。
 *
 * queue_statusは変更しないため、
 * 対象行はpendingのまま次回送信対象として残る。
 */
export async function markLocationQueueRowFailed(
    locationLogId: string,
    errorMessage: string,
): Promise<void> {
    const db = await getDatabase();
    const now = new Date().toISOString();

    await db.runAsync(
        `
        UPDATE ${TABLE_NAME}
        SET
            send_attempt_count = send_attempt_count + 1,
            last_send_attempt_at = $now,
            last_send_error = $errorMessage
        WHERE
            location_log_id = $locationLogId
            AND queue_status = 'pending'
        `,
        {
            $now: now,
            $errorMessage: errorMessage.slice(0, 2000),
            $locationLogId: locationLogId,
        },
    );
}

export async function getLocationQueueStatusSummary(input?: {
    userId?: string;
    recordingSessionId?: string;
}): Promise<LocationQueueStatusSummary> {
    const db = await getDatabase();

    const conditions: string[] = [];
    const params: Record<string, string> = {};

    if (input?.userId) {
        conditions.push("user_id = $userId");
        params.$userId = input.userId;
    }

    if (input?.recordingSessionId) {
        conditions.push("recording_session_id = $recordingSessionId");
        params.$recordingSessionId = input.recordingSessionId;
    }

    const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const row = await db.getFirstAsync<LocationQueueStatusSummaryRow>(
        `
            SELECT
                COUNT(*) AS total_count,

                SUM(
                    CASE
                        WHEN queue_status = 'pending'
                        THEN 1
                        ELSE 0
                    END
                ) AS pending_count,

                SUM(
                    CASE
                        WHEN queue_status = 'sent'
                        THEN 1
                        ELSE 0
                    END
                ) AS sent_count,

                SUM(
                    CASE
                        WHEN queue_status = 'duplicate'
                        THEN 1
                        ELSE 0
                    END
                ) AS duplicate_count,

                SUM(
                    CASE
                        WHEN queue_status = 'skipped'
                        THEN 1
                        ELSE 0
                    END
                ) AS skipped_count,

                SUM(
                    CASE
                        WHEN queue_status = 'pending'
                             AND send_attempt_count > 0
                        THEN 1
                        ELSE 0
                    END
                ) AS failed_pending_count,

                MIN(
                    CASE
                        WHEN queue_status = 'pending'
                        THEN recorded_at
                        ELSE NULL
                    END
                ) AS oldest_pending_recorded_at,

                MAX(
                    CASE
                        WHEN queue_status = 'pending'
                        THEN recorded_at
                        ELSE NULL
                    END
                ) AS latest_pending_recorded_at

            FROM ${TABLE_NAME}
            ${whereClause}
            `,
        params,
    );

    return {
        totalCount: normalizeCount(row?.total_count),
        pendingCount: normalizeCount(row?.pending_count),
        sentCount: normalizeCount(row?.sent_count),
        duplicateCount: normalizeCount(row?.duplicate_count),
        skippedCount: normalizeCount(row?.skipped_count),
        failedPendingCount: normalizeCount(row?.failed_pending_count),
        oldestPendingRecordedAt: row?.oldest_pending_recorded_at ?? null,
        latestPendingRecordedAt: row?.latest_pending_recorded_at ?? null,
    };
}

export async function cleanupProcessedLocationQueue(input?: {
    retentionDays?: number;
}): Promise<CleanupProcessedLocationQueueResult> {
    const db = await getDatabase();

    const retentionDays =
        typeof input?.retentionDays === "number" &&
        Number.isFinite(input.retentionDays)
            ? Math.max(1, Math.min(Math.trunc(input.retentionDays), 90))
            : 7;

    const thresholdMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    const thresholdIso = new Date(thresholdMs).toISOString();

    const result = await db.runAsync(
        `
        DELETE FROM ${TABLE_NAME}
        WHERE
            queue_status IN (
                'sent',
                'duplicate',
                'skipped'
            )
            AND processed_at IS NOT NULL
            AND processed_at < $thresholdIso
        `,
        {
            $thresholdIso: thresholdIso,
        },
    );

    return {
        deletedCount: result.changes,
        thresholdIso,
    };
}

function normalizeCount(value: number | null | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeNullableNumber(
    value: number | null | undefined,
): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function debugPrintLocationQueueSkipReasons(
    recordingSessionId: string,
): Promise<void> {
    const db = await getDatabase();

    const rows = await db.getAllAsync<{
        skip_reason: string | null;
        count: number;
    }>(
        `
        SELECT
            skip_reason,
            COUNT(*) AS count
        FROM ${TABLE_NAME}
        WHERE
            recording_session_id = $recordingSessionId
            AND queue_status = 'skipped'
        GROUP BY skip_reason
        ORDER BY count DESC
        `,
        {
            $recordingSessionId: recordingSessionId,
        },
    );

    console.log(
        "SQLite queue skip reasons:",
        JSON.stringify({
            recordingSessionId,
            rows,
        }),
    );
}

type NearDuplicateDiagnosticRow = {
    location_log_id: string;
    recorded_at: string;
    recorded_at_ms: number;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    processed_at: string | null;

    reference_location_log_id: string | null;
    reference_recorded_at: string | null;
    reference_recorded_at_ms: number | null;
    reference_latitude: number | null;
    reference_longitude: number | null;
};

export async function debugPrintNearDuplicateDetails(
    recordingSessionId: string,
): Promise<void> {
    const db = await getDatabase();

    const rows = await db.getAllAsync<NearDuplicateDiagnosticRow>(
        `
        SELECT
            s.location_log_id,
            s.recorded_at,
            s.recorded_at_ms,
            s.latitude,
            s.longitude,
            s.accuracy,
            s.processed_at,

            a.location_log_id AS reference_location_log_id,
            a.recorded_at AS reference_recorded_at,
            a.recorded_at_ms AS reference_recorded_at_ms,
            a.latitude AS reference_latitude,
            a.longitude AS reference_longitude

        FROM ${TABLE_NAME} s

        LEFT JOIN ${TABLE_NAME} a
            ON a.location_log_id = (
                SELECT a2.location_log_id
                FROM ${TABLE_NAME} a2
                WHERE
                    a2.user_id = s.user_id
                    AND a2.recording_session_id = s.recording_session_id
                    AND a2.queue_status IN ('sent', 'duplicate')
                    AND a2.processed_at IS NOT NULL
                    AND s.processed_at IS NOT NULL
                    AND a2.processed_at <= s.processed_at
                ORDER BY a2.recorded_at_ms DESC
                LIMIT 1
            )

        WHERE
            s.recording_session_id = $recordingSessionId
            AND s.queue_status = 'skipped'
            AND s.skip_reason = 'nearDuplicate'

        ORDER BY s.recorded_at_ms ASC
        `,
        {
            $recordingSessionId: recordingSessionId,
        },
    );

    console.log(
        "SQLite nearDuplicate diagnostics summary:",
        JSON.stringify({
            recordingSessionId,
            count: rows.length,
            nearDuplicateTimeMs: NEAR_DUPLICATE_TIME_MS,
            nearDuplicateDistanceMeters: NEAR_DUPLICATE_DISTANCE_METERS,
        }),
    );

    rows.forEach((row, index) => {
        let elapsedMs: number | null = null;
        let distanceMeters: number | null = null;

        if (
            row.reference_recorded_at_ms != null &&
            row.reference_latitude != null &&
            row.reference_longitude != null
        ) {
            elapsedMs = Math.abs(
                row.recorded_at_ms - row.reference_recorded_at_ms,
            );

            distanceMeters = calculateDistanceMeters(
                row.reference_latitude,
                row.reference_longitude,
                row.latitude,
                row.longitude,
            );
        }

        console.log(
            "SQLite nearDuplicate diagnostic:",
            JSON.stringify({
                no: index + 1,

                recordedAt: row.recorded_at,
                latitude: row.latitude,
                longitude: row.longitude,
                accuracy: row.accuracy,

                referenceRecordedAt: row.reference_recorded_at,
                referenceLatitude: row.reference_latitude,
                referenceLongitude: row.reference_longitude,

                elapsedMs,
                distanceMeters,

                within3Seconds:
                    elapsedMs != null && elapsedMs <= NEAR_DUPLICATE_TIME_MS,

                within5Meters:
                    distanceMeters != null &&
                    distanceMeters <= NEAR_DUPLICATE_DISTANCE_METERS,
            }),
        );
    });
}

type SaveConditionNotMetDiagnosticRow = {
    location_log_id: string;
    recorded_at: string;
    recorded_at_ms: number;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    processed_at: string | null;

    reference_location_log_id: string | null;
    reference_recorded_at: string | null;
    reference_recorded_at_ms: number | null;
    reference_latitude: number | null;
    reference_longitude: number | null;
};

export async function debugPrintSaveConditionNotMetDetails(
    recordingSessionId: string,
): Promise<void> {
    const db = await getDatabase();

    const rows = await db.getAllAsync<SaveConditionNotMetDiagnosticRow>(
        `
        SELECT
            s.location_log_id,
            s.recorded_at,
            s.recorded_at_ms,
            s.latitude,
            s.longitude,
            s.accuracy,
            s.processed_at,

            a.location_log_id AS reference_location_log_id,
            a.recorded_at AS reference_recorded_at,
            a.recorded_at_ms AS reference_recorded_at_ms,
            a.latitude AS reference_latitude,
            a.longitude AS reference_longitude

        FROM ${TABLE_NAME} s

        LEFT JOIN ${TABLE_NAME} a
            ON a.location_log_id = (
                SELECT a2.location_log_id
                FROM ${TABLE_NAME} a2
                WHERE
                    a2.user_id = s.user_id
                    AND a2.recording_session_id = s.recording_session_id
                    AND a2.queue_status IN ('sent', 'duplicate')
                    AND a2.processed_at IS NOT NULL
                    AND s.processed_at IS NOT NULL
                    AND a2.processed_at <= s.processed_at
                ORDER BY a2.recorded_at_ms DESC
                LIMIT 1
            )

        WHERE
            s.recording_session_id = $recordingSessionId
            AND s.queue_status = 'skipped'
            AND s.skip_reason = 'saveConditionNotMet'

        ORDER BY s.recorded_at_ms ASC
        `,
        {
            $recordingSessionId: recordingSessionId,
        },
    );

    console.log(
        "SQLite saveConditionNotMet diagnostics summary:",
        JSON.stringify({
            recordingSessionId,
            count: rows.length,
        }),
    );

    rows.forEach((row, index) => {
        let elapsedMs: number | null = null;
        let distanceMeters: number | null = null;

        if (
            row.reference_recorded_at_ms != null &&
            row.reference_latitude != null &&
            row.reference_longitude != null
        ) {
            elapsedMs = row.recorded_at_ms - row.reference_recorded_at_ms;

            distanceMeters = calculateDistanceMeters(
                row.reference_latitude,
                row.reference_longitude,
                row.latitude,
                row.longitude,
            );
        }

        console.log(
            "SQLite saveConditionNotMet diagnostic:",
            JSON.stringify({
                no: index + 1,

                recordedAt: row.recorded_at,
                latitude: row.latitude,
                longitude: row.longitude,
                accuracy: row.accuracy,

                referenceRecordedAt: row.reference_recorded_at,
                referenceLatitude: row.reference_latitude,
                referenceLongitude: row.reference_longitude,

                elapsedMs,
                elapsedSeconds: elapsedMs != null ? elapsedMs / 1000 : null,

                distanceMeters,

                under30Seconds: elapsedMs != null && elapsedMs < 30_000,

                under20Meters: distanceMeters != null && distanceMeters < 20,
            }),
        );
    });
}

type SaveThresholdTimelineRow = {
    location_log_id: string;
    recorded_at: string;
    recorded_at_ms: number;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    queue_status: string;
    skip_reason: string | null;
    processed_at: string | null;
};

export async function debugPrintSaveThresholdTimeline(
    recordingSessionId: string,
): Promise<void> {
    const db = await getDatabase();

    const rows = await db.getAllAsync<SaveThresholdTimelineRow>(
        `
        SELECT
            location_log_id,
            recorded_at,
            recorded_at_ms,
            latitude,
            longitude,
            accuracy,
            queue_status,
            skip_reason,
            processed_at
        FROM ${TABLE_NAME}
        WHERE recording_session_id = $recordingSessionId
        ORDER BY recorded_at_ms ASC
        `,
        {
            $recordingSessionId: recordingSessionId,
        },
    );

    let reference: SaveThresholdTimelineRow | null = null;

    let candidate: {
        row: SaveThresholdTimelineRow;
        distanceMeters: number;
        elapsedMs: number;
        reference: SaveThresholdTimelineRow;
    } | null = null;

    let caseNo = 0;

    for (const row of rows) {
        if (!reference) {
            if (
                row.queue_status === "sent" ||
                row.queue_status === "duplicate"
            ) {
                reference = row;
            }
            continue;
        }

        const elapsedMs = row.recorded_at_ms - reference.recorded_at_ms;

        const distanceMeters = calculateDistanceMeters(
            reference.latitude,
            reference.longitude,
            row.latitude,
            row.longitude,
        );

        // 15m以上20m未満でsaveConditionNotMetになった地点を記憶
        if (
            row.queue_status === "skipped" &&
            row.skip_reason === "saveConditionNotMet" &&
            distanceMeters >= 15 &&
            distanceMeters < 20 &&
            elapsedMs < 30_000
        ) {
            candidate = {
                row,
                distanceMeters,
                elapsedMs,
                reference,
            };

            continue;
        }

        if (candidate) {
            const candidateReference = candidate.reference;

            const distanceFromCandidateReference = calculateDistanceMeters(
                candidateReference.latitude,
                candidateReference.longitude,
                row.latitude,
                row.longitude,
            );

            const elapsedFromCandidateReferenceMs =
                row.recorded_at_ms - candidateReference.recorded_at_ms;

            const thresholdReached =
                distanceFromCandidateReference >= 20 ||
                elapsedFromCandidateReferenceMs >= 30_000;

            if (thresholdReached) {
                caseNo += 1;

                const correctlyAccepted =
                    row.queue_status === "sent" ||
                    row.queue_status === "duplicate";

                console.log(
                    "SQLite save threshold diagnostic:",
                    JSON.stringify({
                        no: caseNo,

                        referenceRecordedAt: candidateReference.recorded_at,

                        skippedRecordedAt: candidate.row.recorded_at,
                        skippedDistanceMeters: candidate.distanceMeters,
                        skippedElapsedSeconds: candidate.elapsedMs / 1000,

                        thresholdRecordedAt: row.recorded_at,
                        thresholdDistanceMeters: distanceFromCandidateReference,
                        thresholdElapsedSeconds:
                            elapsedFromCandidateReferenceMs / 1000,

                        queueStatus: row.queue_status,
                        skipReason: row.skip_reason,

                        correctlyAccepted,
                    }),
                );

                candidate = null;
            }
        }

        // 実際にacceptedになった地点で基準点更新
        if (row.queue_status === "sent" || row.queue_status === "duplicate") {
            reference = row;
        }
    }

    console.log(
        "SQLite save threshold diagnostics summary:",
        JSON.stringify({
            recordingSessionId,
            caseCount: caseNo,
        }),
    );
}

export async function debugPrintLocationQueueRecoverySummary(): Promise<void> {
    const db = await getDatabase();

    const summary = await db.getFirstAsync<{
        total_count: number;
        pending_count: number;
        sent_count: number;
        duplicate_count: number;
        skipped_count: number;
        oldest_recorded_at: string | null;
        latest_recorded_at: string | null;
    }>(`
        SELECT
            COUNT(*) AS total_count,

            SUM(
                CASE
                    WHEN queue_status = 'pending'
                    THEN 1
                    ELSE 0
                END
            ) AS pending_count,

            SUM(
                CASE
                    WHEN queue_status = 'sent'
                    THEN 1
                    ELSE 0
                END
            ) AS sent_count,

            SUM(
                CASE
                    WHEN queue_status = 'duplicate'
                    THEN 1
                    ELSE 0
                END
            ) AS duplicate_count,

            SUM(
                CASE
                    WHEN queue_status = 'skipped'
                    THEN 1
                    ELSE 0
                END
            ) AS skipped_count,

            MIN(recorded_at) AS oldest_recorded_at,
            MAX(recorded_at) AS latest_recorded_at

        FROM ${TABLE_NAME}
    `);

    const sessions = await db.getAllAsync<{
        recording_session_id: string;
        count: number;
        oldest_recorded_at: string | null;
        latest_recorded_at: string | null;
    }>(`
        SELECT
            recording_session_id,
            COUNT(*) AS count,
            MIN(recorded_at) AS oldest_recorded_at,
            MAX(recorded_at) AS latest_recorded_at
        FROM ${TABLE_NAME}
        GROUP BY recording_session_id
        ORDER BY oldest_recorded_at ASC
    `);

    console.log("[SQLiteRecovery] summary:", JSON.stringify(summary));

    console.log("[SQLiteRecovery] sessions:", JSON.stringify(sessions));
}
