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

import fs from 'node:fs';
import ts from 'typescript';
import { Sha256 } from '@aws-crypto/sha256-js';
async function diagnosticSnapshotFixture(options: { directory?: string; normal?: boolean; missing?: boolean; fail?: boolean; oversized?: boolean; legacy?: boolean; changed?: boolean } = {}) {
    const calls: string[] = []; let written = '';
    const db = {
        execAsync: async (sql: string) => { calls.push(sql); }, closeAsync: async () => { calls.push('close'); },
        getAllAsync: async (sql: string) => {
            calls.push(sql); if (options.fail) throw Error('private-error');
            if (sql.includes('AS owner')) return [{ owner: 'owner', recording_session_id: 'session', queue_status: 'pending', count: 1 }];
            if (sql.includes('GROUP BY queue_status')) return [{ queue_status: 'pending', count: 1 }];
            if (sql.includes('IN (?, ?)')) return [];
            const row = { location_log_id: 'point', queue_status: 'pending', latitude: options.changed ? 2 : 1 };
            return options.oversized ? Array(10001).fill(row) : [row];
        },
    };
    const source = fs.readFileSync('src/services/headlessDiagnosticExportService.ts', 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const exported: any = {};
    new Function('exports', 'require', code)(exported, (name: string) => {
        if (name === 'expo-application') return { applicationId: 'com.hiroshisato.locationtrackerapp' + (options.normal ? '' : '.incident104') };
        if (name === 'expo-sqlite') return { defaultDatabaseDirectory: options.directory ?? '/data/user/0/test/files/SQLite', openDatabaseAsync: async () => { calls.push('open'); return db; } };
        if (name === '@aws-crypto/sha256-js') return { Sha256 };
        if (name === './diagnosticLogCleanupCore') return { clearLegacyDiagnosticLogs, compactDecisionDiagnostic };
        if (name === './iosDelayDiagnosticCore') return { IOS_DELAY_DIAGNOSTIC_KEY: 'delay' };
        if (name === './locationDecisionDiagnosticService') return { readLocationDecisionDiagnostics: async () => options.legacy ? '{}' : JSON.stringify({ schema: 1, rows: [{ nativeEvidence: { schema: 1 } }] }) };
        if (name === '@react-native-async-storage/async-storage') return { getItem: async () => null, getAllKeys: async () => [] };
        if (name === 'expo-file-system/legacy') return { documentDirectory: 'test/', cacheDirectory: 'cache/',
            getInfoAsync: async (path: string) => { if (path.endsWith('.db')) { assert.equal(path, (options.directory?.startsWith('file://') ? options.directory : 'file://' + (options.directory ?? '/data/user/0/test/files/SQLite')).replace(/\/$/, '') + '/location-tracker.db'); } return { exists: path.startsWith('file://') && path.endsWith('.db') && !options.missing }; },
            writeAsStringAsync: async (_: string, text: string) => { written = text; } };
        if (name === 'expo-sharing') return { isAvailableAsync: async () => true, shareAsync: async () => {} };
        throw Error(name);
    });
    await exported.exportHeadlessDiagnosticLog();
    const data = written.split('===== TEST SQLITE READ-ONLY SNAPSHOT =====\n')[1];
    return { calls, written, snapshot: data ? JSON.parse(data) : undefined };
}
test('both export paths include consistent bounded queue evidence without DML or owner/coordinate disclosure', async () => {
    for (const legacy of [false, true]) {
        const result = await diagnosticSnapshotFixture({ legacy });
        assert.equal(result.snapshot.status, 'ok'); assert.equal(result.snapshot.pendingComplete, true);
        assert.equal(result.snapshot.historicalPendingComparisonAvailable, false);
        assert.match(result.snapshot.pendingHash, /^[a-f0-9]{64}$/);
        assert.equal(result.snapshot.sessions[0].owner, undefined);
        assert.equal(JSON.stringify(result.snapshot).includes('latitude'), false);
        assert.equal(result.calls.at(-1), 'close');
        for (const sql of result.calls.filter(x => x !== 'open' && x !== 'close')) assert.match(sql, /^(SELECT|PRAGMA query_only=ON|COMMIT|ROLLBACK)/);
    }
    const first = await diagnosticSnapshotFixture(), same = await diagnosticSnapshotFixture(), changed = await diagnosticSnapshotFixture({ changed: true });
    assert.equal(first.snapshot.pendingHash, same.snapshot.pendingHash);
    assert.notEqual(first.snapshot.pendingHash, changed.snapshot.pendingHash);
});
test('normal app never opens DB; missing DB is not created; partial/error snapshots never claim full hashes', async () => {
    const normal = await diagnosticSnapshotFixture({ normal: true }); assert.deepEqual(normal.calls, []); assert.equal(normal.snapshot, undefined);
    const missing = await diagnosticSnapshotFixture({ missing: true }); assert.deepEqual(missing.calls, []); assert.equal(missing.snapshot.status, 'database-missing');
    const cap = await diagnosticSnapshotFixture({ oversized: true }); assert.equal(cap.snapshot.pendingComplete, false); assert.equal(cap.snapshot.pendingHash, null);
    const failure = await diagnosticSnapshotFixture({ fail: true }); assert.equal(failure.snapshot.status, 'read-error'); assert.equal(failure.written.includes('private-error'), false);
    assert.deepEqual(failure.calls.slice(-2), ['ROLLBACK', 'close']);
});

test('SQLite existence check accepts Android absolute paths and preserves iOS file URIs with trailing slash', async () => {
 for (const directory of ['/data/user/0/test/files/SQLite', '/data/user/0/test/files/SQLite/', 'file:///var/mobile/Containers/Data/SQLite', 'file:///var/mobile/Containers/Data/SQLite/']) {
 const result = await diagnosticSnapshotFixture({ directory }); assert.equal(result.snapshot.status, 'ok'); assert.equal(result.snapshot.pendingComplete, true);
 }
});
