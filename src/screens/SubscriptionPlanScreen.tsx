import {
    ActivityIndicator,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from "react-native";

import {
    FREE_PLAN_LIMITS,
    PREMIUM_PLAN_LIMITS,
} from "../config/subscriptionPlan";
import { useSubscription } from "../hooks/useSubscription";

export default function SubscriptionPlanScreen() {
    const { tier, loading } = useSubscription();

    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={styles.content}
        >
            <Text style={styles.title}>FREE / PREMIUM プラン</Text>

            <Text style={styles.description}>
                LocationTrackerAppはFREEでも基本機能をご利用いただけます。
                PREMIUMでは、より細かな位置記録や、
                より多くのアクティビティ・共有機能をご利用いただけます。
            </Text>

            <View style={styles.currentPlanCard}>
                <Text style={styles.currentPlanLabel}>現在のプラン</Text>

                {loading ? (
                    <ActivityIndicator style={styles.currentPlanLoading} />
                ) : (
                    <Text
                        style={[
                            styles.currentPlanValue,
                            tier === "PREMIUM" &&
                                styles.currentPlanValuePremium,
                        ]}
                    >
                        {tier}
                    </Text>
                )}
            </View>

            <Text style={styles.sectionTitle}>プラン比較</Text>

            <View style={styles.comparisonTable}>
                <View style={styles.headerRow}>
                    <View style={styles.featureColumn}>
                        <Text style={styles.headerText}>機能</Text>
                    </View>

                    <View style={styles.planColumn}>
                        <Text style={styles.headerText}>FREE</Text>
                    </View>

                    <View style={styles.planColumn}>
                        <Text style={styles.premiumHeaderText}>PREMIUM</Text>
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

            <View style={styles.commonFeatureCard}>
                <Text style={styles.cardTitle}>FREEでも利用できる主な機能</Text>

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

            <View style={styles.premiumCard}>
                <Text style={styles.premiumCardTitle}>PREMIUMについて</Text>

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

            <View style={styles.noteCard}>
                <Text style={styles.noteTitle}>サンプルについて</Text>

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
    container: {
        flex: 1,
        backgroundColor: "#f7f8fa",
    },

    content: {
        padding: 16,
        paddingBottom: 48,
    },

    title: {
        fontSize: 24,
        fontWeight: "bold",
        color: "#2f4f66",
        marginBottom: 12,
    },

    description: {
        fontSize: 14,
        lineHeight: 22,
        color: "#555",
        marginBottom: 20,
    },

    currentPlanCard: {
        backgroundColor: "#ffffff",
        borderRadius: 12,
        padding: 16,
        marginBottom: 24,
        borderWidth: 1,
        borderColor: "#dfe5e9",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
    },

    currentPlanLabel: {
        fontSize: 15,
        fontWeight: "600",
        color: "#444",
    },

    currentPlanValue: {
        fontSize: 18,
        fontWeight: "bold",
        color: "#546e7a",
    },

    currentPlanValuePremium: {
        color: "#a06b00",
    },

    currentPlanLoading: {
        marginVertical: 2,
    },

    sectionTitle: {
        fontSize: 18,
        fontWeight: "bold",
        color: "#333",
        marginBottom: 12,
    },

    comparisonTable: {
        backgroundColor: "#ffffff",
        borderRadius: 12,
        overflow: "hidden",
        borderWidth: 1,
        borderColor: "#dfe5e9",
        marginBottom: 20,
    },

    headerRow: {
        flexDirection: "row",
        alignItems: "stretch",
        backgroundColor: "#eef2f4",
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
        fontWeight: "bold",
        color: "#444",
        textAlign: "center",
    },

    premiumHeaderText: {
        fontSize: 13,
        fontWeight: "bold",
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
        fontWeight: "bold",
        color: "#a06b00",
    },

    commonFeatureCard: {
        backgroundColor: "#ffffff",
        borderRadius: 12,
        borderWidth: 1,
        borderColor: "#dfe5e9",
        padding: 16,
        marginBottom: 16,
    },

    cardTitle: {
        fontSize: 16,
        fontWeight: "bold",
        color: "#2f4f66",
        marginBottom: 10,
    },

    cardText: {
        fontSize: 14,
        lineHeight: 24,
        color: "#444",
    },

    premiumCard: {
        backgroundColor: "#fffaf0",
        borderRadius: 12,
        borderWidth: 1,
        borderColor: "#e7c97d",
        padding: 16,
        marginBottom: 16,
    },

    premiumCardTitle: {
        fontSize: 16,
        fontWeight: "bold",
        color: "#8a5a00",
        marginBottom: 10,
    },

    premiumCardText: {
        fontSize: 14,
        lineHeight: 22,
        color: "#55462c",
    },

    noteCard: {
        backgroundColor: "#eef6fb",
        borderRadius: 12,
        padding: 16,
        marginBottom: 20,
    },

    noteTitle: {
        fontSize: 15,
        fontWeight: "bold",
        color: "#2f4f66",
        marginBottom: 8,
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
