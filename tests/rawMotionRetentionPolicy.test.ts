import assert from 'node:assert/strict';import {test} from 'node:test';
import {reviewUnreliableRawMotion,summarizeRawMotionRetention,type RawMotionSummary} from './diagnostics/rawMotionRetentionPolicy';
import {assessMotionCorroboratedJitter,type MotionCorroboratedPoint} from './diagnostics/motionCorroboratedJitter';
const sample:RawMotionSummary={state:'unknown',sensorAccuracy:0,assessment:'positive_motion_only',samples:149,spanMs:29790,maxGapMs:180,rms:.3,peak:1,windowMs:30000};
const quiet={state:'quiet',sensorAccuracy:3,samples:150,spanMs:29800,maxGapMs:200,rms:.02,peak:.08,windowMs:30000};
const p=(x:number,t:number):MotionCorroboratedPoint=>({latitude:35,longitude:139+x/91085,recordedAtMs:t*1000,accuracy:8,motion:quiet});
test('accuracy zero remains unreliable and only supplies a GPS-retention hint',()=>{
 assert.deepEqual(reviewUnreliableRawMotion(sample),{hint:'possible_motion',quality:'unreliable',retentionOnly:true});assert.equal(sample.state,'unknown');
});
test('low signal, missing evidence, old native versions, gaps, cold start and gravity residual never certify stillness',()=>{
 for(const x of [null,undefined,{state:'unknown'}, {...sample,rms:.02,peak:.08},{...sample,samples:0},{...sample,spanMs:23000},{...sample,maxGapMs:1001},{...sample,rms:NaN},{...sample,peak:Infinity},{...sample,rms:-1},{...sample,peak:.1},{...sample,samples:1.5},{...sample,windowMs:60000},{...sample,rms:.0756,peak:1.575},{...sample,rms:.1,peak:.3},{...sample,rms:9.806,peak:9.81},{...sample,sensorAccuracy:-1}]){
  const result=reviewUnreliableRawMotion(x);assert.equal(result.hint,'none');assert.equal(result.retentionOnly,true);
 }
});
test('adding unreliable hints can only reduce excluded candidates for simulated routes',()=>{
 let candidateCount=0;
 for(let n=0;n<400;n++){
  const path=Array.from({length:40},(_,i)=>({...p(Math.sin(i*(n+1)*.17)*130,i*5),rawMotion: i%3===0 ? sample : null}));
  const before=assessMotionCorroboratedJitter(path.map(x=>({...x,rawMotion:null}))).candidateOriginalIndices;
  candidateCount+=before.length;const after=assessMotionCorroboratedJitter(path).candidateOriginalIndices;assert.ok(after.every(i=>before.includes(i)));
 }
 assert.ok(candidateCount>0,'exercise actual exclusion candidates, not only empty paths');
});
test('unreliable hints veto an apparent GPS return without upgrading sensor validity',()=>{
 const path=[p(0,0),{...p(110,30),rawMotion:sample},p(0,60)];assert.deepEqual(assessMotionCorroboratedJitter(path.map(x=>({...x,rawMotion:null}))).candidateOriginalIndices,[1]);assert.deepEqual(assessMotionCorroboratedJitter(path).candidateOriginalIndices,[]);
});
test('missing movement cannot replace unavailable linear evidence, including slow and circular trajectories',()=>{
 const low={...sample,rms:.02,peak:.08};const path=[p(0,0),p(110,30),p(0,60)].map(x=>({...x,motion:null,rawMotion:low}));assert.deepEqual(assessMotionCorroboratedJitter(path).candidateOriginalIndices,[]);
 const walk=Array.from({length:121},(_,i)=>({...p(i*.4,i),motion:null,rawMotion:sample}));assert.deepEqual(assessMotionCorroboratedJitter(walk).candidateOriginalIndices,[]);
 const circle=Array.from({length:121},(_,i)=>({...p(Math.cos(i*Math.PI/30)*60,i),latitude:35+Math.sin(i*Math.PI/30)*60/111000,rawMotion:sample}));assert.deepEqual(assessMotionCorroboratedJitter(circle).candidateOriginalIndices,[]);
});

test('diagnostic summary preserves original sensor state and exports counts without coordinates',()=>{
 const rows=[{recordingSessionId:'s',quality:{motion:{rawAccelerometer:sample}}},{recordingSessionId:'s',quality:{motion:{rawAccelerometer:{...sample,rms:.02,peak:.08}}}},null,{recordingSessionId:'old',quality:{motion:{}}}];
 const original=JSON.stringify(rows);assert.deepEqual(summarizeRawMotionRetention(rows).sessions,[{recordingSessionId:'s',samples:2,unreliable:2,possibleMotionHints:1}]);assert.equal(JSON.stringify(rows),original);assert.equal(summarizeRawMotionRetention(rows).activeFiltering,false);
});
