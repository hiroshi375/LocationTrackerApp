import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocationDecisionArchive } from '../src/services/locationDecisionArchiveCore';
import { createLocationDecisionDiagnostics } from '../src/services/locationDecisionDiagnosticCore';
import { classifyStationaryRoute } from '../scripts/diagnostics/classifyStationaryRoute';

test('paged archive preserves observations evicted from the small in-memory ring', async () => {
    const files = new Map<number, string>();
    const a = createLocationDecisionArchive({ runtimeId: 'r', write: async (page, value) => { files.set(page, value); } });
    const d = createLocationDecisionDiagnostics({ enabled: true, runtimeId: 'r', now: () => 1, capacity: 2, onRow: a.append });
    for (let i = 0; i < 600; i++) {
        d.capture(() => ({ path: 'sqlite-queue', stage: 'decision', userId: 'u', sessionId: 's',
            point: { latitude: 35, longitude: 139, recordedAtMs: i } }));
        if (i % 10 === 0) await a.flush();
    }
    assert.equal(await a.flush(), true);
    const rows = [...files.values()].flatMap(v => JSON.parse(v).rows);
    assert.equal(rows.length, 600); assert.equal(new Set(rows.map(r => r.sequence)).size, 600);
    assert.equal(JSON.parse(d.snapshot()).rows.length, 2); assert.equal(a.stats().droppedRows, 0);
});
test('archive export flush waits for an in-flight write', async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const a = createLocationDecisionArchive({ runtimeId: 'r', write: async () => gate });
    a.append({ sequence: 1 }); let complete = false;
    const flush = a.flush().then(() => { complete = true; });
    await Promise.resolve(); assert.equal(complete, false); release(); await flush; assert.equal(complete, true);
});
test('archive failures and slow storage remain bounded and are explicitly reported', async () => {
    const a = createLocationDecisionArchive({ runtimeId: 'r', rowsPerPage: 1, maxBufferedPages: 2,
        write: async () => { throw new Error('disk'); } });
    for (let i = 0; i < 30; i++) a.append({ sequence: i });
    assert.equal(await a.flush(), false); assert.ok(a.stats().writeFailures > 0);
    assert.ok(a.stats().droppedRows > 0); assert.ok(a.stats().bufferedPages <= 2);
});
test('lookup diagnostic distinguishes no row from read failure without recording exception text', () => {
    const d = createLocationDecisionDiagnostics({ enabled: true, runtimeId: 'r', now: () => 5,
        onRow() { throw Error('archive failure'); } });
    d.capture(() => ({ path: 'sqlite-queue', stage: 'decision', userId: 'u', sessionId: 's',
        point: { latitude: 35, longitude: 139, recordedAtMs: 10 }, lookup: { status: 'read-error', atOrBeforeMs: 10,
            returnedCount: null, startedAtMs: 1, completedAtMs: 2 }, timing: { lockAcquiredAtMs: 1 } }));
    const row = JSON.parse(d.snapshot()).rows[0]; assert.equal(row.lookup.status, 'read-error');
    assert.equal(row.lookup.returnedCount, null); assert.equal(row.timing.lockAcquiredAtMs, 1);
});
test('route classifier is descriptive and distinguishes coordinate speed from missing native speed', () => {
    const rows = [0, 1, 2].map(i => ({ latitude: 35 + i * .00001, longitude: 139,
        recordedAt: new Date(i * 30000).toISOString(), accuracy: 5 }));
    const r = classifyStationaryRoute(rows); assert.equal(r.nativeSpeedAvailablePairs, 0);
    assert.ok(r.distanceMeters > 0); assert.equal(r.bins[0].count, 2);
    assert.equal(r.bins[0].impliedAtMost2mps, 2);
});

test('realistic native and baseline evidence rows survive the conservative size guard', async () => {
    const files = new Map<number, string>();
    const a = createLocationDecisionArchive({ runtimeId: 'r', write: async (n, s) => { files.set(n, s); } });
    for (let i = 0; i < 80; i++) {
        a.append({ sequence: i + 1, path: 'background-direct', evidence: 'x'.repeat(2400) });
        if (i % 10 === 0) await a.flush();
    }
    await a.flush(); assert.equal(a.stats().droppedRows, 0);
    assert.equal([...files.values()].flatMap(s => JSON.parse(s).rows).length, 80);
    for (const value of files.values()) assert.ok(Buffer.byteLength(value, 'utf8') < 512 * 1024);
    a.append({ sequence: 81, evidence: 'x'.repeat(5000) });
    assert.equal(a.stats().droppedRows, 1);
});
