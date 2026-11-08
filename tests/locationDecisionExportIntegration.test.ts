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
 const storage = { getItem: async (key: string) => { if (key !== LOCATION_DECISION_DIAGNOSTIC_KEY) return null; return JSON.stringify({ schema: 1, runtimeId: 'boot2', rows: [last] }); } };
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


function protectionFixture(shared?: { files: Map<string,string>; storage: Map<string,string> }, enabled = true) {
 const state = shared ?? { files: new Map<string,string>(), storage: new Map<string,string>() };
 const deleted: string[] = []; let failWrite = false, oversized = false;
 const directory = 'test/location-decision-evidence-v1/';
 const filesystem = { documentDirectory: 'test/',
  makeDirectoryAsync: async () => {},
  getInfoAsync: async (path: string) => ({ exists: path.endsWith('/') || state.files.has(path), size: oversized && path.includes('/protected-v1/') ? 64*1024*1024 : (state.files.get(path)?.length ?? 0) }),
  readDirectoryAsync: async (path: string) => [...state.files.keys()].filter(k => k.startsWith(path) && !k.slice(path.length).includes('/')).map(k => k.slice(path.length)),
  readAsStringAsync: async (path: string) => { if (!state.files.has(path)) throw Error('missing'); return state.files.get(path)!; },
  writeAsStringAsync: async (path: string, value: string) => { if (failWrite && path.includes('/protected-v1/')) throw Error('disk failure'); state.files.set(path,value); },
  deleteAsync: async (path: string) => { deleted.push(path); state.files.delete(path); },
 };
 const source = fs.readFileSync('src/services/locationDecisionDiagnosticService.ts','utf8').replace('const ENABLE_LOCATION_DECISION_DIAGNOSTICS = false;',`const ENABLE_LOCATION_DECISION_DIAGNOSTICS = ${enabled};`);
 const code = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const exports: any = {};
 new Function('exports','require',code)(exports,(name:string) => {
  if(name==='expo-file-system/legacy') return filesystem;
  if(name==='@react-native-async-storage/async-storage') return {getItem:async(k:string)=>state.storage.get(k)??null,setItem:async(k:string,v:string)=>{state.storage.set(k,v);}};
  if(name==='./locationDecisionExportCore') return {selectLatestSessionEvidence};
  if(name==='./locationDecisionArchiveCore') return {createLocationDecisionArchive};
  if(name==='./locationDecisionDiagnosticCore') return {LOCATION_DECISION_DIAGNOSTIC_KEY,createLocationDecisionDiagnostics:(o:any)=>({capture:(row:any)=>{if(o.enabled)o.onRow(row);}})};
  throw Error(name);
 });
 return {state,deleted,directory,exports,fail:(v:boolean)=>{failWrite=v;},oversize:()=>{oversized=true;},
  append:(session:string,seq:number,time:number)=>exports.observeLocationDecision({userId:'owner',sessionId:session,runtimeId:'receipt-'+time,sequence:seq,observedAtMs:time})};
}
test('protected evidence survives rolling cleanup, restart and repeated export without release',async()=>{
 const f=protectionFixture();
 for(let i=0;i<512;i++)f.state.files.set(f.directory+`location-decision-1-old-${String(i).padStart(8,'0')}.json`,JSON.stringify({schema:1,runtimeId:'old',rows:[]}));
 f.append('target',1,100);let result=JSON.parse(await f.exports.readLocationDecisionDiagnostics());
 assert.equal(result.archive.protection.targets.length,1);assert.equal(result.archive.protection.files,1);
 assert.ok(f.deleted.length>0);assert.ok(f.deleted.every(p=>!p.includes('/protected-v1/')));
 // Simulate the entire legacy rolling set being replaced after the first boot.
 for(const key of [...f.state.files.keys()])if(!key.includes('/protected-v1/'))f.state.files.delete(key);
 const restarted=protectionFixture(f.state);restarted.append('target',2,200);
 result=JSON.parse(await restarted.exports.readLocationDecisionDiagnostics());
 assert.deepEqual(result.rows.map((r:any)=>r.observedAtMs),[100,200]);assert.equal(result.archive.protection.pendingWrite,null);
 const count=f.state.files.size;await restarted.exports.readLocationDecisionDiagnostics();assert.equal(f.state.files.size,count);
 assert.equal(result.archive.protection.targets.length,1);
});
test('protected write interruption remains durable and export never claims success',async()=>{
 const f=protectionFixture();f.fail(true);f.append('target',1,100);
 let result=JSON.parse(await f.exports.readLocationDecisionDiagnostics());
 assert.equal(result.archive.archiveFlushed,false);assert.ok(result.archive.protection.pendingWrite);assert.ok(result.archive.writeFailures>0);
 const restarted=protectionFixture(f.state);result=JSON.parse(await restarted.exports.readLocationDecisionDiagnostics());
 assert.ok(result.archive.protection.pendingWrite);assert.equal(result.archive.protection.files,0);
 assert.equal(f.deleted.length,0);
});
test('protected capacity overflow reports durable failure and never deletes earlier evidence',async()=>{
 const f=protectionFixture();
 f.state.files.set(f.directory+'protected-v1/location-decision-1-old-00000001.json',JSON.stringify({schema:1,runtimeId:'old',rows:[]}));
 f.oversize();f.append('target',1,100);
 const result=JSON.parse(await f.exports.readLocationDecisionDiagnostics());
 assert.ok(result.archive.protection.capacityFailures>0);assert.equal(result.archive.archiveFlushed,false);
 assert.equal(f.deleted.length,0);assert.ok([...f.state.files.keys()].some(k=>k.includes('/protected-v1/')));
});

