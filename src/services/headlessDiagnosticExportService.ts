import * as Application from "expo-application";
import { clearLegacyDiagnosticLogs, compactDecisionDiagnostic } from "./diagnosticLogCleanupCore";
import { IOS_DELAY_DIAGNOSTIC_KEY } from "./iosDelayDiagnosticCore";
import { readLocationDecisionDiagnostics } from "./locationDecisionDiagnosticService";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as SQLite from "expo-sqlite";
import { Sha256 } from "@aws-crypto/sha256-js";

const CURRENT_FILE_NAME = "headless-native-diagnostic.log";

const PREVIOUS_FILE_NAME = "headless-native-diagnostic.previous.log";

const BACKGROUND_LOCATION_TASK_STAGE_PREFIX =
    "location-tracker-background-location-task-stage:";

export async function exportHeadlessDiagnosticLog(): Promise<void> {
    const documentDirectory = FileSystem.documentDirectory;

    if (!documentDirectory) {
        throw new Error("FileSystem.documentDirectory is unavailable.");
    }

    const decisionEvidence = await readLocationDecisionDiagnostics();
    const compact = compactDecisionDiagnostic(decisionEvidence);
    if (compact) {
        await shareDiagnosticText(compact + await readTestLocationRequests() + await readTestQueueSnapshot());
        return;
    }

    const currentPath = `${documentDirectory}${CURRENT_FILE_NAME}`;

    const previousPath = `${documentDirectory}${PREVIOUS_FILE_NAME}`;

    const currentInfo = await FileSystem.getInfoAsync(currentPath);

    const previousInfo = await FileSystem.getInfoAsync(previousPath);

    /*
     * JS側のHeadless task stage診断をAsyncStorageから取得する。
     */
    const stageEntries = await loadBackgroundTaskStageEntries();
    const delayEvidence = await AsyncStorage.getItem(IOS_DELAY_DIAGNOSTIC_KEY);

    /*
     * Nativeログがなくても、
     * JS stage診断が存在すれば出力できるようにする。
     */
    if (
        !currentInfo.exists &&
        !previousInfo.exists &&
        stageEntries.length === 0 &&
        !delayEvidence && !decisionEvidence
    ) {
        throw new Error("Headless diagnostic log does not exist.");
    }

    const parts: string[] = [];

    if (previousInfo.exists) {
        const previousText = await FileSystem.readAsStringAsync(previousPath);

        parts.push("===== PREVIOUS =====", previousText);
    }

    if (currentInfo.exists) {
        const currentText = await FileSystem.readAsStringAsync(currentPath);

        parts.push("===== CURRENT =====", currentText);
    }

    /*
     * JS側stage診断。
     *
     * eventId単位で最後に到達したstageを保存している。
     */
    if (stageEntries.length > 0) {
        parts.push(
            "===== JS TASK STAGES =====",
            ...stageEntries.map(({ key, value }) => `${key}\t${value}`),
        );
    }

    if (delayEvidence) parts.push("===== IOS DELAY EVIDENCE =====", delayEvidence);
    if (decisionEvidence) parts.push("===== LOCATION DECISION EVIDENCE =====", decisionEvidence);

    await shareDiagnosticText(parts.join("\n") + await readTestLocationRequests() + await readTestQueueSnapshot());
}

/** Local validation only; caller must confirm stopped state immediately before this action. */
export async function clearTestLegacyDiagnosticLogs(state: { recording: boolean; sharing: boolean }): Promise<void> {
    const directory = FileSystem.documentDirectory;
    if (!directory) throw new Error("DIAGNOSTIC_DIRECTORY_UNAVAILABLE");
    await clearLegacyDiagnosticLogs({ applicationId: Application.applicationId, ...state,
        deleteFile: name => FileSystem.deleteAsync(`${directory}${name}`, { idempotent: true }) });
}

/** Separate bounded Native lifecycle evidence, including final removal after the last fix. */
async function readTestLocationRequests(): Promise<string> {
    if (Application.applicationId !== "com.hiroshisato.locationtrackerapp.incident104" || !FileSystem.documentDirectory) return "";
    const path = `${FileSystem.documentDirectory}aclog-location-requests.jsonl`;
    try {
        const info = await FileSystem.getInfoAsync(path);
        if (!info.exists) return "\n===== NATIVE LOCATION REQUESTS =====\nmissing";
        if (info.size > 524288) return "\n===== NATIVE LOCATION REQUESTS =====\noversized-not-read";
        return "\n===== NATIVE LOCATION REQUESTS (LAST 256; MAY BE TRUNCATED) =====\n" + await FileSystem.readAsStringAsync(path);
    } catch { return "\n===== NATIVE LOCATION REQUESTS =====\nread-error"; }
}

