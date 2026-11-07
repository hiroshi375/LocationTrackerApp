const test=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript'),fs=require('node:fs');
function fixture(){
 const data=new Map(),key=(t,k)=>t+':'+JSON.stringify(k),writes=[];
 const table={sessions:()=> 'sessions',operations:()=> 'ops',logs:()=> 'logs',grants:()=> 'grants'};
 const pk=(t,r)=>t==='ops'?{recordingSessionRecordId:r.recordingSessionRecordId}:t==='index'?{sessionKey:r.sessionKey,logId:r.logId}:{id:r.id};
 const put=(t,r)=>data.set(key(t,pk(t,r)),structuredClone(r)),get=(t,k)=>data.get(key(t,k));
 const send=async command=>{
 const a=command.input;
 if(command.constructor.name==='QueryCommand')return{Items:[...data.entries()].filter(([k,v])=>k.startsWith('index:')&&v.sessionKey===a.ExpressionAttributeValues[':key']).map(([,v])=>structuredClone(v)).slice(0,a.Limit)};
 if(command.constructor.name==='DeleteCommand'){const old=get(a.TableName,a.Key);data.delete(key(a.TableName,a.Key));return{Attributes:old};}
 if(command.constructor.name!=='TransactWriteCommand')throw Error(command.constructor.name);
 const old=new Map(data);const reasons=a.TransactItems.map(w=>{
  const q=w.Put??w.Update??w.Delete??w.ConditionCheck;const row=get(q.TableName,q.Key??pk(q.TableName,q.Item));const e=q.ConditionExpression??'',v=q.ExpressionAttributeValues??{};let ok=true;
  if(e.includes('attribute_not_exists(sessionLifecycleState)'))ok=!row?.sessionLifecycleState||row.sessionLifecycleState===(v[':saved']??v[':discarding']);
  else if(e==='sessionLifecycleState = :discarding')ok=row?.sessionLifecycleState===v[':discarding'];
  else if(e.includes('attribute_not_exists(discardOperation)'))ok=!row?.discardOperation;
  else if(e==='attribute_not_exists(id)'||e==='attribute_not_exists(recordingSessionRecordId)')ok=!row;
  else if(e.includes('operationId = :id'))ok=row?.operationId===v[':id']&&row?.status===(v[':discarding']??v[':completed']);
  else if(e.includes('#owner = :owner'))ok=row?.owner===v[':owner']&&row?.userId===v[':userId']&&(!v[':session']||row?.recordingSessionId===v[':session']);
  return{Code:ok?'None':'ConditionalCheckFailed'};
 });
 if(reasons.some(r=>r.Code!=='None')){const e=Error('race');e.name='TransactionCanceledException';e.CancellationReasons=reasons;throw e;}
 for(const w of a.TransactItems){
  if(w.Put)put(w.Put.TableName,w.Put.Item);
  if(w.Delete)data.delete(key(w.Delete.TableName,w.Delete.Key));
  if(w.Update){const q=w.Update,r=get(q.TableName,q.Key),v=q.ExpressionAttributeValues;put(q.TableName,{...r,...(q.UpdateExpression.includes('sessionLifecycleState')?{sessionLifecycleState:v[':done']}:{status:v[':done'],updatedAt:v[':now']})});}
 }writes.push(a.TransactItems);return{};
 };
 const mocks={ './groupAccessStore':{tables:table,accessDb:{send},getRow:async(t,k)=>structuredClone(get(t,k)),scanRows:async(t,p)=>[...data.entries()].filter(([k])=>k.startsWith(t+':')).map(([,v])=>structuredClone(v)).filter(p)},
 './recordOwnership':{assertRecordOwner:(r,u)=>{if(r.userId!==u)throw Error('owner')}},'./sessionLogIndex':{indexTable:()=> 'index',sessionIndexReady:async()=>true,sessionLogKey:(u,s)=>JSON.stringify([u,s])},
 './accountDeletionGuard':{assertAccountNotDeleting:async()=>{}},'./locationLogIngest':{ingestLocationLog:async()=>{throw Error('not used')}}};
 const cache={};function load(name){if(mocks[name])return mocks[name];if(name.startsWith('node:')||name.startsWith('@aws-sdk/'))return require(name);if(cache[name])return cache[name];
 const source=fs.readFileSync('amplify/functions/share-group-api/'+name.replace('./','')+'.ts','utf8'),out={};cache[name]=out;
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;new Function('exports','require',code)(out,load);return out;}
 return{...load('./discardRecordingSession'),...load('./legacyRecordingWrite'),...load('./sessionLifecycleFence'),data,put,get,writes};
}
const record={id:'recording-session:A:s',userId:'A',recordingSessionId:'s',owner:'A',recordingSessionName:'saved'};
test('saved legacy summary is protected before any log deletion or discard admission',async()=>{
 const f=fixture();f.put('sessions',record);f.put('logs',{id:'p',userId:'A',recordingSessionId:'s',owner:'A'});
 await assert.rejects(f.discardRecordingSessionBatch('A','s'),/SAVED_SESSION_PROTECTED/);assert.equal(f.writes.length,0);assert.ok(f.get('logs',{id:'p'}));
});
test('normal unsaved discard deletes only scoped logs and resumes idempotently',async()=>{
 const f=fixture();f.put('logs',{id:'p',userId:'A',recordingSessionId:'s',owner:'A'});f.put('logs',{id:'other',userId:'B',recordingSessionId:'s',owner:'B'});
 f.put('index',{sessionKey:JSON.stringify(['A','s']),logId:'p'});
 assert.equal(await f.discardRecordingSessionBatch('A','s'),false);assert.equal(await f.discardRecordingSessionBatch('A','s'),true);assert.equal(await f.discardRecordingSessionBatch('A','s'),true);
 assert.equal(f.get('logs',{id:'p'}),undefined);assert.ok(f.get('logs',{id:'other'}));
});
test('legacy create versus discard race never produces a saved record with discarded logs',async()=>{
 const f=fixture();const outcomes=await Promise.allSettled([f.createLegacyRecordingSession('A','A',record),f.discardRecordingSessionBatch('A','s')]);
 const saved=!!f.get('sessions',{id:record.id});const discarded=f.get('ops',{recordingSessionRecordId:record.id})?.discardOperation===true;
 assert.notEqual(saved,discarded);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
});
test('discard begun first prevents old-client summary creation; explicit history delete stays available',async()=>{
 const f=fixture();await f.discardRecordingSessionBatch('A','s');await assert.rejects(f.createLegacyRecordingSession('A','A',record));
 const g=fixture();g.put('sessions',record);assert.equal((await g.deleteLegacyRecordingSession('A',{id:record.id}))?.id,record.id);
});
test('legacy in-progress unsaved discard without the new lifecycle key can safely resume',async()=>{
 const f=fixture();f.put('ops',{recordingSessionRecordId:record.id,ownerUserId:'A',recordingSessionId:'s',operationId:'old',status:'DISCARDING',discardOperation:true});
 assert.equal(await f.discardRecordingSessionBatch('A','s'),true);
 assert.equal(f.get('ops',{recordingSessionRecordId:record.id}).status,'DISCARDED');
});
test('legacy partial discard cannot continue deleting a session whose saved summary still exists',async()=>{
 const f=fixture();f.put('sessions',record);f.put('ops',{recordingSessionRecordId:record.id,ownerUserId:'A',recordingSessionId:'s',operationId:'old',status:'DISCARDING',discardOperation:true});
 await assert.rejects(f.discardRecordingSessionBatch('A','s'),/SAVED_SESSION_PROTECTED/);assert.equal(f.writes.length,0);
});
