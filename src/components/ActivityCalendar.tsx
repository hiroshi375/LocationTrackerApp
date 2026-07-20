import { useMemo } from "react";
import {
    ActivityIndicator,
    Pressable,
    StyleSheet,
    Text,
    View,
} from "react-native";

export type ActivityCalendarSession = {
    id: string;
    recordingSessionId: string;
    recordingSessionName: string;
    startedAt: string;
    endedAt: string;
    distanceMeters: number;
};

export type ActivityCalendarDay = {
    dateKey: string;
    distanceMeters: number;
    sessionCount: number;
    sessions: ActivityCalendarSession[];
};

type Props = {
    displayedMonth: Date;
    activityDays: Record<string, ActivityCalendarDay>;
    loading?: boolean;
    onMoveMonth: (amount: number) => void;
    onPressDay: (day: ActivityCalendarDay) => void;
};

type CalendarCell = {
    key: string;
    date: Date | null;
    dateKey: string | null;
};

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

export default function ActivityCalendar({
    displayedMonth,
    activityDays,
    loading = false,
    onMoveMonth,
    onPressDay,
}: Props) {
    const calendarCells = useMemo(
        () => createCalendarCells(displayedMonth),
        [displayedMonth],
    );

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Pressable
                    style={styles.monthMoveButton}
                    onPress={() => onMoveMonth(-1)}
                    disabled={loading}
                >
                    <Text style={styles.monthMoveButtonText}>‹</Text>
                </Pressable>

                <Text style={styles.monthTitle}>
                    {displayedMonth.getFullYear()}年
                    {displayedMonth.getMonth() + 1}月
                </Text>

                <Pressable
                    style={styles.monthMoveButton}
                    onPress={() => onMoveMonth(1)}
                    disabled={loading}
                >
                    <Text style={styles.monthMoveButtonText}>›</Text>
                </Pressable>
            </View>

            <View style={styles.weekdayRow}>
                {WEEKDAY_LABELS.map((label, index) => (
                    <Text
                        key={label}
                        style={[
                            styles.weekdayText,
                            index === 0 && styles.sundayText,
                            index === 6 && styles.saturdayText,
                        ]}
                    >
                        {label}
                    </Text>
                ))}
            </View>

            {loading ? (
                <View style={styles.loadingBox}>
                    <ActivityIndicator size="small" />
                    <Text style={styles.loadingText}>
                        アクティビティを読み込み中...
                    </Text>
                </View>
            ) : (
                <View style={styles.calendarGrid}>
                    {calendarCells.map((cell) => {
                        if (!cell.date || !cell.dateKey) {
                            return (
                                <View
                                    key={cell.key}
                                    style={styles.emptyDayCell}
                                />
                            );
                        }

                        const activityDay = activityDays[cell.dateKey];
                        const hasActivity = Boolean(activityDay);
                        const isToday =
                            cell.dateKey === createLocalDateKey(new Date());

                        return (
                            <Pressable
                                key={cell.key}
                                style={({ pressed }) => [
                                    styles.dayCell,
                                    hasActivity && styles.activityDayCell,
                                    isToday && styles.todayCell,
                                    pressed &&
                                        hasActivity &&
                                        styles.activityDayCellPressed,
                                ]}
                                disabled={!hasActivity}
                                onPress={() => {
                                    if (activityDay) {
                                        onPressDay(activityDay);
                                    }
                                }}
                            >
                                <Text
                                    style={[
                                        styles.dayNumber,
                                        cell.date.getDay() === 0 &&
                                            styles.sundayText,
                                        cell.date.getDay() === 6 &&
                                            styles.saturdayText,
                                        hasActivity && styles.activityDayNumber,
                                    ]}
                                >
                                    {cell.date.getDate()}
                                </Text>

                                {hasActivity && (
                                    <>
                                        <View style={styles.activityCircle}>
                                            <Text
                                                style={styles.distanceText}
                                                numberOfLines={1}
                                                adjustsFontSizeToFit
                                                minimumFontScale={0.7}
                                            >
                                                {formatCalendarDistance(
                                                    activityDay.distanceMeters,
                                                )}
                                            </Text>
                                        </View>

                                        {activityDay.sessionCount > 1 && (
                                            <Text
                                                style={styles.sessionCountText}
                                            >
                                                {activityDay.sessionCount}件
                                            </Text>
                                        )}
                                    </>
                                )}
                            </Pressable>
                        );
                    })}
                </View>
            )}

            <View style={styles.legendRow}>
                <View style={styles.legendCircle} />
                <Text style={styles.legendText}>アクティビティがあった日</Text>
            </View>
        </View>
    );
}

