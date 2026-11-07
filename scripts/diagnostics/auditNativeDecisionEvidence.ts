import fs from "node:fs";
import path from "node:path";

/** Summarize a user-exported diagnostic file without printing coordinates, account IDs or credentials. */
export function auditNativeDecisionEvidence(text: string) {
    const marker = "===== LOCATION DECISION EVIDENCE =====";
    const start = text.lastIndexOf(marker);
    if (start < 0) throw new Error("Location decision evidence section missing");
    const body = text.slice(start + marker.length).split(/\n=====/)[0].trim();
    const snapshot = JSON.parse(body);
    if (snapshot.schema !== 1 || !Array.isArray(snapshot.rows)) throw new Error("Unsupported diagnostic schema");
    const rows = snapshot.rows, nativeRows = rows.filter((r: any) => r.nativeEvidence?.schema === 1);
    const ages: number[] = [], paths: Record<string, number> = {}, providers: Record<string, number> = {};
    const links = new Map<string, Set<string>>();
    for (const row of rows) {
        paths[row.path] = (paths[row.path] ?? 0) + 1;
        if (typeof row.correlationKey === "string") {
            const p = links.get(row.correlationKey) ?? new Set(); p.add(row.path); links.set(row.correlationKey, p);
        }
        const n = row.nativeEvidence;
        if (!n) continue;
        providers[String(n.provider)] = (providers[String(n.provider)] ?? 0) + 1;
        if (/^\d{1,20}$/.test(n.fixElapsedRealtimeNanos) && /^\d{1,20}$/.test(n.receivedElapsedRealtimeNanos))
            ages.push(Number(BigInt(n.receivedElapsedRealtimeNanos) - BigInt(n.fixElapsedRealtimeNanos)) / 1e6);
    }
    const sequences = new Map<string, Set<number>>();
    const lookupStatuses: Record<string, number> = {};
    for (const row of rows) {
        if (Number.isInteger(row.sequence) && row.sequence > 0) {
            const key = row.runtimeId ?? snapshot.runtimeId ?? "unknown";
            const set = sequences.get(key) ?? new Set<number>(); set.add(row.sequence); sequences.set(key, set);
        }
        if (row.lookup?.status) lookupStatuses[row.lookup.status] = (lookupStatuses[row.lookup.status] ?? 0) + 1;
    }
    const missingRowsThroughLastSeen = [...sequences.values()].reduce((n, seq) => n + Math.max(...seq) - seq.size, 0);
    return { runtimeCount: sequences.size, missingRowsThroughLastSeen, lookupStatuses,
        archive: snapshot.archive ? { files: snapshot.archive.files, unreadableFiles: snapshot.archive.unreadableFiles,
            droppedRows: snapshot.archive.droppedRows, writeFailures: snapshot.archive.writeFailures,
            priorRuntimeDroppedRows: snapshot.archive.priorRuntimeDroppedRows,
            priorRuntimeWriteFailures: snapshot.archive.priorRuntimeWriteFailures,
            fileCapReached: snapshot.archive.fileCapReached, archiveFlushed: snapshot.archive.archiveFlushed,
            exportReadFailed: snapshot.archive.exportReadFailed } : null,
        rows: rows.length, evicted: snapshot.evicted, persistenceFailures: snapshot.persistenceFailures,
        paths, nativeEvidenceRows: nativeRows.length,
        nativeCoordinateMismatches: nativeRows.filter((r: any) => r.nativeMatchesJSPoint === false).length,
        nativeReceiptAgeSamples: ages.length, negativeReceiptAges: ages.filter(x => x < 0).length,
        maxNativeReceiptAgeMs: ages.length ? Math.max(...ages) : null,
        nativeSpeedPresent: nativeRows.filter((r: any) => r.nativeEvidence.hasSpeed === true).length,
        nativeSpeedMissing: nativeRows.filter((r: any) => r.nativeEvidence.hasSpeed === false).length,
        nativeSpeedAccuracyPresent: nativeRows.filter((r: any) => r.nativeEvidence.hasSpeedAccuracy === true).length,
        mockedNativeRows: nativeRows.filter((r: any) => r.nativeEvidence.mocked === true).length,
        noBaselineWithFutureCandidate: rows.filter((r: any) => r.stage === "decision" && !r.baseline && r.baselineCandidates?.some((c: any) => c.isFuture === true)).length,
        correlationKeysAcrossPaths: [...links.values()].filter(p => p.size > 1).length,
        providers,
        warning: "Observation only. Missing stages/results are unknown, not proof of rejection. Fused provider does not identify GNSS/Wi-Fi contributions." };
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    if (!process.argv[2]) throw new Error("Provide an exported diagnostic file path");
    console.log(JSON.stringify(auditNativeDecisionEvidence(fs.readFileSync(process.argv[2], "utf8")), null, 2));
}
