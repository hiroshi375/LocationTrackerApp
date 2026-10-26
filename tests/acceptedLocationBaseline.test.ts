import assert from 'node:assert/strict';
import {test} from 'node:test';
import {acceptedBaselineKey,createAcceptedBaselineStore,selectAcceptedBaseline} from '../src/services/acceptedLocationBaselineCore';
const point=(recordedAt:number,longitude=139)=>({latitude:35,longitude,recordedAt});
function fixture(){const data=new Map<string,string>();return{data,store:createAcceptedBaselineStore({async getItem(k){return data.get(k)??null},async setItem(k,v){data.set(k,v)}})}}
test('all writers see the confirmed foreground/background/queue point after acquiring a lock',async()=>{
 const {store}=fixture();const stale=point(0);
 await store.record('A','s',point(30000));
 const locked=selectAcceptedBaseline(31000,stale,await store.read('A','s'))!;
 assert.equal(locked.recordedAt,30000);assert.equal(31000-locked.recordedAt>=30000,false);
 assert.equal(31000-stale.recordedAt>=30000,true); // demonstrates the old stale-baseline over-save
});
test('older offline receipt ignores a future live point and uses its actual predecessor',async()=>{
 const {store}=fixture();await store.record('A','s',point(120000));
 const predecessor=selectAcceptedBaseline(60000,await store.read('A','s'),point(20000));
 assert.equal(predecessor?.recordedAt,20000);assert.equal(60000-predecessor!.recordedAt>=30000,true);
});
test('late cloud completions cannot rewind the common baseline',async()=>{
 const {store}=fixture();await Promise.all([store.record('A','s',point(30000)),store.record('A','s',point(90000)),store.record('A','s',point(60000))]);
 assert.equal((await store.read('A','s'))?.recordedAt,90000);
});
test('owner and session are isolated, including a tampered stored scope',async()=>{
 const {store,data}=fixture();await store.record('A','one',point(30000));assert.equal(await store.read('B','one'),null);assert.equal(await store.read('A','two'),null);
 data.set(acceptedBaselineKey('B','one'),data.get(acceptedBaselineKey('A','one'))!);await assert.rejects(store.read('B','one'),/SCOPE/);
});
test('missing/corrupt coordinates never become a saved baseline',async()=>{
 const {store}=fixture();await assert.rejects(store.record('A','s',{...point(1),latitude:100}));assert.equal(await store.read('A','s'),null);
 assert.equal(selectAcceptedBaseline(1,point(2)),null);
});

test('discard removes coordinates and fences a late successful callback',async()=>{
 const {store,data}=fixture();await store.record('A','s',point(30000));await store.discard('A','s');await store.record('A','s',point(90000));
 assert.equal(await store.read('A','s'),null);assert.equal(data.get(acceptedBaselineKey('A','s'))?.includes('latitude'),false);
});
