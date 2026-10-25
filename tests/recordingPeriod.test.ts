import assert from "node:assert/strict";
import test from "node:test";
import { getRecordingPeriod } from "../src/lib/recordingPeriod";
import { calculateRouteDistanceMeters, normalizeRouteLogs } from "../src/lib/locationRoute";

const logs = (...times: string[]) => times.map(recordedAt => ({ recordedAt, latitude: 35, longitude: 139 }));

test("stationary timestamps survive coordinate simplification without changing distance", () => {
    const input = logs("2026-10-25T11:47:20.053Z", "2026-10-25T11:48:24.896Z");
    assert.equal(normalizeRouteLogs(input).length, 1);
    assert.equal(calculateRouteDistanceMeters(input), 0);
    assert.deepEqual(getRecordingPeriod(input), { startAt: input[0].recordedAt, endAt: input[1].recordedAt });
});

test("unordered, duplicate and invalid timestamps do not mutate the source", () => {
    const input = logs("invalid", "2026-10-25T11:48:24.896Z", "", "2026-10-25T11:47:20.053Z", "2026-10-25T11:47:20.053Z");
    const before = structuredClone(input);
    assert.deepEqual(getRecordingPeriod(input), { startAt: input[3].recordedAt, endAt: input[1].recordedAt });
    assert.deepEqual(input, before);
});

test("empty, invalid-only and single-point recordings", () => {
    assert.deepEqual(getRecordingPeriod([]), { startAt: null, endAt: null });
    assert.deepEqual(getRecordingPeriod(logs("invalid", "")), { startAt: null, endAt: null });
    const input = logs("2026-10-25T11:47:20.053Z");
    assert.deepEqual(getRecordingPeriod(input), { startAt: input[0].recordedAt, endAt: input[0].recordedAt });
});

for (const [name, start, end] of [
    ["day", "2026-10-25T23:59:50+09:00", "2026-10-26T00:01:00+09:00"],
    ["week", "2026-10-25T23:59:50+09:00", "2026-10-26T00:01:00+09:00"],
    ["month", "2026-10-31T23:59:50+09:00", "2026-11-01T00:01:00+09:00"],
    ["year", "2026-12-31T23:59:50+09:00", "2027-01-01T00:01:00+09:00"],
]) {
    test(`${name} boundary retains the final stationary timestamp`, () => {
        assert.deepEqual(getRecordingPeriod(logs(end, start)), { startAt: start, endAt: end });
    });
}

test("equivalent offsets are compared as instants", () => {
    const input = logs("2026-10-25T20:00:00+09:00", "2026-10-25T11:01:00Z");
    assert.deepEqual(getRecordingPeriod(input), { startAt: input[0].recordedAt, endAt: input[1].recordedAt });
});

test("walking and a closed loop keep the final stop timestamp", () => {
    const input = [
        { latitude: 35, longitude: 139, recordedAt: "2026-10-25T11:00:00Z" },
        { latitude: 35.0001, longitude: 139, recordedAt: "2026-10-25T11:01:00Z" },
        { latitude: 35.0001, longitude: 139.0001, recordedAt: "2026-10-25T11:02:00Z" },
        { latitude: 35, longitude: 139, recordedAt: "2026-10-25T11:03:00Z" },
        { latitude: 35, longitude: 139, recordedAt: "2026-10-25T11:04:00Z" },
    ];
    const before = structuredClone(input);
    const distance = calculateRouteDistanceMeters(input);
    assert.ok(distance > 30);
    assert.deepEqual(getRecordingPeriod(input), { startAt: input[0].recordedAt, endAt: input[4].recordedAt });
    assert.deepEqual(input, before);
    assert.equal(calculateRouteDistanceMeters(input), distance);
});
