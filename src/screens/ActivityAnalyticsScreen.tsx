import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { getCurrentUser } from "aws-amplify/auth";
import { StatusBar } from "expo-status-bar";
import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useWindowDimensions,
    View,
} from "react-native";
import Svg, {
    Circle,
    G,
    Line,
    Polyline,
    Rect,
    Text as SvgText,
} from "react-native-svg";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { client } from "../lib/client";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { ACTIVITY_TYPE_COLORS } from "../constants/activityTypeColors";

type Props = NativeStackScreenProps<RootStackParamList, "ActivityAnalytics">;

type PeriodMode = "WEEKLY" | "MONTHLY" | "YEARLY";

type ActivityFilter = "ALL" | "WALKING" | "RUNNING" | "CYCLING";

type MetricKey = "distanceKm" | "durationHours" | "sessionCount";

type ChartMetricOption = {
    key: MetricKey;
    label: string;
    title: string;
    unit: string;
    icon: keyof typeof MaterialCommunityIcons.glyphMap;
};

type RecordingSessionItem = {
    id: string;
    userId: string;
    startedAt: string;
    endedAt: string;
    distanceMeters: number;
    movingDurationSeconds: number;
    activityType: string;
};

type ChartPoint = {
    key: string;
    label: string;
    distanceKm: number;
    durationHours: number;
    sessionCount: number;
};

type StackedChartPoint = {
    key: string;
    label: string;
    walking: number;
    running: number;
    cycling: number;
};

type ListResult = {
    data?: any[] | null;
    errors?: unknown;
    nextToken?: string | null;
};

const ANALYTICS_ACTIVITY_TYPES = ["WALKING", "RUNNING", "CYCLING"] as const;

const PERIOD_OPTIONS: {
    value: PeriodMode;
    label: string;
}[] = [
    {
        value: "WEEKLY",
        label: "週間",
    },
    {
        value: "MONTHLY",
        label: "月間",
    },
    {
        value: "YEARLY",
        label: "年間",
    },
];

const ACTIVITY_FILTERS: {
    value: ActivityFilter;
    label: string;
    icon: keyof typeof MaterialCommunityIcons.glyphMap;
    color: string;
}[] = [
    {
        value: "ALL",
        label: "すべて",
        icon: "chart-line",
        color: "#0e7185",
    },
    {
        value: "WALKING",
        label: "ウォーキング",
        icon: "walk",
        color: ACTIVITY_TYPE_COLORS.WALKING,
    },
    {
        value: "RUNNING",
        label: "ランニング",
        icon: "run",
        color: ACTIVITY_TYPE_COLORS.RUNNING,
    },
    {
        value: "CYCLING",
        label: "サイクリング",
        icon: "bike",
        color: ACTIVITY_TYPE_COLORS.CYCLING,
    },
];

const CHART_METRIC_OPTIONS: ChartMetricOption[] = [
    {
        key: "distanceKm",
        label: "距離",
        title: "距離の推移",
        unit: "km",
        icon: "map-marker-distance",
    },
    {
        key: "durationHours",
        label: "活動時間",
        title: "活動時間の推移",
        unit: "時間",
        icon: "clock-outline",
    },
    {
        key: "sessionCount",
        label: "活動回数",
        title: "活動回数の推移",
        unit: "回",
        icon: "shoe-print",
    },
];

