import {test} from 'node:test';import assert from 'node:assert/strict';
import {makeProbeRun,inProbeWindow,probeOptions} from '../diagnostics/location-probe/probeCore';
test('minimal probe uses the same native sampling request without a recording acceptance rule',()=>{const r=makeProbeRun('foreground',1000);assert.equal(r.deadlineMs-r.startedAtMs,300000);assert.deepEqual(probeOptions(),{timeInterval:5000,distanceInterval:0,deferredUpdatesInterval:0,deferredUpdatesDistance:0,pausesUpdatesAutomatically:false});});
test('cached pre-start fixes and fixes after stop/deadline are outside the comparison',()=>{const r=makeProbeRun('background',1000);assert.equal(inProbeWindow(r,999),false);assert.equal(inProbeWindow(r,1000),true);assert.equal(inProbeWindow(r,r.deadlineMs+1),false);assert.equal(inProbeWindow({...r,stoppedAtMs:2000},2001),false);});

test('input analysis deduplicates deliveries and reports jumps without exposing coordinates',async()=>{
 const {analyzeLocationProbe}=await import('../scripts/diagnostics/analyzeLocationProbe');
 const a={timestamp:1000,coords:{latitude:35,longitude:139}},b={timestamp:6000,coords:{latitude:35.007,longitude:139}};
 const r=analyzeLocationProbe({schema:1,run:{mode:'foreground'},rows:[a,a,b],errors:[]});
 assert.equal(r.uniqueFixes,2);assert.ok(r.maxAdjacentJumpMeters>700);assert.equal(r.taskErrors,0);
 assert.equal(JSON.stringify(r).includes('latitude'),false);
});

test('long background run covers 110 minutes without changing the native request',()=>{
 const long=makeProbeRun('background',1000,110);assert.equal(long.deadlineMs-long.startedAtMs,6600000);
 assert.equal(inProbeWindow(long,long.deadlineMs),true);assert.equal(inProbeWindow(long,long.deadlineMs+1),false);
});
test('native operation deadline rejects a hung operation and returns completed results',async()=>{
 const {withProbeDeadline}=await import('../diagnostics/location-probe/probeCore');
 await assert.rejects(withProbeDeadline(new Promise(()=>{}),'stop',5),/PROBE_OPERATION_TIMEOUT:stop/);
 assert.equal(await withProbeDeadline(Promise.resolve('ok'),'start',100),'ok');
});
