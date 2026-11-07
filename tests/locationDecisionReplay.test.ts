import assert from "node:assert/strict";
import { test } from "node:test";
import { queuePredicate, foregroundSavePredicate, replay } from "../scripts/diagnostics/locationDecisionReplay";
const row = (id: string, time: number, longitude: number, source = "background", created = time) => ({ id, userId: "A", recordingSessionId: "s",
    latitude: 35, longitude, accuracy: 5, recordedAt: new Date(time).toISOString(), createdAt: new Date(created).toISOString(), source });
test("actual foreground and queue predicates expose the speed-check difference", () => {
    const baseline = { latitude: 35, longitude: 139, recordedAt: 0 };
    assert.equal(foregroundSavePredicate(35, 139.02, 5000, baseline), true);
    assert.equal(queuePredicate({ latitude: 35, longitude: 139.02, accuracy: 5, recorded_at_ms: 5000 }, baseline, 30000, 50), "abnormalSpeed");
});
test("late arrival with only a future shared baseline can become an unanchored queue candidate", () => {
    const rows = [row("a", 0, 139, "background", 20000), row("b", 5000, 139.02, "foreground", 10000)];
    const result = replay(rows, "server-created", "queue");
    assert.equal(result.acceptedCount, 2);
    assert.equal(result.trace[1].baselineRecordedAt, null);
    assert.equal(replay(rows, "measured", "queue").trace[1].baselineRecordedAt, 0);
});
test("slow walking and returning circuit are not automatically rejected by shape or low speed", () => {
    const rows = [row("a", 0, 139), row("b", 30000, 139.00001), row("c", 60000, 139.00002), row("d", 90000, 139)];
    assert.equal(replay(rows, "measured", "queue").acceptedCount, 4);
});
test("replay isolates owner and session rather than using another activity as a baseline", () => {
    assert.throws(() => replay([row("a", 0, 139), { ...row("b", 30000, 139), userId: "B" }], "measured", "queue"), /owner\/session/);
});
test("normal running and a legitimate loop remain eligible under the existing rules", () => {
    const rows = [row("a", 0, 139), row("b", 30000, 139.001), row("c", 60000, 139.002), row("d", 90000, 139.001), row("e", 120000, 139)];
    assert.equal(replay(rows, "measured", "queue").acceptedCount, 5);
});
test("missing speed information is not reinterpreted as a stationary observation", () => {
    const r = { latitude: 35, longitude: 139.00001, accuracy: null, recorded_at_ms: 30000 };
    assert.equal(queuePredicate(r, { latitude: 35, longitude: 139, recordedAt: 0 }, 30000, 50), null);
});
