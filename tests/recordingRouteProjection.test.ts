import assert from "node:assert/strict";
import { test } from "node:test";
import { projectRecordingRoute, type RecordingRoutePoint } from "../src/services/recordingRouteProjection";

function point(seconds: number, meters: number, speed: number | null): RecordingRoutePoint {
    return Object.freeze({ recordedAtMs: seconds * 1000, latitude: meters / 111195, longitude: 0, accuracy: 3, speed });
}

test("live route waits for follow-up fixes and subsequently includes the moving point", () => {
    const receipts = Array.from({ length: 15 }, (_, i) => point(i * 5, i * 3, 0.6));
    const recorded = [receipts[1]];
    assert.equal(projectRecordingRoute(recorded, receipts, { startedAtMs: 0, observedThroughMs: 15_000 }).decisions[0].decision,
        "waiting-for-following-fixes");
    assert.equal(projectRecordingRoute(recorded, receipts, { startedAtMs: 0, observedThroughMs: 70_000 }).decisions[0].decision, "kept");
});

test("stop excludes a terminal shift from the route while retaining input points", () => {
    const receipts = Object.freeze([point(0, 0, 0.05), point(5, 0, 0.05), point(10, 0, 0.05), point(15, 0, 0.05),
        point(20, 0, 0.05), point(25, 9, 0.05)]);
    const recorded = Object.freeze([receipts[0], receipts[5]]);
    const result = projectRecordingRoute(recorded, receipts, { startedAtMs: 0, observedThroughMs: 30_000, stoppedAtMs: 26_000 });
    assert.deepEqual(result.route, [recorded[0]]);
    assert.equal(result.decisions.at(-1)?.decision, "held-at-stop");
    assert.equal(recorded.length, 2);
    assert.equal(receipts.length, 6);
});

test("stopping while moving retains the last point and excludes post-stop fixes", () => {
    const receipts = [point(0, 0, 0.4), point(5, 2, 0.4), point(10, 4, 0.4), point(15, 6, 0.4),
        point(20, 8, 0.4), point(25, 50, 0)];
    const result = projectRecordingRoute(receipts, receipts, { startedAtMs: 0, observedThroughMs: 30_000, stoppedAtMs: 22_000 });
    assert.equal(result.route.at(-1), receipts[4]);
    assert.ok(result.route.every(p => p.recordedAtMs <= 22_000));
});
