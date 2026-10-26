import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPlanStopReceiptStore, planStopReceiptKey, type PlanStopReceipt} from '../src/services/recordingFinalizationCore';
const receipt: PlanStopReceipt = {userId:'A',recordingSessionId:'one',reason:'FREE_PLAN_DURATION_LIMIT',stoppedAt:'2026-10-23T01:07:00Z',intervalMs:30000,distanceMeters:50,sharedOwners:['viewer'],phase:'stopping'};
function fixture(){
 const data = new Map<string,string>(); let failWrite=false;
 const storage={async getItem(k:string){return data.get(k)??null},async setItem(k:string,v:string){if(failWrite)throw Error('disk');data.set(k,v)},async removeItem(k:string){data.delete(k)}};
 return {data,storage,setFail:(v:boolean)=>{failWrite=v},store:createPlanStopReceiptStore(storage)};
}
test('receipt survives JS restart; stopped phase and captured settings survive without acknowledgment',async()=>{
 const f=fixture();await f.store.prepare(receipt);
 const restarted=createPlanStopReceiptStore(f.storage);
 assert.deepEqual(await restarted.read('A'),receipt);
 await restarted.ready('A','one');
 assert.equal((await createPlanStopReceiptStore(f.storage).read('A'))?.phase,'ready');
 assert.equal((await restarted.read('A'))?.intervalMs,30000);
});
test('account and session isolation protects pending work from stale stop/ack/new session',async()=>{
 const f=fixture();await f.store.prepare(receipt);
 assert.equal(await f.store.read('B'),null);
 assert.equal(await f.store.ready('A','other'),null);
 await f.store.acknowledge('A','other');await f.store.acknowledge('B','one');
 await assert.rejects(f.store.prepare({...receipt,recordingSessionId:'two'}));
 assert.deepEqual(await f.store.read('A'),receipt);
 await f.store.acknowledge('A','one');assert.equal(await f.store.read('A'),null);
});
test('failed durable write does not produce a ready receipt and can be retried',async()=>{
 const f=fixture();f.setFail(true);await assert.rejects(f.store.prepare(receipt));
 assert.equal(await f.store.read('A'),null);
 f.setFail(false);await f.store.prepare(receipt);f.setFail(true);
 await assert.rejects(f.store.ready('A','one'));
 assert.equal((await f.store.read('A'))?.phase,'stopping');
 f.setFail(false);await f.store.ready('A','one');assert.equal((await f.store.read('A'))?.phase,'ready');
});
test('malformed/mismatched owner receipt fails closed without deleting evidence',async()=>{
 const f=fixture();f.data.set(planStopReceiptKey('A'),JSON.stringify({...receipt,userId:'B'}));
 await assert.rejects(f.store.read('A'));assert.equal(f.data.size,1);
});
test('repeated stop preparation preserves original reason/time/settings; concurrent ready cannot be undone',async()=>{
 const f=fixture();await f.store.prepare(receipt);
 await Promise.all([f.store.ready('A','one'),f.store.prepare({...receipt,reason:'FREE_PLAN_POINT_LIMIT',intervalMs:10000})]);
 assert.deepEqual(await f.store.read('A'),{...receipt,phase:'ready'});
});
