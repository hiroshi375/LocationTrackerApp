const test=require('node:test');const assert=require('node:assert/strict');const ts=require('typescript');const fs=require('node:fs');
function load(result,failCache=false){
 const receipts=[],inputs=[];const exports={};
 const requireMock=(name)=>{
  if(name==='../lib/client')return{client:{mutations:{async ingestLocationLog(input){inputs.push(JSON.parse(input.input));return result;}}}};
  if(name==='./acceptedLocationBaselineService')return{acceptedLocationBaselines:{async record(...args){if(failCache)throw Error('disk');receipts.push(args);}}};
  throw Error(name);
 };
 const code=ts.transpileModule(fs.readFileSync('src/services/locationLogWriteService.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('exports','require',code)(exports,requireMock);return{...exports,receipts,inputs};
}
const point={id:'point',userId:'A',recordingSessionId:'s',latitude:35,longitude:139,recordedAt:'2026-10-23T00:00:00Z',sharedOwners:['stale'],owner:'injected'};
test('confirmed write publishes scoped baseline without changing API payload ACL rules',async()=>{
 const m=load({data:{id:'point',created:true}});const result=await m.createLocationLog(point);
 assert.equal(result.data.id,'point');assert.equal(m.receipts.length,1);assert.deepEqual(m.receipts[0].slice(0,2),['A','s']);assert.equal(m.inputs[0].sharedOwners,undefined);assert.equal(m.inputs[0].owner,undefined);
});
test('failed API response never publishes an accepted point; replay preserves duplicate response',async()=>{
 const failed=load({errors:[{message:'Unauthorized'}]});assert.equal((await failed.createLocationLog(point)).data,null);assert.equal(failed.receipts.length,0);
 const replay=load({data:{id:'point',created:false}});const result=await replay.createLocationLog(point);assert.equal(result.data,null);assert.match(result.errors[0].message,/already exists/);assert.equal(replay.receipts.length,1);
});
test('cache failure does not turn confirmed cloud storage into a save failure',async()=>{
 const m=load({data:{id:'point',created:true}},true);const result=await m.createLocationLog(point);assert.equal(result.data.id,'point');assert.equal(result.errors,undefined);
});
