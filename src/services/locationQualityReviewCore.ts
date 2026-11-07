import { calculateDistanceMeters } from '../utils/locationDuplicate';
export type ReviewPoint = { userId: string; sessionId: string; latitude: number; longitude: number; recordedAtMs: number };
export const qualityReviewKey = (p: ReviewPoint) => 'location-quality-review-v1:' + encodeURIComponent(JSON.stringify([
    p.userId, p.sessionId, p.recordedAtMs, p.latitude, p.longitude]));
/** A durable hold, not a deletion. Never expires or releases itself on a different baseline. */
export function createQualityReviewStore(storage: { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> }) {
    return {
        hold: async (point: ReviewPoint, reason: 'abnormalSpeed') => {
            if (!point.userId || !point.sessionId || ![point.latitude, point.longitude, point.recordedAtMs].every(Number.isFinite)) throw Error('INVALID_QUALITY_REVIEW_POINT');
            await storage.setItem(qualityReviewKey(point), JSON.stringify({ schema: 1, point, reason }));
        },
        read: async (point: ReviewPoint) => {
            const value = await storage.getItem(qualityReviewKey(point)); if (!value) return null;
            const row = JSON.parse(value);
            if (row.schema !== 1 || !row.point || qualityReviewKey(row.point) !== qualityReviewKey(point) || row.reason !== 'abnormalSpeed') throw Error('INVALID_QUALITY_REVIEW_RECEIPT');
            return row as { schema: 1; point: ReviewPoint; reason: 'abnormalSpeed' };
        },
    };
}
/** OFFLINE candidate only: thresholds are hypotheses, not production acceptance rules. */
export function assessNativeMovementCandidate(previous: { latitude: number; longitude: number; recordedAtMs: number } | null,
    current: { latitude: number; longitude: number; recordedAtMs: number },
    native: { hasSpeed?: boolean; speedMetersPerSecond?: number | null; hasSpeedAccuracy?: boolean; speedAccuracyMetersPerSecond?: number | null } | null) {
    if (!previous || current.recordedAtMs <= previous.recordedAtMs) return { status: 'insufficient-evidence' as const };
    const meters = calculateDistanceMeters(previous.latitude, previous.longitude, current.latitude, current.longitude);
    const coordinateSpeed = meters / ((current.recordedAtMs - previous.recordedAtMs) / 1000);
    if (!native?.hasSpeed || !native.hasSpeedAccuracy || !Number.isFinite(native.speedMetersPerSecond) ||
        !Number.isFinite(native.speedAccuracyMetersPerSecond) || native.speedMetersPerSecond! < 0 || native.speedAccuracyMetersPerSecond! < 0)
        return { status: 'insufficient-evidence' as const, meters, coordinateSpeed };
    const reportedUpper = native.speedMetersPerSecond! + 5 * native.speedAccuracyMetersPerSecond! + 5;
    return { status: meters >= 100 && coordinateSpeed > reportedUpper ? 'review-candidate' as const : 'no-candidate' as const,
        meters, coordinateSpeed, reportedUpper };
}

/** Keyset pagination skips held rows without changing their status or starving later valid rows. */
export async function collectNonHeldRows<T extends { recorded_at_ms: number; location_log_id: string }>(input: {
    fetch: (after: { recordedAtMs: number; locationLogId: string }) => Promise<T[]>;
    isHeld: (row: T) => Promise<boolean>; limit: number; deadlineAtMs: number; now: () => number;
}) {
    let after = { recordedAtMs: Number.MIN_SAFE_INTEGER, locationLogId: '' };
    const rows: T[] = []; let heldCount = 0;
    while (rows.length < input.limit && input.now() < input.deadlineAtMs) {
        const page = await input.fetch(after); if (!page.length) break;
        for (const row of page) {
            if (input.now() >= input.deadlineAtMs) return { rows, heldCount };
            if (await input.isHeld(row)) heldCount++; else rows.push(row);
            after = { recordedAtMs: row.recorded_at_ms, locationLogId: row.location_log_id };
            if (rows.length >= input.limit) break;
        }
    }
    return { rows, heldCount };
}
