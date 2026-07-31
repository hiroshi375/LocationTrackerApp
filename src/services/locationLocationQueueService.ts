import * as Location from "expo-location";
import * as SQLite from "expo-sqlite";

import {
    createLocationLogId,
    createLocationUniqueKey,
} from "./locationLogDeduplicationService";

const DATABASE_NAME = "location-tracker.db";
const TABLE_NAME = "location_location_queue";
const DATABASE_VERSION = 1;

type LocationQueueSource = "background" | "foreground";

type EnqueueLocationBatchInput = {
    userId: string;
    recordingSessionId: string;
    source: LocationQueueSource;
    locations: Location.LocationObject[];
    receivedAt: string;
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

            created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS
            idx_location_location_queue_unique_key
        ON ${TABLE_NAME}(location_unique_key);

        CREATE INDEX IF NOT EXISTS
            idx_location_location_queue_unsent
        ON ${TABLE_NAME}(is_sent, recorded_at_ms);

        CREATE INDEX IF NOT EXISTS
            idx_location_location_queue_session
        ON ${TABLE_NAME}(recording_session_id, recorded_at_ms);

        PRAGMA user_version = ${DATABASE_VERSION};
    `);

    return db;
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

function normalizeNullableNumber(
    value: number | null | undefined,
): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
