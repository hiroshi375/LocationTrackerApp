import {
    ActivityIndicator,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from "react-native";

import { useLayoutEffect } from "react";
import { useNavigation } from "@react-navigation/native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
    FREE_PLAN_LIMITS,
    PREMIUM_PLAN_LIMITS,
} from "../config/subscriptionPlan";
import { useSubscription } from "../hooks/useSubscription";

export default function SubscriptionPlanScreen() {
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    useLayoutEffect(() => {
        navigation.setOptions({
            headerShown: false,
        });
    }, [navigation]);
    const { tier, loading } = useSubscription();

    return (
        <View style={styles.screen}>
            <StatusBar
                style="light"
                backgroundColor="#06395f"
                translucent={false}
            />

            {/* ヘッダ */}
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
                    プラン一覧
                </Text>

                <View style={styles.headerRightSpace} />
            </View>

            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
            >
                {/* 画面説明 */}
                <View style={styles.introCard}>
                    <View style={styles.introIconCircle}>
                        <MaterialCommunityIcons
                            name="shield-crown-outline"
                            size={24}
                            color="#ffffff"
                        />
                    </View>

                    <View style={styles.introTextArea}>
                        <Text style={styles.introTitle}>
                            FREE / PREMIUM プラン
                        </Text>

                        <Text style={styles.description}>
                            AcLog FitはFREEでも基本機能をご利用いただけます。
                            PREMIUMでは、より細かな位置記録や、
                            より多くのアクティビティ・共有機能をご利用いただけます。
                        </Text>
                    </View>
                </View>

                {/* 現在のプラン */}
                <View style={styles.currentPlanCard}>
                    <View style={styles.currentPlanHeader}>
                        <View style={styles.currentPlanTitleRow}>
                            <MaterialCommunityIcons
                                name={
                                    tier === "PREMIUM"
                                        ? "crown-outline"
                                        : "shield-outline"
                                }
                                size={20}
                                color={
                                    tier === "PREMIUM" ? "#c48a12" : "#0e9384"
                                }
                            />

                            <Text style={styles.currentPlanLabel}>
                                現在のプラン
                            </Text>
                        </View>

                        {loading ? (
                            <ActivityIndicator
                                size="small"
                                color="#0e9384"
                                style={styles.currentPlanLoading}
                            />
                        ) : (
                            <View
                                style={[
                                    styles.planBadge,
                                    tier === "PREMIUM"
                                        ? styles.premiumBadge
                                        : styles.freeBadge,
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.planBadgeText,
                                        tier === "PREMIUM" &&
                                            styles.premiumBadgeText,
                                    ]}
                                >
                                    {tier}
                                </Text>
                            </View>
                        )}
                    </View>

                    <Text
                        style={[
                            styles.currentPlanValue,
                            tier === "PREMIUM" &&
                                styles.currentPlanValuePremium,
                        ]}
                    >
                        {loading ? "確認中..." : tier}
                    </Text>

                    <Text style={styles.currentPlanDescription}>
                        {tier === "PREMIUM"
                            ? "PREMIUMでは、細かな記録設定や拡張共有機能を利用できます。"
                            : "FREEでも自動位置記録や履歴表示などの基本機能をご利用いただけます。"}
                    </Text>
                </View>

                {/* プラン比較 */}
                <View style={styles.sectionCard}>
                    <View style={styles.sectionHeader}>
                        <MaterialCommunityIcons
                            name="table-large"
                            size={21}
                            color="#0e9384"
                        />

                        <Text style={styles.sectionTitle}>プラン比較</Text>
                    </View>

                    <View style={styles.comparisonTable}>
                        <View style={styles.headerRow}>
                            <View style={styles.featureColumn}>
                                <Text style={styles.headerText}>機能</Text>
                            </View>

                            <View style={styles.planColumn}>
                                <Text style={styles.headerText}>FREE</Text>
                            </View>

                            <View style={styles.planColumn}>
                                <Text style={styles.premiumHeaderText}>
                                    PREMIUM
                                </Text>
                            </View>
                        </View>

                        <ComparisonRow
                            label="月間アクティビティ数"
                            free={`${FREE_PLAN_LIMITS.maxMonthlyActivities}件まで`}
                            premium={formatLimit(
                                PREMIUM_PLAN_LIMITS.maxMonthlyActivities,
                                "件",
                            )}
                        />

                        <ComparisonRow
                            label="1回の最大記録時間"
                            free={formatDuration(
                                FREE_PLAN_LIMITS.maxActivityDurationMs,
                            )}
                            premium={formatDuration(
                                PREMIUM_PLAN_LIMITS.maxActivityDurationMs,
                            )}
                        />

                        <ComparisonRow
                            label="1アクティビティの記録ポイント数"
                            free={`${FREE_PLAN_LIMITS.maxPointsPerActivity?.toLocaleString()}件まで`}
                            premium={formatLimit(
                                PREMIUM_PLAN_LIMITS.maxPointsPerActivity,
                                "件",
                            )}
                        />

                        <ComparisonRow
                            label="最短記録間隔"
                            free={`${FREE_PLAN_LIMITS.minRecordingIntervalMs / 1000}秒`}
                            premium={`${PREMIUM_PLAN_LIMITS.minRecordingIntervalMs / 1000}秒`}
                            highlightPremium
                        />

                        <ComparisonRow
                            label="最小記録距離"
                            free={`${FREE_PLAN_LIMITS.minRecordingDistanceMeters}m`}
                            premium={`${PREMIUM_PLAN_LIMITS.minRecordingDistanceMeters}m`}
                            highlightPremium
                        />

                        <ComparisonRow
                            label="作成できる共有グループ"
                            free={formatLimit(
                                FREE_PLAN_LIMITS.maxOwnedShareGroups,
                                "グループ",
                            )}
                            premium={formatLimit(
                                PREMIUM_PLAN_LIMITS.maxOwnedShareGroups,
                                "グループ",
                            )}
                            highlightPremium
                        />

                        <ComparisonRow
                            label="1共有グループの最大人数"
                            free={formatLimit(
                                FREE_PLAN_LIMITS.maxUsersPerShareGroup,
                                "人",
                            )}
                            premium={formatLimit(
                                PREMIUM_PLAN_LIMITS.maxUsersPerShareGroup,
                                "人",
                            )}
                            highlightPremium
                        />

                        <ComparisonRow
                            label="アクティビティ区分の変更"
                            free="利用不可"
                            premium="利用可能"
                            highlightPremium
                        />
                    </View>
                </View>

                {/* FREEで使える機能 */}
                <View style={styles.sectionCard}>
                    <View style={styles.sectionHeader}>
                        <MaterialCommunityIcons
                            name="check-circle-outline"
                            size={21}
                            color="#0e9384"
                        />

                        <Text style={styles.sectionTitle}>
                            FREEでも利用できる主な機能
                        </Text>
                    </View>

                    <Text style={styles.cardText}>
                        ✓ 自動位置記録
                        {"\n"}✓ アクティビティ履歴
                        {"\n"}✓ 移動ルートの地図表示
                        {"\n"}✓ 記録ポイントの確認
                        {"\n"}✓ リアルタイム位置共有
                        {"\n"}✓ アクティビティ履歴の共有
                        {"\n"}✓ ランキング
                        {"\n"}✓ サンプルアクティビティ・使い方ガイド
                    </Text>
                </View>

                {/* PREMIUMについて */}
                <View style={styles.premiumCard}>
                    <View style={styles.sectionHeader}>
                        <MaterialCommunityIcons
                            name="crown-outline"
                            size={21}
                            color="#b57b00"
                        />

                        <Text style={styles.premiumCardTitle}>
                            PREMIUMについて
                        </Text>
                    </View>

                    <Text style={styles.premiumCardText}>
                        PREMIUMは買い切り型です。
                        {"\n"}
                        月額・年額の自動更新ではありません。
                        {"\n\n"}
                        購入価格は、購入時にGoogle Playに表示される
                        価格をご確認ください。
                        {"\n\n"}
                        購入済みの場合は、購入復元機能から
                        Premium利用権限を復元できます。
                    </Text>
                </View>

                {/* サンプルアクティビティ */}
                <View style={styles.noteCard}>
                    <View style={styles.sectionHeader}>
                        <MaterialCommunityIcons
                            name="information-outline"
                            size={21}
                            color="#3f718b"
                        />

                        <Text style={styles.noteTitle}>
                            サンプルアクティビティについて
                        </Text>
                    </View>

                    <Text style={styles.noteText}>
                        操作説明用のサンプルアクティビティは、 FREE /
                        PREMIUMのどちらでも利用できます。
                        {"\n\n"}
                        サンプルは実際の活動実績ではないため、
                        月間アクティビティ数やランキングには加算されません。
                    </Text>
                </View>

                <Text style={styles.footerNote}>
                    ※ プランの内容は、機能追加やサービス改善等により
                    変更される場合があります。
                </Text>
            </ScrollView>
        </View>
    );
}

