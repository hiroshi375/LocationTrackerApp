import assert from 'node:assert/strict';import {test} from 'node:test';
import {assessMotionCorroboratedJitter,type MotionCorroboratedPoint} from './diagnostics/motionCorroboratedJitter';
const quiet={state:'quiet',sensorAccuracy:3,samples:150,spanMs:29800,maxGapMs:200,rms:.02,peak:.08,windowMs:30000};
const p=(x:number,t:number,motion:MotionCorroboratedPoint['motion']=quiet):MotionCorroboratedPoint=>({latitude:35,longitude:139+x/91085,recordedAtMs:t*1000,accuracy:8,motion});
test('fast return plus continuously observed quiet acceleration is a shadow candidate, not a raw mutation',()=>{
 const points=[p(0,0),p(110,30),p(0,60)];const copy=JSON.stringify(points);const r=assessMotionCorroboratedJitter(points);assert.deepEqual(r.candidateOriginalIndices,[1]);assert.equal(r.activeFiltering,false);assert.equal(JSON.stringify(points),copy);
});
test('missing, stale or interrupted sensor observations cannot mean stationary',()=>{
 for(const motion of [null,{...quiet,state:'unknown'},{...quiet,samples:0},{...quiet,maxGapMs:5000},{...quiet,spanMs:5000},{...quiet,rms:NaN}]){
  const r=assessMotionCorroboratedJitter([p(0,0),p(110,30,motion),p(0,60,motion)]);assert.deepEqual(r.candidateOriginalIndices,[]);assert.equal(r.uncertainReturns,1);
 }
});
test('observed motion protects genuine running return even if GPS position resembles a spike',()=>{
 const moving={...quiet,state:'moving',rms:.3,peak:1};assert.deepEqual(assessMotionCorroboratedJitter([p(0,0),p(110,30,moving),p(0,60,moving)]).candidateOriginalIndices,[]);
});
test('slow walking, slow out-and-back, vehicle travel and running circuits are not removed',()=>{
 const slow=Array.from({length:121},(_,i)=>p(i<=60?i*.4:(120-i)*.4,i));assert.deepEqual(assessMotionCorroboratedJitter(slow).candidateOriginalIndices,[]);
 const vehicle=[p(0,0),p(600,30),p(1200,60)];assert.deepEqual(assessMotionCorroboratedJitter(vehicle).candidateOriginalIndices,[]);
 const circle=Array.from({length:61},(_,i)=>({...p(0,i*5),latitude:35+Math.sin(i*Math.PI/15)*.0005,longitude:139+Math.cos(i*Math.PI/15)*.0005}));assert.deepEqual(assessMotionCorroboratedJitter(circle).candidateOriginalIndices,[]);
});
test('offline timestamps and old native clients without evidence keep all original points',()=>{
 const gap=[p(0,0),p(110,120),p(0,240)];assert.deepEqual(assessMotionCorroboratedJitter(gap).candidateOriginalIndices,[]);
 const old=[p(0,0,null),p(110,30,null),p(0,60,null)];assert.deepEqual(assessMotionCorroboratedJitter(old).candidateOriginalIndices,[]);
});

test('physical acceleration movement vetoes a return candidate and absent movement is not a replacement for quiet linear evidence',()=>{
 const moving=[p(0,0),{...p(110,30),rawMotion:{state:'motion_observed'}},p(0,60)];
 assert.deepEqual(assessMotionCorroboratedJitter(moving).candidateOriginalIndices,[]);
 const unconfirmed=[p(0,0,null),{...p(110,30,null),rawMotion:{state:'no_motion_detected'}},{...p(0,60,null),rawMotion:{state:'no_motion_detected'}}];
 const r=assessMotionCorroboratedJitter(unconfirmed);assert.deepEqual(r.candidateOriginalIndices,[]);assert.equal(r.uncertainReturns,1);assert.equal(r.activeFiltering,false);
});

test('anchor motion and unavailable accuracy veto shadow exclusion; quiet cannot prove no travel',()=>{
 for(const anchor of [{...quiet,state:'moving'},null,{...quiet,sensorAccuracy:0},{...quiet,sensorAccuracy:undefined}]) {
  assert.deepEqual(assessMotionCorroboratedJitter([p(0,0,anchor),p(110,30),p(0,60)]).candidateOriginalIndices,[]);
 }
 for(const sensorAccuracy of [undefined,0,-1,4,1.5,NaN]) {
  assert.deepEqual(assessMotionCorroboratedJitter([p(0,0),p(110,30,{...quiet,sensorAccuracy}),p(0,60)]).candidateOriginalIndices,[]);
 }
});
