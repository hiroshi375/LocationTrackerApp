import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { getCurrentUser } from "aws-amplify/auth";
import { useCallback, useState } from "react";
import {
  Alert,
  Modal,
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

type Props = NativeStackScreenProps<RootStackParamList, "ActivityCalendar">;

type RecordingSessionCalendarListResult = {
  data?: any[] | null;
  errors?: unknown;
  nextToken?: string | null;
};

export default function ActivityCalendarScreen({ navigation }: Props) {
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

  const [sessionModalVisible, setSessionModalVisible] = useState(false);

  const loadActivityCalendar = useCallback(async () => {
    try {
      setLoading(true);

      const currentUser = await getCurrentUser();

      const recordingSessionModel = client.models.RecordingSession as any;

      const allSessions: any[] = [];
      let nextToken: string | null = null;

      do {
        const result =
          (await recordingSessionModel.listRecordingSessionsByUserAndEndedAt({
            userId: currentUser.userId,
            sortDirection: "DESC",
            limit: 1000,
            nextToken: nextToken ?? undefined,
          })) as RecordingSessionCalendarListResult;

        if (result.errors) {
          console.error("Activity calendar list errors:", result.errors);

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

          /*
           * 集計対象外として分類されたセッションは
           * アクティビティカレンダーに表示しない。
           *
           * 旧データなどで未設定の場合は表示する。
           */
          if (item.isAggregationTarget === false) {
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
            item.recordingSessionName ?? "自動記録セッション",
          startedAt: item.startedAt,
          endedAt: item.endedAt,
          distanceMeters: Number(item.distanceMeters ?? 0),
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
            new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
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

  const handlePressDay = useCallback(
    (day: ActivityCalendarDay) => {
      if (day.sessions.length === 0) {
        return;
      }

      if (day.sessions.length === 1) {
        openSessionMap(day.sessions[0]);
        return;
      }

      setSelectedDay(day);
      setSessionModalVisible(true);
    },
    [openSessionMap],
  );

  const closeSessionModal = useCallback(() => {
    setSessionModalVisible(false);
    setSelectedDay(null);
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerTextArea}>
          <Text style={styles.title}>アクティビティカレンダー</Text>

          <Text style={styles.description}>
            アクティビティがあった日をタップすると、
            セッションの地図を表示します。
          </Text>
        </View>

        <Pressable
          style={styles.currentMonthButton}
          onPress={moveToCurrentMonth}
          disabled={loading}
        >
          <Text style={styles.currentMonthButtonText}>今月</Text>
        </Pressable>
      </View>

      <ActivityCalendar
        displayedMonth={displayedMonth}
        activityDays={activityDays}
        loading={loading}
        onMoveMonth={moveMonth}
        onPressDay={handlePressDay}
      />

      <Modal
        visible={sessionModalVisible}
        transparent
        animationType="fade"
        onRequestClose={closeSessionModal}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>
              {selectedDay
                ? formatDateLabel(selectedDay.dateKey)
                : "アクティビティ"}
            </Text>

            <Text style={styles.modalDescription}>
              表示するセッションを選択してください。
            </Text>

            <ScrollView
              style={styles.sessionList}
              contentContainerStyle={styles.sessionListContent}
            >
              {selectedDay?.sessions.map((session) => (
                <Pressable
                  key={session.id}
                  style={({ pressed }) => [
                    styles.sessionItem,
                    pressed && styles.sessionItemPressed,
                  ]}
                  onPress={() => {
                    closeSessionModal();
                    openSessionMap(session);
                  }}
                >
                  <Text style={styles.sessionName}>
                    {session.recordingSessionName}
                  </Text>

                  <Text style={styles.sessionPeriod}>
                    {formatSessionPeriod(session.startedAt, session.endedAt)}
                  </Text>

                  <Text style={styles.sessionDistance}>
                    距離: {formatDistance(session.distanceMeters)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            <Pressable style={styles.closeButton} onPress={closeSessionModal}>
              <Text style={styles.closeButtonText}>閉じる</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function formatDateLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);

  return `${year}年${month}月${day}日`;
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    backgroundColor: "#f7f9fb",
  },

  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 14,
  },

  headerTextArea: {
    flex: 1,
  },

  title: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#27445c",
  },

  description: {
    marginTop: 5,
    fontSize: 12,
    lineHeight: 18,
    color: "#667780",
  },

  currentMonthButton: {
    paddingVertical: 7,
    paddingHorizontal: 13,
    borderRadius: 8,
    backgroundColor: "#e5edf3",
  },

  currentMonthButtonText: {
    fontSize: 12,
    fontWeight: "bold",
    color: "#365d78",
  },

  modalOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    backgroundColor: "rgba(0, 0, 0, 0.4)",
  },

  modalContent: {
    width: "100%",
    maxHeight: "75%",
    padding: 20,
    borderRadius: 14,
    backgroundColor: "#ffffff",
  },

  modalTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#27445c",
  },

  modalDescription: {
    marginTop: 5,
    marginBottom: 14,
    fontSize: 13,
    color: "#667780",
  },

  sessionList: {
    maxHeight: 380,
  },

  sessionListContent: {
    gap: 10,
    paddingBottom: 14,
  },

  sessionItem: {
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#dce4e9",
    backgroundColor: "#f8fafb",
  },

  sessionItemPressed: {
    opacity: 0.65,
    backgroundColor: "#eef4f7",
  },

  sessionName: {
    marginBottom: 5,
    fontSize: 15,
    fontWeight: "bold",
    color: "#29475c",
  },

  sessionPeriod: {
    fontSize: 12,
    color: "#667780",
  },

  sessionDistance: {
    marginTop: 3,
    fontSize: 13,
    fontWeight: "600",
    color: "#4c5961",
  },

  closeButton: {
    alignItems: "center",
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: "#e6edf2",
  },

  closeButtonText: {
    fontSize: 14,
    fontWeight: "bold",
    color: "#365d78",
  },
});
