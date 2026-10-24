import {calculateDistanceMeters} from '../../src/utils/locationDuplicate';
import {assessLocationExcursions,excursionDefaults} from './locationExcursionAssessment';
import type {MotionCorroboratedPoint} from './motionCorroboratedJitter';
import {reviewUnreliableRawMotion} from './rawMotionRetentionPolicy';

/** Offline experiment. Stable anchors narrow suspicion but cannot certify no travel. */
export function assessStableAnchorJitter(points:readonly MotionCorroboratedPoint[]) {
    const base=assessLocationExcursions(points,excursionDefaults);
    const candidates:number[]=[];
    const reasons={multipleSuspectPoints:0,missingContext:0,unstableContext:0,motionVeto:0};
    for(const excursion of base.excursions) {
        if(excursion.suspectIndices.length!==1){reasons.multipleSuspectPoints++;continue;}
        const left=excursion.anchorIndex,right=excursion.returnIndex;
        if(left<2||right+2>=points.length){reasons.missingContext++;continue;}
        const context=[...points.slice(left-2,left+1),...points.slice(right,right+3)];
        const anchor=points[left];
        const stable=context.every(p=>p.accuracy!=null&&Number.isFinite(p.accuracy)&&p.accuracy>=0&&p.accuracy<=15&&
            calculateDistanceMeters(anchor.latitude,anchor.longitude,p.latitude,p.longitude)<=10);
        // Retain gaps, reordered observations and motion before/after the excursion.
        const whole=points.slice(left-2,right+3);
        const contiguous=whole.every((p,i)=>i===0||(p.recordedAtMs>whole[i-1].recordedAtMs&&p.recordedAtMs-whole[i-1].recordedAtMs<=15000));
        const covered=points[left].recordedAtMs-points[left-2].recordedAtMs>=10000&&points[right+2].recordedAtMs-points[right].recordedAtMs>=10000;
        if(!stable||!contiguous||!covered){reasons.unstableContext++;continue;}
        // Include movement hints on both stable context windows, not only the jump.
        if(excursion.classification==='retain_motion'||whole.some(p=>p.motion?.state==='moving'||p.rawMotion?.state==='motion_observed'||reviewUnreliableRawMotion(p.rawMotion).hint==='possible_motion')){reasons.motionVeto++;continue;}
        candidates.push(excursion.suspectIndices[0]);
    }
    const excluded=new Set(candidates);let last:MotionCorroboratedPoint|undefined,hypotheticalDistanceMeters=0;
    for(let i=0;i<points.length;i++) {
        const p=points[i];if(excluded.has(i))continue;
        if(!Number.isFinite(p.latitude)||Math.abs(p.latitude)>90||!Number.isFinite(p.longitude)||Math.abs(p.longitude)>180||!Number.isFinite(p.recordedAtMs)){last=undefined;continue;}
        if(last&&p.recordedAtMs>last.recordedAtMs)hypotheticalDistanceMeters+=calculateDistanceMeters(last.latitude,last.longitude,p.latitude,p.longitude);
        last=p;
    }
    return {geometricCandidateIndices:candidates,reasons,rawDistanceMeters:base.rawDistanceMeters,hypotheticalDistanceMeters,
        automaticExclusionIndices:[] as number[],activeFiltering:false as const,
        unresolvedAmbiguity:'stable_before_after_does_not_prove_no_real_excursion' as const};
}
