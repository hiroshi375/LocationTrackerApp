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

/** Prefer durable recording bounds, while preserving legacy and already saved periods. */
export function resolveRecordingSummaryPeriod(
    measured: { startAt: string | null; endAt: string | null },
    existing: { startedAt?: string | null; endedAt?: string | null } | null,
    receipt: { startedAtMs?: number | null; stoppedAtMs: number; state: string } | null,
    autoStoppedAt?: string | null,
) {
    if (existing) return {
        startAt: existing.startedAt ?? measured.startAt,
        endAt: existing.endedAt ?? measured.endAt,
    };
    if (!receipt || !["STOPPED", "SAVE_REQUESTED", "SAVED"].includes(receipt.state) || receipt.startedAtMs == null)
        return measured;
    const start = receipt.startedAtMs, stop = receipt.stoppedAtMs;
    if (!Number.isFinite(start) || !Number.isFinite(stop) || stop < start)
        throw new Error("記録の開始・停止時刻を確認できません。データは保持されています。");
    const automatic = typeof autoStoppedAt === "string" ? Date.parse(autoStoppedAt) : NaN;
    const end = Number.isFinite(automatic) && automatic >= start && automatic <= stop ? automatic : stop;
    return { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() };
}
