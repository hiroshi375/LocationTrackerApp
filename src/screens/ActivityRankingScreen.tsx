import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { getUrl } from "aws-amplify/storage";
import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import {
    ActivityIndicator,
    FlatList,
    Image,
    type ImageSourcePropType,
    Pressable,
    RefreshControl,
    StyleSheet,
    Text,
    View,
} from "react-native";

import { client } from "../lib/client";
import { createMonthKey } from "../services/userActivityAggregationService";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type RankingMode = "MONTHLY" | "TOTAL";

type RankingItem = {
    id: string;
    userId: string;
    displayName: string;
    iconImagePath?: string | null;
    distanceMeters: number;
    durationSeconds: number;
    sessionCount: number;
};

type ListResult = {
    data?: any[] | null;
    errors?: unknown;
    nextToken?: string | null;
};

const RANKING_TROPHY_IMAGES: Record<number, ImageSourcePropType> = {
    1: require("../../assets/images/gold_trophy.png"),
    2: require("../../assets/images/silver_trophy.png"),
    3: require("../../assets/images/bronze_trophy.png"),
};

export default function ActivityRankingScreen() {
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();

    useLayoutEffect(() => {
        navigation.setOptions({
            headerShown: false,
        });
    }, [navigation]);

    const [mode, setMode] = useState<RankingMode>("MONTHLY");
    const [items, setItems] = useState<RankingItem[]>([]);
    const [iconUrls, setIconUrls] = useState<Record<string, string | null>>({});
    const [loading, setLoading] = useState(false);

    const [selectedMonth, setSelectedMonth] = useState(() => {
        const now = new Date();

        return new Date(now.getFullYear(), now.getMonth(), 1);
    });

    const monthKey = useMemo(
        () => createMonthKey(selectedMonth),
        [selectedMonth],
    );

    const moveMonth = useCallback((amount: number) => {
        setSelectedMonth((current) => {
            return new Date(
                current.getFullYear(),
                current.getMonth() + amount,
                1,
            );
        });
    }, []);

    const currentMonthKey = useMemo(() => createMonthKey(new Date()), []);

    const canMoveToNextMonth = monthKey < currentMonthKey;

    const loadRanking = useCallback(async () => {
        try {
            setLoading(true);

            const nextItems =
                mode === "MONTHLY"
                    ? await loadMonthlyRanking(monthKey)
                    : await loadTotalRanking();

            setItems(
                nextItems.sort(
                    (a, b) =>
                        b.distanceMeters - a.distanceMeters ||
                        b.durationSeconds - a.durationSeconds,
                ),
            );

            const iconEntries = await Promise.all(
                nextItems.map(async (item) => {
                    if (!item.iconImagePath) {
                        return [item.userId, null] as const;
                    }

                    try {
                        const result = await getUrl({
                            path: item.iconImagePath,
                            options: { expiresIn: 3600 },
                        });

                        return [item.userId, result.url.toString()] as const;
                    } catch {
                        return [item.userId, null] as const;
                    }
                }),
            );

            setIconUrls(Object.fromEntries(iconEntries));
        } catch (error) {
            console.error("Activity ranking load error:", error);
            setItems([]);
        } finally {
            setLoading(false);
        }
    }, [mode, monthKey]);

    useFocusEffect(
        useCallback(() => {
            void loadRanking();
        }, [loadRanking]),
    );

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
                    アクティビティランキング
                </Text>

                <View style={styles.headerRightSpace} />
            </View>

            <View style={styles.container}>
                {/* 月間 / トータル */}
                <View style={styles.modeSegment}>
                    <Pressable
                        style={[
                            styles.modeSegmentButton,
                            mode === "MONTHLY" &&
                                styles.modeSegmentButtonSelected,
                        ]}
                        onPress={() => setMode("MONTHLY")}
                    >
                        <MaterialCommunityIcons
                            name="calendar-month-outline"
                            size={18}
                            color={mode === "MONTHLY" ? "#ffffff" : "#607783"}
                        />

                        <Text
                            style={[
                                styles.modeSegmentText,
                                mode === "MONTHLY" &&
                                    styles.modeSegmentTextSelected,
                            ]}
                        >
                            月間
                        </Text>
                    </Pressable>

                    <Pressable
                        style={[
                            styles.modeSegmentButton,
                            mode === "TOTAL" &&
                                styles.modeSegmentButtonSelected,
                        ]}
                        onPress={() => setMode("TOTAL")}
                    >
                        <MaterialCommunityIcons
                            name="chart-line"
                            size={18}
                            color={mode === "TOTAL" ? "#ffffff" : "#607783"}
                        />

                        <Text
                            style={[
                                styles.modeSegmentText,
                                mode === "TOTAL" &&
                                    styles.modeSegmentTextSelected,
                            ]}
                        >
                            トータル
                        </Text>
                    </Pressable>
                </View>

                {/* 対象期間 */}
                {mode === "MONTHLY" ? (
                    <View style={styles.periodCard}>
                        <Pressable
                            style={({ pressed }) => [
                                styles.monthArrowButton,
                                pressed && !loading && styles.buttonPressed,
                            ]}
                            onPress={() => moveMonth(-1)}
                            disabled={loading}
                        >
                            <Text style={styles.monthArrowText}>‹</Text>
                        </Pressable>

                        <View style={styles.periodCenter}>
                            <Text style={styles.periodLabel}>
                                月間ランキング
                            </Text>

                            <Text style={styles.periodText}>
                                {formatMonthLabel(selectedMonth)}
                            </Text>
                        </View>

                        <Pressable
                            style={({ pressed }) => [
                                styles.monthArrowButton,
                                !canMoveToNextMonth &&
                                    styles.monthArrowButtonDisabled,
                                pressed &&
                                    canMoveToNextMonth &&
                                    !loading &&
                                    styles.buttonPressed,
                            ]}
                            onPress={() => moveMonth(1)}
                            disabled={!canMoveToNextMonth || loading}
                        >
                            <Text
                                style={[
                                    styles.monthArrowText,
                                    !canMoveToNextMonth &&
                                        styles.monthArrowTextDisabled,
                                ]}
                            >
                                ›
                            </Text>
                        </Pressable>
                    </View>
                ) : (
                    <View style={styles.periodCard}>
                        <View style={styles.periodCenter}>
                            <Text style={styles.periodLabel}>
                                トータルランキング
                            </Text>

                            <Text style={styles.periodText}>全期間</Text>
                        </View>
                    </View>
                )}

                {/* ランキング */}
                {loading && items.length === 0 ? (
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator size="small" color="#0e9384" />

                        <Text style={styles.loadingText}>
                            ランキングを読み込み中...
                        </Text>
                    </View>
                ) : (
                    <FlatList
                        data={items}
                        keyExtractor={(item) => item.id}
                        showsVerticalScrollIndicator={false}
                        contentContainerStyle={
                            items.length === 0
                                ? styles.emptyListContent
                                : styles.listContent
                        }
                        refreshControl={
                            <RefreshControl
                                refreshing={loading}
                                onRefresh={loadRanking}
                                tintColor="#0e9384"
                            />
                        }
                        ListEmptyComponent={
                            <View style={styles.emptyCard}>
                                <MaterialCommunityIcons
                                    name="podium"
                                    size={34}
                                    color="#92a3ab"
                                />

                                <Text style={styles.emptyTitle}>
                                    ランキングデータがありません
                                </Text>

                                <Text style={styles.emptyDescription}>
                                    集計対象のアクティビティが記録されると、
                                    ここにランキングが表示されます。
                                </Text>
                            </View>
                        }
                        renderItem={({ item, index }) => {
                            const iconUrl = iconUrls[item.userId];

                            const rank = index + 1;

                            const trophyImage = RANKING_TROPHY_IMAGES[rank];

                            return (
                                <View
                                    style={[
                                        styles.rankingCard,
                                        rank <= 3 && styles.topRankingCard,
                                    ]}
                                >
                                    {/* 順位 */}
                                    <View style={styles.rankArea}>
                                        {trophyImage ? (
                                            <Image
                                                source={trophyImage}
                                                style={styles.trophyImage}
                                                resizeMode="contain"
                                            />
                                        ) : (
                                            <Text
                                                style={[
                                                    styles.plainRankText,
                                                    rank >= 11 &&
                                                        styles.plainRankTextSmall,
                                                ]}
                                            >
                                                {rank}
                                            </Text>
                                        )}
                                    </View>

                                    {/* ユーザーアイコン */}
                                    {iconUrl ? (
                                        <Image
                                            source={{
                                                uri: iconUrl,
                                            }}
                                            style={styles.userIcon}
                                        />
                                    ) : (
                                        <View style={styles.iconPlaceholder}>
                                            <Text
                                                style={
                                                    styles.iconPlaceholderText
                                                }
                                            >
                                                {item.displayName
                                                    .slice(0, 1)
                                                    .toUpperCase()}
                                            </Text>
                                        </View>
                                    )}

                                    {/* ユーザー情報 */}
                                    <View style={styles.info}>
                                        <Text
                                            style={styles.name}
                                            numberOfLines={1}
                                        >
                                            {item.displayName}
                                        </Text>

                                        <View style={styles.metaRow}>
                                            <MaterialCommunityIcons
                                                name="shoe-print"
                                                size={14}
                                                color="#71838c"
                                            />

                                            <Text style={styles.metaText}>
                                                {item.sessionCount}
                                                セッション
                                            </Text>

                                            <Text style={styles.metaSeparator}>
                                                ・
                                            </Text>

                                            <MaterialCommunityIcons
                                                name="clock-outline"
                                                size={14}
                                                color="#71838c"
                                            />

                                            <Text style={styles.metaText}>
                                                {formatDuration(
                                                    item.durationSeconds,
                                                )}
                                            </Text>
                                        </View>
                                    </View>

                                    {/* 距離 */}
                                    <View style={styles.distanceArea}>
                                        <Text style={styles.distanceValue}>
                                            {formatDistanceValue(
                                                item.distanceMeters,
                                            )}
                                        </Text>

                                        <Text style={styles.distanceUnit}>
                                            {getDistanceUnit(
                                                item.distanceMeters,
                                            )}
                                        </Text>
                                    </View>
                                </View>
                            );
                        }}
                    />
                )}
            </View>
        </View>
    );
}

