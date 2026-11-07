import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import ts from "typescript";
import * as predicates from "../../src/utils/locationDuplicate";
import { selectAcceptedBaseline, type AcceptedLocationBaseline } from "../../src/services/acceptedLocationBaselineCore";
import { normalizeRouteLogs, calculateRouteDistanceMeters } from "../../src/lib/locationRoute";

const root = path.resolve(__dirname, "../..");
const files = { queue: "src/services/locationQueueUploadService.ts", background: "src/tasks/backgroundLocationTask.ts",
    foreground: "src/hooks/useForegroundLocationRecorder.ts" };

/** Evaluate the actual checked-in pure function, without loading React, SQLite or AWS. */
function loadPredicate(file: string, name: string, callback = false): (...args: any[]) => any {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let expression: string | undefined;
    const visit = (node: ts.Node) => {
        if (!callback && ts.isFunctionDeclaration(node) && node.name?.text === name)
            expression = `(${node.getText(ast)})`;
        if (callback && ts.isVariableDeclaration(node) && node.name.getText(ast) === name &&
            node.initializer && ts.isCallExpression(node.initializer))
            expression = `(${node.initializer.arguments[0].getText(ast)})`;
        ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!expression) throw new Error(`Predicate not found: ${file}:${name}`);
    const js = ts.transpileModule(`globalThis.result = ${expression}`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const context = vm.createContext({ ...predicates, DEFAULT_INTERVAL_MS: 30_000, DEFAULT_DISTANCE_METERS: 50,
        getActiveRecordingSettings: () => ({ intervalMs: 30_000, distanceMeters: 50 }) });
    vm.runInContext(js, context, { timeout: 1000 });
    return context.result;
}
export const queuePredicate = loadPredicate(files.queue, "evaluateQueueLocationSkipReason");
export const backgroundSavePredicate = loadPredicate(files.background, "shouldSaveLocation");
export const foregroundSavePredicate = loadPredicate(files.foreground, "shouldSaveLocation", true);

type Row = { id: string; userId: string; recordingSessionId: string; latitude: number; longitude: number;
    accuracy: number | null; recordedAt: string; createdAt: string; source?: string };
export function replay(rows: Row[], order: "measured" | "server-created", backgroundPath: "queue" | "direct") {
    const sorted = [...rows].sort((a, b) => Date.parse(order === "measured" ? a.recordedAt : a.createdAt) -
        Date.parse(order === "measured" ? b.recordedAt : b.createdAt));
    const scopes = new Set(rows.map(r => `${r.userId}\0${r.recordingSessionId}`));
    if (scopes.size !== 1) throw new Error("Replay requires exactly one owner/session");
    let shared: AcceptedLocationBaseline | null = null, fg: AcceptedLocationBaseline | null = null,
        bg: AcceptedLocationBaseline | null = null;
    const accepted: Row[] = [], trace: Record<string, unknown>[] = [];
    const latest = (...points: (AcceptedLocationBaseline | null)[]) => points.reduce<AcceptedLocationBaseline | null>(
        (a, b) => b && (!a || b.recordedAt > a.recordedAt) ? b : a, null);
    for (const row of sorted) {
        const time = Date.parse(row.recordedAt), point = { latitude: Number(row.latitude), longitude: Number(row.longitude), recordedAt: time };
        if (!Number.isFinite(time) || !Number.isFinite(Date.parse(row.createdAt))) throw new Error("Invalid timestamps");
        const isForeground = row.source === "foreground";
        const queue = !isForeground && backgroundPath === "queue";
        const queuePrior = accepted.filter(r => Date.parse(r.recordedAt) <= time)
            .map(r => ({ latitude: Number(r.latitude), longitude: Number(r.longitude), recordedAt: Date.parse(r.recordedAt) }));
        // Queue can query its accepted predecessors. Direct BG first merges FG/BG state,
        // including future state; foreground's locked baseline excludes future points.
        const baseline = queue ? selectAcceptedBaseline(time, shared, ...queuePrior)
            : isForeground ? selectAcceptedBaseline(time, latest(fg, bg), shared)
            : latest(bg, fg, selectAcceptedBaseline(time, shared));
        let reason: string | null = null;
        if (queue) reason = queuePredicate({ latitude: point.latitude, longitude: point.longitude,
            accuracy: row.accuracy, recorded_at_ms: time }, baseline, 30_000, 50);
        else if (!isForeground && predicates.isLowAccuracyLocation(row.accuracy)) reason = "lowAccuracy";
        else if (!isForeground && predicates.isAbnormalSpeedLocation(baseline, point.latitude, point.longitude, time)) reason = "abnormalSpeed";
        else if (predicates.isExactDuplicateLocation(baseline, point.latitude, point.longitude, time)) reason = "exactDuplicate";
        else if (predicates.isNearDuplicateLocation(baseline, point.latitude, point.longitude, time)) reason = "nearDuplicate";
        else if (!(isForeground ? foregroundSavePredicate(point.latitude, point.longitude, time, baseline)
            : backgroundSavePredicate(point.latitude, point.longitude, time, { lastSavedLocation: baseline, intervalMs: 30_000, distanceMeters: 50 })))
            reason = "saveConditionNotMet";
        trace.push({ index: trace.length + 1, pointId: row.id, path: isForeground ? "foreground" : backgroundPath,
            recordedAt: row.recordedAt, baselineRecordedAt: baseline?.recordedAt ?? null, reason: reason ?? "eligible-assumed-success" });
        if (!reason) {
            accepted.push({ ...row, latitude: point.latitude, longitude: point.longitude });
            shared = latest(shared, point);
            if (isForeground) fg = point; else if (!queue) bg = point;
        }
    }
    return { inputCount: rows.length, acceptedCount: accepted.length,
        distanceMeters: calculateRouteDistanceMeters(normalizeRouteLogs(accepted)),
        reasons: trace.reduce<Record<string, number>>((a, t) => { const r = String(t.reason); a[r] = (a[r] ?? 0) + 1; return a; }, {}), trace };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    const directory = path.resolve(process.argv[2] ?? path.join(root, ".amplify/known-issues-20261027"));
    const results: Record<string, unknown> = {};
    for (const run of ["r1", "r2"]) {
        const inputPath = path.join(directory, `${run}-final-android-private.json`), raw = fs.readFileSync(inputPath, "utf8");
        const rows = JSON.parse(raw).rows as Row[];
        for (const order of ["measured", "server-created"] as const) for (const bg of ["queue", "direct"] as const) {
            const result = replay(rows, order, bg), { trace, ...summary } = result;
            results[`${run}-${order}-${bg}`] = { ...summary, inputSha256: crypto.createHash("sha256").update(raw).digest("hex"),
                sourceSha256: Object.fromEntries(Object.entries(files).map(([key, file]) => [key,
                    crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")])) };
            fs.writeFileSync(path.join(directory, `${run}-${order}-${bg}-trace-private.json`), JSON.stringify(trace), { mode: 0o600 });
        }
    }
    const output = { warning: "Saved points only; skipped/raw receipts, lock order, plan/force-save and real baseline histories are absent. Server createdAt is not decision order. Scenarios are counterfactual, not recovery of actual execution.", results };
    fs.writeFileSync(path.join(directory, "decision-order-replay-results.json"), JSON.stringify(output, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(output, null, 2));
}