type ComparisonRowProps = {
    label: string;
    free: string;
    premium: string;
    highlightPremium?: boolean;
};

function ComparisonRow({
    label,
    free,
    premium,
    highlightPremium = false,
}: ComparisonRowProps) {
    return (
        <View style={styles.comparisonRow}>
            <View style={styles.featureColumn}>
                <Text style={styles.featureText}>{label}</Text>
            </View>

            <View style={styles.planColumn}>
                <Text style={styles.freeText}>{free}</Text>
            </View>

            <View style={styles.planColumn}>
                <Text
                    style={[
                        styles.premiumText,
                        highlightPremium && styles.premiumTextHighlighted,
                    ]}
                >
                    {premium}
                </Text>
            </View>
        </View>
    );
}

function formatLimit(value: number | null, unit: string): string {
    if (value === null) {
        return "上限なし";
    }

    return `${value.toLocaleString()}${unit}`;
}

function formatDuration(value: number | null): string {
    if (value === null) {
        return "上限なし";
    }

    const totalMinutes = Math.round(value / 60_000);

    if (totalMinutes >= 60 && totalMinutes % 60 === 0) {
        return `${totalMinutes / 60}時間まで`;
    }

    return `${totalMinutes}分まで`;
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

    content: {
        paddingHorizontal: 14,
        paddingTop: 14,
        paddingBottom: 36,

        backgroundColor: "#f3f7f9",
    },

    introCard: {
        marginBottom: 12,

        padding: 15,

        flexDirection: "row",
        alignItems: "flex-start",

        borderWidth: 1,
        borderColor: "#dfe7ea",
        borderRadius: 14,

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

    introIconCircle: {
        width: 42,
        height: 42,

        marginRight: 11,

        borderRadius: 21,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#0e9384",
    },

    introTextArea: {
        flex: 1,
    },

    introTitle: {
        color: "#203f4f",

        fontSize: 16,
        fontWeight: "700",

        marginBottom: 4,
    },

    description: {
        color: "#71838c",

        fontSize: 12,
        lineHeight: 18,
    },

    currentPlanCard: {
        marginBottom: 12,

        padding: 16,

        borderWidth: 1,
        borderColor: "#dfe7ea",
        borderRadius: 14,

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

    currentPlanHeader: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
    },

    currentPlanTitleRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
    },

    currentPlanLabel: {
        fontSize: 14,
        fontWeight: "700",
        color: "#46606c",
    },

    currentPlanValue: {
        marginTop: 10,

        fontSize: 24,
        fontWeight: "800",
        color: "#546e7a",
    },

    currentPlanValuePremium: {
        color: "#a06b00",
    },

    currentPlanDescription: {
        marginTop: 6,

        fontSize: 12,
        lineHeight: 18,
        color: "#74858d",
    },

    currentPlanLoading: {
        marginVertical: 2,
    },

    planBadge: {
        minHeight: 28,

        paddingHorizontal: 10,

        alignItems: "center",
        justifyContent: "center",

        borderRadius: 14,
    },

    freeBadge: {
        backgroundColor: "#e8eef1",
    },

    premiumBadge: {
        backgroundColor: "#fff1c7",
    },

    planBadgeText: {
        color: "#56727e",

        fontSize: 11,
        fontWeight: "700",
    },

    premiumBadgeText: {
        color: "#9b6a00",
    },

    sectionCard: {
        marginBottom: 12,

        padding: 15,

        borderWidth: 1,
        borderColor: "#dfe7ea",
        borderRadius: 14,

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

    sectionHeader: {
        flexDirection: "row",
        alignItems: "center",

        gap: 8,

        marginBottom: 12,
    },

    sectionTitle: {
        color: "#203f4f",

        fontSize: 16,
        fontWeight: "700",
    },

    comparisonTable: {
        borderWidth: 1,
        borderColor: "#dfe5e9",
        borderRadius: 12,
        overflow: "hidden",
        backgroundColor: "#ffffff",
    },

    headerRow: {
        flexDirection: "row",
        alignItems: "stretch",

        backgroundColor: "#eef3f5",
        borderBottomWidth: 1,
        borderBottomColor: "#dfe5e9",
    },

    comparisonRow: {
        flexDirection: "row",
        alignItems: "stretch",

        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: "#dfe5e9",
    },

    featureColumn: {
        flex: 1.6,
        paddingVertical: 12,
        paddingHorizontal: 8,
        justifyContent: "center",
    },

    planColumn: {
        flex: 1,
        paddingVertical: 12,
        paddingHorizontal: 5,
        justifyContent: "center",
        alignItems: "center",
    },

    headerText: {
        fontSize: 13,
        fontWeight: "700",
        color: "#444",
        textAlign: "center",
    },

    premiumHeaderText: {
        fontSize: 13,
        fontWeight: "700",
        color: "#a06b00",
        textAlign: "center",
    },

    featureText: {
        fontSize: 13,
        color: "#333",
        lineHeight: 18,
    },

    freeText: {
        fontSize: 12,
        color: "#555",
        textAlign: "center",
        lineHeight: 17,
    },

    premiumText: {
        fontSize: 12,
        color: "#444",
        textAlign: "center",
        lineHeight: 17,
    },

    premiumTextHighlighted: {
        fontWeight: "700",
        color: "#a06b00",
    },

    cardText: {
        fontSize: 14,
        lineHeight: 24,
        color: "#444",
    },

    premiumCard: {
        marginBottom: 12,

        padding: 15,

        borderRadius: 14,
        borderWidth: 1,
        borderColor: "#e7c97d",

        backgroundColor: "#fffaf0",
    },

    premiumCardTitle: {
        color: "#8a5a00",

        fontSize: 16,
        fontWeight: "700",
    },

    premiumCardText: {
        fontSize: 14,
        lineHeight: 22,
        color: "#55462c",
    },

    noteCard: {
        marginBottom: 16,

        padding: 15,

        borderRadius: 14,

        backgroundColor: "#eef6fb",
        borderWidth: 1,
        borderColor: "#d8e7f0",
    },

    noteTitle: {
        fontSize: 15,
        fontWeight: "700",
        color: "#2f4f66",
    },

    noteText: {
        fontSize: 13,
        lineHeight: 21,
        color: "#455a64",
    },

    footerNote: {
        fontSize: 12,
        lineHeight: 19,
        color: "#777",
    },
});
