import type { LocationObject } from "expo-location";
/** Display/final-fix cache only. Never acknowledges or removes recording inbox rows. */
export function selectScopedNativeLocation(value: string | null, userId: string, sessionId: string, now: number): LocationObject | null {
    if (!value || !userId || !sessionId) return null;
    try {
        const v = JSON.parse(value);
        const p = v.location;
        if (v.userId !== userId || v.sessionId !== sessionId || !p || !p.coords) return null;
        if (!Number.isFinite(p.timestamp) || p.timestamp > now + 1000 || now - p.timestamp > 30000) return null;
        if (!Number.isFinite(p.coords.latitude) || !Number.isFinite(p.coords.longitude)
            || Math.abs(p.coords.latitude) > 90 || Math.abs(p.coords.longitude) > 180) return null;
        return p;
    } catch { return null; }
}
