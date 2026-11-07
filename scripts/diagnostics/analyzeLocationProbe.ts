import fs from 'node:fs';
import path from 'node:path';
import { calculateDistanceMeters } from '../../src/utils/locationDuplicate';
/** Describes raw input, not a corrected activity distance. Does not print coordinates. */
export function analyzeLocationProbe(snapshot: any) {
 if(snapshot.schema!==1||!Array.isArray(snapshot.rows)||!snapshot.run)throw Error('INVALID_PROBE_LOG');
 const valid=snapshot.rows.filter((r:any)=>Number.isFinite(r.timestamp)&&Number.isFinite(r.coords?.latitude)&&Number.isFinite(r.coords?.longitude));
 const unique=[...new Map<string,any>(valid.map((r:any)=>[JSON.stringify([r.timestamp,r.coords.latitude,r.coords.longitude]),r])).values()].sort((a,b)=>a.timestamp-b.timestamp);
 const native=unique.filter(r=>r.native); let rawPath=0,maxJump=0,maxFromFirst=0;
 for(let i=0;i<unique.length;i++){
  const p=unique[i].coords;
  if(i){const q=unique[i-1].coords,d=calculateDistanceMeters(p.latitude,p.longitude,q.latitude,q.longitude);rawPath+=d;maxJump=Math.max(maxJump,d);}
  const q=unique[0].coords;maxFromFirst=Math.max(maxFromFirst,calculateDistanceMeters(p.latitude,p.longitude,q.latitude,q.longitude));
 }
 const times=unique.map(r=>r.timestamp);
 return { mode:snapshot.run.mode,receivedRows:snapshot.rows.length,uniqueFixes:unique.length,
   firstFix:times.length?new Date(times[0]).toISOString():null,lastFix:times.length?new Date(times.at(-1)!).toISOString():null,
   observedSpanSeconds:times.length?(times.at(-1)!-times[0])/1000:0,
   rawInputPathMeters:rawPath,maxAdjacentJumpMeters:maxJump,maxDistanceFromFirstFixMeters:maxFromFirst,
   nativeEvidenceFixes:native.length,nativeMismatches:native.filter(r=>r.native.latitude!==r.coords.latitude||r.native.longitude!==r.coords.longitude||r.native.fixTimeMs!==r.timestamp).length,
   taskErrors:snapshot.errors?.length??0,
   warning:'Raw input path is not an activity distance. A short non-reproduction does not rule out a device or background issue.' };
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(__filename))console.log(JSON.stringify(analyzeLocationProbe(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))),null,2));
