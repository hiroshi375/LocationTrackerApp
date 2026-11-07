const test=require('node:test');const assert=require('node:assert/strict');const ts=require('typescript');const fs=require('node:fs');
const lifecycleCore={};new Function('exports',ts.transpileModule(fs.readFileSync('src/services/recordingLifecycleCore.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(lifecycleCore);
function load(result,failCache=false,hold=false,lifecycle=null){
 const receipts=[],inputs=[],observations=[];const exports={};
 const requireMock=(name)=>{
  if(name==='./recordingLifecycleService')return{recordingLifecycle:{read:async()=>{if(lifecycle instanceof Error)throw lifecycle;return lifecycle;}}};
  if(name==='./recordingLifecycleCore')return lifecycleCore;
  if(name==='./locationQualityReviewService')return{hasPendingLocationQualityReview:async()=>hold};
  if(name==='../lib/client')return{client:{mutations:{async ingestLocationLog(input){inputs.push(JSON.parse(input.input));if(result instanceof Error)throw result;return result;}}}};
  if(name==='./acceptedLocationBaselineService')return{acceptedLocationBaselines:{async record(...args){if(failCache)throw Error('disk');receipts.push(args);}}};
  if(name==='./locationDecisionDiagnosticService')return{observeLocationDecision(build){observations.push(build());}};
  throw Error(name);
 };
 const code=ts.transpileModule(fs.readFileSync('src/services/locationLogWriteService.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('exports','require',code)(exports,requireMock);return{...exports,receipts,inputs,observations};
}
const point={id:'point',userId:'A',recordingSessionId:'s',latitude:35,longitude:139,recordedAt:'2026-10-23T00:00:00Z',sharedOwners:['stale'],owner:'injected'};
test('confirmed write publishes scoped baseline without changing API payload ACL rules',async()=>{
 const m=load({data:{id:'point',created:true}});const result=await m.createLocationLog(point);
 assert.equal(result.data.id,'point');assert.equal(m.receipts.length,1);assert.deepEqual(m.receipts[0].slice(0,2),['A','s']);assert.equal(m.inputs[0].sharedOwners,undefined);assert.equal(m.inputs[0].owner,undefined);
 assert.equal(m.observations[0].reason,'confirmed-created');assert.equal(m.observations[0].pointId,'point');
});
test('failed API response never publishes an accepted point; replay preserves duplicate response',async()=>{
 const failed=load({errors:[{message:'Unauthorized'}]});assert.equal((await failed.createLocationLog(point)).data,null);assert.equal(failed.receipts.length,0);
 const replay=load({data:{id:'point',created:false}});const result=await replay.createLocationLog(point);assert.equal(result.data,null);assert.match(result.errors[0].message,/already exists/);assert.equal(replay.receipts.length,1);
 assert.equal(failed.observations[0].reason,'explicit-error-or-missing-receipt');assert.equal(replay.observations[0].reason,'confirmed-existing');
});
test('cache failure does not turn confirmed cloud storage into a save failure',async()=>{
 const m=load({data:{id:'point',created:true}},true);const result=await m.createLocationLog(point);assert.equal(result.data.id,'point');assert.equal(result.errors,undefined);
});

test('transport exception preserves the original failure and records an unknown result without exception text',async()=>{
 const error=new Error('private transport details');const m=load(error);
 await assert.rejects(m.createLocationLog(point),e=>e===error);assert.equal(m.receipts.length,0);
 assert.equal(m.observations[0].reason,'transport-exception-result-unknown');
 assert.equal(JSON.stringify(m.observations).includes('private transport details'),false);
 assert.equal(typeof m.observations[0].timing.operationStartedAtMs,'number');
});

test('all save paths stop before the API when the same scoped measurement is held',async()=>{
 const m=load({data:{id:'point',created:true}},false,true);const result=await m.createLocationLog(point);
 assert.equal(result.data,null);assert.match(result.errors[0].message,/QUALITY_REVIEW_PENDING/);
 assert.equal(m.inputs.length,0);assert.equal(m.receipts.length,0);
});

test('saved session still replays a legitimate pre-stop pending point; post-stop point stays local',async()=>{
 const cutoff=Date.parse(point.recordedAt);const saved={state:'SAVED',stoppedAtMs:cutoff};
 const valid=load({data:{id:'point',created:true}},false,false,saved);assert.equal((await valid.createLocationLog(point)).data.id,'point');assert.equal(valid.inputs.length,1);
 const held=load({data:{id:'point',created:true}},false,false,saved);const after={...point,recordedAt:new Date(cutoff+1).toISOString()};
 assert.match((await held.createLocationLog(after)).errors[0].message,/SESSION_STOP_PENDING_REVIEW/);assert.equal(held.inputs.length,0);
 assert.equal(after.recordedAt,new Date(cutoff+1).toISOString());
});
test('unreadable lifecycle fails closed before API; caller retains original pending payload',async()=>{
 const original=structuredClone(point),m=load({data:{id:'point',created:true}},false,false,Error('disk'));
 await assert.rejects(m.createLocationLog(point),/disk/);assert.equal(m.inputs.length,0);assert.deepEqual(point,original);
});
