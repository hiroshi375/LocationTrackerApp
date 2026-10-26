import assert from 'node:assert/strict';import {test} from 'node:test';
import {assessReturningLocationJitter,type JitterSample} from './diagnostics/locationJitterAssessment';
const p=(x:number,t:number,speed:number|null=0.02,accuracy:number|null=8):JitterSample=>({latitude:35,longitude:139+x/91085,recorded_at_ms:t*1000,speed,accuracy});
const stable=()=>[p(0,0),p(1,5),p(0,10)];
test('corroborated fast jump and return during reported stationary motion is assessed, without mutating raw data',()=>{
 const input=[...stable(),p(110,20),p(112,25),p(1,35),p(0,40)];const original=JSON.stringify(input);const result=assessReturningLocationJitter(input);
 assert.deepEqual(result.suspectedOriginalIndices,[3,4]);assert.ok(result.candidateDistanceMeters<10);assert.ok(result.rawDistanceMeters>200);assert.equal(JSON.stringify(input),original);assert.equal(result.activeFiltering,false);
});
test('low speed walking and a genuine slow out-and-back remain intact',()=>{
 const input=Array.from({length:121},(_,i)=>p(i<=60?i*0.4:(120-i)*0.4,i,0.4));assert.deepEqual(assessReturningLocationJitter(input).suspectedOriginalIndices,[]);
 const longer=[...stable(),p(60,160,0.4),p(0,310,0.4)];assert.deepEqual(assessReturningLocationJitter(longer).suspectedOriginalIndices,[]);
});
test('a running out-and-back and small running circuit are never rejected just for returning',()=>{
 const run=[...stable(),p(100,30,5),p(0,50,5)];assert.deepEqual(assessReturningLocationJitter(run).suspectedOriginalIndices,[]);
 const circle=Array.from({length:241},(_,i)=>({latitude:35+Math.sin(i*Math.PI/30)*0.0005,longitude:139+Math.cos(i*Math.PI/30)*0.0005,recorded_at_ms:i*5000,speed:2,accuracy:8}));assert.deepEqual(assessReturningLocationJitter(circle).suspectedOriginalIndices,[]);
});
test('missing/negative speed, poor accuracy and conflicting motion evidence are inconclusive, not stationary',()=>{
 for(const speed of [null,-1,NaN,1]){const input=[...stable(),p(110,20,speed),p(0,30)];assert.deepEqual(assessReturningLocationJitter(input).suspectedOriginalIndices,[]);}
 const inaccurate=[...stable(),p(110,20,0,80),p(0,30)];assert.deepEqual(assessReturningLocationJitter(inaccurate).suspectedOriginalIndices,[]);
});
test('stop followed by genuine movement is not suppressed; absent return stays untouched',()=>{
 const start=[...stable(),p(100,30,3),p(150,50,3),p(200,70,3)];assert.deepEqual(assessReturningLocationJitter(start).suspectedOriginalIndices,[]);
 const relocation=[...stable(),p(110,20),p(112,30),p(110,40)];assert.deepEqual(assessReturningLocationJitter(relocation).suspectedOriginalIndices,[]);
});
test('receipt arrival order does not alter event-time assessment; duplicates do not provide motion corroboration',()=>{
 const input=[...stable(),p(110,20),p(0,30)];const r=assessReturningLocationJitter([...input].reverse());assert.equal(r.suspectedOriginalIndices.length,1);
 const duplicates=[p(0,0),p(0,0),p(0,10),p(110,20),p(0,30)];assert.deepEqual(assessReturningLocationJitter(duplicates).suspectedOriginalIndices,[]);
});
test('long gaps, gradual round trips and malformed coordinates cannot be used to remove samples',()=>{
 const gap=[...stable(),p(100,120,0),p(0,240,0)];assert.deepEqual(assessReturningLocationJitter(gap).suspectedOriginalIndices,[]);
 const invalid=[...stable(),{...p(110,20),latitude:NaN},p(0,30)];assert.deepEqual(assessReturningLocationJitter(invalid).suspectedOriginalIndices,[]);
});
