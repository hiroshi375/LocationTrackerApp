import * as Location from "expo-location";
import * as SQLite from "expo-sqlite";

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

function normalizeNullableNumber(
    value: number | null | undefined,
): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
