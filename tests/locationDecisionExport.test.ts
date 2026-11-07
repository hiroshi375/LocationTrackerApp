import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectLatestSessionEvidence } from '../src/services/locationDecisionExportCore';
test('one recording spans runtimes and retains the beginning while excluding unrelated records', () => {
 const rows = [{ userId: 'a', sessionId: 'one', runtimeId: 'boot1', sequence: 1, observedAtMs: 1 },
 { userId: 'a', sessionId: 'one', runtimeId: 'boot2', sequence: 1, observedAtMs: 100 },
 { userId: 'b', sessionId: 'one', runtimeId: 'old', sequence: 1, observedAtMs: 90 },
 { userId: 'a', sessionId: 'other', runtimeId: 'old', sequence: 2, observedAtMs: 80 }];
 const selected = selectLatestSessionEvidence(rows);
 assert.equal(selected.length, 2); assert.deepEqual(selected.map(r => r.runtimeId), ['boot1','boot2']);
 assert.equal(rows.length, 4);
});
test('no valid observations does not select an arbitrary recording', () => {
 assert.deepEqual(selectLatestSessionEvidence([]), []);
 assert.deepEqual(selectLatestSessionEvidence([{ observedAtMs: 1 }]), []);
});
