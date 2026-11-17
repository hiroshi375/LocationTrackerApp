import { calculateDistanceMeters } from "../utils/locationDuplicate";
import { projectRecordingRoute, routePointKey, type RecordingRoutePoint } from "./recordingRouteProjection";

export type RecordingMapEvidence = {
    startedAtMs: number;
    stoppedAtMs?: number;
    receipts: readonly RecordingRoutePoint[];
};
type MapLog = { id: string; recordedAt: string; latitude: number; longitude: number; accuracy?: number | null };

export function recordingMapEvidence(
    startedAtMs: number,
    receipts: readonly RecordingRoutePoint[],
    stoppedAtMs?: number,
): RecordingMapEvidence | null {
    if (!Number.isFinite(startedAtMs)
        || (stoppedAtMs !== undefined && (!Number.isFinite(stoppedAtMs) || stoppedAtMs < startedAtMs))) return null;

    const inSession = receipts.filter(point => point.recordedAtMs >= startedAtMs
        && (stoppedAtMs === undefined || point.recordedAtMs <= stoppedAtMs)).sort((a, b) => a.recordedAtMs - b.recordedAtMs);
    if (!inSession.length || inSession[0].recordedAtMs - startedAtMs > 15_000
        || !inSession.some(point => point.speed !== null)
        || inSession.some((point, index) => index > 0 && point.recordedAtMs - inSession[index - 1].recordedAtMs > 15_000)) return null;
    if (stoppedAtMs !== undefined
        && (inSession.length < 4 || stoppedAtMs - inSession.at(-1)!.recordedAtMs > 15_000)) return null;
    return { startedAtMs, stoppedAtMs, receipts: inSession };
}

export function buildRecordingMapRoute<T extends MapLog>(logs: readonly T[], evidence: RecordingMapEvidence, legacyLogs: readonly T[]) {
    const byPoint = new Map<string, T>();
    const points: RecordingRoutePoint[] = [];
    for (const log of logs) {
        const point = {
            recordedAtMs: Date.parse(log.recordedAt), latitude: log.latitude, longitude: log.longitude,
            accuracy: typeof log.accuracy === "number" && Number.isFinite(log.accuracy) && log.accuracy >= 0 ? log.accuracy : null,
            speed: null,
        };
        if (!Number.isFinite(point.recordedAtMs) || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)
            || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) continue;
        const key = routePointKey(point);
        if (byPoint.has(key)) continue;
        byPoint.set(key, log);
        points.push(point);
    }
    const receiptKeys = new Set(evidence.receipts.map(routePointKey));
    if (!points.some(point => receiptKeys.has(routePointKey(point)))) return null;
    const legacyIds = new Set(legacyLogs.map(log => log.id));
    const result = projectRecordingRoute(points, evidence.receipts, {
        startedAtMs: evidence.startedAtMs,
        stoppedAtMs: evidence.stoppedAtMs,
        observedThroughMs: evidence.receipts.at(-1)!.recordedAtMs,
    });
    const route = result.decisions.flatMap(({ point, decision }) => {
        const log = byPoint.get(routePointKey(point))!;
        return decision === "kept" || (decision === "kept-without-evidence" && legacyIds.has(log.id)) ? [log] : [];
    });
    return {
        logs: route,
        distanceMeters: route.reduce((sum, point, index) => {
            const previous = route[index - 1];
            return previous ? sum + calculateDistanceMeters(previous.latitude, previous.longitude, point.latitude, point.longitude) : sum;
        }, 0),
    };
}

export function changedRecordingMapDistance(before: number, after: number) {
    return Math.round(before) !== Math.round(after) ? { before: Math.round(before), after: Math.round(after) } : null;
}
