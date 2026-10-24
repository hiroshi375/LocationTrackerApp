import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelayEvidenceWriter, createIOSDelayObserver, IOS_DELAY_DIAGNOSTIC_KEY, type DelayEvidence } from '../src/services/iosDelayDiagnosticCore';
const tick = () => new Promise<void>(r => setImmediate(r));
test('normal callbacks cause no persistent evidence; delayed delivery retains original timestamps', () => {
 const rows: DelayEvidence[]=[]; const o=createIOSDelayObserver(e=>rows.push(e));
 o.receipt('a',100_000,[99_000]);o.stage('a','TASK_FINALLY',100_100);assert.equal(rows.length,0);
 o.receipt('b',180_000,[110_000]);assert.equal(rows.length,1);
 assert.equal(rows[0].timings.deliveryAgeMs,70_000);assert.equal(rows[0].timings.callbackGapMs,80_000);
 o.stage('b','TASK_FINALLY',180_100);assert.equal(rows.length,1);
});
test('timeout evidence preserves phase duration, ignores arbitrary potentially sensitive details', () => {
 const rows: DelayEvidence[]=[];const o=createIOSDelayObserver(e=>rows.push(e));
 o.receipt('a',100_000,[99_000]);o.stage('a','LIVE_LOCATION_START',100_010);
 o.stage('a','LIVE_LOCATION_END',105_010,{timedOut:true,latitude:35,password:'secret'});
 assert.equal(rows[0].reason,'operation_timeout');assert.equal(rows[0].phases.LIVE_LOCATION,5000);
 assert.ok(!JSON.stringify(rows).includes('secret'));assert.ok(!JSON.stringify(rows).includes('latitude'));
 o.stage('a','TASK_FINALLY',105_100);assert.equal(rows.at(-1)?.reason,'slow_task');
});
test('interleaved tasks keep independent timings, completed tasks cannot be mutated', () => {
 const rows: DelayEvidence[]=[];const o=createIOSDelayObserver(e=>rows.push(e));
 o.receipt('a',1000,[]);o.receipt('b',2000,[]);o.stage('a','AUTH_START',2000);o.stage('b','AUTH_START',3000);
 o.stage('a','AUTH_END',8000);o.stage('a','TASK_FINALLY',8100);o.stage('b','AUTH_END',4000);o.stage('b','TASK_FINALLY',4100);
 assert.equal(rows.length,1);assert.equal(rows[0].phases.AUTH,6000);o.stage('a','TASK_ERROR',9000);assert.equal(rows.length,1);
});
test('bounded ring survives reload and storage failures without throwing',async()=>{
 let stored=JSON.stringify(Array.from({length:32},(_,i)=>({eventId:String(i)})));let fail=true;
 const writer=createDelayEvidenceWriter({getItem:async()=>stored,setItem:async(k,v)=>{assert.equal(k,IOS_DELAY_DIAGNOSTIC_KEY);if(fail){fail=false;throw Error('disk');}stored=v;}});
 const evidence=(id:string):DelayEvidence=>({eventId:id,atMs:1,reason:'test',timings:{},phases:{}});
 writer(evidence('failed'));writer(evidence('kept'));await tick();await tick();
 assert.equal(JSON.parse(stored).length,32);assert.equal(JSON.parse(stored).at(-1).eventId,'kept');
 // Simulate module reload: a new writer preserves earlier anomalies.
 createDelayEvidenceWriter({getItem:async()=>stored,setItem:async(_,v)=>{stored=v;}})(evidence('reloaded'));await tick();await tick();
 assert.equal(JSON.parse(stored).length,32);assert.equal(JSON.parse(stored).at(-1).eventId,'reloaded');
});
test('diagnostic emit failures never escape into recording callback',()=>{
 const o=createIOSDelayObserver(()=>{throw Error('diagnostic');});assert.doesNotThrow(()=>{o.receipt('x',100000,[1]);o.stage('x','TASK_ERROR',100001);o.stage('x','TASK_FINALLY',110000);});
});