function createCalendarCells(displayedMonth: Date): CalendarCell[] {
    const year = displayedMonth.getFullYear();
    const month = displayedMonth.getMonth();

    const firstDate = new Date(year, month, 1);
    const lastDate = new Date(year, month + 1, 0);

    const leadingEmptyCount = firstDate.getDay();
    const daysInMonth = lastDate.getDate();

    const cells: CalendarCell[] = [];

    for (let index = 0; index < leadingEmptyCount; index += 1) {
        cells.push({
            key: `leading-${index}`,
            date: null,
            dateKey: null,
        });
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
        const date = new Date(year, month, day);

        cells.push({
            key: createLocalDateKey(date),
            date,
            dateKey: createLocalDateKey(date),
        });
    }

    /*
     * 最終週まで7列で埋める。
     */
    while (cells.length % 7 !== 0) {
        cells.push({
            key: `trailing-${cells.length}`,
            date: null,
            dateKey: null,
        });
    }

    return cells;
}

export function createLocalDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

function formatCalendarDistance(distanceMeters: number): string {
    if (distanceMeters >= 1000) {
        const distanceKm = distanceMeters / 1000;

        return distanceKm >= 10
            ? `${distanceKm.toFixed(1)}km`
            : `${distanceKm.toFixed(2)}km`;
    }

    return `${Math.round(distanceMeters)}m`;
}

const styles = StyleSheet.create({
    container: {
        padding: 14,
        borderWidth: 1,
        borderColor: "#e4e8ec",
        borderRadius: 12,
        backgroundColor: "#ffffff",
    },

    header: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 12,
    },

    monthTitle: {
        fontSize: 18,
        fontWeight: "bold",
        color: "#243746",
    },

    monthMoveButton: {
        width: 42,
        height: 38,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        backgroundColor: "#edf3f7",
    },

    monthMoveButtonText: {
        fontSize: 28,
        lineHeight: 30,
        color: "#365d78",
    },

    weekdayRow: {
        flexDirection: "row",
        marginBottom: 4,
    },

    weekdayText: {
        width: `${100 / 7}%`,
        textAlign: "center",
        fontSize: 12,
        fontWeight: "600",
        color: "#536571",
    },

    sundayText: {
        color: "#c45a5a",
    },

    saturdayText: {
        color: "#4d71aa",
    },

    calendarGrid: {
        flexDirection: "row",
        flexWrap: "wrap",
    },

    emptyDayCell: {
        width: `${100 / 7}%`,
        height: 74,
    },

    dayCell: {
        width: `${100 / 7}%`,
        height: 74,
        paddingTop: 4,
        paddingHorizontal: 2,
        alignItems: "center",
        borderRadius: 10,
    },

    activityDayCell: {
        backgroundColor: "transparent",
    },

    activityDayCellPressed: {
        opacity: 0.65,
    },

    todayCell: {
        borderWidth: 1,
        borderColor: "#7394aa",
    },

    dayNumber: {
        fontSize: 13,
        color: "#334650",
    },

    activityDayNumber: {
        fontWeight: "bold",
    },

    activityCircle: {
        width: 42,
        height: 42,
        marginTop: 3,
        borderRadius: 21,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#fff0a8",
    },

    distanceText: {
        width: 38,
        paddingHorizontal: 2,
        textAlign: "center",
        fontSize: 10,
        lineHeight: 13,
        fontWeight: "bold",
        color: "#5f5428",
    },

    sessionCountText: {
        marginTop: 1,
        fontSize: 9,
        color: "#756a43",
    },

    loadingBox: {
        minHeight: 220,
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
    },

    loadingText: {
        fontSize: 13,
        color: "#667780",
    },

    legendRow: {
        marginTop: 10,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 6,
    },

    legendCircle: {
        width: 13,
        height: 13,
        borderRadius: 7,
        backgroundColor: "#fff0a8",
        borderWidth: 1,
        borderColor: "#e0c45c",
    },

    legendText: {
        fontSize: 11,
        color: "#667780",
    },
});