/** Test-only snapshot: no queue initializer, migration, cleanup or replay is called. */
async function readTestQueueSnapshot(): Promise<string> {
    if (Application.applicationId !== "com.hiroshisato.locationtrackerapp.incident104") return "";
    const section = "\n===== TEST SQLITE READ-ONLY SNAPSHOT =====\n";
    let db: SQLite.SQLiteDatabase | undefined;
    let transaction = false;
    try {
        const directory = SQLite.defaultDatabaseDirectory;
        const path = `${directory.replace(/\/$/, "")}/location-tracker.db`;
        if (!(await FileSystem.getInfoAsync(path.startsWith("file://") ? path : `file://${path}`)).exists) return section + JSON.stringify({ status: "database-missing" });
        db = await SQLite.openDatabaseAsync("location-tracker.db", { useNewConnection: true });
        await db.execAsync("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN DEFERRED TRANSACTION;");
        transaction = true;
        const counts = await db.getAllAsync("SELECT queue_status, COUNT(*) AS count FROM location_location_queue GROUP BY queue_status ORDER BY queue_status");
        const sessions = await db.getAllAsync<{ owner: string; recording_session_id: string; queue_status: string; count: number }>(
            "SELECT user_id AS owner, recording_session_id, queue_status, COUNT(*) AS count FROM location_location_queue GROUP BY user_id, recording_session_id, queue_status ORDER BY user_id, recording_session_id, queue_status LIMIT 501");
        const pending = await db.getAllAsync<Record<string, unknown>>(
            "SELECT * FROM location_location_queue WHERE queue_status = 'pending' ORDER BY location_log_id LIMIT 10001");
        const seeds = await db.getAllAsync<Record<string, unknown>>(
            "SELECT * FROM location_location_queue WHERE location_log_id IN (?, ?) ORDER BY location_log_id",
            "auth-retention-105-0", "auth-retention-105-1");
        await db.execAsync("COMMIT");
        transaction = false;
        const hash = async (value: unknown): Promise<string> => {
            const digest = new Sha256(); digest.update(JSON.stringify(value));
            return Array.from(await digest.digest(), b => b.toString(16).padStart(2, "0")).join("");
        };
        // Canonical key order makes hashes independent of SQLite column enumeration order.
        const canonical = (row: Record<string, unknown>) => Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]]));
        let historicalSeeds: { available: boolean; unchanged?: boolean } = { available: false };
        try {
            const baseline = JSON.parse(await AsyncStorage.getItem("@incident105-auth-retention-baseline") ?? "null");
            if (typeof baseline?.seedHash === "string") historicalSeeds = { available: true,
                unchanged: seeds.length === 2 && seeds.every(row => row.queue_status === "pending") && await hash(seeds) === baseline.seedHash };
        } catch { /* An absent/corrupt old baseline is not evidence of retention. */ }
        const complete = pending.length <= 10000;
        return section + JSON.stringify({ schema: 1, status: "ok", checkedAt: new Date().toISOString(), counts,
            sessionsComplete: sessions.length <= 500,
            sessions: await Promise.all(sessions.slice(0, 500).map(async ({ owner, ...row }) => ({ ownerHash: await hash(owner), ...row }))),
            pendingComplete: complete, pendingHashAlgorithm: "SHA-256/UTF8/JSON/rows-by-location_log_id/keys-sorted/full-row-v1",
            pendingHash: complete ? await hash(pending.map(canonical)) : null,
            pendingRows: complete ? await Promise.all(pending.map(async row => ({ locationLogId: row.location_log_id,
                rowHash: await hash(canonical(row)) }))) : [],
            historicalPendingComparisonAvailable: false, historicalSeeds,
            note: "Full-row hashes include retry/status fields. Compare with another snapshot; no historical full-pending baseline is assumed." });
    } catch {
        return section + JSON.stringify({ status: "read-error", complete: false });
    } finally {
        if (db) {
            if (transaction) await db.execAsync("ROLLBACK").catch(() => undefined);
            await db.closeAsync();
        }
    }
}

async function shareDiagnosticText(text: string): Promise<void> {
    const exportFileName = `HeadlessDiagnostic_${formatTimestamp(
        new Date(),
    )}.txt`;

    const exportPath = `${FileSystem.cacheDirectory}${exportFileName}`;

    await FileSystem.writeAsStringAsync(exportPath, text);

    const sharingAvailable = await Sharing.isAvailableAsync();

    if (!sharingAvailable) {
        throw new Error("Sharing is not available on this device.");
    }

    await Sharing.shareAsync(exportPath, {
        mimeType: "text/plain",
        dialogTitle: "Headless診断ログを共有",
    });
}

type BackgroundTaskStageEntry = {
    key: string;
    value: string;
};

async function loadBackgroundTaskStageEntries(): Promise<
    BackgroundTaskStageEntry[]
> {
    const allKeys = await AsyncStorage.getAllKeys();

    const stageKeys = allKeys.filter((key) =>
        key.startsWith(BACKGROUND_LOCATION_TASK_STAGE_PREFIX),
    );

    if (stageKeys.length === 0) {
        return [];
    }

    const entries = await AsyncStorage.multiGet(stageKeys);

    return entries
        .filter((entry): entry is [string, string] => entry[1] !== null)
        .map(([key, value]) => ({
            key,
            value,
        }))
        .sort((a, b) => {
            return getStageTimestampMs(a.value) - getStageTimestampMs(b.value);
        });
}

function getStageTimestampMs(value: string): number {
    try {
        const parsed = JSON.parse(value) as {
            stageAtMs?: unknown;
        };

        if (
            typeof parsed.stageAtMs === "number" &&
            Number.isFinite(parsed.stageAtMs)
        ) {
            return parsed.stageAtMs;
        }
    } catch {
        // JSON解析できない場合は最後尾へ送る。
    }

    return Number.MAX_SAFE_INTEGER;
}

function formatTimestamp(date: Date): string {
    const year = String(date.getFullYear());

    const month = String(date.getMonth() + 1).padStart(2, "0");

    const day = String(date.getDate()).padStart(2, "0");

    const hour = String(date.getHours()).padStart(2, "0");

    const minute = String(date.getMinutes()).padStart(2, "0");

    const second = String(date.getSeconds()).padStart(2, "0");

    return `${year}${month}${day}_${hour}${minute}${second}`;
}
