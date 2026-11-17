import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecordingMapRoute, changedRecordingMapDistance, recordingMapEvidence } from "../src/services/recordingMapRoute";

const fix = (seconds: number, meters: number, speed: number | null = 0.05) =>
    Object.freeze({ recordedAtMs: seconds * 1000, latitude: meters / 111195, longitude: 0, accuracy: 3, speed });
const log = (point: ReturnType<typeof fix>, id: string) =>
    Object.freeze({ ...point, recordedAt: new Date(point.recordedAtMs).toISOString(), id });

test("map line and distance wait together for follow-up fixes", () => {
    const points = Array.from({ length: 15 }, (_, i) => fix(i * 5, i * 3, 0.6));
    const logs = [log(points[0], "start"), log(points[1], "moving")];
    const early = buildRecordingMapRoute(logs, recordingMapEvidence(0, points.slice(0, 4))!, logs);
    assert.deepEqual(early, { logs: [], distanceMeters: 0 });
    const later = buildRecordingMapRoute(logs, recordingMapEvidence(0, points)!, logs);
    assert.deepEqual(later?.logs, logs);
    assert.ok(Math.abs(later!.distanceMeters - 3) < 0.01);
});

test("saved route holds a terminal shift without modifying the original and reports both displayed amounts", () => {
    const points = Object.freeze([fix(0, 0), fix(5, 0), fix(10, 0), fix(15, 0), fix(20, 0), fix(25, 9)]);
    const logs = Object.freeze([log(points[0], "start"), log(points[5], "shift")]);
    const copy = JSON.stringify(logs);
    const result = buildRecordingMapRoute(logs, recordingMapEvidence(0, points, 26_000)!, logs);
    assert.deepEqual(result, { logs: [logs[0]], distanceMeters: 0 });
    assert.deepEqual(changedRecordingMapDistance(9, result!.distanceMeters), { before: 9, after: 0 });
    assert.equal(changedRecordingMapDistance(0, result!.distanceMeters), null);
    assert.equal(JSON.stringify(logs), copy);
});

test("old and incomplete recordings fall back, and unmatched points keep the original map eligibility", () => {
    const points = Array.from({ length: 15 }, (_, i) => fix(i * 5, i * 3, 0.6));
    const unmatched = log(fix(6, 1000), "unmatched");
    const matching = log(points[0], "matching");
    assert.equal(recordingMapEvidence(0, [], 71_000), null);
    assert.equal(recordingMapEvidence(0, [points[0], ...points.slice(5)], 71_000), null);
    const evidence = recordingMapEvidence(0, points, 71_000)!;
    assert.equal(buildRecordingMapRoute([unmatched], evidence, []), null);
    assert.deepEqual(buildRecordingMapRoute([matching, unmatched], evidence, [matching])?.logs, [matching]);
    assert.deepEqual(buildRecordingMapRoute([matching, unmatched], evidence, [matching, unmatched])?.logs, [matching, unmatched]);
});
