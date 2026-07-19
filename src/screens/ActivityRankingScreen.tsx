import { useFocusEffect } from "@react-navigation/native";
import { getUrl } from "aws-amplify/storage";
import { useCallback, useMemo, useState } from "react";
import {
    ActivityIndicator,
    FlatList,
    Image,
    Pressable,
    RefreshControl,
    StyleSheet,
    Text,
    View,
} from "react-native";

import { client } from "../lib/client";
import { createMonthKey } from "../services/userActivityAggregationService";

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

const RANKING_TROPHY_IMAGES: Record<number, number> = {
    1: require("../../assets/images/gold_trophy.png"),
    2: require("../../assets/images/silver_trophy.png"),
    3: require("../../assets/images/bronze_trophy.png"),
    4: require("../../assets/images/4th_trophy.png"),
    5: require("../../assets/images/5th_trophy.png"),
    6: require("../../assets/images/6th_trophy.png"),
    7: require("../../assets/images/7th_trophy.png"),
    8: require("../../assets/images/8th_trophy.png"),
    9: require("../../assets/images/9th_trophy.png"),
    10: require("../../assets/images/10th_trophy.png"),
};

export default function ActivityRankingScreen() {
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
        <View style={styles.container}>
            <View style={styles.modeRow}>
                <Pressable
                    style={[
                        styles.modeButton,
                        mode === "MONTHLY" && styles.modeButtonSelected,
                    ]}
                    onPress={() => setMode("MONTHLY")}
                >
                    <Text
                        style={[
                            styles.modeButtonText,
                            mode === "MONTHLY" && styles.modeButtonTextSelected,
                        ]}
                    >
                        月間
                    </Text>
                </Pressable>

                <Pressable
                    style={[
                        styles.modeButton,
                        mode === "TOTAL" && styles.modeButtonSelected,
                    ]}
                    onPress={() => setMode("TOTAL")}
                >
                    <Text
                        style={[
                            styles.modeButtonText,
                            mode === "TOTAL" && styles.modeButtonTextSelected,
                        ]}
                    >
                        トータル
                    </Text>
                </Pressable>
            </View>

            {mode === "MONTHLY" ? (
                <View style={styles.monthSelector}>
                    <Pressable
                        style={styles.monthMoveButton}
                        onPress={() => moveMonth(-1)}
                        disabled={loading}
                    >
                        <Text style={styles.monthMoveButtonText}>‹ 前月</Text>
                    </Pressable>

                    <Text style={styles.periodText}>
                        {formatMonthLabel(selectedMonth)}
                    </Text>

                    <Pressable
                        style={[
                            styles.monthMoveButton,
                            !canMoveToNextMonth &&
                                styles.monthMoveButtonDisabled,
                        ]}
                        onPress={() => moveMonth(1)}
                        disabled={!canMoveToNextMonth || loading}
                    >
                        <Text
                            style={[
                                styles.monthMoveButtonText,
                                !canMoveToNextMonth &&
                                    styles.monthMoveButtonTextDisabled,
                            ]}
                        >
                            次月 ›
                        </Text>
                    </Pressable>
                </View>
            ) : (
                <Text style={styles.periodText}>全期間</Text>
            )}

            {loading && items.length === 0 ? (
                <ActivityIndicator style={styles.loading} />
            ) : (
                <FlatList
                    data={items}
                    keyExtractor={(item) => item.id}
                    refreshControl={
                        <RefreshControl
                            refreshing={loading}
                            onRefresh={loadRanking}
                        />
                    }
                    ListEmptyComponent={
                        <Text style={styles.emptyText}>
                            集計対象のセッションがありません。
                        </Text>
                    }
                    renderItem={({ item, index }) => {
                        const iconUrl = iconUrls[item.userId];
                        const rank = index + 1;
                        const trophyImage = RANKING_TROPHY_IMAGES[rank];

                        return (
                            <View style={styles.card}>
                                <View style={styles.rankArea}>
                                    {trophyImage ? (
                                        <Image
                                            source={trophyImage}
                                            style={styles.trophyImage}
                                            resizeMode="contain"
                                        />
                                    ) : (
                                        <Text style={styles.rankText}>
                                            {rank}
                                        </Text>
                                    )}
                                </View>

                                {iconUrl ? (
                                    <Image
                                        source={{ uri: iconUrl }}
                                        style={styles.icon}
                                    />
                                ) : (
                                    <View style={styles.iconPlaceholder}>
                                        <Text
                                            style={styles.iconPlaceholderText}
                                        >
                                            {item.displayName.slice(0, 1)}
                                        </Text>
                                    </View>
                                )}

                                <View style={styles.info}>
                                    <Text style={styles.name}>
                                        {item.displayName}
                                    </Text>
                                    <Text style={styles.subText}>
                                        {formatDistance(item.distanceMeters)} ・{" "}
                                        {item.sessionCount}セッション
                                    </Text>
                                    <Text style={styles.subText}>
                                        {formatDuration(item.durationSeconds)}
                                    </Text>
                                </View>
                            </View>
                        );
                    }}
                />
            )}
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

function formatDistance(value: number): string {
    return value >= 1000
        ? `${(value / 1000).toFixed(2)}km`
        : `${Math.round(value)}m`;
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
    container: {
        flex: 1,
        padding: 16,
        backgroundColor: "#f7f9fb",
    },
    modeRow: {
        flexDirection: "row",
        gap: 8,
    },
    modeButton: {
        flex: 1,
        paddingVertical: 10,
        alignItems: "center",
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "#4b6f8f",
        backgroundColor: "#fff",
    },
    modeButtonSelected: {
        backgroundColor: "#4b6f8f",
    },
    modeButtonText: {
        color: "#4b6f8f",
        fontWeight: "bold",
    },
    modeButtonTextSelected: {
        color: "#fff",
    },
    periodText: {
        marginVertical: 14,
        fontSize: 16,
        fontWeight: "bold",
        textAlign: "center",
    },
    loading: {
        marginTop: 40,
    },
    emptyText: {
        marginTop: 40,
        textAlign: "center",
        color: "#666",
    },
    card: {
        flexDirection: "row",
        alignItems: "center",
        padding: 14,
        marginBottom: 10,
        borderRadius: 10,
        backgroundColor: "#fff",
        borderWidth: 1,
        borderColor: "#e1e7ec",
    },
    rankArea: {
        width: 54,
        height: 54,
        alignItems: "center",
        justifyContent: "center",
    },

    trophyImage: {
        width: 52,
        height: 52,
    },

    rankText: {
        fontSize: 20,
        fontWeight: "bold",
        textAlign: "center",
        color: "#2f4f66",
    },
    icon: {
        width: 44,
        height: 44,
        borderRadius: 22,
        marginHorizontal: 10,
    },
    iconPlaceholder: {
        width: 44,
        height: 44,
        borderRadius: 22,
        marginHorizontal: 10,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#dbe5ec",
    },
    iconPlaceholderText: {
        color: "#2f4f66",
        fontSize: 18,
        fontWeight: "bold",
    },
    info: {
        flex: 1,
    },
    name: {
        fontSize: 16,
        fontWeight: "bold",
        marginBottom: 4,
    },
    subText: {
        color: "#555",
        fontSize: 13,
    },
    monthSelector: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: 12,
        marginBottom: 12,
    },

    monthMoveButton: {
        minWidth: 80,
        paddingVertical: 8,
        paddingHorizontal: 12,
        alignItems: "center",
    },

    monthMoveButtonDisabled: {
        opacity: 0.4,
    },

    monthMoveButtonText: {
        fontSize: 14,
        fontWeight: "600",
        color: "#27445c",
    },

    monthMoveButtonTextDisabled: {
        color: "#999999",
    },
});
