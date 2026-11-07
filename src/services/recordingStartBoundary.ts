/** Compare measurement time, never arrival time. Missing legacy boundaries stay compatible. */
export function isBeforeRecordingStart(recordedAtMs: number, startedAt?: string | null): boolean {
    const start = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
    return Number.isFinite(recordedAtMs) && Number.isFinite(start) && recordedAtMs < start;
}
/** A different session's current plan must never become an old queue row's boundary. */
export function matchingRecordingStart(sessionId: string, plan: { recordingSessionId: string; recordingStartedAt: string } | null): string | null {
    return plan?.recordingSessionId === sessionId ? plan.recordingStartedAt : null;
}
