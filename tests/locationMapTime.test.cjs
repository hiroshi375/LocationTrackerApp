const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const source=fs.readFileSync('src/screens/LocationMapScreen.tsx','utf8');const from=source.indexOf('    const sessionStartAt =');const to=source.indexOf('\n    /*',from);assert.ok(from>=0&&to>from);
const period=new Function('isOwnLiveRecordingMap','recordingSessionSummary','activeSessionId','editableLocationLogs','routeLogs',source.slice(from,to)+'\nreturn {start:sessionStartAt,end:sessionEndAt};');
const stamp=Date.parse('2026-10-23T21:19:04.034Z');const log=t=>({recordedAt:new Date(stamp+t).toISOString()});const seconds=r=>Math.floor((Date.parse(r.end)-Date.parse(r.start))/1000);
test('stationary final fixes still count toward elapsed time after map route simplification',()=>{
 const logs=[log(0),log(28000),log(60000),log(94284)];const r=period(false,null,'session',logs,logs.slice(0,2));assert.equal(seconds(r),94);assert.equal(r.end,logs.at(-1).recordedAt);
 assert.equal(seconds(period(false,null,'session',logs,[logs[0]])),94);
});
test('elapsed time does not change with simplified walking/circle geometry',()=>{
 const logs=[log(0),log(20000),log(127727),log(132297)];assert.equal(seconds(period(false,null,'session',logs,logs.slice(0,3))),132);
});
test('live start, no active session and single fix retain previous semantics',()=>{
 const summary={startedAt:log(-5000).recordedAt};assert.equal(period(true,summary,'session',[log(0),log(90000)],[]).start,summary.startedAt);
 assert.deepEqual(period(false,null,null,[log(0)],[]),{start:null,end:null});assert.equal(seconds(period(false,null,'session',[log(0)],[])),0);
});
