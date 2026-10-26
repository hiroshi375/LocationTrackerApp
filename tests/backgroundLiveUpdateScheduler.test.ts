import { test } from "node:test";
import assert from "node:assert/strict";
import { createBackgroundLiveUpdateScheduler } from "../src/services/backgroundLiveUpdateScheduler";

test("fresh live send starts while historical cloud upload is blocked", async () => {
    const scheduler = createBackgroundLiveUpdateScheduler();
    let release!: () => void;
    const history = new Promise<void>(r => { release = r; });
    let historyDone = false;
    history.then(() => { historyDone = true; });
    let liveSent = false;
    await scheduler.start({ key: "A:1", recordedAtMs: 1_000, nowMs: 1_000,
        send: async () => { liveSent = true; return { succeeded: true }; } });
    assert.equal(liveSent, true);
    assert.equal(historyDone, false);
    release(); await history;
});

test("old and future OS batches never masquerade as current location", () => {
    const scheduler = createBackgroundLiveUpdateScheduler();
    const send = async () => { throw new Error("must not send stale coordinates"); };
    for (const recordedAtMs of [0, 200_000, NaN, Infinity]) {
        assert.equal(scheduler.start({ key: "A:1", recordedAtMs, nowMs: 100_000, send }), null);
    }
});

test("overlapping callbacks do not start simultaneous live requests", async () => {
    const scheduler = createBackgroundLiveUpdateScheduler();
    let resolve!: (r: { succeeded: boolean }) => void;
    const first = scheduler.start({ key: "A:1", recordedAtMs: 1_000, nowMs: 1_000,
        send: () => new Promise<{ succeeded: boolean }>(r => { resolve = r; }) });
    await Promise.resolve();
    assert.equal(scheduler.start({ key: "A:1", recordedAtMs: 40_000, nowMs: 40_000,
        send: async () => ({ succeeded: true }) }), null);
    resolve({ succeeded: true }); await first;
});

test("failed update permits next callback retry without a 30 second penalty", async () => {
    const scheduler = createBackgroundLiveUpdateScheduler();
    await scheduler.start({ key: "A:1", recordedAtMs: 1_000, nowMs: 1_000,
        send: async () => ({ succeeded: false }) });
    assert.ok(await scheduler.start({ key: "A:1", recordedAtMs: 1_000, nowMs: 2_000,
        send: async () => ({ succeeded: true }) }));
});

test("success throttles, rejects out of order data, and sharing revision resets throttle", async () => {
    const scheduler = createBackgroundLiveUpdateScheduler();
    const send = async () => ({ succeeded: true });
    await scheduler.start({ key: "A:1", recordedAtMs: 1_000, nowMs: 1_000, send });
    assert.equal(scheduler.start({ key: "A:1", recordedAtMs: 2_000, nowMs: 2_000, send }), null);
    assert.equal(scheduler.start({ key: "A:1", recordedAtMs: 999, nowMs: 40_000, send }), null);
    assert.ok(await scheduler.start({ key: "A:2", recordedAtMs: 2_000, nowMs: 2_000, send }));
});

test("synchronous exceptions release the gate for a later retry", async () => {
    const scheduler = createBackgroundLiveUpdateScheduler();
    const request = { key: "A:1", recordedAtMs: 1_000, nowMs: 1_000 };
    await assert.rejects(scheduler.start({ ...request, send: () => { throw new Error("network"); } })!);
    assert.ok(await scheduler.start({ ...request, send: async () => ({ succeeded: true }) }));
});
