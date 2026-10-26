import { calculateDistanceMeters } from "../../src/utils/locationDuplicate";

export type JitterSample = {
    latitude: number; longitude: number; recorded_at_ms: number;
    accuracy: number | null; speed: number | null;
};
const distance = (a:JitterSample,b:JitterSample) => calculateDistanceMeters(a.latitude,a.longitude,b.latitude,b.longitude);
const valid = (p:JitterSample) => Number.isFinite(p.latitude)&&Math.abs(p.latitude)<=90&&
    Number.isFinite(p.longitude)&&Math.abs(p.longitude)<=180&&Number.isFinite(p.recorded_at_ms);
const stationaryReport = (p:JitterSample) => valid(p)&&p.speed!=null&&Number.isFinite(p.speed)&&
    p.speed>=0&&p.speed<=0.5&&p.accuracy!=null&&Number.isFinite(p.accuracy)&&p.accuracy>=0&&p.accuracy<=30;

/**
 * Shadow assessment only. Raw rows, cloud writes and current route calculations remain unchanged.
 * A speed reading alone cannot prove that the user was stationary.
 */
export function assessReturningLocationJitter(input: readonly JitterSample[]) {
    const rows=input.map((point,index)=>({point,index})).sort((a,b)=>a.point.recorded_at_ms-b.point.recorded_at_ms);
    const suspect=new Set<number>();const excursions:{firstIndex:number;lastIndex:number;durationMs:number}[]=[];
    for(let i=2;i<rows.length-2;i++) {
        const anchor=rows[i].point, before=rows[i-1].point, earlier=rows[i-2].point;
        if(![earlier,before,anchor].every(stationaryReport))continue;
        // Require a stable, observed anchor, not just the preceding GPS fix.
        const anchorSpan=anchor.recorded_at_ms-earlier.recorded_at_ms;
        if(anchorSpan<10000||anchorSpan>60000||before.recorded_at_ms<=earlier.recorded_at_ms||
            anchor.recorded_at_ms<=before.recorded_at_ms||distance(earlier,anchor)>15||distance(before,anchor)>15)continue;
        const first=rows[i+1].point;
        if(!stationaryReport(first))continue;
        const outboundMs=first.recorded_at_ms-anchor.recorded_at_ms;
        const outward=distance(anchor,first);
        if(outboundMs<=0||outboundMs>30000||outward<Math.max(50,3*Math.max(anchor.accuracy!,first.accuracy!))||outward/(outboundMs/1000)<2)continue;
        // A short return must contradict reported motion throughout the whole excursion.
        for(let j=i+2;j<Math.min(rows.length,i+8);j++) {
            const current=rows[j].point, previous=rows[j-1].point;
            const duration=current.recorded_at_ms-anchor.recorded_at_ms;
            if(duration>90000||current.recorded_at_ms<=previous.recorded_at_ms||!stationaryReport(current))break;
            const returnTolerance=Math.max(8,Math.min(15,anchor.accuracy!+current.accuracy!));
            if(distance(anchor,current)>returnTolerance)continue;
            const returnMs=current.recorded_at_ms-previous.recorded_at_ms;
            if(returnMs<=0||distance(previous,current)/(returnMs/1000)<2)break;
            for(let k=i+1;k<j;k++)suspect.add(rows[k].index);
            excursions.push({firstIndex:rows[i+1].index,lastIndex:rows[j-1].index,durationMs:duration});
            i=j-1;break;
        }
    }
    const pathDistance=(items:typeof rows)=>items.slice(1).reduce((sum,row,i)=>{
        const previous=items[i].point;
        return sum+(valid(previous)&&valid(row.point)&&row.point.recorded_at_ms>previous.recorded_at_ms?distance(previous,row.point):0);
    },0);
    const retained=rows.filter(row=>!suspect.has(row.index));
    return {suspectedOriginalIndices:[...suspect].sort((a,b)=>a-b),excursions,
        rawDistanceMeters:pathDistance(rows),candidateDistanceMeters:pathDistance(retained),
        assessmentVersion:"return-low-speed-shadow-v1" as const,activeFiltering:false as const};
}
