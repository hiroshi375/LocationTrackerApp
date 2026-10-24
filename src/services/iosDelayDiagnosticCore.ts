/** Diagnostic only: no coordinates, credentials, save decisions or network calls. */
export type DelayEvidence = {
    eventId: string;
    atMs: number;
    reason: string;
    timings: Record<string, number>;
    phases: Record<string, number>;
};
export function createIOSDelayObserver(emit: (value: DelayEvidence) => void) {
    const events = new Map<string, { start: number; timings: Record<string, number>; phases: Record<string, number>; starts: Record<string, number> }>();
    let previousReceipt: number | undefined;
    const output = (eventId: string, atMs: number, reason: string, e: {timings: Record<string, number>; phases: Record<string, number>}) => {
        try { emit({eventId, atMs, reason, timings: {...e.timings}, phases: {...e.phases}}); } catch { /* diagnostics must never affect recording */ }
    };
    return {
        receipt(eventId: string, atMs: number, timestamps: number[]) {
            const valid = timestamps.filter(Number.isFinite);
            const timings: Record<string, number> = {receivedAtMs: atMs};
            if (valid.length) { timings.oldestFixAtMs = Math.min(...valid); timings.latestFixAtMs = Math.max(...valid); timings.deliveryAgeMs = atMs - timings.latestFixAtMs; }
            if (previousReceipt !== undefined) timings.callbackGapMs = atMs - previousReceipt;
            previousReceipt = atMs;
            const e = {start: atMs, timings, phases: {}, starts: {}};
            events.set(eventId, e);
            // Bound memory even when a task never completes.
            while (events.size > 32) events.delete(events.keys().next().value!);
            if (timings.deliveryAgeMs >= 60_000 || timings.callbackGapMs >= 60_000) output(eventId, atMs, 'late_delivery_or_callback_gap', e);
        },
        stage(eventId: string, stage: string, atMs: number, details?: Record<string, unknown>) {
            const e = events.get(eventId);
            if (!e) return;
            // Retain only timing scalars, never arbitrary stage details.
            if (stage.endsWith('_START')) e.starts[stage.slice(0, -6)] = atMs;
            if (stage.endsWith('_END')) {
                const name = stage.slice(0, -4), start = e.starts[name];
                if (start !== undefined) { e.phases[name] = Math.max(e.phases[name] ?? 0, atMs - start); delete e.starts[name]; }
            }
            if (details?.timedOut === true || stage === 'TASK_ERROR') output(eventId, atMs, details?.timedOut ? 'operation_timeout' : 'task_error', e);
            if (stage === 'TASK_FINALLY') {
                e.timings.completedAtMs = atMs;
                e.timings.executionMs = atMs - e.start;
                if (atMs - e.start >= 5_000) output(eventId, atMs, 'slow_task', e);
                events.delete(eventId);
            }
        },
    };
}

export interface DiagnosticStorage { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<unknown> }
export const IOS_DELAY_DIAGNOSTIC_KEY = 'location-tracker-ios-delay-evidence-v1';
/** Single independent bounded ring. No waits in the recording task. */
export function createDelayEvidenceWriter(storage: DiagnosticStorage) {
    let tail = Promise.resolve();
    let pending = 0;
    return (evidence: DelayEvidence): void => {
        if (pending >= 32) return;
        pending++;
        tail = tail.then(async () => {
            let rows: DelayEvidence[] = [];
            try { const parsed = JSON.parse(await storage.getItem(IOS_DELAY_DIAGNOSTIC_KEY) ?? '[]'); if (Array.isArray(parsed)) rows = parsed.slice(-31); } catch { /* corrupt diagnostics must not block recording */ }
            rows.push(evidence);
            await storage.setItem(IOS_DELAY_DIAGNOSTIC_KEY, JSON.stringify(rows));
        }).catch(() => { /* best effort, independent of recording */ }).finally(() => { pending--; });
    };
}
