const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function harness({apiError=false,queueError=false,emptyCount=0}={}){
 const calls=[],store=new Map(),exports={};let first=true;
 const profile={id:'profile-B',userId:'B',iconImagePath:'profile-icons/B/photo.jpg'};
 const model={list:async()=>({data:[profile],errors:[]}),delete:async()=>{calls.push('profile');return{data:profile,errors:[]};}};
 const deps={
  './accountDeletionState':{accountDeletionStateKey:u=>'aclog-account-deletion:'+u},
  './locationLocationQueueService':{deleteLocationQueueForAccount:async u=>{calls.push('queue:'+u);if(queueError)throw Error('queue failure');return 4;}},
  '@react-native-async-storage/async-storage':{__esModule:true,default:{getItem:async k=>store.get(k),setItem:async(k,v)=>store.set(k,v),removeItem:async k=>store.delete(k),getAllKeys:async()=>[...store.keys()],multiRemove:async keys=>keys.forEach(k=>store.delete(k))}},
  'aws-amplify/auth':{getCurrentUser:async()=>({userId:'B'}),deleteUser:async()=>calls.push('cognito')},
  'aws-amplify/storage':{remove:async()=>calls.push('image')},
  '../lib/client':{client:{models:{UserProfile:model},mutations:{deleteCurrentAccountData:async args=>{assert.deepEqual(Object.keys(args),[]);calls.push('server');if(emptyCount-->0)return{data:null};if(apiError)return{errors:[{message:'failed'}]};let completed=!first;first=false;return{data:{completed}};}}}},
  '../tasks/backgroundLocationTask':{BACKGROUND_RECORDING_STATE_KEY:'location-tracker-background-state'},
  './backgroundLocationService':{getBackgroundRecordingStatus:async()=>({hasStarted:true}),stopBackgroundLocationRecording:async()=>calls.push('stop')}
 };
 const code=ts.transpileModule(fs.readFileSync('src/services/accountDeletionService.ts','utf8'),{compilerOptions:{module:1,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{exports,require:p=>{if(!deps[p])throw Error('Unexpected dependency '+p);return deps[p];},setTimeout:f=>{f();return 0;},console:{error(){},log(){}}});
 return{run:()=>exports.deleteCurrentAccount(),calls,store};
}
test('server cleanup finishes before image/profile/own queue/auth deletion',async()=>{
 const h=harness();await h.run();assert.deepEqual(h.calls,['stop','server','server','image','profile','queue:B','cognito']);assert.equal(h.store.size,0);
});
test('cloud failure preserves login and local queue for resumption',async()=>{
 const h=harness({apiError:true});await assert.rejects(h.run());assert.deepEqual(h.calls,['stop','server']);assert.equal(h.store.has('aclog-account-deletion:B'),true);
});
test('queue failure does not delete Cognito and retains restart inventory',async()=>{
 const h=harness({queueError:true});await assert.rejects(h.run());assert.equal(h.calls.includes('cognito'),false);assert.equal(h.store.has('aclog-account-deletion:B'),true);
});

test('transient empty response retries without assuming completion',async()=>{
 const h=harness({emptyCount:1});await h.run();assert.equal(h.calls.filter(v=>v==='server').length,3);assert.equal(h.calls.at(-1),'cognito');
});
test('repeated empty responses retain login and queue',async()=>{
 const h=harness({emptyCount:8});await assert.rejects(h.run());assert.equal(h.calls.includes('cognito'),false);assert.equal(h.calls.includes('queue:B'),false);
});
