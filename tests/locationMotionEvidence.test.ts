import assert from 'node:assert/strict';
import {test} from 'node:test';
import {summarizeLocationMotionEvidence,projectMotionSampleEvidence} from './diagnostics/locationMotionEvidence';
const p=(longitude:number,recorded_at_ms:number,speed:number|null)=>({latitude:35,longitude,recorded_at_ms,speed,accuracy:10});
test('diagnostic identifies large coordinate jumps with reported stationary speed without altering samples',()=>{
 const points=[p(139,0,0),p(139.001,30000,0),p(139,60000,0)];const before=JSON.stringify(points);const result=summarizeLocationMotionEvidence(points);
 assert.equal(result.jumpsOver50m,2);assert.equal(result.jumpsOver50mWithReportedSpeedUnder0_5,2);assert.equal(JSON.stringify(points),before);
 assert.equal(JSON.stringify(result).includes('latitude'),false);
});
test('running and unknown speed remain distinct; unknown does not become stationary',()=>{
 const running=summarizeLocationMotionEvidence([p(139,0,3),p(139.001,30000,3)]);assert.equal(running.jumpsOver50mWithReportedSpeedUnder0_5,0);
 const missing=summarizeLocationMotionEvidence([p(139,0,null),p(139.001,30000,null)]);assert.equal(missing.jumpsOver50mWithUnknownSpeed,1);assert.equal(missing.reportedSpeedMedian,null);
});

test('offline evidence exposes timestamps/speed/accuracy only, without coordinates or coordinate-derived IDs',()=>{
 const source=[p(139.001,12345,0.1)];const projected=projectMotionSampleEvidence(source);
 assert.deepEqual(projected,[{recordedAtMs:12345,reportedSpeed:0.1,reportedAccuracy:10}]);
 assert.deepEqual(Object.keys(projected[0]).sort(),['recordedAtMs','reportedAccuracy','reportedSpeed']);
 assert.equal(JSON.stringify(projected).includes('139.001'),false);
});