export default function ActivityAnalyticsScreen({ navigation }: Props) {
    const insets = useSafeAreaInsets();

    useLayoutEffect(() => {
        navigation.setOptions({
            headerShown: false,
        });
    }, [navigation]);

    const [periodMode, setPeriodMode] = useState<PeriodMode>("WEEKLY");

    const [activityFilter, setActivityFilter] = useState<ActivityFilter>("ALL");

    const [selectedMetric, setSelectedMetric] =
        useState<MetricKey>("distanceKm");

    const { width: windowWidth } = useWindowDimensions();

    const [anchorDate, setAnchorDate] = useState(() => new Date());

    const [sessions, setSessions] = useState<RecordingSessionItem[]>([]);

    const [loading, setLoading] = useState(false);

    const periodRange = useMemo(
        () => getPeriodRange(periodMode, anchorDate),
        [periodMode, anchorDate],
    );

    const periodStartTime = periodRange.start.getTime();

    const periodEndTime = periodRange.end.getTime();

    const loadSessions = useCallback(async () => {
        try {
            setLoading(true);

            const currentUser = await getCurrentUser();

            const model = client.models.RecordingSession as any;

            const allData: any[] = [];

            let nextToken: string | null = null;

            do {
                const result =
                    (await model.listRecordingSessionsByUserAndEndedAt({
                        userId: currentUser.userId,

                        endedAt: {
                            between: [
                                new Date(periodStartTime).toISOString(),

                                new Date(periodEndTime).toISOString(),
                            ],
                        },

                        sortDirection: "ASC",

                        limit: 1000,

                        nextToken: nextToken ?? undefined,
                    })) as ListResult;

                if (result.errors) {
                    throw new Error(
                        `RecordingSession analytics query failed: ${JSON.stringify(
                            result.errors,
                        )}`,
                    );
                }

                allData.push(...(result.data ?? []));

                nextToken = result.nextToken ?? null;
            } while (nextToken);

            const nextSessions: RecordingSessionItem[] = allData
                .filter((item: any) => {
                    return (
                        item?.id &&
                        item.userId === currentUser.userId &&
                        typeof item.startedAt === "string" &&
                        typeof item.endedAt === "string" &&
                        ANALYTICS_ACTIVITY_TYPES.includes(
                            item.activityType as (typeof ANALYTICS_ACTIVITY_TYPES)[number],
                        )
                    );
                })
                .map((item: any) => ({
                    id: item.id,

                    userId: item.userId,

                    startedAt: item.startedAt,

                    endedAt: item.endedAt,

                    distanceMeters: Math.max(
                        0,
                        Number(item.distanceMeters ?? 0),
                    ),

                    movingDurationSeconds: getSessionDurationSeconds(item),

                    activityType: item.activityType,
                }));

            setSessions(nextSessions);
        } catch (error) {
            console.error("[ActivityAnalyticsScreen] Load error:", error);

            setSessions([]);

            Alert.alert(
                "取得エラー",
                "アクティビティ分析データを取得できませんでした。",
            );
        } finally {
            setLoading(false);
        }
    }, [periodStartTime, periodEndTime]);

    useFocusEffect(
        useCallback(() => {
            void loadSessions();
        }, [loadSessions]),
    );

    const filteredSessions = useMemo(() => {
        if (activityFilter === "ALL") {
            return sessions;
        }

        return sessions.filter(
            (session) => session.activityType === activityFilter,
        );
    }, [sessions, activityFilter]);

    const summary = useMemo(() => {
        return filteredSessions.reduce(
            (result, session) => {
                result.distanceMeters += session.distanceMeters;

                result.durationSeconds += session.movingDurationSeconds;

                result.sessionCount += 1;

                return result;
            },
            {
                distanceMeters: 0,
                durationSeconds: 0,
                sessionCount: 0,
            },
        );
    }, [filteredSessions]);

    const chartPoints = useMemo(
        () =>
            createChartPoints(
                periodMode,
                new Date(periodStartTime),
                filteredSessions,
            ),
        [periodMode, periodStartTime, filteredSessions],
    );

    const stackedChartPoints = useMemo(
        () =>
            createStackedChartPoints(
                periodMode,
                new Date(periodStartTime),
                sessions,
                selectedMetric,
            ),
        [periodMode, periodStartTime, sessions, selectedMetric],
    );

    const currentPeriodStart = useMemo(
        () => getPeriodRange(periodMode, new Date()).start.getTime(),
        [periodMode],
    );

    const canMoveToNextPeriod = periodStartTime < currentPeriodStart;

    const movePeriod = useCallback(
        (amount: number) => {
            setAnchorDate((current) => {
                const next = new Date(current);

                if (periodMode === "WEEKLY") {
                    next.setDate(next.getDate() + amount * 7);
                } else if (periodMode === "MONTHLY") {
                    next.setMonth(next.getMonth() + amount);
                } else {
                    next.setFullYear(next.getFullYear() + amount);
                }

                return next;
            });
        },
        [periodMode],
    );

    const changePeriodMode = useCallback((nextMode: PeriodMode) => {
        setPeriodMode(nextMode);

        setAnchorDate(new Date());
    }, []);

    const chartWidth = Math.max(280, windowWidth - 44);

    const selectedChartOption = useMemo(() => {
        return (
            CHART_METRIC_OPTIONS.find(
                (option) => option.key === selectedMetric,
            ) ?? CHART_METRIC_OPTIONS[0]
        );
    }, [selectedMetric]);

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
                    styles.header,
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

                <Text style={styles.headerTitle}>アクティビティ分析</Text>

                <View style={styles.headerRightSpace} />
            </View>

            <ScrollView
                style={styles.container}
                contentContainerStyle={styles.contentContainer}
                showsVerticalScrollIndicator={false}
            >
                {/* 週間 / 月間 / 年間 */}
                <View style={styles.periodSegment}>
                    {PERIOD_OPTIONS.map((option) => {
                        const selected = option.value === periodMode;

                        return (
                            <Pressable
                                key={option.value}
                                style={[
                                    styles.periodSegmentButton,

                                    selected &&
                                        styles.periodSegmentButtonSelected,
                                ]}
                                onPress={() => changePeriodMode(option.value)}
                            >
                                <Text
                                    style={[
                                        styles.periodSegmentText,

                                        selected &&
                                            styles.periodSegmentTextSelected,
                                    ]}
                                >
                                    {option.label}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>

                {/* 期間移動 */}
                <View style={styles.periodCard}>
                    <Pressable
                        style={styles.periodArrowButton}
                        onPress={() => movePeriod(-1)}
                        disabled={loading}
                    >
                        <Text style={styles.periodArrowText}>‹</Text>
                    </Pressable>

                    <View style={styles.periodCenter}>
                        <Text style={styles.periodLabel}>
                            {getPeriodModeLabel(periodMode)}
                        </Text>

                        <Text style={styles.periodText}>
                            {formatPeriodLabel(
                                periodMode,
                                periodRange.start,
                                periodRange.end,
                            )}
                        </Text>
                    </View>

                    <Pressable
                        style={[
                            styles.periodArrowButton,

                            !canMoveToNextPeriod &&
                                styles.periodArrowButtonDisabled,
                        ]}
                        onPress={() => movePeriod(1)}
                        disabled={loading || !canMoveToNextPeriod}
                    >
                        <Text
                            style={[
                                styles.periodArrowText,

                                !canMoveToNextPeriod &&
                                    styles.periodArrowTextDisabled,
                            ]}
                        >
                            ›
                        </Text>
                    </Pressable>
                </View>

                {/* アクティビティ種別 */}
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.activityFilterRow}
                >
                    {ACTIVITY_FILTERS.map((option) => {
                        const selected = option.value === activityFilter;

                        return (
                            <Pressable
                                key={option.value}
                                style={[
                                    styles.activityFilterButton,
                                    selected && {
                                        borderColor: option.color,
                                        backgroundColor: option.color,
                                    },
                                ]}
                                onPress={() => setActivityFilter(option.value)}
                            >
                                <MaterialCommunityIcons
                                    name={option.icon}
                                    size={17}
                                    color={selected ? "#ffffff" : option.color}
                                />

                                <Text
                                    style={[
                                        styles.activityFilterText,
                                        !selected && {
                                            color: option.color,
                                        },
                                        selected &&
                                            styles.activityFilterTextSelected,
                                    ]}
                                >
                                    {option.label}
                                </Text>
                            </Pressable>
                        );
                    })}
                </ScrollView>

                {loading ? (
                    <View style={styles.loadingBox}>
                        <ActivityIndicator size="small" color="#0e9384" />

                        <Text style={styles.loadingText}>
                            アクティビティを分析中...
                        </Text>
                    </View>
                ) : (
                    <>
                        {/* サマリー */}
                        <View style={styles.summaryRow}>
                            <SummaryCard
                                icon="map-marker-distance"
                                label="総距離"
                                value={formatDistance(summary.distanceMeters)}
                            />

                            <SummaryCard
                                icon="clock-outline"
                                label="総活動時間"
                                value={formatDuration(summary.durationSeconds)}
                            />

                            <SummaryCard
                                icon="shoe-print"
                                label="活動回数"
                                value={`${summary.sessionCount}回`}
                            />
                        </View>

                        {filteredSessions.length === 0 ? (
                            <View style={styles.emptyCard}>
                                <MaterialCommunityIcons
                                    name="chart-line"
                                    size={40}
                                    color="#91a3ac"
                                />

                                <Text style={styles.emptyTitle}>
                                    アクティビティがありません
                                </Text>

                                <Text style={styles.emptyText}>
                                    選択した期間・種別に該当するアクティビティはありません。
                                </Text>
                            </View>
                        ) : (
                            <>
                                {/* グラフ切替 */}
                                <View style={styles.chartMetricSegment}>
                                    {CHART_METRIC_OPTIONS.map((option) => {
                                        const selected =
                                            selectedMetric === option.key;

                                        return (
                                            <Pressable
                                                key={option.key}
                                                style={[
                                                    styles.chartMetricButton,

                                                    selected &&
                                                        styles.chartMetricButtonSelected,
                                                ]}
                                                onPress={() =>
                                                    setSelectedMetric(
                                                        option.key,
                                                    )
                                                }
                                            >
                                                <MaterialCommunityIcons
                                                    name={option.icon}
                                                    size={17}
                                                    color={
                                                        selected
                                                            ? "#ffffff"
                                                            : "#63747d"
                                                    }
                                                />

                                                <Text
                                                    style={[
                                                        styles.chartMetricText,

                                                        selected &&
                                                            styles.chartMetricTextSelected,
                                                    ]}
                                                >
                                                    {option.label}
                                                </Text>
                                            </Pressable>
                                        );
                                    })}
                                </View>

                                {/* 選択したグラフだけ表示 */}
                                <AnalyticsChartCard
                                    title={selectedChartOption.title}
                                    icon={selectedChartOption.icon}
                                    points={chartPoints}
                                    stackedPoints={stackedChartPoints}
                                    metricKey={selectedChartOption.key}
                                    unit={selectedChartOption.unit}
                                    chartWidth={chartWidth}
                                    periodMode={periodMode}
                                    showStackedBars={activityFilter === "ALL"}
                                />
                            </>
                        )}
                    </>
                )}
            </ScrollView>
        </View>
    );
}

function SummaryCard({
    icon,
    label,
    value,
}: {
    icon: keyof typeof MaterialCommunityIcons.glyphMap;
    label: string;
    value: string;
}) {
    return (
        <View style={styles.summaryCard}>
            <MaterialCommunityIcons name={icon} size={21} color="#0e7185" />

            <Text style={styles.summaryLabel}>{label}</Text>

            <Text
                style={styles.summaryValue}
                numberOfLines={1}
                adjustsFontSizeToFit
            >
                {value}
            </Text>
        </View>
    );
}

function AnalyticsChartCard({
    title,
    icon,
    points,
    stackedPoints,
    metricKey,
    unit,
    chartWidth,
    periodMode,
    showStackedBars,
}: {
    title: string;
    icon: keyof typeof MaterialCommunityIcons.glyphMap;
    points: ChartPoint[];
    stackedPoints: StackedChartPoint[];
    metricKey: MetricKey;
    unit: string;
    chartWidth: number;
    periodMode: PeriodMode;
    showStackedBars: boolean;
}) {
    return (
        <View style={styles.chartCard}>
            <View style={styles.chartTitleRow}>
                <MaterialCommunityIcons name={icon} size={20} color="#0e7185" />

                <Text style={styles.chartTitle}>{title}</Text>
            </View>

            <Text style={styles.chartAxisNote}>縦軸：{unit}</Text>

            {showStackedBars ? (
                <>
                    <ActivityChartLegend />

                    <SimpleStackedBarChart
                        points={stackedPoints}
                        metricKey={metricKey}
                        width={chartWidth}
                        periodMode={periodMode}
                    />
                </>
            ) : (
                <SimpleLineChart
                    points={points}
                    metricKey={metricKey}
                    width={chartWidth}
                    periodMode={periodMode}
                />
            )}
        </View>
    );
}

function SimpleStackedBarChart({
    points,
    metricKey,
    width,
    periodMode,
}: {
    points: StackedChartPoint[];
    metricKey: MetricKey;
    width: number;
    periodMode: PeriodMode;
}) {
    const height = 230;

    const paddingLeft = 52;
    const paddingRight = 18;
    const paddingTop = 24;
    const paddingBottom = 48;

    const plotWidth = width - paddingLeft - paddingRight;

    const plotHeight = height - paddingTop - paddingBottom;

    const totals = points.map(
        (point) => point.walking + point.running + point.cycling,
    );

    const rawMax = Math.max(0, ...totals);

    const maxValue = rawMax <= 0 ? 1 : getNiceMaxValue(rawMax, metricKey);

    const yStepCount = 4;

    const xStep = points.length > 0 ? plotWidth / points.length : plotWidth;

    /*
     * 月間は31本近く表示するため細めにする。
     * 週間・年間は少し太めに表示する。
     */
    const barWidth =
        periodMode === "MONTHLY"
            ? Math.max(3, Math.min(8, xStep * 0.62))
            : periodMode === "YEARLY"
              ? Math.max(10, Math.min(18, xStep * 0.58))
              : Math.max(14, Math.min(28, xStep * 0.58));

    return (
        <View>
            <Svg width={width} height={height}>
                {/* 横グリッド＋Y軸ラベル */}
                {Array.from({
                    length: yStepCount + 1,
                }).map((_, index) => {
                    const ratio = index / yStepCount;

                    const y = paddingTop + plotHeight * ratio;

                    const value = maxValue * (1 - ratio);

                    return (
                        <G key={`grid-${index}`}>
                            <Line
                                x1={paddingLeft}
                                y1={y}
                                x2={width - paddingRight}
                                y2={y}
                                stroke="#e3eaee"
                                strokeWidth={1}
                            />

                            <SvgText
                                x={paddingLeft - 8}
                                y={y + 4}
                                textAnchor="end"
                                fontSize={10}
                                fill="#758790"
                            >
                                {formatYAxisValue(value, metricKey)}
                            </SvgText>
                        </G>
                    );
                })}

                {/* Y軸 */}
                <Line
                    x1={paddingLeft}
                    y1={paddingTop}
                    x2={paddingLeft}
                    y2={paddingTop + plotHeight}
                    stroke="#b7c6cd"
                    strokeWidth={1}
                />

                {/* X軸 */}
                <Line
                    x1={paddingLeft}
                    y1={paddingTop + plotHeight}
                    x2={width - paddingRight}
                    y2={paddingTop + plotHeight}
                    stroke="#b7c6cd"
                    strokeWidth={1}
                />

                {points.map((point, index) => {
                    const x = paddingLeft + xStep * index + xStep / 2;

                    const walkingHeight =
                        (point.walking / maxValue) * plotHeight;

                    const runningHeight =
                        (point.running / maxValue) * plotHeight;

                    const cyclingHeight =
                        (point.cycling / maxValue) * plotHeight;

                    const baselineY = paddingTop + plotHeight;

                    const walkingY = baselineY - walkingHeight;

                    const runningY = walkingY - runningHeight;

                    const cyclingY = runningY - cyclingHeight;

                    return (
                        <G key={point.key}>
                            {/* ウォーキング */}
                            {walkingHeight > 0 && (
                                <Rect
                                    x={x - barWidth / 2}
                                    y={walkingY}
                                    width={barWidth}
                                    height={walkingHeight}
                                    fill={ACTIVITY_TYPE_COLORS.WALKING}
                                />
                            )}

                            {/* ランニング */}
                            {runningHeight > 0 && (
                                <Rect
                                    x={x - barWidth / 2}
                                    y={runningY}
                                    width={barWidth}
                                    height={runningHeight}
                                    fill={ACTIVITY_TYPE_COLORS.RUNNING}
                                />
                            )}

                            {/* サイクリング */}
                            {cyclingHeight > 0 && (
                                <Rect
                                    x={x - barWidth / 2}
                                    y={cyclingY}
                                    width={barWidth}
                                    height={cyclingHeight}
                                    fill={ACTIVITY_TYPE_COLORS.CYCLING}
                                />
                            )}

                            {shouldShowXAxisLabel(
                                periodMode,
                                index,
                                points.length,
                            ) && (
                                <SvgText
                                    x={x}
                                    y={paddingTop + plotHeight + 22}
                                    textAnchor="middle"
                                    fontSize={periodMode === "YEARLY" ? 8 : 9}
                                    fill="#71838c"
                                >
                                    {formatXAxisLabel(point.label, periodMode)}
                                </SvgText>
                            )}
                        </G>
                    );
                })}
            </Svg>
        </View>
    );
}

function SimpleLineChart({
    points,
    metricKey,
    width,
    periodMode,
}: {
    points: ChartPoint[];
    metricKey: MetricKey;
    width: number;
    periodMode: PeriodMode;
}) {
    const height = 230;

    const paddingLeft = 52;
    const paddingRight = 18;
    const paddingTop = 24;
    const paddingBottom = 48;

    const plotWidth = width - paddingLeft - paddingRight;

    const plotHeight = height - paddingTop - paddingBottom;

    const values = points.map((point) => Number(point[metricKey] ?? 0));

    const rawMax = Math.max(0, ...values);

    const maxValue = rawMax <= 0 ? 1 : getNiceMaxValue(rawMax, metricKey);

    const yStepCount = 4;

    const pointRadius =
        periodMode === "MONTHLY" ? 2 : periodMode === "YEARLY" ? 3 : 3.5;

    const xStep =
        points.length > 1 ? plotWidth / (points.length - 1) : plotWidth;

    const coordinates = points.map((point, index) => {
        const value = Number(point[metricKey] ?? 0);

        const x =
            paddingLeft + (points.length === 1 ? plotWidth / 2 : index * xStep);

        const y = paddingTop + plotHeight - (value / maxValue) * plotHeight;

        return {
            x,
            y,
            value,
            label: point.label,
        };
    });

    const polylinePoints = coordinates
        .map((point) => `${point.x},${point.y}`)
        .join(" ");

    return (
        <View>
            <Svg width={width} height={height}>
                {Array.from({
                    length: yStepCount + 1,
                }).map((_, index) => {
                    const ratio = index / yStepCount;

                    const y = paddingTop + plotHeight * ratio;

                    const value = maxValue * (1 - ratio);

                    return (
                        <G key={`grid-${index}`}>
                            <Line
                                x1={paddingLeft}
                                y1={y}
                                x2={width - paddingRight}
                                y2={y}
                                stroke="#e3eaee"
                                strokeWidth={1}
                            />

                            <SvgText
                                x={paddingLeft - 8}
                                y={y + 4}
                                textAnchor="end"
                                fontSize={10}
                                fill="#758790"
                            >
                                {formatYAxisValue(value, metricKey)}
                            </SvgText>
                        </G>
                    );
                })}

                <Line
                    x1={paddingLeft}
                    y1={paddingTop}
                    x2={paddingLeft}
                    y2={paddingTop + plotHeight}
                    stroke="#b7c6cd"
                    strokeWidth={1}
                />

                <Line
                    x1={paddingLeft}
                    y1={paddingTop + plotHeight}
                    x2={width - paddingRight}
                    y2={paddingTop + plotHeight}
                    stroke="#b7c6cd"
                    strokeWidth={1}
                />

                <Polyline
                    points={polylinePoints}
                    fill="none"
                    stroke="#0e9384"
                    strokeWidth={2.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />

                {coordinates.map((point, index) => (
                    <Circle
                        key={`point-${index}`}
                        cx={point.x}
                        cy={point.y}
                        r={pointRadius}
                        fill="#0e9384"
                    />
                ))}

                {coordinates.map((point, index) => {
                    if (
                        !shouldShowXAxisLabel(
                            periodMode,
                            index,
                            coordinates.length,
                        )
                    ) {
                        return null;
                    }

                    return (
                        <SvgText
                            key={`label-${index}`}
                            x={point.x}
                            y={paddingTop + plotHeight + 22}
                            textAnchor="middle"
                            fontSize={periodMode === "YEARLY" ? 8 : 9}
                            fill="#71838c"
                        >
                            {formatXAxisLabel(point.label, periodMode)}
                        </SvgText>
                    );
                })}
            </Svg>
        </View>
    );
}

function shouldShowXAxisLabel(
    periodMode: PeriodMode,
    index: number,
    pointCount: number,
): boolean {
    if (periodMode === "WEEKLY") {
        return true;
    }

    if (periodMode === "YEARLY") {
        return true;
    }

    /*
     * 月間は全28〜31ポイントを
     * プロットするが、
     * ラベルは混雑防止のため
     * 5日単位＋最終日だけ表示。
     */
    const day = index + 1;

    return day === 1 || day % 5 === 0 || index === pointCount - 1;
}

function formatXAxisLabel(label: string, periodMode: PeriodMode): string {
    if (periodMode === "MONTHLY") {
        /*
         * "15日" → "15"
         */
        return label.replace("日", "");
    }

    return label;
}

function createChartPoints(
    periodMode: PeriodMode,
    periodStart: Date,
    sessions: RecordingSessionItem[],
): ChartPoint[] {
    const today = new Date();

    today.setHours(23, 59, 59, 999);

    /*
     * 週間
     *
     * 月〜日の7日分を生成するが、
     * 今日より後の日付は生成しない。
     */
    if (periodMode === "WEEKLY") {
        return Array.from({ length: 7 }, (_, index) => {
            const date = new Date(periodStart);

            date.setDate(date.getDate() + index);

            return date;
        })
            .filter((date) => date.getTime() <= today.getTime())
            .map((date) => createDayPoint(date, sessions, true));
    }

    /*
     * 月間
     *
     * 月初〜月末の日付を作るが、
     * 今日より後の日付は除外する。
     */
    if (periodMode === "MONTHLY") {
        const year = periodStart.getFullYear();

        const month = periodStart.getMonth();

        const daysInMonth = new Date(year, month + 1, 0).getDate();

        return Array.from(
            {
                length: daysInMonth,
            },
            (_, index) => new Date(year, month, index + 1),
        )
            .filter((date) => date.getTime() <= today.getTime())
            .map((date) => createDayPoint(date, sessions, false));
    }

    /*
     * 年間
     *
     * 1〜12月を作るが、
     * 現在月より未来の月は生成しない。
     *
     * 現在月は途中経過として表示する。
     */
    const year = periodStart.getFullYear();

    return Array.from({ length: 12 }, (_, monthIndex) => {
        const monthStart = new Date(year, monthIndex, 1);

        return {
            monthIndex,
            monthStart,
        };
    })
        .filter(({ monthStart }) => monthStart.getTime() <= today.getTime())
        .map(({ monthIndex }) => {
            const monthSessions = sessions.filter((session) => {
                const endedAt = new Date(session.endedAt);

                return (
                    endedAt.getFullYear() === year &&
                    endedAt.getMonth() === monthIndex
                );
            });

            return createAggregatePoint(
                `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
                `${monthIndex + 1}月`,
                monthSessions,
            );
        });
}

function createStackedChartPoints(
    periodMode: PeriodMode,
    periodStart: Date,
    sessions: RecordingSessionItem[],
    metricKey: MetricKey,
): StackedChartPoint[] {
    const walkingPoints = createChartPoints(
        periodMode,
        periodStart,
        sessions.filter((session) => session.activityType === "WALKING"),
    );

    const runningPoints = createChartPoints(
        periodMode,
        periodStart,
        sessions.filter((session) => session.activityType === "RUNNING"),
    );

    const cyclingPoints = createChartPoints(
        periodMode,
        periodStart,
        sessions.filter((session) => session.activityType === "CYCLING"),
    );

    return walkingPoints.map((walkingPoint, index) => ({
        key: walkingPoint.key,
        label: walkingPoint.label,

        walking: Number(walkingPoint[metricKey] ?? 0),

        running: Number(runningPoints[index]?.[metricKey] ?? 0),

        cycling: Number(cyclingPoints[index]?.[metricKey] ?? 0),
    }));
}

function createDayPoint(
    date: Date,
    sessions: RecordingSessionItem[],
    showWeekday: boolean,
): ChartPoint {
    const key = createLocalDateKey(date);

    const daySessions = sessions.filter(
        (session) => createLocalDateKey(new Date(session.endedAt)) === key,
    );

    const weekdayLabels = ["日", "月", "火", "水", "木", "金", "土"];

    const label = showWeekday
        ? `${date.getDate()}(${weekdayLabels[date.getDay()]})`
        : `${date.getDate()}日`;

    return createAggregatePoint(key, label, daySessions);
}

function createAggregatePoint(
    key: string,
    label: string,
    sessions: RecordingSessionItem[],
): ChartPoint {
    let distanceMeters = 0;
    let durationSeconds = 0;

    sessions.forEach((session) => {
        distanceMeters += session.distanceMeters;

        durationSeconds += session.movingDurationSeconds;
    });

    return {
        key,
        label,

        distanceKm: distanceMeters / 1000,

        durationHours: durationSeconds / 3600,

        sessionCount: sessions.length,
    };
}

function getPeriodRange(
    periodMode: PeriodMode,
    anchorDate: Date,
): {
    start: Date;
    end: Date;
} {
    if (periodMode === "WEEKLY") {
        const start = getWeekStart(anchorDate);

        const end = new Date(start);

        end.setDate(end.getDate() + 6);

        end.setHours(23, 59, 59, 999);

        return {
            start,
            end,
        };
    }

    if (periodMode === "MONTHLY") {
        return {
            start: new Date(
                anchorDate.getFullYear(),
                anchorDate.getMonth(),
                1,
                0,
                0,
                0,
                0,
            ),

            end: new Date(
                anchorDate.getFullYear(),
                anchorDate.getMonth() + 1,
                0,
                23,
                59,
                59,
                999,
            ),
        };
    }

    return {
        start: new Date(anchorDate.getFullYear(), 0, 1, 0, 0, 0, 0),

        end: new Date(anchorDate.getFullYear(), 11, 31, 23, 59, 59, 999),
    };
}

function getWeekStart(value: Date): Date {
    const date = new Date(value);

    date.setHours(0, 0, 0, 0);

    const day = date.getDay();

    const daysFromMonday = day === 0 ? 6 : day - 1;

    date.setDate(date.getDate() - daysFromMonday);

    return date;
}

function createLocalDateKey(date: Date): string {
    const year = date.getFullYear();

    const month = String(date.getMonth() + 1).padStart(2, "0");

    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

function getSessionDurationSeconds(session: any): number {
    const movingDurationSeconds = Number(session?.movingDurationSeconds);

    if (Number.isFinite(movingDurationSeconds) && movingDurationSeconds > 0) {
        return movingDurationSeconds;
    }

    const startTime = new Date(session?.startedAt ?? "").getTime();

    const endTime = new Date(session?.endedAt ?? "").getTime();

    if (
        !Number.isFinite(startTime) ||
        !Number.isFinite(endTime) ||
        endTime <= startTime
    ) {
        return 0;
    }

    return Math.round((endTime - startTime) / 1000);
}

function getPeriodModeLabel(periodMode: PeriodMode): string {
    if (periodMode === "WEEKLY") {
        return "週間";
    }

    if (periodMode === "MONTHLY") {
        return "月間";
    }

    return "年間";
}

function formatPeriodLabel(
    periodMode: PeriodMode,
    start: Date,
    end: Date,
): string {
    if (periodMode === "YEARLY") {
        return `${start.getFullYear()}年`;
    }

    if (periodMode === "MONTHLY") {
        return `${start.getFullYear()}年${start.getMonth() + 1}月`;
    }

    if (start.getFullYear() === end.getFullYear()) {
        return `${start.getFullYear()}年${
            start.getMonth() + 1
        }月${start.getDate()}日〜${end.getMonth() + 1}月${end.getDate()}日`;
    }

    return `${start.getFullYear()}年${
        start.getMonth() + 1
    }月${start.getDate()}日〜${end.getFullYear()}年${
        end.getMonth() + 1
    }月${end.getDate()}日`;
}

function formatDistance(distanceMeters: number): string {
    if (distanceMeters < 1000) {
        return `${Math.round(distanceMeters)}m`;
    }

    return `${(distanceMeters / 1000).toFixed(2)}km`;
}

function formatDuration(durationSeconds: number): string {
    const totalMinutes = Math.floor(durationSeconds / 60);

    const hours = Math.floor(totalMinutes / 60);

    const minutes = totalMinutes % 60;

    if (hours === 0) {
        return `${minutes}分`;
    }

    return `${hours}時間${minutes}分`;
}

function getNiceMaxValue(value: number, metricKey: MetricKey): number {
    if (metricKey === "sessionCount") {
        return Math.max(4, Math.ceil(value / 4) * 4);
    }

    if (value <= 1) {
        return 1;
    }

    if (value <= 5) {
        return Math.ceil(value);
    }

    return Math.ceil(value / 5) * 5;
}

function formatYAxisValue(value: number, metricKey: MetricKey): string {
    if (metricKey === "sessionCount") {
        return `${Math.round(value)}`;
    }

    if (value >= 10) {
        return `${Math.round(value)}`;
    }

    return value.toFixed(1);
}

function ActivityChartLegend() {
    return (
        <View style={styles.activityChartLegend}>
            <View style={styles.activityChartLegendItem}>
                <View
                    style={[
                        styles.activityChartLegendColor,
                        {
                            backgroundColor: ACTIVITY_TYPE_COLORS.WALKING,
                        },
                    ]}
                />
                <Text style={styles.activityChartLegendText}>ウォーキング</Text>
            </View>

            <View style={styles.activityChartLegendItem}>
                <View
                    style={[
                        styles.activityChartLegendColor,
                        {
                            backgroundColor: ACTIVITY_TYPE_COLORS.RUNNING,
                        },
                    ]}
                />
                <Text style={styles.activityChartLegendText}>ランニング</Text>
            </View>

            <View style={styles.activityChartLegendItem}>
                <View
                    style={[
                        styles.activityChartLegendColor,
                        {
                            backgroundColor: ACTIVITY_TYPE_COLORS.CYCLING,
                        },
                    ]}
                />
                <Text style={styles.activityChartLegendText}>サイクリング</Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    screen: {
        flex: 1,
        backgroundColor: "#f3f7f9",
    },

    header: {
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
    },

    contentContainer: {
        paddingHorizontal: 14,
        paddingTop: 14,
        paddingBottom: 40,
    },

    periodSegment: {
        flexDirection: "row",

        padding: 4,

        borderRadius: 12,

        backgroundColor: "#e4ebef",
    },

    periodSegmentButton: {
        flex: 1,

        minHeight: 42,

        alignItems: "center",
        justifyContent: "center",

        borderRadius: 9,
    },

    periodSegmentButtonSelected: {
        backgroundColor: "#06395f",
    },

    periodSegmentText: {
        color: "#63747d",
        fontSize: 14,
        fontWeight: "700",
    },

    periodSegmentTextSelected: {
        color: "#ffffff",
    },

    periodCard: {
        minHeight: 72,

        marginTop: 12,

        paddingHorizontal: 10,

        flexDirection: "row",
        alignItems: "center",

        borderWidth: 1,
        borderColor: "#dce6ea",
        borderRadius: 14,

        backgroundColor: "#ffffff",
    },

    periodArrowButton: {
        width: 42,
        height: 42,

        borderRadius: 21,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#e1f3ef",
    },

    periodArrowButtonDisabled: {
        backgroundColor: "#edf1f3",
    },

    periodArrowText: {
        color: "#0e9384",
        fontSize: 30,
        lineHeight: 31,
    },

    periodArrowTextDisabled: {
        color: "#aebbc1",
    },

    periodCenter: {
        flex: 1,

        alignItems: "center",
    },

    periodLabel: {
        marginBottom: 3,

        color: "#7a8b93",
        fontSize: 11,
        fontWeight: "600",
    },

    periodText: {
        color: "#183b50",
        fontSize: 15,
        fontWeight: "700",
    },

    activityFilterRow: {
        paddingVertical: 12,

        gap: 8,
    },

    activityFilterButton: {
        minHeight: 38,

        paddingHorizontal: 13,

        flexDirection: "row",
        alignItems: "center",

        gap: 5,

        borderWidth: 1,
        borderColor: "#d2dfe4",
        borderRadius: 19,

        backgroundColor: "#ffffff",
    },

    activityFilterText: {
        color: "#526873",
        fontSize: 12,
        fontWeight: "700",
    },

    activityFilterTextSelected: {
        color: "#ffffff",
    },

    summaryRow: {
        flexDirection: "row",

        gap: 8,

        marginBottom: 12,
    },

    summaryCard: {
        flex: 1,

        minHeight: 98,

        paddingHorizontal: 6,
        paddingVertical: 12,

        alignItems: "center",
        justifyContent: "center",

        borderWidth: 1,
        borderColor: "#dce6ea",
        borderRadius: 13,

        backgroundColor: "#ffffff",
    },

    summaryLabel: {
        marginTop: 5,

        color: "#73868f",
        fontSize: 11,
        fontWeight: "600",
    },

    summaryValue: {
        marginTop: 5,

        color: "#163f54",
        fontSize: 16,
        fontWeight: "800",
    },

    chartMetricSegment: {
        flexDirection: "row",

        marginBottom: 12,

        padding: 4,

        borderRadius: 12,

        backgroundColor: "#e4ebef",
    },

    chartMetricButton: {
        flex: 1,

        minHeight: 42,

        flexDirection: "row",

        alignItems: "center",
        justifyContent: "center",

        gap: 4,

        borderRadius: 9,
    },

    chartMetricButtonSelected: {
        backgroundColor: "#0e7185",
    },

    chartMetricText: {
        color: "#63747d",

        fontSize: 12,
        fontWeight: "700",
    },

    chartMetricTextSelected: {
        color: "#ffffff",
    },

    chartCard: {
        marginBottom: 12,

        paddingTop: 14,
        paddingHorizontal: 8,
        paddingBottom: 8,

        borderWidth: 1,
        borderColor: "#dce6ea",
        borderRadius: 14,

        backgroundColor: "#ffffff",
    },

    chartTitleRow: {
        paddingHorizontal: 7,

        flexDirection: "row",
        alignItems: "center",

        gap: 6,

        marginBottom: 4,
    },

    chartTitle: {
        color: "#234958",
        fontSize: 15,
        fontWeight: "700",
    },

    chartAxisNote: {
        marginTop: 2,
        marginLeft: 7,
        marginBottom: 4,

        color: "#84949b",
        fontSize: 10,
    },

    loadingBox: {
        minHeight: 220,

        alignItems: "center",
        justifyContent: "center",

        gap: 8,
    },

    loadingText: {
        color: "#71838c",
        fontSize: 13,
    },

    emptyCard: {
        paddingHorizontal: 24,
        paddingVertical: 34,

        alignItems: "center",

        borderWidth: 1,
        borderColor: "#dce6ea",
        borderRadius: 14,

        backgroundColor: "#ffffff",
    },

    emptyTitle: {
        marginTop: 8,

        color: "#36515f",
        fontSize: 15,
        fontWeight: "700",
    },

    emptyText: {
        marginTop: 6,

        textAlign: "center",

        color: "#7b8c94",
        fontSize: 12,
        lineHeight: 18,
    },

    activityChartLegend: {
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 12,
        marginTop: 4,
        marginLeft: 7,
        marginBottom: 2,
    },

    activityChartLegendItem: {
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
    },

    activityChartLegendColor: {
        width: 10,
        height: 10,
        borderRadius: 2,
    },

    activityChartLegendText: {
        color: "#667780",
        fontSize: 10,
        fontWeight: "600",
    },
});
