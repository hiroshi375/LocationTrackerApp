export type RecordingDeliveryContext = {
    userId: string;
    recordingSessionId: string;
    startedAtMs: number;
    intervalMs: number;
    distanceMeters: number;
};
type InboxLocation = { timestamp: number; coords: { latitude: number; longitude: number } };
export type RecordingInboxBatch = { context: RecordingDeliveryContext; rows: { id: number; location: InboxLocation }[] };

export function matchesRecordingReceipt(location: { timestamp: number; aclogOwner?: string; aclogSessionId?: string },
    state: { userId: string; isRecording: boolean; recordingSessionId?: string | null; startedAt?: string | null } | null | undefined): boolean {
    if (!location.aclogOwner) return true; // Old clients and iOS retain their existing path.
    if (location.aclogOwner !== state?.userId) return false;
    if (!state.isRecording) return true; // Same-owner sharing must continue after recording stops.
    const start = state.startedAt ? Date.parse(state.startedAt) : NaN;
    return location.aclogSessionId === state.recordingSessionId && Number.isFinite(start) && location.timestamp >= start;
}

/** The native receipt is acknowledged only after every point exists durably in JS SQLite. */
export async function handoffRecordingInboxBatch(params: {
    batch: RecordingInboxBatch;
    persist: (batch: RecordingInboxBatch) => Promise<{ receivedCount: number; insertedCount: number; duplicateCount: number; invalidCount: number }>;
    acknowledge: (context: RecordingDeliveryContext, ids: number[]) => Promise<void>;
}): Promise<void> {
    const { context: c, rows } = params.batch;
    if (!c || !c.userId || !c.recordingSessionId || !Number.isFinite(c.startedAtMs) ||
        !Number.isFinite(c.intervalMs) || c.intervalMs <= 0 ||
        !Number.isFinite(c.distanceMeters) || c.distanceMeters < 0 || !Array.isArray(rows) ||
        !rows.length || rows.length > 25 || new Set(rows.map(r => r.id)).size !== rows.length)
        throw new Error("INVALID_NATIVE_RECORDING_CONTEXT");
    for (const row of rows) {
        const p = row.location;
        if (!Number.isSafeInteger(row.id) || row.id < 1 || !Number.isFinite(p?.timestamp) ||
            p.timestamp < c.startedAtMs || !Number.isFinite(p?.coords?.latitude) ||
            Math.abs(p.coords.latitude) > 90 || !Number.isFinite(p?.coords?.longitude) || Math.abs(p.coords.longitude) > 180)
            throw new Error("INVALID_NATIVE_RECORDING_POINT");
    }
    const result = await params.persist(params.batch);
    if (result.invalidCount !== 0 || result.receivedCount !== rows.length ||
        result.insertedCount + result.duplicateCount !== rows.length)
        throw new Error("NATIVE_RECORDING_HANDOFF_INCOMPLETE");
    await params.acknowledge(c, rows.map(r => r.id));
}
