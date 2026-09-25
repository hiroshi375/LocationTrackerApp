import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import {
    Alert,
    Image,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from "react-native";
import * as Updates from "expo-updates";
import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
    const insets = useSafeAreaInsets();

    useLayoutEffect(() => {
        navigation.setOptions({
            headerShown: false,
        });
    }, [navigation]);

    const [checkingEasUpdateInfo, setCheckingEasUpdateInfo] = useState(false);
    const [forcingEasUpdate, setForcingEasUpdate] = useState(false);
    const [easUpdateInfo, setEasUpdateInfo] = useState<EasUpdateInfo | null>(
        null,
    );
    const [versionInfoExpanded, setVersionInfoExpanded] = useState(false);
    const isDevelopmentBuild = __DEV__;

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

            if (__DEV__) {
                Alert.alert(
                    "Update情報",
                    "現在は開発ビルドで実行しています。\n\n" +
                        "開発ビルドでは Channel や Update ID など、一部のEAS Update情報を取得できません。\n\n" +
                        "実際のUpdate情報はリリースビルドで確認してください。",
                );

                return;
            }

            Alert.alert("Update情報", "EAS Update情報を更新しました。");
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

        if (__DEV__) {
            Alert.alert(
                "EAS Update",
                "開発ビルドでは最新Updateの確認・適用はできません。\n\n" +
                    "EAS Buildで作成したPreviewまたはProductionビルドで確認してください。",
            );

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

    const appVersion = Constants.expoConfig?.version ?? "不明";

    const buildVersion = useMemo(() => {
        if (Platform.OS === "ios") {
            return Constants.expoConfig?.ios?.buildNumber ?? "不明";
        }

        const versionCode = Constants.expoConfig?.android?.versionCode;

        return versionCode != null ? String(versionCode) : "不明";
    }, []);

    const packageName = useMemo(() => {
        if (Platform.OS === "ios") {
            return Constants.expoConfig?.ios?.bundleIdentifier ?? "不明";
        }

        return Constants.expoConfig?.android?.package ?? "不明";
    }, []);

    /*
     * 添付アイコンを assets 配下へ保存したうえで、
     * 下の require パスを実際の保存先に合わせてください。
     * 例: ../../assets/icon.png
     */
    const appIconSource = require("../../assets/images/icon.png");

    return (
        <View style={styles.screen}>
            <StatusBar
                style="light"
                backgroundColor="#06395f"
                translucent={false}
            />

            <View
                style={[
                    styles.appHeader,
                    {
                        paddingTop: Math.max(insets.top, 8),
                    },
                ]}
            >
                <Pressable
                    style={styles.headerBackButton}
                    onPress={() => navigation.goBack()}
                >
                    <Text style={styles.headerBackText}>‹</Text>
                </Pressable>

                <Text style={styles.headerTitle} numberOfLines={1}>
                    アプリ情報
                </Text>

                <View style={styles.headerRightSpace} />
            </View>

            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.contentContainer}
                showsVerticalScrollIndicator={false}
            >
                <View style={styles.heroCard}>
                    <Image source={appIconSource} style={styles.appIcon} />

                    <Text style={styles.appName}>AcLog Fit</Text>

                    <Text style={styles.appSubText}>
                        アプリのバージョン情報や使い方ガイド、
                        規約・お問い合わせ先を確認できます。
                    </Text>
                </View>

                <View style={styles.infoCard}>
                    <Pressable
                        style={({ pressed }) => [
                            styles.versionHeader,
                            pressed && styles.menuRowPressed,
                        ]}
                        onPress={() =>
                            setVersionInfoExpanded((current) => !current)
                        }
                    >
                        <View style={styles.cardHeaderRowNoMargin}>
                            <MaterialCommunityIcons
                                name="information-outline"
                                size={20}
                                color="#0e9384"
                            />

                            <Text style={styles.cardTitle}>バージョン情報</Text>
                        </View>

                        <MaterialCommunityIcons
                            name={
                                versionInfoExpanded
                                    ? "chevron-up"
                                    : "chevron-down"
                            }
                            size={24}
                            color="#8798a0"
                        />
                    </Pressable>

                    {versionInfoExpanded && (
                        <View style={styles.versionInfoContent}>
                            <InfoRow label="アプリ名" value="AcLog Fit" />

                            <InfoRow label="バージョン" value={appVersion} />

                            <InfoRow label="ビルド" value={buildVersion} />

                            <InfoRow label="パッケージ" value={packageName} />

                            <InfoRow
                                label="EAS Channel"
                                value={Updates.channel ?? "未取得"}
                            />

                            <InfoRow
                                label="Runtime Version"
                                value={Updates.runtimeVersion ?? "未取得"}
                            />
                        </View>
                    )}
                </View>

                <View style={styles.menuCard}>
                    <View style={[styles.cardHeaderRow, styles.menuCardHeader]}>
                        <MaterialCommunityIcons
                            name="book-open-page-variant-outline"
                            size={20}
                            color="#0e9384"
                        />

                        <Text style={styles.cardTitle}>ガイド・サポート</Text>
                    </View>

                    <MenuRow
                        icon="book-open-variant"
                        title="使い方ガイド"
                        subtitle="チュートリアルを表示"
                        onPress={() =>
                            navigation.navigate("LocationHome", {
                                startTutorial: true,
                            })
                        }
                    />

                    <MenuRow
                        icon="crown-outline"
                        title="プラン一覧"
                        subtitle="FREE / PREMIUM の違いを確認"
                        onPress={() => navigation.navigate("SubscriptionPlan")}
                    />

                    <MenuRow
                        icon="shield-account-outline"
                        title="プライバシーポリシー"
                        subtitle="個人情報の取扱いを確認"
                        onPress={() => navigation.navigate("PrivacyPolicy")}
                    />

                    <MenuRow
                        icon="file-document-outline"
                        title="利用規約"
                        subtitle="利用条件を確認"
                        onPress={() => navigation.navigate("TermsOfService")}
                    />

                    <MenuRow
                        icon="email-outline"
                        title="お問い合わせ"
                        subtitle="アプリに関するお問い合わせ"
                        onPress={() => navigation.navigate("Contact")}
                        isLast
                    />
                </View>

                <View style={styles.updateCard}>
                    <View style={styles.cardHeaderRow}>
                        <MaterialCommunityIcons
                            name="update"
                            size={20}
                            color="#0e9384"
                        />

                        <Text style={styles.cardTitle}>アプリUpdate</Text>
                    </View>

                    <Text style={styles.updateDescription}>
                        EAS Update の配信状況を確認したり、
                        最新のUpdateを手動で適用できます。
                    </Text>

                    <Pressable
                        style={({ pressed }) => [
                            styles.primaryButton,
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
                        <Text style={styles.primaryButtonText}>
                            {checkingEasUpdateInfo
                                ? "Update情報を確認中..."
                                : "Update情報を確認"}
                        </Text>
                    </Pressable>

                    <Pressable
                        style={({ pressed }) => [
                            styles.secondaryButton,
                            pressed &&
                                !forcingEasUpdate &&
                                !isDevelopmentBuild &&
                                styles.buttonPressed,
                            (forcingEasUpdate || isDevelopmentBuild) &&
                                styles.disabledButton,
                        ]}
                        onPress={() => {
                            void handleForceEasUpdate();
                        }}
                        disabled={forcingEasUpdate || isDevelopmentBuild}
                    >
                        <Text style={styles.secondaryButtonText}>
                            {isDevelopmentBuild
                                ? "開発ビルドでは利用できません"
                                : forcingEasUpdate
                                  ? "最新Updateを確認中..."
                                  : "最新Updateを適用"}
                        </Text>
                    </Pressable>

                    {easUpdateInfo && (
                        <View style={styles.updateInfoCard}>
                            <Text style={styles.updateInfoTitle}>
                                取得したUpdate情報
                            </Text>

                            <InfoRow
                                label="適用状態"
                                value={
                                    easUpdateInfo.isEmbeddedLaunch
                                        ? "ビルド内蔵版"
                                        : "EAS Update適用済み"
                                }
                            />

                            <InfoRow
                                label="Channel"
                                value={easUpdateInfo.channel ?? "取得不可"}
                            />

                            <InfoRow
                                label="Runtime Version"
                                value={
                                    easUpdateInfo.runtimeVersion ?? "取得不可"
                                }
                            />

                            <InfoRow
                                label="Update ID"
                                value={easUpdateInfo.updateId ?? "取得不可"}
                                selectable
                            />

                            <InfoRow
                                label="Update作成日時"
                                value={
                                    easUpdateInfo.createdAt
                                        ? formatEasUpdateDateTime(
                                              easUpdateInfo.createdAt,
                                          )
                                        : "取得不可"
                                }
                            />

                            <InfoRow
                                label="expo-updates"
                                value={
                                    easUpdateInfo.isEnabled ? "有効" : "無効"
                                }
                            />
                        </View>
                    )}
                </View>
            </ScrollView>
        </View>
    );
}

type InfoRowProps = {
    label: string;
    value: string;
    selectable?: boolean;
};

function InfoRow({ label, value, selectable = false }: InfoRowProps) {
    return (
        <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>{label}</Text>

            <Text style={styles.infoValue} selectable={selectable}>
                {value}
            </Text>
        </View>
    );
}

type MenuRowProps = {
    icon: keyof typeof MaterialCommunityIcons.glyphMap;
    title: string;
    subtitle: string;
    onPress: () => void;
    isLast?: boolean;
};

function MenuRow({
    icon,
    title,
    subtitle,
    onPress,
    isLast = false,
}: MenuRowProps) {
    return (
        <Pressable
            style={({ pressed }) => [
                styles.menuRow,
                !isLast && styles.menuRowBorder,
                pressed && styles.menuRowPressed,
            ]}
            onPress={onPress}
        >
            <View style={styles.menuRowLeft}>
                <View style={styles.menuIconCircle}>
                    <MaterialCommunityIcons
                        name={icon}
                        size={20}
                        color="#0e9384"
                    />
                </View>

                <View style={styles.menuTextArea}>
                    <Text style={styles.menuTitle}>{title}</Text>
                    <Text style={styles.menuSubtitle}>{subtitle}</Text>
                </View>
            </View>

            <MaterialCommunityIcons
                name="chevron-right"
                size={24}
                color="#9aa8b1"
            />
        </Pressable>
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
    screen: {
        flex: 1,
        backgroundColor: "#f3f7f9",
    },

    appHeader: {
        minHeight: 58,
        paddingHorizontal: 10,
        paddingBottom: 8,
        flexDirection: "row",
        alignItems: "flex-end",
        backgroundColor: "#06395f",
        elevation: 6,
        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.16,
        shadowRadius: 4,
    },

    headerBackButton: {
        width: 46,
        height: 44,
        alignItems: "center",
        justifyContent: "center",
    },

    headerBackText: {
        color: "#ffffff",
        fontSize: 42,
        lineHeight: 42,
        fontWeight: "300",
    },

    headerTitle: {
        flex: 1,
        paddingBottom: 9,
        textAlign: "center",
        color: "#ffffff",
        fontSize: 18,
        fontWeight: "700",
    },

    headerRightSpace: {
        width: 46,
        height: 44,
    },

    scrollView: {
        flex: 1,
    },

    contentContainer: {
        paddingHorizontal: 14,
        paddingTop: 14,
        paddingBottom: 32,
    },

    heroCard: {
        alignItems: "center",
        marginBottom: 12,
        paddingVertical: 22,
        paddingHorizontal: 18,
        borderWidth: 1,
        borderColor: "#dfe7ea",
        borderRadius: 18,
        backgroundColor: "#ffffff",
        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.05,
        shadowRadius: 4,
        elevation: 1,
    },

    appIcon: {
        width: 82,
        height: 82,
        borderRadius: 20,
        marginBottom: 14,
    },

    appName: {
        fontSize: 28,
        fontWeight: "800",
        color: "#203f4f",
        marginBottom: 8,
    },

    appSubText: {
        fontSize: 13,
        lineHeight: 20,
        color: "#6d7e87",
        textAlign: "center",
    },

    infoCard: {
        marginBottom: 12,
        padding: 15,
        borderWidth: 1,
        borderColor: "#dfe7ea",
        borderRadius: 16,
        backgroundColor: "#ffffff",
        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.05,
        shadowRadius: 4,
        elevation: 1,
    },

    menuCard: {
        marginBottom: 12,

        paddingTop: 12,

        borderWidth: 1,
        borderColor: "#dfe7ea",
        borderRadius: 16,

        backgroundColor: "#ffffff",

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.05,
        shadowRadius: 4,

        elevation: 1,

        overflow: "hidden",
    },

    updateCard: {
        marginBottom: 12,
        padding: 15,
        borderWidth: 1,
        borderColor: "#dfe7ea",
        borderRadius: 16,
        backgroundColor: "#ffffff",
        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.05,
        shadowRadius: 4,
        elevation: 1,
    },

    cardHeaderRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        marginBottom: 12,
    },

    cardTitle: {
        fontSize: 16,
        fontWeight: "700",
        color: "#203f4f",
    },

    infoRow: {
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: "#e2e8ec",
    },

    infoLabel: {
        fontSize: 12,
        fontWeight: "700",
        color: "#70838c",
        marginBottom: 3,
    },

    infoValue: {
        fontSize: 14,
        lineHeight: 20,
        color: "#20303a",
    },

    menuRow: {
        minHeight: 72,
        paddingHorizontal: 15,
        paddingVertical: 12,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        backgroundColor: "#ffffff",
    },

    menuRowBorder: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: "#e2e8ec",
    },

    menuRowPressed: {
        opacity: 0.72,
        backgroundColor: "#f6fafb",
    },

    menuRowLeft: {
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        marginRight: 12,
    },

    menuIconCircle: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#e9f8f5",
        marginRight: 12,
    },

    menuTextArea: {
        flex: 1,
    },

    menuTitle: {
        fontSize: 15,
        fontWeight: "700",
        color: "#20303a",
        marginBottom: 2,
    },

    menuSubtitle: {
        fontSize: 12,
        lineHeight: 17,
        color: "#71838c",
    },

    updateDescription: {
        fontSize: 13,
        lineHeight: 20,
        color: "#6f8089",
        marginBottom: 14,
    },

    primaryButton: {
        minHeight: 46,
        marginBottom: 10,
        paddingHorizontal: 16,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#0e9384",
    },

    primaryButtonText: {
        fontSize: 15,
        fontWeight: "700",
        color: "#ffffff",
    },

    secondaryButton: {
        minHeight: 46,
        marginBottom: 4,
        paddingHorizontal: 16,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#06395f",
    },

    secondaryButtonText: {
        fontSize: 15,
        fontWeight: "700",
        color: "#ffffff",
    },

    buttonPressed: {
        opacity: 0.82,
    },

    disabledButton: {
        opacity: 0.5,
    },

    updateInfoCard: {
        marginTop: 16,
        padding: 14,
        borderRadius: 12,
        backgroundColor: "#f5f9fb",
        borderWidth: 1,
        borderColor: "#e2ebef",
    },

    updateInfoTitle: {
        fontSize: 14,
        fontWeight: "700",
        color: "#27445c",
        marginBottom: 8,
    },

    versionHeader: {
        minHeight: 48,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
    },

    cardHeaderRowNoMargin: {
        flexDirection: "row",
        alignItems: "center",

        gap: 8,
    },

    versionInfoContent: {
        marginTop: 4,

        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: "#e2e8ec",
    },

    menuCardHeader: {
        paddingHorizontal: 15,
        marginBottom: 4,
    },
});
