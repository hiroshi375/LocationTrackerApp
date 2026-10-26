import {calculateDistanceMeters} from '../../src/utils/locationDuplicate';
import {reviewUnreliableRawMotion} from './rawMotionRetentionPolicy';
import type {MotionCorroboratedPoint} from './motionCorroboratedJitter';
export type SpeedConsistencyPoint=MotionCorroboratedPoint&{reportedSpeed:number|null;speedAccuracy:number|null};
/** End-point speeds are instantaneous estimates, not a bound on the intervening path. */
export function reviewLocationSpeedConsistency(a:SpeedConsistencyPoint,b:SpeedConsistencyPoint) {
    const keep=(reason:string)=>({reason,suspect:false,automaticExclusion:false as const});
    if([a,b].some(p=>p.motion?.state==='moving'||p.rawMotion?.state==='motion_observed'||reviewUnreliableRawMotion(p.rawMotion).hint==='possible_motion'))return keep('retain_motion');
    if([a,b].some(p=>!Number.isFinite(p.latitude)||Math.abs(p.latitude)>90||!Number.isFinite(p.longitude)||Math.abs(p.longitude)>180||!Number.isFinite(p.recordedAtMs)))return keep('invalid_position');
    const dt=(b.recordedAtMs-a.recordedAtMs)/1000;
    if(dt<=0||dt>15)return keep('gap_or_chronology');
    if([a,b].some(p=>p.reportedSpeed==null||!Number.isFinite(p.reportedSpeed)||p.reportedSpeed<0||p.speedAccuracy==null||!Number.isFinite(p.speedAccuracy)||p.speedAccuracy<0||p.speedAccuracy>.5||p.accuracy==null||!Number.isFinite(p.accuracy)||p.accuracy<0||p.accuracy>30))return keep('missing_or_weak_quality');
    // Any positive lower estimate protects slow travel. Zero/absence is not stillness.
    if([a,b].some(p=>p.reportedSpeed!-3*p.speedAccuracy!>.3))return keep('retain_reported_motion');
    const distance=calculateDistanceMeters(a.latitude,a.longitude,b.latitude,b.longitude);
    // The multiplier is a provisional comparison threshold, not a guaranteed
    // confidence bound (no Gaussian or independence assumptions are made).
    const heuristicAllowance=Math.max(a.reportedSpeed!+3*a.speedAccuracy!,b.reportedSpeed!+3*b.speedAccuracy!)*dt+3*(a.accuracy!+b.accuracy!);
    return {reason:distance>Math.max(50,heuristicAllowance)?'suspect_endpoint_disagreement':'consistent_or_uncertain',
        suspect:distance>Math.max(50,heuristicAllowance),distanceMeters:distance,heuristicAllowanceMeters:heuristicAllowance,automaticExclusion:false as const};
}
