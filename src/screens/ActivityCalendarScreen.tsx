import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { getCurrentUser } from "aws-amplify/auth";
import { useCallback, useLayoutEffect, useState } from "react";
import {
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from "react-native";

import ActivityCalendar, {
    type ActivityCalendarDay,
    type ActivityCalendarSession,
    createLocalDateKey,
} from "../components/ActivityCalendar";
import { client } from "../lib/client";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type Props = NativeStackScreenProps<RootStackParamList, "ActivityCalendar">;

type RecordingSessionCalendarListResult = {
    data?: any[] | null;
    errors?: unknown;
    nextToken?: string | null;
};

export default function ActivityCalendarScreen({ navigation }: Props) {
    const insets = useSafeAreaInsets();

    useLayoutEffect(() => {
        navigation.setOptions({
            headerShown: false,
        });
    }, [navigation]);

    const [displayedMonth, setDisplayedMonth] = useState(() => {
        const now = new Date();

        return new Date(now.getFullYear(), now.getMonth(), 1);
    });

    const [activityDays, setActivityDays] = useState<
        Record<string, ActivityCalendarDay>
    >({});

    const [loading, setLoading] = useState(false);

    const [selectedDay, setSelectedDay] = useState<ActivityCalendarDay | null>(
        null,
    );

    const loadActivityCalendar = useCallback(async () => {
        try {
            setLoading(true);

            const currentUser = await getCurrentUser();

            const recordingSessionModel = client.models.RecordingSession as any;

            const allSessions: any[] = [];
            let nextToken: string | null = null;

            do {
                const result =
                    (await recordingSessionModel.listRecordingSessionsByUserAndEndedAt(
                        {
                            userId: currentUser.userId,
                            sortDirection: "DESC",
                            limit: 1000,
                            nextToken: nextToken ?? undefined,
                        },
                    )) as RecordingSessionCalendarListResult;

                if (result.errors) {
                    console.error(
                        "Activity calendar list errors:",
                        result.errors,
                    );

                    Alert.alert(
                        "取得エラー",
                        "アクティビティカレンダーを取得できませんでした。",
                    );

                    return;
                }

                allSessions.push(...(result.data ?? []));
                nextToken = result.nextToken ?? null;
            } while (nextToken);

            const monthStart = new Date(
                displayedMonth.getFullYear(),
                displayedMonth.getMonth(),
                1,
            );

            const nextMonthStart = new Date(
                displayedMonth.getFullYear(),
                displayedMonth.getMonth() + 1,
                1,
            );

            const monthSessions: ActivityCalendarSession[] = allSessions
                .filter((item) => {
                    if (
                        !item?.id ||
                        !item?.recordingSessionId ||
                        !item?.startedAt ||
                        !item?.endedAt
                    ) {
                        return false;
                    }

                    const endedAtMs = new Date(item.endedAt).getTime();

                    return (
                        Number.isFinite(endedAtMs) &&
                        endedAtMs >= monthStart.getTime() &&
                        endedAtMs < nextMonthStart.getTime()
                    );
                })
                .map((item) => ({
                    id: item.id,
                    recordingSessionId: item.recordingSessionId,

                    recordingSessionName:
                        item.recordingSessionName ?? "自動記録アクティビティ",

                    startedAt: item.startedAt,
                    endedAt: item.endedAt,

                    distanceMeters: Number(item.distanceMeters ?? 0),

                    activityType:
                        item.activityType === "WALKING" ||
                        item.activityType === "RUNNING" ||
                        item.activityType === "CYCLING" ||
                        item.activityType === "VEHICLE" ||
                        item.activityType === "MIXED"
                            ? item.activityType
                            : "UNKNOWN",
                }));

            const nextActivityDays: Record<string, ActivityCalendarDay> = {};

            monthSessions.forEach((session) => {
                /*
                 * カレンダーの日付はセッション終了日を基準にする。
                 */
                const dateKey = createLocalDateKey(new Date(session.endedAt));

                const existingDay = nextActivityDays[dateKey];

                if (existingDay) {
                    existingDay.distanceMeters += session.distanceMeters;

                    existingDay.sessionCount += 1;
                    existingDay.sessions.push(session);
                } else {
                    nextActivityDays[dateKey] = {
                        dateKey,
                        distanceMeters: session.distanceMeters,
                        sessionCount: 1,
                        sessions: [session],
                    };
                }
            });

            Object.values(nextActivityDays).forEach((day) => {
                day.sessions.sort(
                    (a, b) =>
                        new Date(a.startedAt).getTime() -
                        new Date(b.startedAt).getTime(),
                );
            });

            setActivityDays(nextActivityDays);
        } catch (error) {
            console.error("Load activity calendar error:", error);

            Alert.alert(
                "取得エラー",
                "アクティビティカレンダーの読み込みに失敗しました。",
            );
        } finally {
            setLoading(false);
        }
    }, [displayedMonth]);

    useFocusEffect(
        useCallback(() => {
            void loadActivityCalendar();
        }, [loadActivityCalendar]),
    );

    const moveMonth = useCallback((amount: number) => {
        setDisplayedMonth((currentMonth) => {
            return new Date(
                currentMonth.getFullYear(),
                currentMonth.getMonth() + amount,
                1,
            );
        });
    }, []);

    const moveToCurrentMonth = useCallback(() => {
        const now = new Date();

        setDisplayedMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    }, []);

    const openSessionMap = useCallback(
        (session: ActivityCalendarSession) => {
            navigation.navigate("LocationMap", {
                recordingSessionId: session.recordingSessionId,
            });
        },
        [navigation],
    );

    const handlePressDay = useCallback((day: ActivityCalendarDay) => {
        setSelectedDay(day);
    }, []);

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
                    アクティビティカレンダー
                </Text>

                <Pressable
                    style={({ pressed }) => [
                        styles.headerCurrentMonthButton,
                        pressed && !loading && styles.buttonPressed,
                        loading && styles.buttonDisabled,
                    ]}
                    onPress={moveToCurrentMonth}
                    disabled={loading}
                >
                    <Text style={styles.headerCurrentMonthButtonText}>
                        今月
                    </Text>
                </Pressable>
            </View>

            {/* 画面本体 */}
            <View style={styles.container}>
                {/* カレンダー */}
                <View style={styles.calendarCard}>
                    <ActivityCalendar
                        displayedMonth={displayedMonth}
                        activityDays={activityDays}
                        selectedDateKey={selectedDay?.dateKey ?? null}
                        loading={loading}
                        onMoveMonth={moveMonth}
                        onPressDay={handlePressDay}
                    />
                </View>

                {/* 選択日のアクティビティ */}
                {selectedDay ? (
                    <View style={styles.selectedDaySection}>
                        <Text style={styles.selectedDayTitle}>
                            {formatSelectedDayTitle(selectedDay.dateKey)} の記録
                        </Text>

                        <ScrollView
                            style={styles.selectedDayScrollView}
                            contentContainerStyle={styles.selectedDayList}
                            showsVerticalScrollIndicator={false}
                        >
                            {selectedDay.sessions.map((session) => {
                                const iconSpec = getActivityTypeIconSpec(
                                    session.activityType,
                                );

                                return (
                                    <Pressable
                                        key={session.id}
                                        style={({ pressed }) => [
                                            styles.activitySummaryRow,
                                            pressed &&
                                                styles.activitySummaryRowPressed,
                                        ]}
                                        onPress={() => openSessionMap(session)}
                                    >
                                        <View
                                            style={[
                                                styles.activityIconCircle,
                                                {
                                                    backgroundColor:
                                                        iconSpec.backgroundColor,
                                                },
                                            ]}
                                        >
                                            <MaterialCommunityIcons
                                                name={iconSpec.name}
                                                size={23}
                                                color="#ffffff"
                                            />
                                        </View>

                                        <View
                                            style={
                                                styles.activitySummaryContent
                                            }
                                        >
                                            <Text
                                                style={
                                                    styles.activitySummaryTitle
                                                }
                                                numberOfLines={1}
                                            >
                                                {session.recordingSessionName}
                                            </Text>

                                            <View
                                                style={
                                                    styles.activitySummaryMetaRow
                                                }
                                            >
                                                <View
                                                    style={
                                                        styles.activityMetaItem
                                                    }
                                                >
                                                    <MaterialCommunityIcons
                                                        name="clock-outline"
                                                        size={14}
                                                        color="#71838c"
                                                    />

                                                    <Text
                                                        style={
                                                            styles.activitySummaryTime
                                                        }
                                                    >
                                                        {formatSessionPeriod(
                                                            session.startedAt,
                                                            session.endedAt,
                                                        )}
                                                    </Text>
                                                </View>

                                                <View
                                                    style={
                                                        styles.activityMetaItem
                                                    }
                                                >
                                                    <MaterialCommunityIcons
                                                        name="map-marker-distance"
                                                        size={15}
                                                        color="#0e9384"
                                                    />

                                                    <Text
                                                        style={
                                                            styles.activitySummaryDistance
                                                        }
                                                    >
                                                        {formatDistance(
                                                            session.distanceMeters,
                                                        )}
                                                    </Text>
                                                </View>
                                            </View>
                                        </View>

                                        <MaterialCommunityIcons
                                            name="chevron-right"
                                            size={22}
                                            color="#8798a0"
                                        />
                                    </Pressable>
                                );
                            })}
                        </ScrollView>
                    </View>
                ) : (
                    <View style={styles.noSelectionCard}>
                        <MaterialCommunityIcons
                            name="calendar-outline"
                            size={24}
                            color="#8a9ba3"
                        />

                        <Text style={styles.noSelectionText}>
                            アクティビティのある日をタップすると、
                            記録を表示します。
                        </Text>
                    </View>
                )}
            </View>
        </View>
    );
}

