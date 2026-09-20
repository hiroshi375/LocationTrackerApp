import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

const CURRENT_FILE_NAME = "headless-native-diagnostic.log";

const PREVIOUS_FILE_NAME = "headless-native-diagnostic.previous.log";

export async function exportHeadlessDiagnosticLog(): Promise<void> {
    const documentDirectory = FileSystem.documentDirectory;

    if (!documentDirectory) {
        throw new Error("FileSystem.documentDirectory is unavailable.");
    }

    const currentPath = `${documentDirectory}${CURRENT_FILE_NAME}`;

    const previousPath = `${documentDirectory}${PREVIOUS_FILE_NAME}`;

    const currentInfo = await FileSystem.getInfoAsync(currentPath);

    const previousInfo = await FileSystem.getInfoAsync(previousPath);

    if (!currentInfo.exists && !previousInfo.exists) {
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

function formatTimestamp(date: Date): string {
    const year = String(date.getFullYear());

    const month = String(date.getMonth() + 1).padStart(2, "0");

    const day = String(date.getDate()).padStart(2, "0");

    const hour = String(date.getHours()).padStart(2, "0");

    const minute = String(date.getMinutes()).padStart(2, "0");

    const second = String(date.getSeconds()).padStart(2, "0");

    return `${year}${month}${day}_${hour}${minute}${second}`;
}
