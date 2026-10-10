/**
 * SQLite-backed recording control state.
 *
 * The production database is independent of the test database. Until the
 * migration is implemented, AsyncStorage remains the authoritative source.
 */
import * as SQLite from "expo-sqlite";

const PRODUCTION_DATABASE_NAME = "location-tracker.db";
const CONTROL_TABLE = "background_recording_control";
const CURRENT_ROW_ID = "current";

export type SavedRecordingLocation = {
    latitude: number;
    longitude: number;
    recordedAt: number;
};

export type RecordingControlState = {
    userId: string;
    isRecording: boolean;
    recordingSessionId?: string | null;
    startedAt?: string | null;
    recordingExpiresAt?: string | null;
    liveShareOwnerValues?: string[];
    liveLocationId?: string | null;
    shareRevision?: number;
    liveSharingStartedAt?: number | null;
    lastSavedLocation?: SavedRecordingLocation | null;
    intervalMs: number;
    distanceMeters: number;
};

export type VersionedRecordingControlState = {
    state: RecordingControlState;
    version: number;
};

type ControlRow = { state_json: string; version: number };
const MIGRATION_TABLE = "background_recording_migration";
const LEGACY_MIGRATION_KEY = "async_storage_v1";

export type LegacyMigrationResult = "migrated" | "no_legacy_state" | "already_migrated";


export type RecordingControlStateStore = {
    close(): Promise<void>;
    readLegacyMigrationStatus(): Promise<boolean>;
    migrateLegacyStateIfNeeded(
        legacySnapshot: RecordingControlState | null,
    ): Promise<LegacyMigrationResult>;
    readRecordingControlState(): Promise<VersionedRecordingControlState | null>;
    initializeRecordingControlStateIfAbsent(state: RecordingControlState): Promise<boolean>;
    replaceRecordingControlStateIfVersion(
        expectedVersion: number,
        nextState: RecordingControlState,
    ): Promise<boolean>;
    updateLastSavedLocationIfRecording(
        expectedUserId: string,
        expectedRecordingSessionId: string,
        location: SavedRecordingLocation,
    ): Promise<boolean>;
};

function validateState(state: RecordingControlState): void {
    if (
        typeof state.userId !== "string" || !state.userId ||
        typeof state.isRecording !== "boolean" ||
        !Number.isFinite(state.intervalMs) ||
        !Number.isFinite(state.distanceMeters)
    ) {
        throw new Error("INVALID_RECORDING_CONTROL_STATE");
    }
    if (
        state.shareRevision !== undefined &&
        (!Number.isSafeInteger(state.shareRevision) || state.shareRevision < 0)
    ) {
        throw new Error("INVALID_RECORDING_CONTROL_SHARE_REVISION");
    }
}

/**
 * A store instance only touches its own database file.
 * Construct a test instance with a DIFFERENT database filename.
 */
