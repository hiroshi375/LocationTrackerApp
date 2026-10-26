import { calculateDistanceMeters } from "../../src/utils/locationDuplicate";
export type MotionEvidencePoint = { latitude:number; longitude:number; recorded_at_ms:number; accuracy:number|null; speed:number|null };
/** Diagnostic only: never rewrites or filters stored points; output contains no coordinates. */
export function summarizeLocationMotionEvidence(points: MotionEvidencePoint[]) {
    const rows=[...points].sort((a,b)=>a.recorded_at_ms-b.recorded_at_ms);
    let jumps=0, slowJumps=0, unknownSpeedJumps=0, computedDistanceMeters=0;
    for(let i=1;i<rows.length;i++) {
        const previous=rows[i-1],row=rows[i];
        if(row.recorded_at_ms<=previous.recorded_at_ms)continue;
        const distance=calculateDistanceMeters(previous.latitude,previous.longitude,row.latitude,row.longitude);
        computedDistanceMeters+=distance;
        if(distance>=50) {
            jumps++;
            if(row.speed==null||!Number.isFinite(row.speed)||row.speed<0)unknownSpeedJumps++;
            else if(row.speed<=0.5)slowJumps++;
        }
    }
    const speeds=rows.map(x=>x.speed).filter((x):x is number=>x!=null&&Number.isFinite(x)&&x>=0).sort((a,b)=>a-b);
    return {pointCount:rows.length,reportedSpeedCount:speeds.length,reportedSpeedMedian:speeds.length?speeds[Math.floor(speeds.length/2)]:null,
        jumpsOver50m:jumps,jumpsOver50mWithReportedSpeedUnder0_5:slowJumps,jumpsOver50mWithUnknownSpeed:unknownSpeedJumps,computedDistanceMeters};
}

/** Timestamp matching supports offline assessment without exporting any coordinates or coordinate-derived IDs. */
export function projectMotionSampleEvidence(points: readonly MotionEvidencePoint[]) {
    return points.map(point=>({recordedAtMs:point.recorded_at_ms,reportedSpeed:point.speed,reportedAccuracy:point.accuracy}));
}
