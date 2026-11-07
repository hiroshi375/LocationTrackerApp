import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBeforeRecordingStart, matchingRecordingStart } from '../src/services/recordingStartBoundary';
const start='2026-11-03T22:16:46.374Z';
const ms=Date.parse(start);
for (const [offset, excluded] of [[-125043,true],[-1,true],[0,false],[1,false],[30000,false]] as const) {
 test(`measurement offset ${offset}ms: before-start=${excluded}`,()=>assert.equal(isBeforeRecordingStart(ms+offset,start),excluded));
}
test('late arrival does not exclude a legitimate same-session measurement',()=>{
 const recordedAt=ms+1, arrivals=[ms+30000,ms+3600000];
 for (const arrival of arrivals) { assert.ok(arrival>recordedAt); assert.equal(isBeforeRecordingStart(recordedAt,start),false); }
});
test('current session start is not applied to a previous session queue',()=>{
 const plan={recordingSessionId:'new',recordingStartedAt:start};
 assert.equal(matchingRecordingStart('old',plan),null);
 assert.equal(isBeforeRecordingStart(ms-100000,matchingRecordingStart('old',plan)),false);
 assert.equal(matchingRecordingStart('new',plan),start);
});
test('missing or invalid legacy boundary does not discard existing queued records',()=>{
 for (const boundary of [undefined,null,'invalid','']) assert.equal(isBeforeRecordingStart(ms,boundary),false);
 assert.equal(matchingRecordingStart('old',null),null);
});
test('deciding on a stale pending point does not mutate its payload or status',()=>{
 const pending=Object.freeze({recordedAtMs:ms-1,queue_status:'pending',latitude:35,longitude:139});
 const before=JSON.stringify(pending);assert.equal(isBeforeRecordingStart(pending.recordedAtMs,start),true);
 assert.equal(JSON.stringify(pending),before);
});