function createStore(databaseName: string): RecordingControlStateStore {
    let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

    async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
        if (!databasePromise) {
            databasePromise = (async () => {
                const db = await SQLite.openDatabaseAsync(databaseName);
                // Do not modify the queue table or PRAGMA user_version.
                await db.execAsync(`
                    CREATE TABLE IF NOT EXISTS ${CONTROL_TABLE} (
                        id TEXT PRIMARY KEY NOT NULL,
                        state_json TEXT NOT NULL,
                        version INTEGER NOT NULL DEFAULT 1,
                        updated_at TEXT NOT NULL
                    );
                `);
                await db.execAsync(`
                    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
                        migration_key TEXT PRIMARY KEY NOT NULL,
                        completed_at TEXT NOT NULL,
                        had_legacy_state INTEGER NOT NULL
                    );
                `);
                return db;
            })().catch((error) => {
                databasePromise = null;
                throw error;
            });
        }
        return databasePromise;
    }

    return {
        async close() {
            if (databasePromise) {
                const db = await databasePromise;
                await db.closeAsync();
                databasePromise = null;
            }
        },
        async readLegacyMigrationStatus() {
            const db = await getDatabase();
            const row = await db.getFirstAsync<{ migration_key: string }>(
                `SELECT migration_key FROM ${MIGRATION_TABLE} WHERE migration_key = ?`,
                LEGACY_MIGRATION_KEY,
            );
            return row !== null;
        },

        async migrateLegacyStateIfNeeded(legacySnapshot) {
            // Do not read AsyncStorage here. The caller must take the snapshot
            // ONLY after all legacy writers (FG and headless BG) are quiescent.
            // There is no atomic transaction spanning SQLite and AsyncStorage.
            if (legacySnapshot !== null) validateState(legacySnapshot);
            const db = await getDatabase();
            let migrationResult: LegacyMigrationResult | null = null;
            await db.withExclusiveTransactionAsync(async (txn): Promise<void> => {
                const completed = await txn.getFirstAsync<{ migration_key: string }>(
                    `SELECT migration_key FROM ${MIGRATION_TABLE} WHERE migration_key = ?`,
                    LEGACY_MIGRATION_KEY,
                );
                if (completed) {
                    migrationResult = "already_migrated";
                    return;
                }

                const preexisting = await txn.getFirstAsync<{ id: string }>(
                    `SELECT id FROM ${CONTROL_TABLE} WHERE id = ?`,
                    CURRENT_ROW_ID,
                );
                if (preexisting) {
                    // Do not overwrite a state that was written by another path.
                    throw new Error("RECORDING_CONTROL_MIGRATION_EXISTING_STATE");
                }

                if (legacySnapshot !== null) {
                    const result = await txn.runAsync(
                        `INSERT INTO ${CONTROL_TABLE}
                         (id, state_json, version, updated_at) VALUES (?, ?, 1, ?)`,
                        CURRENT_ROW_ID,
                        JSON.stringify(legacySnapshot),
                        new Date().toISOString(),
                    );
                    if (result.changes !== 1) {
                        throw new Error("RECORDING_CONTROL_MIGRATION_INSERT_FAILED");
                    }
                }

                await txn.runAsync(
                    `INSERT INTO ${MIGRATION_TABLE}
                     (migration_key, completed_at, had_legacy_state) VALUES (?, ?, ?)`,
                    LEGACY_MIGRATION_KEY,
                    new Date().toISOString(),
                    legacySnapshot === null ? 0 : 1,
                );
                migrationResult = legacySnapshot === null ? "no_legacy_state" : "migrated";
            });
            if (migrationResult === null) {
                throw new Error("RECORDING_CONTROL_MIGRATION_RESULT_MISSING");
            }
            return migrationResult;
        },

        async readRecordingControlState() {
            const db = await getDatabase();
            const row = await db.getFirstAsync<ControlRow>(
                `SELECT state_json, version FROM ${CONTROL_TABLE} WHERE id = ?`,
                CURRENT_ROW_ID,
            );
            if (!row) return null;
            const state = JSON.parse(row.state_json) as RecordingControlState;
            validateState(state);
            return { state, version: row.version };
        },

        async initializeRecordingControlStateIfAbsent(state) {
            validateState(state);
            const db = await getDatabase();
            const result = await db.runAsync(
                `INSERT OR IGNORE INTO ${CONTROL_TABLE}
                 (id, state_json, version, updated_at) VALUES (?, ?, 1, ?)`,
                CURRENT_ROW_ID,
                JSON.stringify(state),
                new Date().toISOString(),
            );
            return result.changes === 1;
        },

        async replaceRecordingControlStateIfVersion(expectedVersion, nextState) {
            if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
                throw new Error("INVALID_RECORDING_CONTROL_VERSION");
            }
            validateState(nextState);
            const db = await getDatabase();
            const result = await db.runAsync(
                `UPDATE ${CONTROL_TABLE}
                 SET state_json = ?, version = version + 1, updated_at = ?
                 WHERE id = ? AND version = ?`,
                JSON.stringify(nextState),
                new Date().toISOString(),
                CURRENT_ROW_ID,
                expectedVersion,
            );
            return result.changes === 1;
        },

        async updateLastSavedLocationIfRecording(
            expectedUserId,
            expectedRecordingSessionId,
            location,
        ) {
            if (
                !expectedUserId || !expectedRecordingSessionId ||
                !Number.isFinite(location.latitude) ||
                !Number.isFinite(location.longitude) ||
                !Number.isFinite(location.recordedAt)
            ) {
                throw new Error("INVALID_RECORDING_CONTROL_LOCATION_UPDATE");
            }
            const db = await getDatabase();
            const result = await db.runAsync(
                `UPDATE ${CONTROL_TABLE}
                 SET state_json = json_set(state_json, '$.lastSavedLocation', json(?)),
                     version = version + 1,
                     updated_at = ?
                 WHERE id = ?
                   AND json_extract(state_json, '$.userId') = ?
                   AND json_extract(state_json, '$.recordingSessionId') = ?
                   AND json_extract(state_json, '$.isRecording') = 1
                   AND (json_extract(state_json, '$.lastSavedLocation.recordedAt') IS NULL
                        OR json_extract(state_json, '$.lastSavedLocation.recordedAt') < ?)`,
                JSON.stringify(location),
                new Date().toISOString(),
                CURRENT_ROW_ID,
                expectedUserId,
                expectedRecordingSessionId,
                location.recordedAt,
            );
            return result.changes === 1;
        },
    };
}

const productionStore = createStore(PRODUCTION_DATABASE_NAME);

// Backward-compatible public API (existing call sites need no changes).
export const readRecordingControlState =
    productionStore.readRecordingControlState;
export const readLegacyMigrationStatus =
    productionStore.readLegacyMigrationStatus;
export const migrateLegacyStateIfNeeded =
    productionStore.migrateLegacyStateIfNeeded;
export const initializeRecordingControlStateIfAbsent =
    productionStore.initializeRecordingControlStateIfAbsent;
export const replaceRecordingControlStateIfVersion =
    productionStore.replaceRecordingControlStateIfVersion;
export const updateLastSavedLocationIfRecording =
    productionStore.updateLastSavedLocationIfRecording;

/**
 * Isolated diagnostic store. Never access the production database in tests.
 * The argument must be a fixed, non-production .db filename.
 */
export function createRecordingControlStateTestStore(
    testDatabaseName: string,
): RecordingControlStateStore {
    if (
        !/^background-control-test-[a-zA-Z0-9_-]+\.db$/.test(testDatabaseName) ||
        testDatabaseName === PRODUCTION_DATABASE_NAME
    ) {
        throw new Error("INVALID_RECORDING_CONTROL_TEST_DATABASE");
    }
    return createStore(testDatabaseName);
}
