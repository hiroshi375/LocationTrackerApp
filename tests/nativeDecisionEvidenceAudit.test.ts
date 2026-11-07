import assert from "node:assert/strict";
import { test } from "node:test";
import { auditNativeDecisionEvidence } from "../scripts/diagnostics/auditNativeDecisionEvidence";
test("native receipt age uses precise monotonic subtraction and distinguishes missing speed", () => {
    const data = { schema: 1, evicted: 0, persistenceFailures: 0, rows: [
        { path: "native-inbox", correlationKey: "private", nativeMatchesJSPoint: true, nativeEvidence: { schema: 1,
            fixElapsedRealtimeNanos: "1234567890123456789", receivedElapsedRealtimeNanos: "1234567890124456789",
            hasSpeed: false, hasSpeedAccuracy: false, provider: "fused", mocked: false } },
        { path: "sqlite-queue", stage: "decision", correlationKey: "private", baseline: null, baselineCandidates: [{ isFuture: true }] },
    ] };
    const result = auditNativeDecisionEvidence("===== LOCATION DECISION EVIDENCE =====\n" + JSON.stringify(data));
    assert.equal(result.maxNativeReceiptAgeMs, 1); assert.equal(result.nativeSpeedMissing, 1);
    assert.equal(result.correlationKeysAcrossPaths, 1); assert.equal(result.noBaselineWithFutureCandidate, 1);
    assert.equal(JSON.stringify(result).includes("private"), false);
});
test("old exports without new fields cannot be mistaken for a successful native observation", () => {
    assert.throws(() => auditNativeDecisionEvidence("===== CURRENT =====\nno native payload"), /missing/);
});

test("archive coverage reports missing prefixes and internal gaps per runtime without exposing identifiers", () => {
    const result = auditNativeDecisionEvidence("===== LOCATION DECISION EVIDENCE =====\n" + JSON.stringify({ schema: 1,
        rows: [{ runtimeId: "secret-runtime", sequence: 3 }, { runtimeId: "secret-runtime", sequence: 5 },
            { runtimeId: "other", sequence: 1 }], archive: { files: 2, unreadableFiles: 1, droppedRows: 3 } }));
    assert.equal(result.missingRowsThroughLastSeen, 3); assert.equal(result.runtimeCount, 2);
    assert.equal(result.archive?.unreadableFiles, 1); assert.equal(JSON.stringify(result).includes("secret-runtime"), false);
});