function formatDateLabel(dateKey: string): string {
    const [year, month, day] = dateKey.split("-").map(Number);

    return `${year}年${month}月${day}日`;
}

function formatSelectedDayTitle(dateKey: string): string {
    const [year, month, day] = dateKey.split("-").map(Number);

    return `${year}/${month}/${day}`;
}

function formatSessionPeriod(startedAt: string, endedAt: string): string {
    const startDate = new Date(startedAt);
    const endDate = new Date(endedAt);

    const startHour = String(startDate.getHours()).padStart(2, "0");

    const startMinute = String(startDate.getMinutes()).padStart(2, "0");

    const endHour = String(endDate.getHours()).padStart(2, "0");

    const endMinute = String(endDate.getMinutes()).padStart(2, "0");

    return `${startHour}:${startMinute} - ${endHour}:${endMinute}`;
}

function formatDistance(distanceMeters: number): string {
    if (distanceMeters >= 1000) {
        return `${(distanceMeters / 1000).toFixed(2)}km`;
    }

    return `${Math.round(distanceMeters)}m`;
}

function getActivityTypeIconSpec(
    activityType: ActivityCalendarSession["activityType"],
): {
    name:
        | "walk"
        | "run"
        | "bike"
        | "car"
        | "transit-connection-variant"
        | "help-circle-outline";
    backgroundColor: string;
} {
    switch (activityType) {
        case "WALKING":
            return {
                name: "walk",
                backgroundColor: "#15B8A6",
            };

        case "RUNNING":
            return {
                name: "run",
                backgroundColor: "#5AA9F7",
            };

        case "CYCLING":
            return {
                name: "bike",
                backgroundColor: "#F5B32F",
            };

        case "VEHICLE":
            return {
                name: "car",
                backgroundColor: "#F26B6B",
            };

        case "MIXED":
            return {
                name: "transit-connection-variant",
                backgroundColor: "#8B7CF6",
            };

        case "UNKNOWN":
        default:
            return {
                name: "help-circle-outline",
                backgroundColor: "#9AA5B1",
            };
    }
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

    container: {
        flex: 1,

        paddingHorizontal: 14,
        paddingTop: 12,
        paddingBottom: 14,

        backgroundColor: "#f3f7f9",
    },

    introCard: {
        marginBottom: 12,

        padding: 15,

        borderRadius: 14,

        backgroundColor: "#ffffff",

        borderWidth: 1,
        borderColor: "#e0e8ec",

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.06,
        shadowRadius: 5,

        elevation: 2,
    },

    introTopRow: {
        flexDirection: "row",
        alignItems: "center",
    },

    introTitleRow: {
        flex: 1,

        flexDirection: "row",
        alignItems: "center",
    },

    introIconCircle: {
        width: 44,
        height: 44,

        borderRadius: 22,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#0e9384",
    },

    introTextArea: {
        flex: 1,
        marginLeft: 12,
    },

    introTitle: {
        color: "#183b50",

        fontSize: 16,
        fontWeight: "700",
    },

    description: {
        marginTop: 3,

        color: "#667780",

        fontSize: 12,
        lineHeight: 17,
    },

    introBottomRow: {
        marginTop: 13,
        paddingTop: 12,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",

        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: "#dce5e9",
    },

    monthInfoRow: {
        flexDirection: "row",
        alignItems: "center",

        gap: 6,
    },

    monthInfoText: {
        color: "#425d6a",

        fontSize: 14,
        fontWeight: "700",
    },

    currentMonthButton: {
        minHeight: 36,

        paddingHorizontal: 12,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 5,

        borderWidth: 1,
        borderColor: "#0e9384",
        borderRadius: 9,

        backgroundColor: "#ffffff",
    },

    currentMonthButtonText: {
        color: "#0e9384",

        fontSize: 12,
        fontWeight: "700",
    },

    buttonPressed: {
        opacity: 0.72,
    },

    buttonDisabled: {
        opacity: 0.5,
    },

    modalOverlay: {
        flex: 1,

        alignItems: "center",
        justifyContent: "center",

        padding: 20,

        backgroundColor: "rgba(0, 0, 0, 0.45)",
    },

    modalContent: {
        width: "100%",
        maxHeight: "78%",

        padding: 18,

        borderRadius: 16,

        backgroundColor: "#ffffff",

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 4,
        },
        shadowOpacity: 0.18,
        shadowRadius: 10,

        elevation: 8,
    },

    modalHeaderRow: {
        flexDirection: "row",
        alignItems: "center",

        marginBottom: 16,
    },

    modalIconCircle: {
        width: 42,
        height: 42,

        borderRadius: 21,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#0e9384",
    },

    modalHeaderTextArea: {
        flex: 1,

        marginLeft: 11,
    },

    modalTitle: {
        color: "#183b50",

        fontSize: 17,
        fontWeight: "700",
    },

    modalDescription: {
        marginTop: 2,

        color: "#6c7d85",

        fontSize: 12,
    },

    sessionList: {
        maxHeight: 380,
    },

    sessionListContent: {
        gap: 9,

        paddingBottom: 12,
    },

    sessionItem: {
        padding: 13,

        borderRadius: 12,

        borderWidth: 1,
        borderColor: "#dce6ea",

        backgroundColor: "#f9fbfc",
    },

    sessionItemPressed: {
        opacity: 0.7,

        backgroundColor: "#edf6f5",
    },

    sessionItemTopRow: {
        flexDirection: "row",
        alignItems: "center",
    },

    sessionIconCircle: {
        width: 40,
        height: 40,

        marginRight: 11,

        borderRadius: 20,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#e1f3ef",
    },

    sessionTextArea: {
        flex: 1,
        minWidth: 0,
    },

    sessionName: {
        marginBottom: 5,

        color: "#213e4d",

        fontSize: 15,
        fontWeight: "700",
    },

    sessionMetaRow: {
        flexDirection: "row",
        alignItems: "center",

        gap: 5,

        marginTop: 2,
    },

    sessionPeriod: {
        color: "#667780",

        fontSize: 12,
    },

    sessionDistance: {
        color: "#405d69",

        fontSize: 13,
        fontWeight: "600",
    },

    closeButton: {
        minHeight: 44,

        alignItems: "center",
        justifyContent: "center",

        borderRadius: 10,

        backgroundColor: "#e8eef1",
    },

    closeButtonText: {
        color: "#365d78",

        fontSize: 14,
        fontWeight: "700",
    },

    headerCurrentMonthButton: {
        width: 46,
        height: 44,

        alignItems: "center",
        justifyContent: "center",
    },

    headerCurrentMonthButtonText: {
        color: "#ffffff",

        fontSize: 12,
        fontWeight: "700",
    },

    calendarCard: {
        flexShrink: 0,

        borderRadius: 14,

        backgroundColor: "#ffffff",

        borderWidth: 1,
        borderColor: "#e0e8ec",

        overflow: "hidden",

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.06,
        shadowRadius: 5,

        elevation: 2,
    },

    selectedDaySection: {
        flex: 1,

        minHeight: 140,

        marginTop: 12,

        borderRadius: 14,

        backgroundColor: "#ffffff",

        borderWidth: 1,
        borderColor: "#e0e8ec",

        overflow: "hidden",

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.05,
        shadowRadius: 4,

        elevation: 1,
    },

    selectedDayTitle: {
        paddingHorizontal: 16,
        paddingVertical: 13,

        color: "#183b50",

        fontSize: 16,
        fontWeight: "700",

        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: "#dce5e9",
    },

    selectedDayScrollView: {
        flex: 1,
    },

    selectedDayList: {
        paddingBottom: 4,
    },

    activitySummaryRow: {
        minHeight: 70,

        paddingHorizontal: 14,
        paddingVertical: 10,

        flexDirection: "row",
        alignItems: "center",

        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: "#e4eaed",
    },

    activitySummaryRowPressed: {
        backgroundColor: "#eff7f6",
    },

    activityIconCircle: {
        width: 44,
        height: 44,

        marginRight: 12,

        borderRadius: 22,

        alignItems: "center",
        justifyContent: "center",
    },

    activitySummaryContent: {
        flex: 1,
        minWidth: 0,
    },

    activitySummaryTitle: {
        color: "#203f4f",

        fontSize: 14,
        fontWeight: "700",
    },

    activitySummaryMetaRow: {
        marginTop: 5,

        flexDirection: "row",
        alignItems: "center",

        gap: 14,
    },

    activityMetaItem: {
        flexDirection: "row",
        alignItems: "center",

        gap: 4,
    },

    activitySummaryTime: {
        color: "#71818a",

        fontSize: 12,
    },

    activitySummaryDistance: {
        color: "#3d6573",

        fontSize: 12,
        fontWeight: "600",
    },

    noSelectionCard: {
        marginTop: 12,

        minHeight: 76,

        paddingHorizontal: 16,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 9,

        borderRadius: 14,

        borderWidth: 1,
        borderColor: "#dde6ea",

        backgroundColor: "#ffffff",
    },

    noSelectionText: {
        flex: 1,

        color: "#71818a",

        fontSize: 13,
        lineHeight: 18,
    },
});
