import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import * as Updates from "expo-updates";

import type { RootStackParamList } from "../navigation/RootNavigator";
import { getBackgroundRecordingStatus } from "../services/backgroundLocationService";

type Props = NativeStackScreenProps<RootStackParamList, "AppInfo">;

type EasUpdateInfo = {
    updateId: string | null;
    channel: string | null;
    runtimeVersion: string | null;
    createdAt: string | null;
    isEmbeddedLaunch: boolean;
    isEnabled: boolean;
};

export default function AppInfoScreen({ navigation }: Props) {
    const [checkingEasUpdateInfo, setCheckingEasUpdateInfo] = useState(false);
    const [forcingEasUpdate, setForcingEasUpdate] = useState(false);
    const [easUpdateInfo, setEasUpdateInfo] = useState<EasUpdateInfo | null>(
        null,
    );
    const handleCheckEasUpdateInfo = useCallback(async (): Promise<void> => {
        if (checkingEasUpdateInfo) {
            return;
        }

        try {
            setCheckingEasUpdateInfo(true);

            const info: EasUpdateInfo = {
                updateId: Updates.updateId ?? null,
                channel: Updates.channel ?? null,
                runtimeVersion: Updates.runtimeVersion ?? null,
                createdAt:
                    Updates.createdAt instanceof Date
                        ? Updates.createdAt.toISOString()
                        : null,
                isEmbeddedLaunch: Updates.isEmbeddedLaunch,
                isEnabled: Updates.isEnabled,
            };

            setEasUpdateInfo(info);

            console.log("EAS Update info:", info);
        } catch (error) {
            console.error("Check EAS Update info error:", error);

            Alert.alert("確認エラー", "EAS Update情報を確認できませんでした。");
        } finally {
            setCheckingEasUpdateInfo(false);
        }
    }, [checkingEasUpdateInfo]);

    const handleForceEasUpdate = useCallback(async (): Promise<void> => {
        if (forcingEasUpdate) {
            return;
        }

        try {
            setForcingEasUpdate(true);

            /*
             * Update適用によるJS Reloadで
             * バックグラウンド位置記録が中断されないよう、
             * 自動記録・現在地共有中は適用しない。
             */
            const initialBackgroundStatus =
                await getBackgroundRecordingStatus();

            const initialBackgroundState = initialBackgroundStatus.state;

            const isBackgroundLocationInUse =
                initialBackgroundState?.isRecording === true ||
                (initialBackgroundState?.liveShareOwnerValues?.length ?? 0) > 0;

            if (isBackgroundLocationInUse) {
                Alert.alert(
                    "EAS Update",
                    "自動記録中または現在地共有中はUpdateを適用できません。\n\n" +
                        "自動記録と現在地共有を停止してから実行してください。",
                );

                return;
            }

            if (!Updates.isEnabled) {
                Alert.alert(
                    "EAS Update",
                    "expo-updates が無効になっています。",
                );

                return;
            }

            console.log("EAS Update check started:", {
                updateId: Updates.updateId,
                channel: Updates.channel,
                runtimeVersion: Updates.runtimeVersion,
                createdAt: Updates.createdAt,
            });

            const checkResult = await Updates.checkForUpdateAsync();

            console.log("EAS Update check result:", checkResult);

            if (!checkResult.isAvailable) {
                Alert.alert("EAS Update", "新しいUpdateはありません。");

                return;
            }

            const fetchResult = await Updates.fetchUpdateAsync();

            console.log("EAS Update fetch result:", fetchResult);

            /*
             * Download中に自動記録等が始まった可能性もあるため、
             * 適用前に再確認する。
             */
            const backgroundStatus = await getBackgroundRecordingStatus();

            const backgroundState = backgroundStatus.state;

            const isStillBackgroundLocationInUse =
                backgroundState?.isRecording === true ||
                (backgroundState?.liveShareOwnerValues?.length ?? 0) > 0;

            if (isStillBackgroundLocationInUse) {
                Alert.alert(
                    "EAS Update",
                    "最新Updateを取得しましたが、現在位置情報をバックグラウンドで使用中のため適用できません。\n\n" +
                        "自動記録と現在地共有を停止してから、もう一度Updateを適用してください。",
                );

                return;
            }

            Alert.alert(
                "EAS Update",
                "最新Updateを取得しました。今すぐ適用します。",
                [
                    {
                        text: "キャンセル",
                        style: "cancel",
                    },
                    {
                        text: "適用",
                        onPress: () => {
                            void (async () => {
                                try {
                                    /*
                                     * Alert表示中に自動記録等が
                                     * 開始されていないか最終確認する。
                                     */
                                    const latestBackgroundStatus =
                                        await getBackgroundRecordingStatus();

                                    const latestBackgroundState =
                                        latestBackgroundStatus.state;

                                    const isLatestBackgroundLocationInUse =
                                        latestBackgroundState?.isRecording ===
                                            true ||
                                        (latestBackgroundState
                                            ?.liveShareOwnerValues?.length ??
                                            0) > 0;

                                    if (isLatestBackgroundLocationInUse) {
                                        Alert.alert(
                                            "EAS Update",
                                            "位置情報のバックグラウンド処理が開始されているため、Updateを適用できません。\n\n" +
                                                "自動記録と現在地共有を停止してから、もう一度Updateを適用してください。",
                                        );

                                        return;
                                    }

                                    await Updates.reloadAsync();
                                } catch (error) {
                                    const message =
                                        error instanceof Error
                                            ? error.message
                                            : String(error);

                                    console.error(
                                        "EAS Update reload error:",
                                        error,
                                    );

                                    Alert.alert("EAS Updateエラー", message);
                                }
                            })();
                        },
                    },
                ],
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);

            console.error("Force EAS Update error:", error);

            Alert.alert("EAS Updateエラー", message);
        } finally {
            setForcingEasUpdate(false);
        }
    }, [forcingEasUpdate]);

    return (
        <View style={styles.container}>
            <Text style={styles.title}>アプリ情報</Text>

            <Text style={styles.description}>
                LocationTrackerAppに関する情報を確認できます。
            </Text>

            <View style={styles.buttonColumn}>
                <Pressable
                    style={({ pressed }) => [
                        styles.button,
                        pressed && styles.buttonPressed,
                    ]}
                    onPress={() => navigation.navigate("PrivacyPolicy")}
                >
                    <Text style={styles.buttonText}>プライバシーポリシー</Text>
                </Pressable>

                <Pressable
                    style={({ pressed }) => [
                        styles.button,
                        pressed && styles.buttonPressed,
                    ]}
                    onPress={() => navigation.navigate("TermsOfService")}
                >
                    <Text style={styles.buttonText}>利用規約</Text>
                </Pressable>

                <Pressable
                    style={({ pressed }) => [
                        styles.button,
                        pressed && styles.buttonPressed,
                    ]}
                    onPress={() => navigation.navigate("Contact")}
                >
                    <Text style={styles.buttonText}>お問い合わせ</Text>
                </Pressable>

                <Pressable
                    style={({ pressed }) => [
                        styles.button,
                        pressed && styles.buttonPressed,
                    ]}
                    onPress={() =>
                        navigation.navigate("LocationHome", {
                            startTutorial: true,
                        })
                    }
                >
                    <Text style={styles.buttonText}>使い方を見る</Text>
                </Pressable>

                <View style={styles.updateSection}>
                    <Text style={styles.sectionTitle}>アプリUpdate</Text>

                    <Pressable
                        style={({ pressed }) => [
                            styles.updateButton,
                            pressed &&
                                !checkingEasUpdateInfo &&
                                styles.buttonPressed,
                            checkingEasUpdateInfo && styles.disabledButton,
                        ]}
                        onPress={() => {
                            void handleCheckEasUpdateInfo();
                        }}
                        disabled={checkingEasUpdateInfo}
                    >
                        <Text style={styles.updateButtonText}>
                            {checkingEasUpdateInfo
                                ? "Update情報を確認中..."
                                : "Update情報を確認"}
                        </Text>
                    </Pressable>

                    <Pressable
                        style={({ pressed }) => [
                            styles.updateButton,
                            pressed &&
                                !forcingEasUpdate &&
                                styles.buttonPressed,
                            forcingEasUpdate && styles.disabledButton,
                        ]}
                        onPress={() => {
                            void handleForceEasUpdate();
                        }}
                        disabled={forcingEasUpdate}
                    >
                        <Text style={styles.updateButtonText}>
                            {forcingEasUpdate
                                ? "最新Updateを確認中..."
                                : "最新Updateを適用"}
                        </Text>
                    </Pressable>

                    {easUpdateInfo && (
                        <View style={styles.updateInfoContainer}>
                            <Text style={styles.updateInfoTitle}>
                                Update情報
                            </Text>

                            <Text style={styles.updateInfoText}>
                                適用状態:{" "}
                                {easUpdateInfo.isEmbeddedLaunch
                                    ? "ビルド内蔵版"
                                    : "EAS Update適用済み"}
                            </Text>

                            <Text style={styles.updateInfoText}>
                                Channel: {easUpdateInfo.channel ?? "取得不可"}
                            </Text>

                            <Text style={styles.updateInfoText}>
                                Runtime Version:{" "}
                                {easUpdateInfo.runtimeVersion ?? "取得不可"}
                            </Text>

                            <Text style={styles.updateInfoText} selectable>
                                Update ID:{" "}
                                {easUpdateInfo.updateId ?? "取得不可"}
                            </Text>

                            <Text style={styles.updateInfoText}>
                                Update作成日時:{" "}
                                {easUpdateInfo.createdAt
                                    ? formatEasUpdateDateTime(
                                          easUpdateInfo.createdAt,
                                      )
                                    : "取得不可"}
                            </Text>

                            <Text style={styles.updateInfoText}>
                                expo-updates:{" "}
                                {easUpdateInfo.isEnabled ? "有効" : "無効"}
                            </Text>
                        </View>
                    )}
                </View>
            </View>
        </View>
    );
}

