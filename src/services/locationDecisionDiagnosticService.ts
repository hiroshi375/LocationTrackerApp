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
const PROTECTION_KEY = "location-decision-protection-v1";
const MAX_PROTECTED_FILES = 2048;
const MAX_PROTECTED_BYTES = 64 * 1024 * 1024;
type Protection = { schema: 1; targets: { userId: string; sessionId: string }[];
    capacityFailures: number; interruptedWrites?: number; lastInterruptedWrite?: string; pendingWrite: string | null };
const emptyProtection = (): Protection => ({ schema: 1, targets: [], capacityFailures: 0, pendingWrite: null });
const protectionDirectory = () => `${archiveDirectory()}protected-v1/`;
async function readProtection(): Promise<Protection> {
    const raw = await AsyncStorage.getItem(PROTECTION_KEY);
    if (!raw) return emptyProtection();
    const value = JSON.parse(raw);
    if (value.schema !== 1 || !Array.isArray(value.targets) || value.targets.length > 4 ||
        value.targets.some((t: any) => typeof t.userId !== "string" || typeof t.sessionId !== "string") ||
        !Number.isSafeInteger(value.capacityFailures) || value.capacityFailures < 0 ||
        !(value.pendingWrite === null || typeof value.pendingWrite === "string")) throw Error("INVALID_DIAGNOSTIC_PROTECTION");
    return value;
}
/** Separate bounded copies; legacy rolling cleanup cannot delete protected evidence. */
let protectedSizes: Map<string, number> | undefined;
async function protectPage(name: string, value: string) {
    const page = JSON.parse(value), state = await readProtection();
    if (state.pendingWrite && state.pendingWrite !== name) {
        state.interruptedWrites = (state.interruptedWrites ?? 0) + 1;
        state.lastInterruptedWrite = state.pendingWrite;
    }
    for (const row of page.rows) {
        if (typeof row.userId !== "string" || typeof row.sessionId !== "string") continue;
        if (!state.targets.some(t => t.userId === row.userId && t.sessionId === row.sessionId)) {
            if (state.targets.length === 4) {
                state.capacityFailures++; await AsyncStorage.setItem(PROTECTION_KEY, JSON.stringify(state));
                throw Error("DIAGNOSTIC_TARGET_CAPACITY");
            }
            state.targets.push({ userId: row.userId, sessionId: row.sessionId });
        }
    }
    await FileSystem.makeDirectoryAsync(protectionDirectory(), { intermediates: true });
    // Rebuild once per runtime, then avoid thousands of filesystem stats on every diagnostic page.
    if (!protectedSizes) {
        const sizes = new Map<string, number>();
        for (const file of (await FileSystem.readDirectoryAsync(protectionDirectory())).filter(isArchiveName)) {
            const info = await FileSystem.getInfoAsync(`${protectionDirectory()}${file}`);
            if (!info.exists || typeof info.size !== "number") throw Error("DIAGNOSTIC_SIZE_UNKNOWN");
            sizes.set(file, info.size);
        }
        protectedSizes = sizes;
    }
    const bytes = [...protectedSizes].reduce((n, [file, size]) => n + (file === name ? 0 : size), 0);
    if ((!protectedSizes.has(name) && protectedSizes.size >= MAX_PROTECTED_FILES) || bytes + value.length * 3 > MAX_PROTECTED_BYTES) {
        state.capacityFailures++; await AsyncStorage.setItem(PROTECTION_KEY, JSON.stringify(state));
        throw Error("DIAGNOSTIC_PROTECTION_CAPACITY");
    }
    // A crash during replacement remains visible on the next runtime/export.
    state.pendingWrite = name;
    await AsyncStorage.setItem(PROTECTION_KEY, JSON.stringify(state));
    await FileSystem.writeAsStringAsync(`${protectionDirectory()}${name}`, value);
    protectedSizes.set(name, value.length * 3);
    state.pendingWrite = null;
    await AsyncStorage.setItem(PROTECTION_KEY, JSON.stringify(state));
}
let directoryReady: Promise<void> | undefined;
let prunedFiles = 0;
const archive = createLocationDecisionArchive({ runtimeId,
    write: async (page, value) => {
        const directory = archiveDirectory();
        if (!directoryReady) directoryReady = FileSystem.makeDirectoryAsync(directory, { intermediates: true })
            .catch(error => { directoryReady = undefined; throw error; });
        await directoryReady;
        // This prefix is exclusive to diagnostics; never enumerate/delete recording or authentication files.
        const name = `${runtimeId}-${String(page).padStart(8, "0")}.json`;
        await protectPage(name, value);
        await FileSystem.writeAsStringAsync(`${directory}${name}`, value);
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
        const protection = await readProtection();
        const protectedInfo = await FileSystem.getInfoAsync(protectionDirectory());
        const protectedNames = protectedInfo.exists ? (await FileSystem.readDirectoryAsync(protectionDirectory())).filter(isArchiveName).sort() : [];
        if (protectedNames.length > MAX_PROTECTED_FILES) throw Error("INVALID_PROTECTED_FILE_COUNT");
        const locations = [
            ...names.slice(-MAX_ARCHIVE_FILES).map(name => `${archiveDirectory()}${name}`),
            ...protectedNames.map(name => `${protectionDirectory()}${name}`),
        ];
        for (const file of locations) {
            try {
                const fileInfo = await FileSystem.getInfoAsync(file);
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
        const ranges = [...new Set(selected.map(r => r.runtimeId))].map(id => {
            const rows = selected.filter(r => r.runtimeId === id), sequences = [...new Set(rows.map(r => Number(r.sequence)))].sort((a,b) => a-b);
            return { runtimeId: id, firstSequence: sequences[0], lastSequence: sequences.at(-1),
                internalSequenceHoles: sequences.length ? sequences[sequences.length-1] - sequences[0] + 1 - sequences.length : 0,
                firstObservedAtMs: rows[0]?.observedAtMs, lastObservedAtMs: rows.at(-1)?.observedAtMs };
        });
        return JSON.stringify({ ...snapshot, rows: selected, archive: {
            protection: { ...protection,
                status: !protection.targets.length ? "not-protected" : protection.pendingWrite || protection.capacityFailures || protection.interruptedWrites || unreadableFiles || !archiveFlushed
                    ? "incomplete" : "retained-observations",
                files: protectedNames.length, maxFiles: MAX_PROTECTED_FILES,
                maxBytes: MAX_PROTECTED_BYTES, ranges,
                scope: "first-observed-evidence; not proof of recording-start/stop coverage; sequence holes can include other records; no automatic release" },
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
