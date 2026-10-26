/** An unreliable sensor may only make an exclusion more conservative, never certify stillness. */
export type RawMotionSummary = {
    state: string;
    sensorAccuracy?: number;
    assessment?: string;
    samples?: number;
    spanMs?: number;
    maxGapMs?: number;
    rms?: number;
    peak?: number;
    windowMs?: number;
};
export type RawMotionRetentionReview = {
    hint: 'possible_motion' | 'none';
    quality: 'unreliable' | 'not_applicable';
    retentionOnly: true;
};
export function reviewUnreliableRawMotion(raw?: RawMotionSummary | null): RawMotionRetentionReview {
    const none: RawMotionRetentionReview = { hint: 'none', quality: raw?.sensorAccuracy === 0 ? 'unreliable' : 'not_applicable', retentionOnly: true };
    if (!raw || raw.sensorAccuracy !== 0 || raw.state !== 'unknown' || raw.assessment !== 'positive_motion_only') return none;
    const { samples, spanMs, maxGapMs, rms, peak } = raw;
    if (![samples, spanMs, maxGapMs, rms, peak].every(v => typeof v === 'number' && Number.isFinite(v))) return none;
    if (!Number.isInteger(samples) || samples! < 80 || samples! > 1000 || spanMs! < 24000 || spanMs! > 30000 ||
        maxGapMs! < 0 || maxGapMs! > 1000 || raw.windowMs !== 30000 || rms! < 0 || peak! < rms! || peak! > 100) return none;
    // For unreliable data, require both energy and a peak; isolated weak spikes are not enough.
    // These are provisional diagnostic thresholds, never permission to exclude GPS samples.
    if (rms! < 0.16 || peak! < 0.5) return none;
    // A residual still dominated by gravity cannot supply a movement hint.
    if (rms! >= 8 && rms! <= 11 && peak! >= 8 && peak! <= 12) return none;
    return { hint: 'possible_motion', quality: 'unreliable', retentionOnly: true };
}

export function summarizeRawMotionRetention(rows: readonly unknown[]) {
    const sessions = new Map<string, { samples: number; unreliable: number; possibleMotionHints: number }>();
    for (const row of rows.slice(0, 5000)) {
        if (!row || typeof row !== 'object') continue;
        const r = row as { recordingSessionId?: unknown; quality?: { motion?: { rawAccelerometer?: RawMotionSummary } } };
        if (typeof r.recordingSessionId !== 'string') continue;
        const raw = r.quality?.motion?.rawAccelerometer;
        if (!raw || typeof raw !== 'object') continue;
        const current = sessions.get(r.recordingSessionId) ?? { samples: 0, unreliable: 0, possibleMotionHints: 0 };
        current.samples++;
        const review = reviewUnreliableRawMotion(raw);
        if (review.quality === 'unreliable') current.unreliable++;
        if (review.hint === 'possible_motion') current.possibleMotionHints++;
        sessions.set(r.recordingSessionId, current);
    }
    return { policy: 'unreliable_retention_only_v1', activeFiltering: false, sessions: Array.from(sessions, ([recordingSessionId, counts]) => ({ recordingSessionId, ...counts })) };
}
