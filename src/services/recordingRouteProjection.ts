import { calculateDistanceMeters } from "../utils/locationDuplicate";

export type RecordingRoutePoint = { recordedAtMs: number; latitude: number; longitude: number; accuracy: number | null; speed: number | null };
type Decision = "kept" | "waiting-for-following-fixes" | "held" | "held-at-stop" | "kept-without-evidence";
type Boundary = { startedAtMs: number; observedThroughMs: number; stoppedAtMs?: number };
const WINDOW_MS = 20_000;
const HALF_OUTLIER_WINDOW = 10;
const distance = (a: RecordingRoutePoint, b: RecordingRoutePoint) => calculateDistanceMeters(a.latitude, a.longitude, b.latitude, b.longitude);
export const routePointKey = (p: RecordingRoutePoint) => JSON.stringify([p.recordedAtMs, p.latitude, p.longitude]);
const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
};
const medoid = (points: RecordingRoutePoint[]) => {
    const totals = points.map(p => points.reduce((sum, q) => sum + distance(p, q), 0));
    return points[totals.indexOf(Math.min(...totals))];
};
function hasMovement(points: RecordingRoutePoint[]) {
    if (points.length < 3 || points.at(-1)!.recordedAtMs - points[0].recordedAtMs < 8000) return false;
    if (points.some((point, i) => point.accuracy === null || (i > 0 && point.recordedAtMs - points[i - 1].recordedAtMs > 15000))) return false;
    const accuracy = median(points.map(p => p.accuracy!));
    const net = distance(points[0], points.at(-1)!);
    const length = points.reduce((sum, p, i) => i ? sum + distance(points[i - 1], p) : sum, 0);
    return accuracy <= 25 && net >= Math.max(3, accuracy) && length > 0 && net / length >= 0.30
        && points.filter(p => p.speed !== null && p.speed >= 0.20).length / points.length >= 0.30;
}

function shiftedAtStop(point: RecordingRoutePoint, before: RecordingRoutePoint[]) {
    if (before.length < 4 || point.accuracy === null || point.recordedAtMs - before[0].recordedAtMs < 12000) return false;
    if (before.some((p, i) => p.speed === null || p.speed >= 0.20
        || (i > 0 && p.recordedAtMs - before[i - 1].recordedAtMs > 7500))) return false;
    const anchor = before.slice(0, 3);
    if (anchor.some(p => p.accuracy === null || anchor.some(q => distance(p, q) > 3))) return false;
    return distance(medoid(anchor), point) >= Math.max(5, 2 * Math.max(point.accuracy, median(anchor.map(p => p.accuracy!))));
}

/** Projection only. Source points stay eligible for their existing persistence and upload paths. */
export function projectRecordingRoute(saved: readonly RecordingRoutePoint[], receipts: readonly RecordingRoutePoint[], boundary: Boundary) {
    const end = boundary.stoppedAtMs ?? boundary.observedThroughMs;
    const inSession = (p: RecordingRoutePoint) => p.recordedAtMs >= boundary.startedAtMs && p.recordedAtMs <= end;
    const sortUnique = (points: readonly RecordingRoutePoint[]) =>
        [...new Map(points.filter(inSession).map(p => [routePointKey(p), p])).values()].sort((a, b) => a.recordedAtMs - b.recordedAtMs);
    const native = sortUnique(receipts);
    const indices = new Map(native.map((p, i) => [routePointKey(p), i]));
    const decisions: { point: RecordingRoutePoint; decision: Decision }[] = [];
    let basicPredecessor: RecordingRoutePoint | undefined;
    for (const point of sortUnique(saved)) {
        const index = indices.get(routePointKey(point));
        if (index === undefined) {
            decisions.push({ point, decision: "kept-without-evidence" });
            basicPredecessor = point;
            continue;
        }
        const p = native[index];
        const tail = end - p.recordedAtMs < WINDOW_MS;
        const window = native.slice(Math.max(0, index - HALF_OUTLIER_WINDOW), index + HALF_OUTLIER_WINDOW + 1);
        if (boundary.stoppedAtMs === undefined && (tail || native.length - index - 1 < HALF_OUTLIER_WINDOW)) {
            decisions.push({ point, decision: "waiting-for-following-fixes" });
            continue;
        }
        const center = medoid(window);
        const radii = window.map(q => distance(center, q));
        const mid = median(radii);
        const allowed = window.length < 5 || distance(center, p) <= Math.max(15, mid + 3 * 1.4826 * median(radii.map(x => Math.abs(x - mid))));
        const basic = allowed && (!basicPredecessor || basicPredecessor.accuracy === null || p.accuracy === null
            || distance(basicPredecessor, p) > Math.min(25, Math.max(5, (basicPredecessor.accuracy + p.accuracy) / 2)));
        if (basic) basicPredecessor = p;
        let first = index;
        while (first > 0 && p.recordedAtMs - native[first - 1].recordedAtMs <= WINDOW_MS) first--;
        const before = native.slice(first, index + 1);
        let last = index;
        while (last + 1 < native.length && native[last + 1].recordedAtMs - p.recordedAtMs <= WINDOW_MS) last++;
        const released = hasMovement(before) || (!tail && hasMovement(native.slice(index, last + 1)));
        const decision = !basic && !released ? "held"
            : boundary.stoppedAtMs !== undefined && tail && shiftedAtStop(p, before) ? "held-at-stop" : "kept";
        decisions.push({ point, decision });
    }
    const route = decisions.filter(({ decision }) => decision === "kept" || decision === "kept-without-evidence").map(({ point }) => point);
    return { decisions, route, distanceMeters: route.reduce((sum, p, i) => i ? sum + distance(route[i - 1], p) : sum, 0) };
}
