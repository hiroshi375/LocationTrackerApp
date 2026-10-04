import { Alert } from "react-native";
import * as Updates from "expo-updates";

const MIN_CHECK_INTERVAL_MS = 10 * 60 * 1000;

let isCheckingUpdate = false;
let lastCheckedAt = 0;
let isUpdateAlertVisible = false;

export async function checkForOtaUpdate(): Promise<void> {
    if (__DEV__) {
        return;
    }

    if (!Updates.isEnabled) {
        return;
    }

    if (isCheckingUpdate || isUpdateAlertVisible) {
        return;
    }

    const now = Date.now();

    if (now - lastCheckedAt < MIN_CHECK_INTERVAL_MS) {
        return;
    }

    isCheckingUpdate = true;
    lastCheckedAt = now;

    try {
        const update = await Updates.checkForUpdateAsync();

        if (!update.isAvailable) {
            return;
        }

        isUpdateAlertVisible = true;

        Alert.alert(
            "アプリの更新",
            "新しい更新があります。今すぐ更新しますか？",
            [
                {
                    text: "あとで",
                    style: "cancel",
                    onPress: () => {
                        isUpdateAlertVisible = false;
                    },
                },
                {
                    text: "更新する",
                    onPress: () => {
                        isUpdateAlertVisible = false;
                        void applyOtaUpdate();
                    },
                },
            ],
            {
                cancelable: true,
                onDismiss: () => {
                    isUpdateAlertVisible = false;
                },
            },
        );
    } catch (error) {
        console.warn("[OTA Update] 更新確認に失敗しました:", error);
    } finally {
        isCheckingUpdate = false;
    }
}

async function applyOtaUpdate(): Promise<void> {
    try {
        const result = await Updates.fetchUpdateAsync();

        if (!result.isNew) {
            return;
        }

        await Updates.reloadAsync();
    } catch (error) {
        console.warn("[OTA Update] 更新の適用に失敗しました:", error);

        Alert.alert(
            "更新エラー",
            "更新を適用できませんでした。しばらくしてからもう一度お試しください。",
        );
    }
}
