import fs from 'node:fs';
import { assessNativeMovementCandidate } from '../../src/services/locationQualityReviewCore';
import { normalizeRouteLogs, calculateRouteDistanceMeters } from '../../src/lib/locationRoute';
const text=fs.readFileSync(process.argv[2], 'utf8');
const snapshot=JSON.parse(text.split('===== LOCATION DECISION EVIDENCE =====').pop()!.split(/\n=====/)[0]);
const evidence=new Map<string,any[]>();
for(const row of snapshot.rows){const arr=evidence.get(row.correlationKey)??[];arr.push(row);evidence.set(row.correlationKey,arr);}
const rows=[...new Map<string,any>(snapshot.rows.filter((r:any)=>r.path==='cloud-write'&&r.reason==='confirmed-created').map((r:any)=>[r.correlationKey,r])).values()].sort((a,b)=>a.point.recordedAtMs-b.point.recordedAtMs);
const metric=(items:any[])=>calculateRouteDistanceMeters(normalizeRouteLogs(items.map(r=>({...r.point,recordedAt:new Date(r.point.recordedAtMs).toISOString()}))));
const heldByEarlierRejection=new Set(rows.filter(r=>(evidence.get(r.correlationKey)??[]).some(x=>x.path==='background-direct'&&x.reason==='abnormalSpeed'&&x.sequence<r.sequence)).map(r=>r.correlationKey));
const kept:any[]=[];let reviewCandidates=0,unknown=0;
for(const row of rows){const native=(evidence.get(row.correlationKey)??[]).find(r=>r.nativeEvidence)?.nativeEvidence??null;
 const verdict=assessNativeMovementCandidate(kept.at(-1)?.point??null,row.point,native);
 if(verdict.status==='review-candidate'){reviewCandidates++;continue;}
 if(verdict.status==='insufficient-evidence')unknown++;kept.push(row);
}
console.log(JSON.stringify({warning:'Offline hypothesis only, not a reconstruction of correct movement. Original data unchanged; holding may change later baselines. Real walking/loop controls still required.',inputPoints:rows.length,originalMeters:metric(rows),priorRejectedButSaved:heldByEarlierRejection.size,priorRejectionHoldOnlyMeters:metric(rows.filter(r=>!heldByEarlierRejection.has(r.correlationKey))),candidateHeld:reviewCandidates,insufficientEvidence:unknown,candidateRemainingPoints:kept.length,candidateMeters:metric(kept)},null,2));