async function loadMonthlyRanking(monthKey: string): Promise<RankingItem[]> {
    const model = client.models.UserActivityMonthlySummary as any;
    const allData: any[] = [];
    let nextToken: string | null = null;

    do {
        const result = (await model.listMonthlyActivityRanking({
            monthKey,
            sortDirection: "DESC",
            limit: 1000,
            nextToken: nextToken ?? undefined,
        })) as ListResult;

        if (result.errors) {
            throw new Error(JSON.stringify(result.errors));
        }

        allData.push(...(result.data ?? []));
        nextToken = result.nextToken ?? null;
    } while (nextToken);

    return allData.map((item) => ({
        id: item.id,
        userId: item.userId,
        displayName: item.displayName ?? "ユーザー",
        iconImagePath: item.iconImagePath ?? null,
        distanceMeters: Number(item.distanceMeters ?? 0),
        durationSeconds: Number(item.durationSeconds ?? 0),
        sessionCount: Number(item.sessionCount ?? 0),
    }));
}

async function loadTotalRanking(): Promise<RankingItem[]> {
    const model = client.models.UserProfile as any;
    const allData: any[] = [];
    let nextToken: string | null = null;

    do {
        const result = (await model.list({
            limit: 1000,
            nextToken: nextToken ?? undefined,
        })) as ListResult;

        if (result.errors) {
            throw new Error(JSON.stringify(result.errors));
        }

        allData.push(...(result.data ?? []));
        nextToken = result.nextToken ?? null;
    } while (nextToken);

    return allData
        .filter((item) => Number(item.totalAggregationSessionCount ?? 0) > 0)
        .map((item) => ({
            id: item.id,
            userId: item.userId,
            displayName: item.displayName ?? item.email ?? "ユーザー",
            iconImagePath: item.iconImagePath ?? null,
            distanceMeters: Number(item.totalAggregationDistanceMeters ?? 0),
            durationSeconds: Number(item.totalAggregationDurationSeconds ?? 0),
            sessionCount: Number(item.totalAggregationSessionCount ?? 0),
        }));
}

