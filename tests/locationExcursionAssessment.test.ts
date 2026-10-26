import assert from 'node:assert/strict';import {test} from 'node:test';
import {assessLocationExcursions,type ExcursionOptions,excursionDefaults} from './diagnostics/locationExcursionAssessment';
import type {MotionCorroboratedPoint} from './diagnostics/motionCorroboratedJitter';
const quiet={state:'quiet',sensorAccuracy:3,samples:150,spanMs:29800,maxGapMs:200,rms:.02,peak:.08,windowMs:30000};
const p=(x:number,t:number):MotionCorroboratedPoint=>({latitude:35,longitude:139+x/91085,recordedAtMs:t*1000,accuracy:5,motion:quiet});
const hint={state:'unknown',sensorAccuracy:0,assessment:'positive_motion_only',samples:150,spanMs:29800,maxGapMs:200,rms:.3,peak:1,windowMs:30000};
test('short fast return is only a hypothetical candidate without reliable quiet evidence',()=>{
 const path=[p(0,0),p(120,5),p(0,10)].map(p=>({...p,motion:null}));const before=JSON.stringify(path);const r=assessLocationExcursions(path);assert.equal(r.excursions[0].classification,'unconfirmed');assert.deepEqual(r.geometricOriginalIndices,[1]);assert.deepEqual(r.supportedOriginalIndices,[]);assert.equal(r.supportedDistanceMeters,r.rawDistanceMeters);assert.equal(JSON.stringify(path),before);assert.equal(r.activeFiltering,false);
});
test('retention hints veto an entire excursion including multi-point detours',()=>{
 const path=[p(0,0),p(120,5),{...p(122,10),rawMotion:hint},p(0,15)];const r=assessLocationExcursions(path);assert.equal(r.excursions[0].classification,'retain_motion');assert.deepEqual(r.supportedOriginalIndices,[]);
});
test('normal slow walking, out-and-back and many sizes of walking/running circles retain every point',()=>{
 const walk=Array.from({length:200},(_,i)=>p(i<=100?i*.4:(200-i)*.4,i));assert.deepEqual(assessLocationExcursions(walk).geometricOriginalIndices,[]);
 for(const radius of [5,10,30,60,100])for(const period of [60,120,300]){
  const path=Array.from({length:121},(_,i)=>({...p(Math.cos(i*5*2*Math.PI/period)*radius,i*5),latitude:35+Math.sin(i*5*2*Math.PI/period)*radius/111000}));assert.deepEqual(assessLocationExcursions(path).geometricOriginalIndices,[]);
 }
});
test('real fast periodic loops can alias as GPS spikes; missing evidence must retain them',()=>{
 const path=Array.from({length:21},(_,i)=>({...p(Math.cos(i*Math.PI)*60,i*5),motion:null}));
 const r=assessLocationExcursions(path);assert.ok(r.geometricOriginalIndices.length>0);assert.equal(r.supportedOriginalIndices.length,0);assert.equal(r.supportedDistanceMeters,r.rawDistanceMeters);
 const moving=path.map(p=>({...p,rawMotion:hint}));assert.ok(assessLocationExcursions(moving).excursions.every(e=>e.classification==='retain_motion'));
});
test('cold, gapped, unreliable or stale quiet claims cannot authorize exclusion',()=>{
 for(const m of [null,{...quiet,sensorAccuracy:0},{...quiet,samples:1},{...quiet,maxGapMs:5000},{...quiet,spanMs:5000},{...quiet,peak:NaN}]){
  const r=assessLocationExcursions([p(0,0),p(120,5),p(0,10)].map(p=>({...p,motion:m})));assert.deepEqual(r.supportedOriginalIndices,[]);
 }
 for(const path of [[p(0,0),p(120,5),p(0,100)],[p(0,0),p(120,5),p(0,5)]])assert.equal(assessLocationExcursions(path).excursions.length,0);
});
test('trusted quiet supports a shadow comparison, but no active write/filter is enabled',()=>{
 const r=assessLocationExcursions([p(0,0),p(120,5),p(0,10)]);assert.deepEqual(r.supportedOriginalIndices,[1]);assert.equal(r.activeFiltering,false);
});

test('relaxing thresholds can erase a realistic running circle geometrically; absent evidence still retains it',()=>{
 const path=Array.from({length:5},(_,i)=>({...p(Math.cos(i*Math.PI/2)*40,i*15),latitude:35+Math.sin(i*Math.PI/2)*40/111000,motion:null}));
 assert.equal(assessLocationExcursions(path).geometricOriginalIndices.length,0);
 const relaxed=assessLocationExcursions(path,{...excursionDefaults,minLegSpeedMps:2,maxGapMs:30000,maxExcursionMs:90000});
 assert.ok(relaxed.geometricOriginalIndices.length>0);assert.equal(relaxed.supportedOriginalIndices.length,0);assert.equal(relaxed.supportedDistanceMeters,relaxed.rawDistanceMeters);
});
test('reliable retained distance includes positions with unknown accuracy instead of silently dropping them',()=>{
 const path=[p(0,0),{...p(30,10),accuracy:null},p(60,20)];const r=assessLocationExcursions(path);assert.ok(r.rawDistanceMeters>59);assert.equal(r.supportedDistanceMeters,r.rawDistanceMeters);
});

test('even quality-certified low acceleration does not distinguish a smooth real loop from stationary GPS jitter',()=>{
 // The input observations are intentionally identical under two physical explanations.
 // No function of these observations can certify which explanation is true.
 const observations=[p(0,0),p(120,5),p(0,10)];
 const r=assessLocationExcursions(observations);
 assert.equal(r.excursions[0].classification,'quiet_supported');
 assert.equal(r.activeFiltering,false);
});

test('coarsely sampled low-speed circles remain intact across phase offsets and threshold settings',()=>{
 for(const radius of [2,5,10,20]) for(const period of [60,120,240]) for(const interval of [5,15,30]) for(const phase of [0,.3,1]) {
  const path=Array.from({length:25},(_,i)=>({...p(Math.cos(phase+i*interval*2*Math.PI/period)*radius,i*interval),latitude:35+Math.sin(phase+i*interval*2*Math.PI/period)*radius/111000}));
  for(const o of [excursionDefaults,{...excursionDefaults,minLegSpeedMps:2,maxGapMs:30000,maxExcursionMs:90000}]) {
   const r=assessLocationExcursions(path,o);assert.equal(r.supportedOriginalIndices.length,0);assert.equal(r.supportedDistanceMeters,r.rawDistanceMeters);
  }
 }
});
