export type AcceptedLocationBaseline = { latitude: number; longitude: number; recordedAt: number };
/** A future live point is never a reason to delete an older offline receipt. */
export function selectAcceptedBaseline(recordedAt: number, ...candidates: (AcceptedLocationBaseline | null | undefined)[]) {
    return candidates.filter((x): x is AcceptedLocationBaseline => !!x &&
        Number.isFinite(x.recordedAt) && x.recordedAt <= recordedAt &&
        Number.isFinite(x.latitude) && Math.abs(x.latitude) <= 90 &&
        Number.isFinite(x.longitude) && Math.abs(x.longitude) <= 180)
        .reduce<AcceptedLocationBaseline | null>((last, x) => !last || x.recordedAt > last.recordedAt ? x : last, null);
}
export const acceptedBaselineKey = (userId: string, sessionId: string) =>
    `location-tracker-accepted-baseline:${encodeURIComponent(userId)}:${encodeURIComponent(sessionId)}`;
type Storage = {getItem(key:string):Promise<string|null>;setItem(key:string,value:string):Promise<void>};
export function createAcceptedBaselineStore(storage: Storage) {
    let tail: Promise<unknown> = Promise.resolve();
    function serial<T>(work:()=>Promise<T>):Promise<T> {
        const result=tail.then(work);tail=result.catch(()=>{});return result;
    }
    async function read(userId:string,sessionId:string) {
        const raw=await storage.getItem(acceptedBaselineKey(userId,sessionId));
        if(!raw)return null;
        const row=JSON.parse(raw);
        if(row.userId!==userId||row.sessionId!==sessionId)throw new Error("ACCEPTED_BASELINE_SCOPE_MISMATCH");
        return row.discarded ? null : selectAcceptedBaseline(Infinity,row.point);
    }
    return {
        discard:(userId:string,sessionId:string)=>serial(()=>storage.setItem(acceptedBaselineKey(userId,sessionId),JSON.stringify({userId,sessionId,discarded:true}))),
        read:(userId:string,sessionId:string)=>serial(()=>read(userId,sessionId)),
        // Existing LocationSaveLock protects cloud decisions; serialization also protects late timeout completions.
        record:(userId:string,sessionId:string,point:AcceptedLocationBaseline)=>serial(async()=>{
            const raw=await storage.getItem(acceptedBaselineKey(userId,sessionId));
            if(raw && JSON.parse(raw).discarded) return;
            const previous=await read(userId,sessionId);
            if(previous&&previous.recordedAt>=point.recordedAt)return;
            if(!selectAcceptedBaseline(Infinity,point))throw new Error("INVALID_ACCEPTED_BASELINE");
            await storage.setItem(acceptedBaselineKey(userId,sessionId),JSON.stringify({userId,sessionId,point}));
        }),
    };
}
