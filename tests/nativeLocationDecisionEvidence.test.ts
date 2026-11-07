import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocationDecisionDiagnostics, sanitizeNativeLocationEvidence } from "../src/services/locationDecisionDiagnosticCore";
const native = { schema: 1, captureStage: "native-location-serialization", fixTimeMs: 10, latitude: 35, longitude: 139,
    fixElapsedRealtimeNanos: "1234567890123456789", capturedElapsedRealtimeNanos: "1234567890123456799",
    receivedElapsedRealtimeNanos: "1234567890123456790", receivedWallTimeMs: 11, capturedWallTimeMs: 12,
    bootCount: 1, hasSpeed: false, speedMetersPerSecond: 0, hasSpeedAccuracy: false, speedAccuracyMetersPerSecond: 0,
    hasAccuracy: true, accuracyMeters: 5, provider: "fused", mocked: false };
test("native nanoseconds preserve precision and missing speed never becomes a valid zero", () => {
    const e = sanitizeNativeLocationEvidence(JSON.stringify(native))!;
    assert.equal(e.fixElapsedRealtimeNanos, "1234567890123456789");
    assert.equal(e.hasSpeed, false); assert.equal(e.speedMetersPerSecond, null); assert.equal(e.speedAccuracyMetersPerSecond, null);
});
test("native schema is allowlisted and corrupt/oversized input is ignored", () => {
    assert.equal(sanitizeNativeLocationEvidence("invalid"), null);
    assert.equal(sanitizeNativeLocationEvidence("x".repeat(4097)), null);
    assert.equal(sanitizeNativeLocationEvidence({ ...native, schema: 2 }), null);
    assert.equal(JSON.stringify(sanitizeNativeLocationEvidence({ ...native, token: "secret" })).includes("secret"), false);
});
test("raw native and JS coordinates are compared without changing the original location", () => {
    const d = createLocationDecisionDiagnostics({ enabled: true, runtimeId: "test", now: () => 20 });
    const point = { latitude: 35, longitude: 139, recordedAtMs: 10, speed: 0 };
    d.capture(() => ({ path: "native-inbox", stage: "receipt", userId: "A", sessionId: "s", point, nativeEvidence: JSON.stringify(native) }));
    const e = JSON.parse(d.snapshot()).rows[0]; assert.equal(e.nativeMatchesJSPoint, true);
    assert.equal(e.point.speedValidity, "native-reported-missing"); assert.equal(point.speed, 0);
    d.capture(() => ({ path: "foreground", stage: "receipt", userId: "A", sessionId: "s", point: { ...point, longitude: 140 }, nativeEvidence: native }));
    assert.equal(JSON.parse(d.snapshot()).rows[1].nativeMatchesJSPoint, false);
});

 test("receipt snapshot survives allowlist and exposes Native mutation without trusting supplied equality", () => {
    const original = { ...native, receiptSnapshot: { ...native, receiptId: "process:1", password: "secret" }, receiptSource: "background-result", requestId: "req-1" };
    const matching = sanitizeNativeLocationEvidence(original)!;
    assert.equal(matching.receiptMatchesSerialized, true);
    assert.equal(matching.requestId, "req-1");
    assert.equal(JSON.stringify(matching).includes("secret"), false);
    const changed = sanitizeNativeLocationEvidence({ ...original, longitude: 140, receiptMatchesSerialized: true })!;
    assert.equal(changed.receiptMatchesSerialized, false);
    assert.equal((changed.receiptSnapshot as any).longitude, 139);
    assert.equal(sanitizeNativeLocationEvidence(native)!.receiptMatchesSerialized, null);
 });
