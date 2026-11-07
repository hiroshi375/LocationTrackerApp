/** Local observation only. Never used to decide whether a location is saved. */
export const LOCATION_DECISION_DIAGNOSTIC_KEY = "location-tracker-location-decision-diagnostic-v1";
export type DiagnosticPoint = { latitude: number; longitude: number; recordedAtMs: number; accuracy?: number | null; speed?: number | null };
export type LocationDecisionObservation = {
    path: "foreground" | "background-direct" | "native-inbox" | "sqlite-queue" | "cloud-write";
    stage: "receipt" | "baseline" | "decision" | "cloud-result";
    userId: string; sessionId: string;
    point: DiagnosticPoint;
    pointId?: string;
    nativeRowId?: number;
    nativeEvidence?: unknown;
    receivedAtMs?: number;
    baseline?: DiagnosticPoint | null;
    baselineCandidates?: { name: "foreground" | "background" | "merged-foreground-background" | "shared" | "accepted-predecessor" | "previous-in-batch"; point: DiagnosticPoint | null }[];
    lookup?: { status: "found" | "not-found" | "read-error"; atOrBeforeMs: number;
        returnedCount: number | null; selectedQueueStatus?: string; sharedReadStatus?: "found" | "not-found" | "read-error"; startedAtMs: number; completedAtMs: number };
    timing?: { lockAcquiredAtMs?: number; operationStartedAtMs?: number };
    reason?: string;
    forceSave?: boolean;
    intervalMs?: number; distanceMeters?: number;
};

export function nativeLocationEvidence(location: unknown): unknown {
    return location && typeof location === "object" ? (location as { aclogNativeEvidence?: unknown }).aclogNativeEvidence : undefined;
}
export function sanitizeNativeLocationEvidence(value: unknown): Record<string, unknown> | null {
    try {
        if (typeof value === "string" && value.length > 4096) return null;
        const v = typeof value === "string" ? JSON.parse(value) : value;
        if (!v || typeof v !== "object" || v.schema !== 1) return null;
        const number = (x: unknown) => typeof x === "number" && Number.isFinite(x) ? x : null;
        const bool = (x: unknown) => typeof x === "boolean" ? x : null;
        const nanos = (x: unknown) => typeof x === "string" && /^\d{1,20}$/.test(x) ? x : null;
        const r = v.receiptSnapshot;
        const receiptSnapshot = r && typeof r === "object" ? {
            latitude: number(r.latitude), longitude: number(r.longitude), fixTimeMs: number(r.fixTimeMs),
            fixElapsedRealtimeNanos: nanos(r.fixElapsedRealtimeNanos),
            receiptId: typeof r.receiptId === "string" ? r.receiptId.slice(0, 128) : null,
            hasAccuracy: bool(r.hasAccuracy), accuracyMeters: r.hasAccuracy === true ? number(r.accuracyMeters) : null,
            hasSpeed: bool(r.hasSpeed), speedMetersPerSecond: r.hasSpeed === true ? number(r.speedMetersPerSecond) : null,
            hasSpeedAccuracy: bool(r.hasSpeedAccuracy), speedAccuracyMetersPerSecond: r.hasSpeedAccuracy === true ? number(r.speedAccuracyMetersPerSecond) : null,
            provider: typeof r.provider === "string" ? r.provider.slice(0, 64) : null, mocked: bool(r.mocked),
        } : null;
        return { receiptSnapshot,
            receiptSource: ["foreground-result", "background-result", "background-last-location-fallback"].includes(v.receiptSource) ? v.receiptSource : null,
            requestId: typeof v.requestId === "string" ? v.requestId.slice(0, 128) : null,
            receiptMatchesSerialized: receiptSnapshot ? receiptSnapshot.latitude === number(v.latitude) && receiptSnapshot.longitude === number(v.longitude)
                && receiptSnapshot.fixTimeMs === number(v.fixTimeMs) && receiptSnapshot.fixElapsedRealtimeNanos === nanos(v.fixElapsedRealtimeNanos) : null,
            schema: 1, captureStage: v.captureStage === "native-location-serialization" ? v.captureStage : null,
            fixTimeMs: number(v.fixTimeMs), latitude: number(v.latitude), longitude: number(v.longitude),
            fixElapsedRealtimeNanos: nanos(v.fixElapsedRealtimeNanos), capturedElapsedRealtimeNanos: nanos(v.capturedElapsedRealtimeNanos),
            receivedElapsedRealtimeNanos: nanos(v.receivedElapsedRealtimeNanos), receivedWallTimeMs: number(v.receivedWallTimeMs),
            capturedWallTimeMs: number(v.capturedWallTimeMs), bootCount: number(v.bootCount),
            hasAccuracy: bool(v.hasAccuracy), accuracyMeters: v.hasAccuracy === true ? number(v.accuracyMeters) : null,
            hasSpeed: bool(v.hasSpeed), speedMetersPerSecond: v.hasSpeed === true ? number(v.speedMetersPerSecond) : null,
            hasSpeedAccuracy: bool(v.hasSpeedAccuracy), speedAccuracyMetersPerSecond: v.hasSpeedAccuracy === true ? number(v.speedAccuracyMetersPerSecond) : null,
            provider: typeof v.provider === "string" ? v.provider.slice(0, 64) : null, mocked: bool(v.mocked) };
    } catch { return null; }
}

