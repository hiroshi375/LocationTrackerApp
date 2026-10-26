import { test } from "node:test";
import assert from "node:assert/strict";
import { handoffRecordingInboxBatch, matchesRecordingReceipt, type RecordingInboxBatch } from "../src/services/nativeRecordingInboxCore";

const batch: RecordingInboxBatch = { context: { userId: "A", recordingSessionId: "old-session", startedAtMs: 100,
    intervalMs: 30_000, distanceMeters: 50 }, rows: [{ id: 1, location: { timestamp: 101, coords: { latitude: 35, longitude: 139 } } }] };

test("delayed jobs cannot borrow a new session; sharing-only and legacy delivery still work", () => {
    const point = { timestamp: 101, aclogOwner: "A", aclogSessionId: "old-session" };
    const state = { userId: "A", isRecording: true, recordingSessionId: "new-session", startedAt: new Date(100).toISOString() };
    assert.equal(matchesRecordingReceipt(point, state), false);
    assert.equal(matchesRecordingReceipt(point, { ...state, recordingSessionId: "old-session" }), true);
    assert.equal(matchesRecordingReceipt({ ...point, timestamp: 99 }, { ...state, recordingSessionId: "old-session" }), false);
    assert.equal(matchesRecordingReceipt(point, { ...state, isRecording: false, recordingSessionId: null }), true);
    assert.equal(matchesRecordingReceipt(point, { ...state, userId: "B", isRecording: false }), false);
    assert.equal(matchesRecordingReceipt({ timestamp: 101 }, state), true);
});

test("native receipts survive a failed or partial JS SQLite write", async () => {
    for (const persist of [async () => { throw new Error("disk unavailable"); },
        async () => ({ receivedCount: 1, insertedCount: 0, duplicateCount: 0, invalidCount: 1 })]) {
        let ack = false;
        await assert.rejects(handoffRecordingInboxBatch({ batch, persist, acknowledge: async () => { ack = true; } }));
        assert.equal(ack, false);
    }
});

test("crash after JS commit before native acknowledgement retries as duplicate", async () => {
    const stored = new Set<number>(); let failAck = true;
    const persist = async (b: RecordingInboxBatch) => {
        let insertedCount = 0, duplicateCount = 0;
        for (const r of b.rows) if (stored.has(r.id)) duplicateCount++; else { stored.add(r.id); insertedCount++; }
        return { receivedCount: b.rows.length, insertedCount, duplicateCount, invalidCount: 0 };
    };
    const acknowledge = async (c: typeof batch.context, ids: number[]) => {
        assert.equal(c.userId, "A"); assert.equal(c.recordingSessionId, "old-session"); assert.deepEqual(ids, [1]);
        if (failAck) throw new Error("process died");
    };
    await assert.rejects(handoffRecordingInboxBatch({ batch, persist, acknowledge }));
    failAck = false; await handoffRecordingInboxBatch({ batch, persist, acknowledge }); assert.equal(stored.size, 1);
});

test("receipt-time owner/session remain unchanged after a later session starts", async () => {
    const nextSession = { userId: "B", recordingSessionId: "new-session" };
    await handoffRecordingInboxBatch({ batch,
        persist: async b => { assert.notEqual(b.context.userId, nextSession.userId); assert.equal(b.context.recordingSessionId, "old-session");
            return { receivedCount: 1, insertedCount: 1, duplicateCount: 0, invalidCount: 0 }; },
        acknowledge: async (c, ids) => { assert.equal(c.userId, "A"); assert.deepEqual(ids, [1]); } });
});

test("invalid identity, coordinates, earlier-session timestamps and duplicate receipt IDs cannot be acknowledged", async () => {
    const cases = [
        { ...batch, context: { ...batch.context, userId: "" } },
        { ...batch, rows: [batch.rows[0], batch.rows[0]] },
        { ...batch, rows: [{ ...batch.rows[0], location: { ...batch.rows[0].location, timestamp: 99 } }] },
        { ...batch, rows: [{ ...batch.rows[0], location: { timestamp: 101, coords: { latitude: NaN, longitude: 139 } } }] },
    ];
    for (const b of cases) await assert.rejects(handoffRecordingInboxBatch({ batch: b,
        persist: async () => { throw new Error("must not write"); }, acknowledge: async () => { assert.fail("must not ack"); } }));
});
