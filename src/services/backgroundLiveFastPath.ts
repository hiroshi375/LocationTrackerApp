type Point = { timestamp: number; coords: { latitude: number; longitude: number } };
type SharingState = {
    userId: string;
    shareRevision?: number;
    liveShareOwnerValues: readonly string[];
    startedAt?: string | null;
    isRecording: boolean;
};

/** A current-location-only lane. It has no recording, queue or state-write dependency. */
export async function runBackgroundLiveFastPath<S extends SharingState, P extends Point>(params: {
    locations: P[];
    nowMs: number;
    loadState: () => Promise<S | null>;
    authorize: (userId: string) => Promise<boolean>;
    schedule: (state: S, location: P) => Promise<{ succeeded: boolean }> | null;
}): Promise<string> {
    const state = await params.loadState();
    if (!state || !state.userId || !state.liveShareOwnerValues?.length ||
        !Number.isSafeInteger(state.shareRevision) || (state.shareRevision ?? 0) < 1) return "inactive";
    const point = params.locations.filter(p => Number.isFinite(p?.timestamp) &&
        Number.isFinite(p?.coords?.latitude) && Math.abs(p.coords.latitude) <= 90 &&
        Number.isFinite(p?.coords?.longitude) && Math.abs(p.coords.longitude) <= 180)
        .reduce<P | null>((latest, p) => !latest || p.timestamp > latest.timestamp ? p : latest, null);
    if (!point || params.nowMs - point.timestamp > 90_000 || point.timestamp - params.nowMs > 10_000)
        return "stale_or_invalid";
    // A batch received before a new recording must not become that recording's current point.
    const startedAt = state.startedAt ? Date.parse(state.startedAt) : NaN;
    if (state.isRecording && (!Number.isFinite(startedAt) || point.timestamp < startedAt)) return "before_session";
    if (!await params.authorize(state.userId)) return "wrong_user";
    // The existing sender rechecks current owner/session and enforces the captured share revision server-side.
    const result = await params.schedule(state, point);
    return result ? result.succeeded ? "updated" : "failed" : "coalesced";
}
