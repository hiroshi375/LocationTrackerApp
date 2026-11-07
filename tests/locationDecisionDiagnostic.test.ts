import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocationDecisionDiagnostics, type LocationDecisionObservation } from "../src/services/locationDecisionDiagnosticCore";
const sample = (): LocationDecisionObservation => ({ path: "sqlite-queue", stage: "decision", userId: "owner", sessionId: "session",
    point: { latitude: 35, longitude: 139, recordedAtMs: 10, speed: 0 }, reason: "eligible-before-plan-reservation" });
test("disabled observation performs no field evaluation or storage", async () => {
    let writes = 0;
    const d = createLocationDecisionDiagnostics({ enabled: false, runtimeId: "r", now: () => 1, persist: async () => { writes++; } });
    d.capture(() => { throw new Error("must not evaluate"); });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(writes, 0); assert.equal(JSON.parse(d.snapshot()).rows.length, 0);
});
test("allowlist retains baseline, sequence and exact coordinates but no arbitrary credentials", () => {
    const d = createLocationDecisionDiagnostics({ enabled: true, runtimeId: "r", now: () => 20, capacity: 2 });
    d.capture(() => ({ ...sample(), password: "never-store", email: "private", baseline: { latitude: 35.1, longitude: 139.1, recordedAtMs: 1 } }));
    const value = d.snapshot(), row = JSON.parse(value).rows[0];
    assert.equal(row.baseline.recordedAtMs, 1); assert.equal(row.sequence, 1);
    assert.equal(row.point.speed, 0); assert.equal(row.point.speedValidity, "not_exposed");
    assert.deepEqual(JSON.parse(row.correlationKey), ["owner", "session", 10, 35, 139]);
    assert.equal(value.includes("never-store"), false); assert.equal(value.includes("private"), false);
});
test("bounded ring reports evictions and copies inputs instead of retaining mutable references", () => {
    const d = createLocationDecisionDiagnostics({ enabled: true, runtimeId: "r", now: () => 1, capacity: 2 });
    const s = sample(); d.capture(() => s); s.point.latitude = 80;
    assert.equal(JSON.parse(d.snapshot()).rows[0].point.latitude, 35);
    d.capture(sample); d.capture(sample);
    const value = JSON.parse(d.snapshot()); assert.equal(value.rows.length, 2); assert.equal(value.evicted, 1);
});
test("builder and asynchronous storage errors never escape to the recording caller", async () => {
    const d = createLocationDecisionDiagnostics({ enabled: true, runtimeId: "r", now: () => 1,
        persist: async () => { throw new Error("disk full"); } });
    assert.doesNotThrow(() => d.capture(() => { throw new Error("invalid"); }));
    assert.doesNotThrow(() => d.capture(sample));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(JSON.parse(d.snapshot()).persistenceFailures, 1);
});
test("slow storage coalesces events and does not grow an unbounded write queue", async () => {
    let release: (() => void) | undefined, writes = 0;
    const d = createLocationDecisionDiagnostics({ enabled: true, runtimeId: "r", now: () => 1, capacity: 2,
        persist: async () => { writes++; if (writes === 1) await new Promise<void>(resolve => { release = resolve; }); } });
    for (let i = 0; i < 100; i++) d.capture(sample);
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(writes, 1);
    release!(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(writes, 2); assert.equal(JSON.parse(d.snapshot()).evicted, 98);
});
test("persisted evidence has a byte bound and exposes eviction instead of pretending completeness", () => {
    const d = createLocationDecisionDiagnostics({ enabled: true, runtimeId: "r", now: () => 1 });
    for (let i = 0; i < 1100; i++) d.capture(() => ({ ...sample(), reason: "長".repeat(256), pointId: String(i) }));
    const snapshot = d.snapshot(); assert.ok(Buffer.byteLength(snapshot, "utf8") <= 512 * 1024);
    assert.ok(JSON.parse(snapshot).evicted > 0);
});
test("a missing selected baseline retains the future candidate that explains selection", () => {
    const d = createLocationDecisionDiagnostics({ enabled: true, runtimeId: "r", now: () => 1 });
    d.capture(() => ({ ...sample(), baseline: null,
        baselineCandidates: [{ name: "shared", point: { latitude: 35, longitude: 139, recordedAtMs: 100 } }] }));
    const r = JSON.parse(d.snapshot()).rows[0]; assert.equal(r.baseline, null);
    assert.equal(r.baselineCandidates[0].isFuture, true);
});
