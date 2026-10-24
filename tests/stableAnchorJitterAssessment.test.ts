import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assessStableAnchorJitter} from './diagnostics/stableAnchorJitterAssessment';
import type {MotionCorroboratedPoint} from './diagnostics/motionCorroboratedJitter';
const p=(x:number,t:number):MotionCorroboratedPoint=>({latitude:35,longitude:139+x/91085,recordedAtMs:t*1000,accuracy:5,motion:null});
const spike=()=>[0,0,0,120,0,0,0].map((x,i)=>p(x,i*5));
test('stable before and after narrows suspicion but never authorizes automatic removal',()=>{
 const path=spike(),copy=JSON.stringify(path),r=assessStableAnchorJitter(path);
 assert.deepEqual(r.geometricCandidateIndices,[3]);assert.ok(r.hypotheticalDistanceMeters<1);
 assert.deepEqual(r.automaticExclusionIndices,[]);assert.equal(r.activeFiltering,false);assert.equal(JSON.stringify(path),copy);
});
test('movement in any context point vetoes suspicion including unreliable retention-only hints',()=>{
 const hint={state:'unknown',sensorAccuracy:0,assessment:'positive_motion_only',samples:150,spanMs:29800,maxGapMs:200,rms:.3,peak:1,windowMs:30000};
 for(let i=0;i<7;i++) {const path=spike();path[i]={...path[i],rawMotion:hint};assert.deepEqual(assessStableAnchorJitter(path).geometricCandidateIndices,[]);}
});
test('missing context, poor accuracy, invalid chronology and gaps preserve all points',()=>{
 const paths=[spike().slice(1),spike().map((p,i)=>i===0?{...p,accuracy:null}:p),spike().map((p,i)=>i===0?{...p,accuracy:50}:p),spike().map((p,i)=>i===6?{...p,recordedAtMs:100000}:p),spike().map((p,i)=>i===6?{...p,recordedAtMs:25000}:p)];
 for(const path of paths)assert.deepEqual(assessStableAnchorJitter(path).geometricCandidateIndices,[]);
});
test('slow walking, stopping before moving, and slow circular trajectories remain intact',()=>{
 const paths=[Array.from({length:61},(_,i)=>p(i*.4,i)),Array.from({length:61},(_,i)=>p(i<20?0:(i-20)*.4,i))];
 for(const radius of [5,10,20,40])for(const period of [60,120,240])for(const interval of [5,15,30]){
  paths.push(Array.from({length:61},(_,i)=>({...p(Math.cos(i*interval*2*Math.PI/period)*radius,i*interval),latitude:35+Math.sin(i*interval*2*Math.PI/period)*radius/111000})));
 }
 for(const path of paths){const r=assessStableAnchorJitter(path);assert.deepEqual(r.geometricCandidateIndices,[]);assert.equal(r.hypotheticalDistanceMeters,r.rawDistanceMeters);}
});
test('a genuine fast out-and-back with pauses is observationally identical and must not be automatically erased',()=>{
 const realTrip=spike(); // Smooth transport or sparse sampling can supply the same observations.
 assert.equal(assessStableAnchorJitter(realTrip).geometricCandidateIndices.length,1);
 assert.deepEqual(assessStableAnchorJitter(realTrip).automaticExclusionIndices,[]);
});