test('normal configuration performs no protection or storage writes',async()=>{
 const f=protectionFixture(undefined,false);f.append('target',1,100);
 assert.equal(await f.exports.readLocationDecisionDiagnostics(),null);
 assert.equal(f.state.files.size,0);assert.equal(f.state.storage.size,0);assert.equal(f.deleted.length,0);
});
test('fifth target is refused explicitly without releasing prior protected targets',async()=>{
 const f=protectionFixture();for(let i=0;i<4;i++){f.append('target'+i,i+1,100+i);await f.exports.readLocationDecisionDiagnostics();}
 f.append('fifth',5,105);const result=JSON.parse(await f.exports.readLocationDecisionDiagnostics());
 assert.equal(result.archive.protection.targets.length,4);assert.equal(result.archive.protection.status,'incomplete');
 assert.ok(result.archive.protection.capacityFailures>0);assert.equal(f.deleted.length,0);
});

test('restart after interrupted write continues collecting but keeps durable incompleteness',async()=>{
 const f=protectionFixture();f.fail(true);f.append('target',1,100);await f.exports.readLocationDecisionDiagnostics();
 const restarted=protectionFixture(f.state);restarted.append('target',2,200);
 const result=JSON.parse(await restarted.exports.readLocationDecisionDiagnostics());
 assert.equal(result.archive.protection.status,'incomplete');assert.ok(result.archive.protection.interruptedWrites>0);
 assert.equal(result.archive.protection.pendingWrite,null);assert.ok(result.rows.some((r:any)=>r.observedAtMs===200));
});

test('protected file-count cap rejects new pages without deleting retained pages',async()=>{
 const f=protectionFixture();
 for(let i=0;i<2048;i++)f.state.files.set(f.directory+`protected-v1/location-decision-1-old-${String(i).padStart(8,'0')}.json`,JSON.stringify({schema:1,runtimeId:'old',rows:[]}));
 f.append('target',1,100);const result=JSON.parse(await f.exports.readLocationDecisionDiagnostics());
 assert.equal(result.archive.protection.files,2048);assert.equal(result.archive.protection.status,'incomplete');
 assert.ok(result.archive.protection.capacityFailures>0);assert.equal(f.deleted.length,0);
});
