import {calculateDistanceMeters} from '../../src/utils/locationDuplicate';
import {reviewUnreliableRawMotion} from './rawMotionRetentionPolicy';
import type {MotionCorroboratedPoint} from './motionCorroboratedJitter';
export type ExcursionOptions={minJumpMeters:number;minLegSpeedMps:number;returnRadiusMeters:number;maxGapMs:number;maxExcursionMs:number};
export const excursionDefaults:ExcursionOptions={minJumpMeters:50,minLegSpeedMps:12,returnRadiusMeters:15,maxGapMs:15000,maxExcursionMs:45000};
const distance=(a:MotionCorroboratedPoint,b:MotionCorroboratedPoint)=>calculateDistanceMeters(a.latitude,a.longitude,b.latitude,b.longitude);
const positionGood=(p:MotionCorroboratedPoint)=>Number.isFinite(p.latitude)&&Math.abs(p.latitude)<=90&&Number.isFinite(p.longitude)&&Math.abs(p.longitude)<=180&&Number.isFinite(p.recordedAtMs);
const good=(p:MotionCorroboratedPoint)=>positionGood(p)&&p.accuracy!=null&&Number.isFinite(p.accuracy)&&p.accuracy>=0&&p.accuracy<=30;
const moving=(p:MotionCorroboratedPoint)=>p.motion?.state==='moving'||p.rawMotion?.state==='motion_observed'||reviewUnreliableRawMotion(p.rawMotion).hint==='possible_motion';
function quiet(p:MotionCorroboratedPoint){
 const m=p.motion as (NonNullable<MotionCorroboratedPoint['motion']>&{sensorAccuracy?:number})|null|undefined;
 return !!m&&m.state==='quiet'&&typeof m.sensorAccuracy==='number'&&m.sensorAccuracy>=1&&m.sensorAccuracy<=3&&Number.isInteger(m.sensorAccuracy)&&
 [m.samples,m.spanMs,m.maxGapMs,m.rms,m.peak,m.windowMs].every(Number.isFinite)&&Number.isInteger(m.samples)&&m.samples>=80&&m.samples<=1000&&m.spanMs>=24000&&m.spanMs<=30000&&m.maxGapMs>=0&&m.maxGapMs<=1000&&m.windowMs===30000&&m.rms>=0&&m.rms<=.08&&m.peak>=m.rms&&m.peak<=.25;
}
/** Offline hypothesis comparison only. Geometry alone is deliberately not authority to remove a point. */
export function assessLocationExcursions(points:readonly MotionCorroboratedPoint[],options:ExcursionOptions=excursionDefaults){
 const o=options;
 if(!Object.values(o).every(Number.isFinite)||o.minJumpMeters<50||o.minLegSpeedMps<2||o.returnRadiusMeters<0||o.returnRadiusMeters>15||o.maxGapMs<=0||o.maxGapMs>30000||o.maxExcursionMs<=0||o.maxExcursionMs>90000)throw new Error('INVALID_EXCURSION_OPTIONS');
 const geometric=new Set<number>(),supported=new Set<number>();
 const excursions:{anchorIndex:number;returnIndex:number;suspectIndices:number[];classification:'retain_motion'|'unconfirmed'|'quiet_supported'}[]=[];
 for(let i=0;i<points.length-2;i++){
  const a=points[i],b=points[i+1];if(!good(a)||!good(b))continue;
  const dt=b.recordedAtMs-a.recordedAtMs,out=distance(a,b);
  if(dt<=0||dt>o.maxGapMs||out<Math.max(o.minJumpMeters,3*Math.max(a.accuracy!,b.accuracy!))||out/(dt/1000)<o.minLegSpeedMps)continue;
  for(let j=i+2;j<Math.min(points.length,i+8);j++){
   const c=points[j],previous=points[j-1],gap=c.recordedAtMs-previous.recordedAtMs;
   if(!good(c)||gap<=0||gap>o.maxGapMs||c.recordedAtMs-a.recordedAtMs>o.maxExcursionMs)break;
   if(distance(a,c)>o.returnRadiusMeters)continue;
   if(distance(previous,c)<o.minJumpMeters||distance(previous,c)/(gap/1000)<o.minLegSpeedMps)break;
   const suspectIndices=Array.from({length:j-i-1},(_,k)=>i+k+1),segment=points.slice(i,j+1);
   const classification=segment.some(moving)?'retain_motion':segment.every(quiet)?'quiet_supported':'unconfirmed';
   for(const k of suspectIndices){geometric.add(k);if(classification==='quiet_supported')supported.add(k);}
   excursions.push({anchorIndex:i,returnIndex:j,suspectIndices,classification});i=j-1;break;
  }
 }
 const routeDistance=(excluded:Set<number>)=>{let last:MotionCorroboratedPoint|null=null,sum=0;for(let i=0;i<points.length;i++){
  const p=points[i];if(excluded.has(i))continue;if(!positionGood(p)){last=null;continue;}
  if(last&&p.recordedAtMs>last.recordedAtMs)sum+=distance(last,p);last=p;
 }return sum;};
 return {excursions,geometricOriginalIndices:[...geometric],supportedOriginalIndices:[...supported],rawDistanceMeters:routeDistance(new Set()),hypotheticalGeometryDistanceMeters:routeDistance(geometric),supportedDistanceMeters:routeDistance(supported),activeFiltering:false as const};
}
