import { selectLatestSessionEvidence } from "./locationDecisionExportCore";
import * as FileSystem from "expo-file-system/legacy";
import { createLocationDecisionArchive } from "./locationDecisionArchiveCore";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createLocationDecisionDiagnostics, LOCATION_DECISION_DIAGNOSTIC_KEY } from "./locationDecisionDiagnosticCore";

// Deliberately OFF. No remote flag, administrator role or stored value can activate it.
// Enabling requires a separately reviewed local validation configuration; no deployment in this task.
const ENABLE_LOCATION_DECISION_DIAGNOSTICS = false;
const runtimeId = `location-decision-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const MAX_ARCHIVE_FILES = 512;
const archiveDirectory = () => {
    if (!FileSystem.documentDirectory) throw new Error("DIAGNOSTIC_DIRECTORY_UNAVAILABLE");
    return `${FileSystem.documentDirectory}location-decision-evidence-v1/`;
};
let directoryReady: Promise<void> | undefined;
let prunedFiles = 0;
const archive = createLocationDecisionArchive({ runtimeId,
    write: async (page, value) => {
        const directory = archiveDirectory();
        if (!directoryReady) directoryReady = FileSystem.makeDirectoryAsync(directory, { intermediates: true })
            .catch(error => { directoryReady = undefined; throw error; });
        await directoryReady;
        // This prefix is exclusive to diagnostics; never enumerate/delete recording or authentication files.
        await FileSystem.writeAsStringAsync(`${directory}${runtimeId}-${String(page).padStart(8, "0")}.json`, value);
        const names = (await FileSystem.readDirectoryAsync(directory)).filter(isArchiveName).sort();
        for (const name of names.slice(0, Math.max(0, names.length - MAX_ARCHIVE_FILES))) {
            await FileSystem.deleteAsync(`${directory}${name}`, { idempotent: true }); prunedFiles++;
        }
    },
});
function isArchiveName(name: string) { return /^location-decision-\d+-[a-z0-9]+-\d{8}\.json$/.test(name); }
const observer = createLocationDecisionDiagnostics({
    enabled: ENABLE_LOCATION_DECISION_DIAGNOSTICS,
    runtimeId,
    onRow: row => archive.append(row),
    now: Date.now,
    persist: value => AsyncStorage.setItem(LOCATION_DECISION_DIAGNOSTIC_KEY, value),
});
export const observeLocationDecision = observer.capture;
export async function readLocationDecisionDiagnostics(): Promise<string | null> {
    if (!ENABLE_LOCATION_DECISION_DIAGNOSTICS) return null;
    let current: string | null = null;
    try {
        const archiveFlushed = await archive.flush();
        current = await AsyncStorage.getItem(LOCATION_DECISION_DIAGNOSTIC_KEY);
        const stored = current ? JSON.parse(current) : null;
        const snapshot = stored ?? { schema: 1, runtimeId, rows: [] };
        const unique = new Map<string, Record<string, unknown>>();
        let unreadableFiles = 0, files = 0, retainedRows = 0;
        const priorRuntimeStats = new Map<string, { droppedRows: number; writeFailures: number }>();
        const info = await FileSystem.getInfoAsync(archiveDirectory());
        const names = info.exists ? (await FileSystem.readDirectoryAsync(archiveDirectory())).filter(isArchiveName).sort() : [];
        for (const name of names.slice(-MAX_ARCHIVE_FILES)) {
            try {
                const file = `${archiveDirectory()}${name}`, fileInfo = await FileSystem.getInfoAsync(file);
                if (!fileInfo.exists || fileInfo.size > 512 * 1024) { unreadableFiles++; continue; }
                const page = JSON.parse(await FileSystem.readAsStringAsync(file));
                if (page.schema !== 1 || !Array.isArray(page.rows) || page.rows.length > 64) { unreadableFiles++; continue; }
                files++;
                const prior = priorRuntimeStats.get(page.runtimeId) ?? { droppedRows: 0, writeFailures: 0 };
                priorRuntimeStats.set(page.runtimeId, { droppedRows: Math.max(prior.droppedRows, Number(page.droppedRows) || 0),
                    writeFailures: Math.max(prior.writeFailures, Number(page.writeFailures) || 0) });
                for (const row of page.rows) {
                    if (typeof row.sequence !== "number") continue;
                    unique.set(`${page.runtimeId}:${row.sequence}`, { ...row, runtimeId: row.runtimeId ?? page.runtimeId }); retainedRows++;
                }
            } catch { unreadableFiles++; }
        }
        for (const row of snapshot.rows ?? []) unique.set(`${row.runtimeId ?? snapshot.runtimeId}:${row.sequence}`, { ...row, runtimeId: row.runtimeId ?? snapshot.runtimeId });
        const selected = selectLatestSessionEvidence([...unique.values()]);
        const selectedRuntimes = new Set(selected.map(r => r.runtimeId));
        const relevantStats = [...priorRuntimeStats].filter(([id]) => selectedRuntimes.has(id)).map(([, stats]) => stats);
        return JSON.stringify({ ...snapshot, rows: selected, archive: {
            exportScope: "latest-owner-session-across-runtimes; other activities remain on disk", archiveFlushed, files, retainedRows, unreadableFiles, prunedFilesInCurrentRuntime: prunedFiles,
            fileCapReached: names.length >= MAX_ARCHIVE_FILES, maxFiles: MAX_ARCHIVE_FILES,
            priorRuntimeDroppedRows: relevantStats.reduce((n, x) => n + x.droppedRows, 0),
            priorRuntimeWriteFailures: relevantStats.reduce((n, x) => n + x.writeFailures, 0),
            ...archive.stats(),
            completeness: "bounded; inspect runtime sequence gaps, droppedRows, failures and cap; not guaranteed complete",
        } });
    }
    catch {
        // Preserve the current ring even when archive enumeration fails; never claim a complete export.
        if (current) { try { return JSON.stringify({ ...JSON.parse(current), archive: { exportReadFailed: true, ...archive.stats() } }); } catch { /* invalid snapshot */ } }
        return null;
    }
}
