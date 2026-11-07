export const PROBE_APPLICATION_ID = 'com.hiroshisato.locationtrackerapp.locationprobe';
export type ProbeRun = { schema: 1; id: string; mode: 'foreground' | 'background'; startedAtMs: number; deadlineMs: number; stoppedAtMs?: number };
export function makeProbeRun(mode: ProbeRun['mode'], now: number, backgroundMinutes: 10 | 110 = 10): ProbeRun {
    return { schema: 1, id: `probe-${now}-${Math.random().toString(36).slice(2)}`, mode,
        startedAtMs: now, deadlineMs: now + (mode === 'foreground' ? 5 : backgroundMinutes) * 60_000 };
}
/** Do not mix cached pre-start fixes or post-deadline observations into this comparison. */
export function inProbeWindow(run: ProbeRun, timestamp: number) {
    return Number.isFinite(timestamp) && timestamp >= run.startedAtMs && timestamp <= Math.min(run.deadlineMs, run.stoppedAtMs ?? Infinity);
}
export function probeOptions() { return { timeInterval: 5000, distanceInterval: 0, deferredUpdatesInterval: 0, deferredUpdatesDistance: 0, pausesUpdatesAutomatically: false }; }

/** A timeout exposes unknown completion; it does not claim the Native operation was cancelled. */
export async function withProbeDeadline<T>(work: Promise<T>, label: string, timeoutMs = 15000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work,new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new Error(`PROBE_OPERATION_TIMEOUT:${label}`)),timeoutMs);
    })]); } finally { if(timer)clearTimeout(timer); }
}