function formatDistanceValue(distanceMeters: number): string {
    if (distanceMeters >= 1000) {
        return (distanceMeters / 1000).toFixed(2);
    }

    return `${Math.round(distanceMeters)}`;
}

function getDistanceUnit(distanceMeters: number): string {
    return distanceMeters >= 1000 ? "km" : "m";
}

function formatDuration(totalSeconds: number): string {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (hours > 0) {
        return `${hours}時間${minutes}分`;
    }

    return `${minutes}分`;
}

function formatMonthLabel(date: Date): string {
    return `${date.getFullYear()}年${date.getMonth() + 1}月`;
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

    container: {
        flex: 1,

        paddingHorizontal: 14,
        paddingTop: 12,

        backgroundColor: "#f3f7f9",
    },

    modeSegment: {
        padding: 4,

        flexDirection: "row",

        borderRadius: 12,

        backgroundColor: "#e4ebef",
    },

    modeSegmentButton: {
        flex: 1,

        minHeight: 42,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 6,

        borderRadius: 9,
    },

    modeSegmentButtonSelected: {
        backgroundColor: "#0e9384",

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 1,
        },
        shadowOpacity: 0.12,
        shadowRadius: 2,

        elevation: 2,
    },

    modeSegmentText: {
        color: "#607783",

        fontSize: 14,
        fontWeight: "700",
    },

    modeSegmentTextSelected: {
        color: "#ffffff",
    },

    periodCard: {
        minHeight: 72,

        marginTop: 12,
        marginBottom: 12,

        paddingHorizontal: 10,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",

        borderWidth: 1,
        borderColor: "#dce6ea",

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

    periodCenter: {
        flex: 1,

        alignItems: "center",
        justifyContent: "center",
    },

    periodLabel: {
        marginBottom: 2,

        color: "#7a8b93",

        fontSize: 11,
        fontWeight: "600",
    },

    periodText: {
        color: "#183b50",

        fontSize: 17,
        fontWeight: "700",
    },

    monthArrowButton: {
        width: 42,
        height: 42,

        alignItems: "center",
        justifyContent: "center",

        borderRadius: 21,

        backgroundColor: "#e1f3ef",
    },

    monthArrowButtonDisabled: {
        backgroundColor: "#edf1f3",
    },

    monthArrowText: {
        color: "#0e9384",

        fontSize: 30,
        lineHeight: 31,
        fontWeight: "400",
    },

    monthArrowTextDisabled: {
        color: "#aebbc1",
    },

    buttonPressed: {
        opacity: 0.65,
    },

    listContent: {
        paddingBottom: 24,
    },

    rankingCard: {
        minHeight: 86,

        marginBottom: 10,
        paddingHorizontal: 10,
        paddingVertical: 9,

        flexDirection: "row",
        alignItems: "center",

        borderWidth: 1,
        borderColor: "#e0e8ec",

        borderRadius: 14,

        backgroundColor: "#ffffff",

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.04,
        shadowRadius: 4,

        elevation: 1,
    },

    topRankingCard: {
        borderColor: "#cddde4",

        shadowOpacity: 0.07,

        elevation: 2,
    },

    rankArea: {
        width: 66,
        height: 66,

        alignItems: "center",
        justifyContent: "center",

        overflow: "visible",
    },

    trophyImage: {
        width: 62,
        height: 62,
    },

    rankBadge: {
        width: 42,
        height: 42,

        borderRadius: 21,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#e8eef3",
    },

    rankText: {
        color: "#35566b",

        fontSize: 19,
        fontWeight: "700",
    },

    userIcon: {
        width: 46,
        height: 46,

        marginLeft: 2,
        marginRight: 11,

        borderRadius: 23,

        backgroundColor: "#e8eef1",
    },

    iconPlaceholder: {
        width: 46,
        height: 46,

        marginLeft: 2,
        marginRight: 11,

        borderRadius: 23,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#dce8ed",
    },

    iconPlaceholderText: {
        color: "#315c6d",

        fontSize: 18,
        fontWeight: "700",
    },

    info: {
        flex: 1,
        minWidth: 0,
    },

    name: {
        marginBottom: 6,

        color: "#203f4f",

        fontSize: 15,
        fontWeight: "700",
    },

    metaRow: {
        flexDirection: "row",
        alignItems: "center",

        flexWrap: "wrap",
    },

    metaText: {
        marginLeft: 3,

        color: "#71838c",

        fontSize: 11,
    },

    metaSeparator: {
        marginHorizontal: 4,

        color: "#9aa7ad",

        fontSize: 11,
    },

    distanceArea: {
        minWidth: 66,

        marginLeft: 8,

        alignItems: "flex-end",
        justifyContent: "center",
    },

    distanceValue: {
        color: "#0e7185",

        fontSize: 20,
        fontWeight: "800",
    },

    distanceUnit: {
        marginTop: -2,

        color: "#71838c",

        fontSize: 11,
        fontWeight: "600",
    },

    loadingContainer: {
        flex: 1,

        alignItems: "center",
        justifyContent: "center",

        gap: 8,
    },

    loadingText: {
        color: "#6f818a",

        fontSize: 13,
    },

    emptyListContent: {
        flexGrow: 1,
    },

    emptyCard: {
        marginTop: 28,
        paddingHorizontal: 24,
        paddingVertical: 26,

        alignItems: "center",

        borderWidth: 1,
        borderColor: "#dfe7ea",

        borderRadius: 14,

        backgroundColor: "#ffffff",
    },

    emptyTitle: {
        marginTop: 9,

        color: "#334f5d",

        fontSize: 15,
        fontWeight: "700",
    },

    emptyDescription: {
        marginTop: 5,

        textAlign: "center",

        color: "#7b8b93",

        fontSize: 12,
        lineHeight: 18,
    },

    rankBadgeSmall: {
        width: 34,
        height: 34,

        borderRadius: 17,
    },

    rankTextSmall: {
        fontSize: 15,
    },

    plainRankText: {
        fontSize: 22,
        fontWeight: "700",
        color: "#35566b",
    },

    plainRankTextSmall: {
        fontSize: 15,
        fontWeight: "600",
    },
});
