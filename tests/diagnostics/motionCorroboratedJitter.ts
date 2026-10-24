import { reviewUnreliableRawMotion, type RawMotionSummary } from "./rawMotionRetentionPolicy";
import { calculateDistanceMeters } from "../../src/utils/locationDuplicate";
export type MotionCorroboratedPoint = {
    latitude:number; longitude:number; recordedAtMs:number; accuracy:number|null;
    rawMotion?: RawMotionSummary|null;
    motion?:{state:string;sensorAccuracy?:number;samples:number;spanMs:number;maxGapMs:number;rms:number;peak:number;windowMs:number}|null;
};
function coveredQuiet(point:MotionCorroboratedPoint) {
    const m=point.motion;
    return !!m&&Number.isInteger(m.sensorAccuracy)&&m.sensorAccuracy!>=1&&m.sensorAccuracy!<=3&&[m.samples,m.spanMs,m.maxGapMs,m.rms,m.peak,m.windowMs].every(Number.isFinite)&&m.state==='quiet'&&Number.isInteger(m.samples)&&m.samples>=80&&m.samples<=1000&&m.spanMs>=24000&&m.spanMs<=30000&&m.maxGapMs>=0&&m.maxGapMs<=1000&&m.windowMs===30000&&
        Number.isFinite(m.rms)&&m.rms>=0&&m.rms<=0.08&&Number.isFinite(m.peak)&&m.peak>=m.rms&&m.peak<=0.25;
}
const good=(p:MotionCorroboratedPoint)=>Number.isFinite(p.latitude)&&Math.abs(p.latitude)<=90&&
    Number.isFinite(p.longitude)&&Math.abs(p.longitude)<=180&&Number.isFinite(p.recordedAtMs)&&
    p.accuracy!=null&&Number.isFinite(p.accuracy)&&p.accuracy>=0&&p.accuracy<=30;
const distance=(a:MotionCorroboratedPoint,b:MotionCorroboratedPoint)=>calculateDistanceMeters(a.latitude,a.longitude,b.latitude,b.longitude);
/** Diagnostic candidate only: independent quiet evidence plus a fast spatial return. No raw sample mutation. */
export function assessMotionCorroboratedJitter(points:readonly MotionCorroboratedPoint[]) {
    const candidates:number[]=[];let uncertainReturns=0;
    for(let i=1;i<points.length-1;i++) {
        const [a,b,c]=[points[i-1],points[i],points[i+1]];
        if(![a,b,c].every(good))continue;
        const outMs=b.recordedAtMs-a.recordedAtMs,backMs=c.recordedAtMs-b.recordedAtMs;
        if(outMs<=0||backMs<=0||outMs>30000||backMs>30000)continue;
        const out=distance(a,b),back=distance(b,c);
        if(out<Math.max(50,3*Math.max(a.accuracy!,b.accuracy!))||back<50||out/(outMs/1000)<2||back/(backMs/1000)<2||distance(a,c)>15)continue;
        if([a,b,c].some(p=>reviewUnreliableRawMotion(p.rawMotion).hint==='possible_motion'||p.motion?.state==='moving'||p.rawMotion?.state==='motion_observed'))continue;
        if([a,b,c].every(coveredQuiet))candidates.push(i);else uncertainReturns++;
    }
    return {candidateOriginalIndices:candidates,uncertainReturns,activeFiltering:false as const};
}
