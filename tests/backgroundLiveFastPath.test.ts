import { test } from "node:test";
import assert from "node:assert/strict";
import { runBackgroundLiveFastPath } from "../src/services/backgroundLiveFastPath";
import { createBackgroundLiveUpdateScheduler } from "../src/services/backgroundLiveUpdateScheduler";

const now = 100_000;
const state = { userId: "A", shareRevision: 3, liveShareOwnerValues: ["B"], isRecording: true, startedAt: new Date(95_000).toISOString() };
const point = (timestamp = now) => ({ timestamp, coords: { latitude: 35, longitude: 139 } });

test("live-only delivery selects newest point without changing recording state", async () => {
    const before = structuredClone(state);
    let sent = 0;
    const result = await runBackgroundLiveFastPath({ locations: [point(99_000), point(), point(98_000)], nowMs: now,
        loadState: async () => state, authorize: async id => id === "A",
        schedule: async (captured, location) => { assert.equal(captured.shareRevision, 3); assert.equal(location.timestamp, now); sent++; return { succeeded: true }; } });
    assert.equal(result, "updated"); assert.equal(sent, 1); assert.deepEqual(state, before);
});

test("stopped sharing, missing revision, other user, invalid/stale/future and previous session points fail closed", async () => {
    for (const [s, locations, authorized] of [
        [{ ...state, liveShareOwnerValues: [] }, [point()], true],
        [{ ...state, shareRevision: undefined }, [point()], true],
        [state, [point()], false],
        [state, [point(1)], true],
        [state, [point(now + 11_000)], true],
        [state, [point(94_000)], true],
        [state, [{ ...point(), coords: { latitude: 91, longitude: 139 } }], true],
        [{ ...state, startedAt: null }, [point()], true],
    ] as const) {
        let sent = false;
        await runBackgroundLiveFastPath({ locations: [...locations], nowMs: now, loadState: async () => s,
            authorize: async () => authorized, schedule: async () => { sent = true; return { succeeded: true }; } });
        assert.equal(sent, false);
    }
});

test("fast and normal job delivery share one scheduler; failure permits retry", async () => {
    const scheduler = createBackgroundLiveUpdateScheduler();
    let calls = 0;
    const send = async () => { calls++; return { succeeded: true }; };
    await runBackgroundLiveFastPath({ locations: [point()], nowMs: now, loadState: async () => state,
        authorize: async () => true, schedule: (_, location) => scheduler.start({ key: "A:3", recordedAtMs: location.timestamp, nowMs: now, send }) });
    assert.equal(scheduler.start({ key: "A:3", recordedAtMs: now, nowMs: now, send }), null);
    assert.equal(calls, 1);
});
