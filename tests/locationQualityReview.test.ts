import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQualityReviewStore, assessNativeMovementCandidate, qualityReviewKey } from '../src/services/locationQualityReviewCore';
const point = { userId: 'owner', sessionId: 'session', latitude: 35, longitude: 139, recordedAtMs: 1000 };
test('a held measurement remains held across retries/restarts; owner and session are isolated', async () => {
 const data = new Map<string,string>(); const io = { getItem: async (k:string) => data.get(k) ?? null, setItem: async (k:string,v:string) => { data.set(k,v); } };
 await createQualityReviewStore(io).hold(point, 'abnormalSpeed'); const restored = createQualityReviewStore(io);
 assert.equal((await restored.read(point))?.reason, 'abnormalSpeed');
 assert.equal(await restored.read({ ...point, userId: 'other' }), null);
 assert.equal(await restored.read({ ...point, sessionId: 'other' }), null);
 assert.notEqual(qualityReviewKey(point), qualityReviewKey({ ...point, recordedAtMs: 2000 }));
});
test('storage errors are not treated as an automatic release', async () => {
 const store=createQualityReviewStore({getItem:async()=>{throw Error('disk');},setItem:async()=>{throw Error('disk');}});
 await assert.rejects(store.hold(point,'abnormalSpeed')); await assert.rejects(store.read(point));
});
test('missing native speed is unknown; slow walking, running and returning circuits are not shape-filtered', () => {
 const native = { hasSpeed:true,hasSpeedAccuracy:true,speedMetersPerSecond:1,speedAccuracyMetersPerSecond:.2 };
 const points=[0,.0001,.0002,.0001,0].map((x,i)=>({...point,latitude:35+x,recordedAtMs:i*30000}));
 for(let i=1;i<points.length;i++)assert.equal(assessNativeMovementCandidate(points[i-1],points[i],native).status,'no-candidate');
 assert.equal(assessNativeMovementCandidate(points[0],points[1],null).status,'insufficient-evidence');
 const runner={...point,latitude:35.003,recordedAtMs:30000};
 assert.equal(assessNativeMovementCandidate({...point,recordedAtMs:0},runner,{...native,speedMetersPerSecond:12}).status,'no-candidate');
});
test('a large jump with low native movement is only a review candidate; input is retained',()=>{
 const a={...point,recordedAtMs:0},b={...point,latitude:35.0074,recordedAtMs:19535};
 const original=JSON.stringify([a,b]);
 assert.equal(assessNativeMovementCandidate(a,b,{hasSpeed:true,hasSpeedAccuracy:true,speedMetersPerSecond:.19,speedAccuracyMetersPerSecond:.39}).status,'review-candidate');
 assert.equal(JSON.stringify([a,b]),original);
});

test('held queue prefixes do not starve later unsent rows, including equal timestamps', async () => {
 const { collectNonHeldRows } = await import('../src/services/locationQualityReviewCore');
 const all = Array.from({length:12},(_,i)=>({ recorded_at_ms: Math.floor(i/3), location_log_id: String(i).padStart(3,'0') }));
 const result=await collectNonHeldRows({fetch:async after=>all.filter(r=>r.recorded_at_ms>after.recordedAtMs||r.recorded_at_ms===after.recordedAtMs&&r.location_log_id>after.locationLogId).slice(0,3),
    isHeld:async row=>Number(row.location_log_id)<10,limit:2,deadlineAtMs:100,now:()=>0});
 assert.deepEqual(result.rows.map(r=>r.location_log_id),['010','011']);assert.equal(result.heldCount,10);assert.equal(all.length,12);
});
