/**
 * Device-side integration tests. Must run in an Expo Development Build, not
 * plain Node.js; expo-sqlite requires its native module.
 *
 * Tests use a dedicated test database, NOT location-tracker.db.
 */
import * as SQLite from "expo-sqlite";
import { createRecordingControlTransitions } from "../services/recordingControlTransitions";
import {
    createRecordingControlStateTestStore,
    type RecordingControlState,
} from "../services/backgroundRecordingStateStore";

type TestResult = { name: string; passed: boolean; detail?: string };

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function makeState(overrides: Partial<RecordingControlState> = {}): RecordingControlState {
    return {
        userId: "test-user",
        isRecording: true,
        recordingSessionId: "test-session-A",
        shareRevision: 5,
        liveShareOwnerValues: ["owner-A"],
        intervalMs: 30_000,
        distanceMeters: 50,
        ...overrides,
    };
}

/** Run from a temporary DEV-only button. Throws on any failure. */
export async function runBackgroundRecordingStateStoreTests(): Promise<TestResult[]> {
    if (!__DEV__) {
        throw new Error("RECORDING_CONTROL_TESTS_REQUIRE_DEV_BUILD");
    }

    // New name each run: no production row, no leftover data from prior tests.
    const databaseName = `background-control-test-${Date.now()}-${Math.random()
        .toString(36).slice(2, 8)}.db`;
    const store = createRecordingControlStateTestStore(databaseName);
    const results: TestResult[] = [];

    async function test(name: string, operation: () => Promise<void>): Promise<void> {
        try {
            await operation();
            results.push({ name, passed: true });
            console.log(`[RecordingControlTest] PASS: ${name}`);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            results.push({ name, passed: false, detail });
            console.error(`[RecordingControlTest] FAIL: ${name}`, error);
        }
    }

    await test("initialization: empty and first insert", async () => {
        assert((await store.readRecordingControlState()) === null, "state should be empty");
        assert(await store.initializeRecordingControlStateIfAbsent(makeState()), "seed failed");
        const current = await store.readRecordingControlState();
        assert(current?.version === 1, "initial version != 1");
        assert(current.state.recordingSessionId === "test-session-A", "session mismatch");
    });

    await test("initialization: second insert cannot overwrite", async () => {
        const inserted = await store.initializeRecordingControlStateIfAbsent(
            makeState({ recordingSessionId: "unexpected-session", shareRevision: 99 }),
        );
        assert(inserted === false, "duplicate seed should fail");
        const current = await store.readRecordingControlState();
        assert(current?.state.recordingSessionId === "test-session-A", "state overwritten");
    });

    await test("CAS: correct version succeeds", async () => {
        const current = await store.readRecordingControlState();
        assert(current !== null, "missing current state");
        assert(
            await store.replaceRecordingControlStateIfVersion(
                current.version,
                { ...current.state, shareRevision: 6, liveShareOwnerValues: ["owner-B"] },
            ),
            "valid CAS rejected",
        );
        const next = await store.readRecordingControlState();
        assert(next?.version === current.version + 1, "version not incremented");
        assert(next.state.shareRevision === 6, "revision not saved");
    });

    await test("CAS: stale version cannot roll back sharing", async () => {
        const current = await store.readRecordingControlState();
        assert(current !== null, "missing current state");
        const success = await store.replaceRecordingControlStateIfVersion(
            current.version - 1,
            makeState({ shareRevision: 5, liveShareOwnerValues: ["owner-A"] }),
        );
        assert(success === false, "stale update was accepted");
        const next = await store.readRecordingControlState();
        assert(next?.state.shareRevision === 6, "sharing revision rolled back");
    });

    await test("recording session: wrong user/session rejected", async () => {
        const location = { latitude: 35.7, longitude: 139.7, recordedAt: 1000 };
        assert(
            !(await store.updateLastSavedLocationIfRecording("other-user", "test-session-A", location)),
            "other user accepted",
        );
        assert(
            !(await store.updateLastSavedLocationIfRecording("test-user", "old-session", location)),
            "old session accepted",
        );
        const current = await store.readRecordingControlState();
        assert(current?.state.lastSavedLocation == null, "rejected update changed location");
    });

    await test("recording session: valid location and older location", async () => {
        const latest = { latitude: 35.7, longitude: 139.7, recordedAt: 2000 };
        assert(
            await store.updateLastSavedLocationIfRecording("test-user", "test-session-A", latest),
            "valid location rejected (SQLite JSON functions may be unavailable)",
        );
        assert(
            !(await store.updateLastSavedLocationIfRecording("test-user", "test-session-A", {
                ...latest, recordedAt: 1000,
            })),
            "older location accepted",
        );
        const current = await store.readRecordingControlState();
        assert(current?.state.lastSavedLocation?.recordedAt === 2000, "last location regressed");
    });

    await test("stopped session: location update rejected", async () => {
        const current = await store.readRecordingControlState();
        assert(current !== null, "missing state");
        assert(
            await store.replaceRecordingControlStateIfVersion(current.version, {
                ...current.state,
                isRecording: false,
                recordingSessionId: null,
            }),
            "stop CAS failed",
        );
        assert(
            !(await store.updateLastSavedLocationIfRecording("test-user", "test-session-A", {
                latitude: 35.8, longitude: 139.8, recordedAt: 3000,
            })),
            "stopped session accepted location",
        );
    });

    await test("session switch: old session cannot update new session", async () => {
        const current = await store.readRecordingControlState();
        assert(current !== null, "missing state");
        assert(await store.replaceRecordingControlStateIfVersion(current.version, {
            ...current.state, isRecording: true, recordingSessionId: "test-session-B",
            lastSavedLocation: null,
        }), "session switch rejected");
        assert(!(await store.updateLastSavedLocationIfRecording("test-user", "test-session-A", {
            latitude: 35.8, longitude: 139.8, recordedAt: 3001,
        })), "old session updated new session");
    });

    await test("concurrent CAS: exactly one writer wins", async () => {
        const current = await store.readRecordingControlState();
        assert(current !== null, "missing state");
        const candidateA = { ...current.state, shareRevision: 7 };
        const candidateB = { ...current.state, shareRevision: 8 };
        const settled = await Promise.allSettled([
            store.replaceRecordingControlStateIfVersion(current.version, candidateA),
            store.replaceRecordingControlStateIfVersion(current.version, candidateB),
        ]);
        const wins = settled.filter((item) => item.status === "fulfilled" && item.value === true);
        const failures = settled.filter((item) => item.status === "rejected");
        assert(failures.length === 0, "SQLite operation threw during concurrent CAS");
        assert(wins.length === 1, `expected one winner, got ${wins.length}`);
        const next = await store.readRecordingControlState();
        assert(next?.version === current.version + 1, "version should increase exactly once");
        assert(next.state.shareRevision === 7 || next.state.shareRevision === 8, "invalid winner");
    });

    // Migration tests use separate databases. The existing CAS tests above
    // deliberately seed the main test database without a migration marker.
    async function withMigrationDb(
        label: string,
        operation: (s: ReturnType<typeof createRecordingControlStateTestStore>) => Promise<void>,
    ) {
        const name = `background-control-test-${Date.now()}-${Math.random()
            .toString(36).slice(2, 9)}.db`;
        const migrationStore = createRecordingControlStateTestStore(name);
        try {
            await test(label, () => operation(migrationStore));
        } finally {
            await migrationStore.close();
            await SQLite.deleteDatabaseAsync(name);
        }
    }

    await withMigrationDb("migration: existing legacy snapshot copied once", async (s) => {
        assert(!(await s.readLegacyMigrationStatus()), "migration should be pending");
        const snapshot = makeState({ shareRevision: 12, liveShareOwnerValues: ["owner-m"] });
        assert((await s.migrateLegacyStateIfNeeded(snapshot)) === "migrated", "migration failed");
        const current = await s.readRecordingControlState();
        assert(current?.version === 1, "wrong initial version");
        assert(current.state.shareRevision === 12, "legacy shareRevision lost");
        assert(await s.readLegacyMigrationStatus(), "migration flag missing");
    });

    await withMigrationDb("migration: repeated call never overwrites", async (s) => {
        assert((await s.migrateLegacyStateIfNeeded(makeState())) === "migrated", "initial migration failed");
        assert(
            (await s.migrateLegacyStateIfNeeded(makeState({ recordingSessionId: "stale", shareRevision: 99 })))
                === "already_migrated",
            "migration should be idempotent",
        );
        const current = await s.readRecordingControlState();
        assert(current?.state.recordingSessionId === "test-session-A", "replay overwrote state");
    });

    await withMigrationDb("migration: empty legacy snapshot has persistent marker", async (s) => {
        assert((await s.migrateLegacyStateIfNeeded(null)) === "no_legacy_state", "empty migration failed");
        assert(await s.readLegacyMigrationStatus(), "missing empty migration marker");
        assert((await s.readRecordingControlState()) === null, "unexpected control state");
        assert(
            (await s.migrateLegacyStateIfNeeded(makeState())) === "already_migrated",
            "stale snapshot resurrected state",
        );
        assert((await s.readRecordingControlState()) === null, "state resurrected");
    });

    await withMigrationDb("migration: existing SQLite state is never overwritten", async (s) => {
        assert(await s.initializeRecordingControlStateIfAbsent(makeState()), "seed failed");
        let rejected = false;
        try {
            await s.migrateLegacyStateIfNeeded(makeState({ shareRevision: 99 }));
        } catch (error) {
            rejected = error instanceof Error &&
                error.message === "RECORDING_CONTROL_MIGRATION_EXISTING_STATE";
        }
        assert(rejected, "existing SQLite state was not protected");
        assert(!(await s.readLegacyMigrationStatus()), "incorrect completed marker");
        assert((await s.readRecordingControlState())?.state.shareRevision === 5, "SQLite state changed");
    });

    await withMigrationDb("migration: competing initialization cannot duplicate", async (s) => {
        const outcomes = await Promise.allSettled([
            s.migrateLegacyStateIfNeeded(makeState()),
            s.migrateLegacyStateIfNeeded(makeState({ shareRevision: 77 })),
        ]);
        const migrated = outcomes.filter((x) => x.status === "fulfilled" && x.value === "migrated");
        assert(migrated.length === 1, "expected exactly one successful migration");
        // A concurrent exclusive transaction may report SQLITE_BUSY; on retry
        // the durable migration marker must prevent a second copy.
        assert(
            (await s.migrateLegacyStateIfNeeded(makeState({ shareRevision: 99 })))
                === "already_migrated",
            "retry did not observe completed migration",
        );
        assert((await s.readRecordingControlState())?.version === 1, "migration inserted twice");
    });

    // The transition suite uses isolated DBs with explicit migration status.
    async function transitionTest(name: string, operation: (
        stateStore: ReturnType<typeof createRecordingControlStateTestStore>,
        api: ReturnType<typeof createRecordingControlTransitions>
    ) => Promise<void>) {
        const nameDb = `background-control-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.db`;
        const stateStore = createRecordingControlStateTestStore(nameDb);
        const api = createRecordingControlTransitions(stateStore);
        try {
            await test(name, () => operation(stateStore, api));
        } finally {
            await stateStore.close();
            await SQLite.deleteDatabaseAsync(nameDb);
        }
    }

    const startArgs = {
        userId: "test-user", recordingSessionId: "session-new",
        startedAt: "2026-10-11T00:00:00.000Z", intervalMs: 30000,
        distanceMeters: 50, shareRevision: 6, liveShareOwnerValues: ["owner-B"],
    };

    await transitionTest("transition: refuses before migration", async (s, api) => {
        assert(await s.initializeRecordingControlStateIfAbsent(makeState()), "seed failed");
        let rejected = false;
        try { await api.stopRecordingControlSession({
            userId: "test-user", recordingSessionId: "test-session-A", expectedShareRevision: 5,
        }); } catch (e) {
            rejected = e instanceof Error && e.message === "RECORDING_CONTROL_NOT_MIGRATED";
        }
        assert(rejected, "unmigrated store accepted");
    });

    await transitionTest("transition: start from stopped state", async (s, api) => {
        assert((await s.migrateLegacyStateIfNeeded(makeState({
            isRecording:false, recordingSessionId:null, liveShareOwnerValues:[], shareRevision:5,
        }))) === "migrated", "migration failed");
        const result = await api.startRecordingControlSession(startArgs);
        assert(result.status === "updated", "start rejected");
        const now = await s.readRecordingControlState();
        assert(now?.state.recordingSessionId === "session-new", "session not started");
        assert(now.state.shareRevision === 6, "revision wrong");
    });

    await transitionTest("transition: stop preserves sharing", async (s, api) => {
        await s.migrateLegacyStateIfNeeded(makeState());
        const r = await api.stopRecordingControlSession({
            userId:"test-user", recordingSessionId:"test-session-A", expectedShareRevision:5,
        });
        assert(r.status === "updated", "stop rejected");
        const now = await s.readRecordingControlState();
        assert(now?.state.isRecording === false, "recording still active");
        assert(now.state.liveShareOwnerValues?.[0] === "owner-A", "sharing lost");
        assert(now.state.recordingSessionId == null, "session remains");
    });

    await transitionTest("transition: continue sharing requires recipients", async (s, api) => {
        await s.migrateLegacyStateIfNeeded(makeState({liveShareOwnerValues:[]}));
        const result = await api.continueRecordingControlSharing({
            userId:"test-user", recordingSessionId:"test-session-A", expectedShareRevision:5,
        });
        assert(result.status === "stale", "empty recipient continuation allowed");
    });

    await transitionTest("transition: stop all leaves tombstone and rejects old callback", async (s, api) => {
        await s.migrateLegacyStateIfNeeded(makeState());
        const r = await api.stopRecordingControlCompletely({
            userId:"test-user", expectedShareRevision:5, confirmedShareRevision:6,
        });
        assert(r.status === "updated", "stop all rejected");
        const now = await s.readRecordingControlState();
        assert(now?.state.isRecording === false, "recording active");
        assert(now.state.liveShareOwnerValues?.length === 0, "sharing active");
        assert(now.state.shareRevision === 6, "revision lost");
        const old = await api.stopRecordingControlSession({
            userId:"test-user",recordingSessionId:"test-session-A",expectedShareRevision:5,
        });
        assert(old.status === "stale", "old callback accepted");
    });

    await transitionTest("transition: wrong session and revision refused", async (s, api) => {
        await s.migrateLegacyStateIfNeeded(makeState());
        const oldSession = await api.stopRecordingControlSession({
            userId:"test-user",recordingSessionId:"old-session",expectedShareRevision:5,
        });
        const oldRevision = await api.stopRecordingControlSession({
            userId:"test-user",recordingSessionId:"test-session-A",expectedShareRevision:4,
        });
        assert(oldSession.status === "stale" && oldRevision.status === "stale", "stale stop accepted");
    });

    await transitionTest("transition: repeat stop is not a restart", async (s, api) => {
        await s.migrateLegacyStateIfNeeded(makeState());
        const args = {userId:"test-user", expectedShareRevision:5, confirmedShareRevision:6};
        assert((await api.stopRecordingControlCompletely(args)).status === "updated", "first stop failed");
        assert((await api.stopRecordingControlCompletely(args)).status === "stale", "repeat stop should be stale");
        assert((await s.readRecordingControlState())?.state.shareRevision === 6, "revision rolled back");
    });

    const failed = results.filter((result) => !result.passed);
    console.log("[RecordingControlTest] SUMMARY", {
        total: results.length, passed: results.length - failed.length,
        failed: failed.length, results,
        testDatabase: databaseName,
    });
    // Only remove the isolated test DB. Never touch location-tracker.db.
    try {
        await store.close();
        await SQLite.deleteDatabaseAsync(databaseName);
    } catch (error) {
        console.warn("[RecordingControlTest] Test DB cleanup failed:", databaseName, error);
    }
    if (failed.length > 0) {
        throw new Error(`RECORDING_CONTROL_TEST_FAILED: ${failed.map((x) => x.name).join(", ")}`);
    }
    return results;
}
