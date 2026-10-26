/** Recording time is independent of coordinate simplification for the map. */
export function getRecordingPeriod(logs: readonly { recordedAt: string }[]) {
    let first: { value: string; time: number } | undefined;
    let last: { value: string; time: number } | undefined;
    for (const log of logs) {
        const time = Date.parse(log.recordedAt);
        if (!Number.isFinite(time)) continue;
        if (!first || time < first.time) first = { value: log.recordedAt, time };
        if (!last || time > last.time) last = { value: log.recordedAt, time };
    }
    return { startAt: first?.value ?? null, endAt: last?.value ?? null };
}
