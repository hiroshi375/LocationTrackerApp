import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { selectLatestSessionEvidence } from '../src/services/locationDecisionExportCore';
import { createLocationDecisionArchive } from '../src/services/locationDecisionArchiveCore';
import { createLocationDecisionDiagnostics, LOCATION_DECISION_DIAGNOSTIC_KEY } from '../src/services/locationDecisionDiagnosticCore';
test('actual exporter joins first and last observations across runtimes and does not mix owners or sessions', async () => {
 const first = { userId: 'owner', sessionId: 'recording', runtimeId: 'boot1', sequence: 1, observedAtMs: 1000,
    point: { recordedAtMs: 1000 }, nativeEvidence: { schema: 1 } };
 const last = { ...first, runtimeId: 'boot2', observedAtMs: 145000, point: { recordedAtMs: 145000 } };
 const old = { ...first, sequence: 2, sessionId: 'other', observedAtMs: 500 };
 const names = ['location-decision-1000-abc-00000001.json', 'location-decision-2000-def-00000001.json'];
 const pages = new Map(names.map((name, i) => [name, JSON.stringify({ schema: 1, runtimeId: i ? 'boot2' : 'boot1',
   rows: i ? [last] : [first, old], droppedRows: 0, writeFailures: 0 })]));
 const storage = { getItem: async (key: string) => { assert.equal(key, LOCATION_DECISION_DIAGNOSTIC_KEY); return JSON.stringify({ schema: 1, runtimeId: 'boot2', rows: [last] }); } };
 const filesystem = { documentDirectory: 'test/', getInfoAsync: async () => ({ exists: true, size: 1000 }),
   readDirectoryAsync: async () => names,
   readAsStringAsync: async (file: string) => pages.get(file.split('/').at(-1)!)!, };
 const source = fs.readFileSync('src/services/locationDecisionDiagnosticService.ts', 'utf8')
    .replace('const ENABLE_LOCATION_DECISION_DIAGNOSTICS = false;', 'const ENABLE_LOCATION_DECISION_DIAGNOSTICS = true;');
 const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
 const exports: any = {};
 new Function('exports', 'require', code)(exports, (name: string) => {
    if (name === 'expo-file-system/legacy') return filesystem;
    if (name === '@react-native-async-storage/async-storage') return storage;
    if (name === './locationDecisionExportCore') return { selectLatestSessionEvidence };
    if (name === './locationDecisionArchiveCore') return { createLocationDecisionArchive };
    if (name === './locationDecisionDiagnosticCore') return { createLocationDecisionDiagnostics, LOCATION_DECISION_DIAGNOSTIC_KEY };
    throw Error(name);
 });
 const result = JSON.parse(await exports.readLocationDecisionDiagnostics());
 assert.equal(result.rows.length, 2); assert.deepEqual(result.rows.map((r: any) => r.runtimeId), ['boot1','boot2']);
 assert.equal(result.rows[1].point.recordedAtMs - result.rows[0].point.recordedAtMs, 144000);
 assert.equal(result.archive.unreadableFiles, 0); assert.equal(result.archive.droppedRows, 0);
 assert.match(result.archive.exportScope, /across-runtimes/);
});
