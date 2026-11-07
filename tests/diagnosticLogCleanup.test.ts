import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearLegacyDiagnosticLogs, LEGACY_DIAGNOSTIC_FILES, compactDecisionDiagnostic } from '../src/services/diagnosticLogCleanupCore';
test('cleanup only deletes the two allowlisted legacy diagnostic files', async () => {
    const deleted: string[] = [];
    await clearLegacyDiagnosticLogs({ applicationId: 'com.hiroshisato.locationtrackerapp.incident104', recording: false, sharing: false,
        deleteFile: async n => { deleted.push(n); } });
    assert.deepEqual(deleted, [...LEGACY_DIAGNOSTIC_FILES]);
});
test('normal app and active test sessions cannot clear logs', async () => {
    for (const state of [{ applicationId: 'com.hiroshisato.locationtrackerapp', recording: false, sharing: false },
        { applicationId: 'com.hiroshisato.locationtrackerapp.incident104', recording: true, sharing: false },
        { applicationId: 'com.hiroshisato.locationtrackerapp.incident104', recording: false, sharing: true }]) {
        let calls = 0;
        await assert.rejects(clearLegacyDiagnosticLogs({ ...state, deleteFile: async () => { calls++; } })); assert.equal(calls, 0);
    }
});
test('compact export retains every decision row and coverage counter; legacy exports keep their existing path', () => {
    const data = { schema: 1, rows: [{ sequence: 5, nativeEvidence: { schema: 1 } }], archive: { droppedRows: 7 } };
    const result = compactDecisionDiagnostic(JSON.stringify(data))!;
    assert.deepEqual(JSON.parse(result.split('===== LOCATION DECISION EVIDENCE =====\n')[1]), data);
    assert.equal(compactDecisionDiagnostic(null), null); assert.equal(compactDecisionDiagnostic('bad'), null);
    assert.equal(compactDecisionDiagnostic(JSON.stringify({ schema: 1, rows: [] })), null);
});
