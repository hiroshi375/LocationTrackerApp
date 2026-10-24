import assert from 'node:assert/strict';import {test} from 'node:test';
import {reviewLocationSpeedConsistency,type SpeedConsistencyPoint} from './diagnostics/locationSpeedConsistency';
const p=(x:number,t:number):SpeedConsistencyPoint=>({latitude:35,longitude:139+x/91085,recordedAtMs:t*1000,accuracy:5,motion:null,reportedSpeed:0,speedAccuracy:.05});
test('speed disagreement is suspicion only, never automatic removal',()=>{
 const a=p(0,0),b=p(120,10),original=JSON.stringify([a,b]);const r=reviewLocationSpeedConsistency(a,b);assert.equal(r.suspect,true);assert.equal(r.automaticExclusion,false);assert.equal(JSON.stringify([a,b]),original);
});
test('old clients, missing accuracy, poor uncertainty and long gaps retain points',()=>{
 for(const b of [{...p(120,10),speedAccuracy:null},{...p(120,10),speedAccuracy:1.5},{...p(120,10),reportedSpeed:-1},{...p(120,10),speedAccuracy:NaN},{...p(120,10),accuracy:null},p(120,30),p(120,0)]){const r=reviewLocationSpeedConsistency(p(0,0),b);assert.equal(r.suspect,false);assert.equal(r.automaticExclusion,false);}
});
test('positive movement, even only at the first endpoint, protects slow walking',()=>{
 for(const i of [0,1]) {const path=[p(0,0),p(120,10)];path[i].reportedSpeed=.6;assert.equal(reviewLocationSpeedConsistency(...path as [SpeedConsistencyPoint,SpeedConsistencyPoint]).reason,'retain_reported_motion');}
});
test('slow walk and circles remain intact across sampling phases',()=>{
 for(const radius of [5,10,20,40])for(const period of [60,120,240])for(const dt of [5,10,15])for(const phase of [0,.5,1]){
  const path=Array.from({length:25},(_,i)=>({...p(Math.cos(phase+i*dt*2*Math.PI/period)*radius,i*dt),latitude:35+Math.sin(phase+i*dt*2*Math.PI/period)*radius/111000,reportedSpeed:2*Math.PI*radius/period}));
  for(let i=1;i<path.length;i++)assert.equal(reviewLocationSpeedConsistency(path[i-1],path[i]).suspect,false);
 }
});
test('real acceleration between two stopped endpoints can produce identical observations',()=>{
 // Rest -> accelerate -> decelerate -> rest is possible inside the sampling interval.
 const r=reviewLocationSpeedConsistency(p(0,0),p(120,10));assert.equal(r.suspect,true);assert.equal(r.automaticExclusion,false);
});
test('unreliable acceleration can only veto suspicion, never authorize removal',()=>{
 const a={...p(0,0),rawMotion:{state:'unknown',sensorAccuracy:0,assessment:'positive_motion_only',samples:150,spanMs:29800,maxGapMs:200,rms:.3,peak:1,windowMs:30000}};
 assert.equal(reviewLocationSpeedConsistency(a,p(120,10)).reason,'retain_motion');
});