/** Fixed allowlist: credentials, arbitrary objects and exceptions never enter the ring. */
export function createLocationDecisionDiagnostics(options: {
    enabled: boolean;
    runtimeId: string;
    now: () => number;
    persist?: (snapshot: string) => Promise<unknown>;
    capacity?: number;
    onRow?: (row: Record<string, unknown>) => void;
}) {
    const capacity = Number.isFinite(options.capacity) ? Math.min(1024, Math.max(1, Math.floor(options.capacity!))) : 1024;
    const rows: Record<string, unknown>[] = [];
    let sequence = 0, evicted = 0, persistenceFailures = 0, pending = false, dirty = false;
    const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? n : null;
    const point = (p: DiagnosticPoint) => ({ latitude: finite(p.latitude), longitude: finite(p.longitude),
        recordedAtMs: finite(p.recordedAtMs), accuracy: finite(p.accuracy), speed: finite(p.speed),
        // Expo's normal payload does not expose these validity flags. Zero is not evidence of stillness.
        speedValidity: "not_exposed", speedAccuracy: null, fixElapsedRealtimeNanos: null });
    const text = (v: unknown) => typeof v === "string" ? v.slice(0, 256) : undefined;
    const snapshot = () => JSON.stringify({ schema: 1, runtimeId: text(options.runtimeId), sequence,
        evicted, persistenceFailures, rows });
    const flush = () => {
        if (!options.persist || pending) return;
        pending = true; dirty = false;
        let value: string;
        try { value = snapshot(); } catch { pending = false; persistenceFailures++; return; }
        // No recording-path await; at most one write and one latest-state coalesced write.
        Promise.resolve().then(() => options.persist!(value)).catch(() => { persistenceFailures++; })
            .finally(() => { pending = false; if (dirty) flush(); });
    };
    return {
        capture(build: () => LocationDecisionObservation): void {
            if (!options.enabled) return;
            try {
                const e = build();
                if (!e.userId || !e.sessionId) return;
                const native = sanitizeNativeLocationEvidence(e.nativeEvidence);
                const row = { runtimeId: text(options.runtimeId), sequence: ++sequence, observedAtMs: finite(options.now()),
                    path: text(e.path), stage: text(e.stage), userId: text(e.userId), sessionId: text(e.sessionId),
                    correlationKey: JSON.stringify([text(e.userId), text(e.sessionId), finite(e.point.recordedAtMs), finite(e.point.latitude), finite(e.point.longitude)]),
                    point: { ...point(e.point), speedValidity: native?.hasSpeed === true ? "native-reported-present"
                        : native?.hasSpeed === false ? "native-reported-missing" : "not_exposed",
                        speedAccuracy: native?.speedAccuracyMetersPerSecond ?? null,
                        fixElapsedRealtimeNanos: native?.fixElapsedRealtimeNanos ?? null },
                    pointId: text(e.pointId), nativeRowId: finite(e.nativeRowId),
                    nativeEvidence: native,
                    nativeMatchesJSPoint: native ? native.fixTimeMs === e.point.recordedAtMs && native.latitude === e.point.latitude && native.longitude === e.point.longitude : null,
                    receivedAtMs: finite(e.receivedAtMs), baseline: e.baseline ? point(e.baseline) : null,
                    baselineCandidates: e.baselineCandidates?.slice(0, 5).map(c => ({ name: text(c.name),
                        point: c.point ? point(c.point) : null,
                        isFuture: c.point ? c.point.recordedAtMs > e.point.recordedAtMs : null })),
                    lookup: e.lookup ? { status: ["found", "not-found", "read-error"].includes(e.lookup.status) ? e.lookup.status : null,
                        atOrBeforeMs: finite(e.lookup.atOrBeforeMs), returnedCount: finite(e.lookup.returnedCount),
                        sharedReadStatus: ["found", "not-found", "read-error"].includes(e.lookup.sharedReadStatus ?? "") ? e.lookup.sharedReadStatus : null,
                        selectedQueueStatus: ["sent", "duplicate"].includes(e.lookup.selectedQueueStatus ?? "") ? e.lookup.selectedQueueStatus : null,
                        startedAtMs: finite(e.lookup.startedAtMs), completedAtMs: finite(e.lookup.completedAtMs) } : null,
                    timing: e.timing ? { lockAcquiredAtMs: finite(e.timing.lockAcquiredAtMs), operationStartedAtMs: finite(e.timing.operationStartedAtMs) } : null,
                    reason: text(e.reason), forceSave: e.forceSave === true,
                    intervalMs: finite(e.intervalMs), distanceMeters: finite(e.distanceMeters) };
                rows.push(row);
                try { options.onRow?.(row); } catch { /* Archive failure cannot affect the ring or recording. */ }
                if (rows.length > capacity) { rows.shift(); evicted++; }
                // Conservative UTF-8 bound (<=3 bytes per UTF-16 code unit), including metadata.
                while (rows.length && snapshot().length * 3 > 512 * 1024) { rows.shift(); evicted++; }
                dirty = true; flush();
            } catch { /* An observer must never break recording, handoff or upload. */ }
        },
        snapshot,
    };
}
