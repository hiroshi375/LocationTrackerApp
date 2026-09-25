import { useMemo } from "react";
import {
    ActivityIndicator,
    Pressable,
    StyleSheet,
    Text,
    View,
} from "react-native";

export type ActivityType =
    | "WALKING"
    | "RUNNING"
    | "CYCLING"
    | "VEHICLE"
    | "MIXED"
    | "UNKNOWN";

export type ActivityCalendarSession = {
    id: string;
    recordingSessionId: string;
    recordingSessionName: string;
    startedAt: string;
    endedAt: string;
    distanceMeters: number;
    activityType: ActivityType;
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
    selectedDateKey?: string | null;
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
    selectedDateKey = null,
    loading = false,
    onMoveMonth,
    onPressDay,
}: Props) {
    const calendarWeeks = useMemo(() => {
        const cells = createCalendarCells(displayedMonth);

        const weeks: CalendarCell[][] = [];

        for (let index = 0; index < cells.length; index += 7) {
            weeks.push(cells.slice(index, index + 7));
        }

        return weeks;
    }, [displayedMonth]);

    return (
        <View style={styles.container}>
            {/* 月切替 */}
            <View style={styles.header}>
                <Pressable
                    style={({ pressed }) => [
                        styles.monthMoveButton,
                        pressed && styles.monthMoveButtonPressed,
                    ]}
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
                    style={({ pressed }) => [
                        styles.monthMoveButton,
                        pressed && styles.monthMoveButtonPressed,
                    ]}
                    onPress={() => onMoveMonth(1)}
                    disabled={loading}
                >
                    <Text style={styles.monthMoveButtonText}>›</Text>
                </Pressable>
            </View>

            {/* 曜日 */}
            <View style={styles.weekdayRow}>
                {WEEKDAY_LABELS.map((label, index) => (
                    <View key={label} style={styles.weekdayCell}>
                        <Text
                            style={[
                                styles.weekdayText,
                                index === 0 && styles.sundayText,
                                index === 6 && styles.saturdayText,
                            ]}
                        >
                            {label}
                        </Text>
                    </View>
                ))}
            </View>

            {loading ? (
                <View style={styles.loadingBox}>
                    <ActivityIndicator size="small" color="#0e9384" />

                    <Text style={styles.loadingText}>
                        アクティビティを読み込み中...
                    </Text>
                </View>
            ) : (
                <View style={styles.calendarGrid}>
                    {calendarWeeks.map((week, weekIndex) => (
                        <View key={`week-${weekIndex}`} style={styles.weekRow}>
                            {week.map((cell) => {
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
                                    cell.dateKey ===
                                    createLocalDateKey(new Date());

                                const isSelected =
                                    cell.dateKey === selectedDateKey;

                                return (
                                    <Pressable
                                        key={cell.key}
                                        style={({ pressed }) => [
                                            styles.dayCell,
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
                                        <View
                                            style={[
                                                styles.dayBadge,
                                                isToday && styles.todayBadge,
                                                isSelected &&
                                                    styles.selectedDayBadge,
                                            ]}
                                        >
                                            <Text
                                                style={[
                                                    styles.dayNumber,
                                                    cell.date.getDay() === 0 &&
                                                        styles.sundayText,
                                                    cell.date.getDay() === 6 &&
                                                        styles.saturdayText,
                                                    hasActivity &&
                                                        styles.activityDayNumber,
                                                    isSelected &&
                                                        styles.selectedDayNumber,
                                                ]}
                                            >
                                                {cell.date.getDate()}
                                            </Text>
                                        </View>

                                        {hasActivity && (
                                            <View
                                                style={styles.activityDotsRow}
                                            >
                                                {activityDay.sessions
                                                    .slice(0, 4)
                                                    .map((session) => (
                                                        <View
                                                            key={session.id}
                                                            style={[
                                                                styles.activityDot,
                                                                {
                                                                    backgroundColor:
                                                                        getActivityTypeColor(
                                                                            session.activityType,
                                                                        ),
                                                                },
                                                            ]}
                                                        />
                                                    ))}
                                            </View>
                                        )}
                                    </Pressable>
                                );
                            })}
                        </View>
                    ))}
                </View>
            )}
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

export function getActivityTypeColor(activityType: ActivityType): string {
    switch (activityType) {
        case "WALKING":
            return "#15B8A6";

        case "RUNNING":
            return "#5AA9F7";

        case "CYCLING":
            return "#F5B32F";

        case "VEHICLE":
            return "#F26B6B";

        case "MIXED":
            return "#8B7CF6";

        case "UNKNOWN":
        default:
            return "#9AA5B1";
    }
}

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: 12,
        paddingTop: 12,
        paddingBottom: 10,

        backgroundColor: "#ffffff",
    },

    header: {
        minHeight: 44,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",

        marginBottom: 8,
    },

    monthTitle: {
        flex: 1,

        textAlign: "center",

        fontSize: 18,
        fontWeight: "700",

        color: "#183b50",
    },

    monthMoveButton: {
        width: 40,
        height: 40,

        alignItems: "center",
        justifyContent: "center",

        borderRadius: 20,

        backgroundColor: "#e1f3ef",
    },

    monthMoveButtonPressed: {
        opacity: 0.65,
    },

    monthMoveButtonText: {
        fontSize: 28,
        lineHeight: 30,

        color: "#0e9384",
    },

    weekdayRow: {
        flexDirection: "row",

        paddingVertical: 7,

        marginBottom: 4,

        borderTopWidth: StyleSheet.hairlineWidth,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: "#e3eaee",
    },

    weekdayCell: {
        flex: 1,

        alignItems: "center",
        justifyContent: "center",
    },

    weekdayText: {
        textAlign: "center",

        fontSize: 12,
        fontWeight: "700",

        color: "#657781",
    },

    sundayText: {
        color: "#c45a5a",
    },

    saturdayText: {
        color: "#4d71aa",
    },

    calendarGrid: {
        width: "100%",
    },

    weekRow: {
        width: "100%",

        flexDirection: "row",
    },

    emptyDayCell: {
        flex: 1,

        height: 50,
    },

    dayCell: {
        flex: 1,
        height: 60,
        paddingTop: 2,
        alignItems: "center",
    },

    activityDayCellPressed: {
        opacity: 0.55,
    },

    dayBadge: {
        width: 40,
        height: 40,
        borderRadius: 21,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
    },

    todayBadge: {
        borderWidth: 2,
        borderColor: "#8fb0bf",
        backgroundColor: "#f6fbfc",
    },

    selectedDayBadge: {
        backgroundColor: "#175CD3",
    },

    selectedDayNumber: {
        color: "#ffffff",
        fontWeight: "700",
    },

    dayNumber: {
        fontSize: 16,
        fontWeight: "600",

        color: "#334d59",
    },

    activityDayNumber: {
        fontWeight: "700",
    },

    activityDotsRow: {
        marginTop: 5,

        minHeight: 7,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 3,
    },

    activityDot: {
        width: 6,
        height: 6,

        borderRadius: 3,
    },

    loadingBox: {
        minHeight: 250,

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
        backgroundColor: "#dff3ef",
        borderWidth: 1,
        borderColor: "#8fd2c8",
    },

    legendText: {
        fontSize: 11,
        color: "#667780",
    },
});
