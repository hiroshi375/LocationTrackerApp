/** Keep the newest owner/session across JS runtimes; never equate a JS boot with a recording. */
export function selectLatestSessionEvidence(rows: Record<string, any>[]) {
    const latest = rows.filter(r => typeof r.userId === 'string' && typeof r.sessionId === 'string' && Number.isFinite(r.observedAtMs))
        .reduce<Record<string, any> | null>((a, r) => !a || r.observedAtMs > a.observedAtMs ? r : a, null);
    if (!latest) return [];
    return rows.filter(r => r.userId === latest.userId && r.sessionId === latest.sessionId)
        .sort((a, b) => a.observedAtMs - b.observedAtMs || a.sequence - b.sequence);
}