function formatEasUpdateDateTime(value: string): string {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return value;
    }

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mi = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 20,
        backgroundColor: "#f7f7f7",
    },
    title: {
        fontSize: 24,
        fontWeight: "bold",
        color: "#2f4f66",
        marginBottom: 10,
    },
    description: {
        fontSize: 14,
        lineHeight: 21,
        color: "#555",
        marginBottom: 24,
    },
    buttonColumn: {
        gap: 12,
    },
    button: {
        minHeight: 48,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderRadius: 8,
        backgroundColor: "#4b6f8f",
        alignItems: "center",
        justifyContent: "center",
    },
    buttonPressed: {
        opacity: 0.75,
    },
    buttonText: {
        fontSize: 15,
        fontWeight: "bold",
        color: "#ffffff",
    },
    updateSection: {
        marginTop: 24,
        padding: 16,
        borderWidth: 1,
        borderColor: "#d0d7de",
        borderRadius: 12,
        backgroundColor: "#ffffff",
    },

    sectionTitle: {
        marginBottom: 12,
        fontSize: 16,
        fontWeight: "700",
        color: "#1f2937",
    },

    updateButton: {
        minHeight: 44,
        marginTop: 10,
        paddingHorizontal: 16,
        paddingVertical: 12,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        backgroundColor: "#27445c",
    },

    updateButtonText: {
        fontSize: 15,
        fontWeight: "600",
        color: "#ffffff",
    },

    disabledButton: {
        opacity: 0.5,
    },

    updateInfoContainer: {
        marginTop: 16,
        padding: 12,
        borderRadius: 8,
        backgroundColor: "#f3f4f6",
    },

    updateInfoTitle: {
        marginBottom: 8,
        fontSize: 14,
        fontWeight: "700",
        color: "#1f2937",
    },

    updateInfoText: {
        marginBottom: 4,
        fontSize: 13,
        lineHeight: 19,
        color: "#4b5563",
    },
});
