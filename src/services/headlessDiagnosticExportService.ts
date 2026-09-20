import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

const CURRENT_FILE_NAME = "headless-native-diagnostic.log";

const PREVIOUS_FILE_NAME = "headless-native-diagnostic.previous.log";

const BACKGROUND_LOCATION_TASK_STAGE_PREFIX =
    "location-tracker-background-location-task-stage:";

export async function exportHeadlessDiagnosticLog(): Promise<void> {
    const documentDirectory = FileSystem.documentDirectory;

    if (!documentDirectory) {
        throw new Error("FileSystem.documentDirectory is unavailable.");
    }

    const currentPath = `${documentDirectory}${CURRENT_FILE_NAME}`;

    const previousPath = `${documentDirectory}${PREVIOUS_FILE_NAME}`;

    const currentInfo = await FileSystem.getInfoAsync(currentPath);

    const previousInfo = await FileSystem.getInfoAsync(previousPath);

    /*
     * JS側のHeadless task stage診断をAsyncStorageから取得する。
     */
    const stageEntries = await loadBackgroundTaskStageEntries();

    /*
     * Nativeログがなくても、
     * JS stage診断が存在すれば出力できるようにする。
     */
    if (
        !currentInfo.exists &&
        !previousInfo.exists &&
        stageEntries.length === 0
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

    const exportFileName = `HeadlessDiagnostic_${formatTimestamp(
        new Date(),
    )}.txt`;

    const exportPath = `${FileSystem.cacheDirectory}${exportFileName}`;

    await FileSystem.writeAsStringAsync(exportPath, parts.join("\n"));

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
