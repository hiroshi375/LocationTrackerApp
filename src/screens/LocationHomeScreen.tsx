import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { getCurrentUser, signOut } from "aws-amplify/auth";
import * as Location from "expo-location";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Animated,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";

import { useFocusEffect } from "@react-navigation/native";
import { useForegroundLocationRecorder } from "../hooks/useForegroundLocationRecorder";
import { client } from "../lib/client";
import type { RootStackParamList } from "../navigation/RootNavigator";
import {
    ensureUserProfile,
    getCurrentUserProfile,
} from "../services/userProfileService";

type Props = NativeStackScreenProps<RootStackParamList, "LocationHome">;

type CurrentLocation = {
    latitude: number;
    longitude: number;
    accuracy: number | null;
    recordedAt: string;
};

type AppButtonProps = {
    title: string;
    onPress: () => void;
    disabled?: boolean;
};

// 現在地の記録と保存を行うホーム画面コンポーネント
export default function LocationHomeScreen({ navigation }: Props) {
    const [currentLocation, setCurrentLocation] =
        useState<CurrentLocation | null>(null);
    const [memo, setMemo] = useState("");
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [loginUserName, setLoginUserName] = useState("ユーザー");

    const RECORD_INTERVAL_OPTIONS = [
        { label: "10秒", value: 10 * 1000 },
        { label: "30秒", value: 30 * 1000 },
        { label: "1分", value: 60 * 1000 },
        { label: "3分", value: 3 * 60 * 1000 },
        { label: "5分", value: 5 * 60 * 1000 },
    ];

    const DISTANCE_OPTIONS = [
        { label: "10m", value: 10 },
        { label: "20m", value: 20 },
        { label: "50m", value: 50 },
        { label: "100m", value: 100 },
    ];

    const [recordIntervalMs, setRecordIntervalMs] = useState(30 * 1000);
    const [recordDistanceMeters, setRecordDistanceMeters] = useState(20);

    const {
        isRecording,
        recordingStartedAt,
        activeRecordingSessionId,
        startRecording,
        stopRecording,
    } = useForegroundLocationRecorder({
        intervalMs: recordIntervalMs,
        distanceMeters: recordDistanceMeters,
    });

    const recordingBlinkAnim = useRef(new Animated.Value(1)).current;
    const [elapsedSeconds, setElapsedSeconds] = useState(0);

    const [sessionNameModalVisible, setSessionNameModalVisible] =
        useState(false);
    const [sessionNameInput, setSessionNameInput] = useState("");
    const [pendingSessionId, setPendingSessionId] = useState<string | null>(
        null,
    );
    const [savingSessionName, setSavingSessionName] = useState(false);

    const loadLoginUserName = useCallback(async () => {
        try {
            const profile = await getCurrentUserProfile();

            const name =
                profile?.displayName?.trim() ||
                profile?.email?.trim() ||
                "ユーザー";

            setLoginUserName(name);
        } catch (error) {
            console.error("Load login user name error:", error);
            setLoginUserName("ユーザー");
        }
    }, []);

    useFocusEffect(
        useCallback(() => {
            void loadLoginUserName();
        }, [loadLoginUserName]),
    );

    useEffect(() => {
        if (!isRecording) {
            recordingBlinkAnim.stopAnimation();
            recordingBlinkAnim.setValue(1);
            return;
        }

        // 点滅アニメーションの開始
        const animation = Animated.loop(
            Animated.sequence([
                Animated.timing(recordingBlinkAnim, {
                    toValue: 0.2,
                    duration: 500,
                    useNativeDriver: true,
                }),
                Animated.timing(recordingBlinkAnim, {
                    toValue: 1,
                    duration: 500,
                    useNativeDriver: true,
                }),
            ]),
        );

        animation.start();

        return () => {
            animation.stop();
        };
    }, [isRecording, recordingBlinkAnim]);

    useEffect(() => {
        if (!isRecording || !recordingStartedAt) {
            setElapsedSeconds(0);
            return;
        }

        const updateElapsedSeconds = () => {
            const startedAtTime = new Date(recordingStartedAt).getTime();
            const seconds = Math.floor((Date.now() - startedAtTime) / 1000);
            setElapsedSeconds(seconds);
        };

        updateElapsedSeconds();

        const timerId = setInterval(updateElapsedSeconds, 1000);

        return () => {
            clearInterval(timerId);
        };
    }, [isRecording, recordingStartedAt]);

    // 位置情報を取得する処理
    const handleGetLocation = async () => {
        try {
            setLoading(true);

            const { status } =
                await Location.requestForegroundPermissionsAsync();

            if (status !== "granted") {
                Alert.alert(
                    "位置情報の許可が必要です",
                    "現在地を記録するには位置情報の許可が必要です。",
                );
                return;
            }

            const location = await Location.getCurrentPositionAsync({
                accuracy: Location.Accuracy.High,
            });

            const nextLocation: CurrentLocation = {
                latitude: location.coords.latitude,
                longitude: location.coords.longitude,
                accuracy: location.coords.accuracy,
                recordedAt: new Date().toISOString(),
            };

            setCurrentLocation(nextLocation);
        } catch (error) {
            console.error(error);
            Alert.alert("エラー", "現在地を取得できませんでした。");
        } finally {
            setLoading(false);
        }
    };

    // 位置情報を保存する処理
    const handleSaveLocation = async () => {
        if (!currentLocation) {
            Alert.alert("未取得", "先に現在地を取得してください。");
            return;
        }

        try {
            setSaving(true);

            const user = await getCurrentUser();

            const result = await client.models.LocationLog.create({
                userId: user.userId,
                latitude: currentLocation.latitude,
                longitude: currentLocation.longitude,
                accuracy: currentLocation.accuracy ?? undefined,
                recordedAt: currentLocation.recordedAt,
                memo: memo.trim() || undefined,
            });

            if (result.errors) {
                console.error(result.errors);
                Alert.alert("保存エラー", "位置情報を保存できませんでした。");
                return;
            }

            setMemo("");

            Alert.alert("保存完了", "現在地を記録しました。");
        } catch (error) {
            console.error(error);
            Alert.alert("エラー", "位置情報の保存に失敗しました。");
        } finally {
            setSaving(false);
        }
    };

    //
    const handleSignOut = async () => {
        try {
            await signOut();
        } catch (error) {
            console.error("Sign out error:", error);
            Alert.alert("サインアウトエラー", "サインアウトできませんでした。");
        }
    };

    // セッションIDを生成する関数
    const saveSessionName = async (name: string) => {
        if (!pendingSessionId) {
            return;
        }

        const trimmedName = name.trim();
        const sessionName =
            trimmedName ||
            `自動記録 ${formatDateTime(new Date().toISOString())}`;

        try {
            setSavingSessionName(true);

            const result = await client.models.LocationLog.list({
                filter: {
                    recordingSessionId: {
                        eq: pendingSessionId,
                    },
                },
                limit: 1000,
            });

            if (result.errors) {
                console.error(
                    "LocationLog session list errors:",
                    result.errors,
                );
                Alert.alert(
                    "保存エラー",
                    "セッション名を保存できませんでした。",
                );
                return;
            }

            const sessionLogs = result.data ?? [];

            const updateResults = await Promise.all(
                sessionLogs.map((log) =>
                    client.models.LocationLog.update({
                        id: log.id,
                        recordingSessionName: sessionName,
                    }),
                ),
            );

            const hasErrors = updateResults.some((updateResult) => {
                return updateResult.errors;
            });

            if (hasErrors) {
                console.error(
                    "LocationLog session name update errors:",
                    updateResults,
                );
                Alert.alert(
                    "保存エラー",
                    "セッション名を保存できませんでした。",
                );
                return;
            }

            setSessionNameModalVisible(false);
            setSessionNameInput("");
            setPendingSessionId(null);
        } catch (error) {
            console.error("Save session name error:", error);
            Alert.alert("保存エラー", "セッション名の保存に失敗しました。");
        } finally {
            setSavingSessionName(false);
        }
    };

    // セッションIDに紐づくLocationLogを全件取得してセッション名を更新する
    const handleStopRecording = async () => {
        const finishedSessionId = await stopRecording();

        if (!finishedSessionId) {
            return;
        }

        setPendingSessionId(finishedSessionId);
        setSessionNameInput("");
        setSessionNameModalVisible(true);
    };

    useEffect(() => {
        void ensureUserProfile();
    }, []);

    return (
        <KeyboardAvoidingView
            style={styles.keyboardAvoiding}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
            <ScrollView
                contentContainerStyle={styles.container}
                keyboardShouldPersistTaps="handled"
            >
                <View style={styles.userInfoBox}>
                    <Text style={styles.userInfoLabel}>ログインユーザー</Text>
                    <Text style={styles.userInfoName}>{loginUserName}</Text>
                </View>
                {/* <Text style={styles.title}>現在地を手動記録</Text> */}

                <AppButton title="現在地を取得" onPress={handleGetLocation} />

                {loading && <ActivityIndicator style={styles.loading} />}

                {currentLocation && (
                    <View style={styles.locationBox}>
                        <Text>緯度: {currentLocation.latitude}</Text>
                        <Text>経度: {currentLocation.longitude}</Text>
                        <Text>
                            精度:{" "}
                            {currentLocation.accuracy !== null
                                ? `${currentLocation.accuracy}m`
                                : "不明"}
                        </Text>
                        <Text>
                            記録日時:{" "}
                            {formatDateTime(currentLocation.recordedAt)}
                        </Text>
                    </View>
                )}

                <View style={styles.memoArea}>
                    <Text style={styles.label}>メモ</Text>
                    <TextInput
                        style={styles.memoInput}
                        value={memo}
                        onChangeText={setMemo}
                        placeholder="例：東京駅で打ち合わせ"
                        multiline={false}
                        textAlignVertical="center"
                    />
                </View>

                <View style={styles.buttonSpace}>
                    <AppButton
                        title={saving ? "保存中..." : "この位置を保存"}
                        onPress={handleSaveLocation}
                        disabled={saving}
                    />
                </View>

                <View style={styles.buttonSpace}>
                    <AppButton
                        title="位置履歴を見る"
                        onPress={() => navigation.navigate("LocationLog")}
                    />
                </View>

                <View style={styles.buttonSpace}>
                    <AppButton
                        title="地図で見る"
                        onPress={() =>
                            navigation.navigate("LocationMap", {
                                recordingSessionId:
                                    activeRecordingSessionId ?? undefined,
                                recordingIntervalMs: activeRecordingSessionId
                                    ? recordIntervalMs
                                    : undefined,
                                recordingDistanceMeters:
                                    activeRecordingSessionId
                                        ? recordDistanceMeters
                                        : undefined,
                            })
                        }
                    />
                </View>
                <View style={styles.autoRecordBox}>
                    <View style={styles.autoRecordHeader}>
                        <Text style={styles.autoRecordTitle}>自動記録</Text>

                        <View style={styles.recordingStatusArea}>
                            {isRecording ? (
                                <Animated.View
                                    style={[
                                        styles.recordingBadge,
                                        {
                                            opacity: recordingBlinkAnim,
                                        },
                                    ]}
                                >
                                    <View style={styles.recordingDot} />
                                    <Text style={styles.recordingBadgeText}>
                                        記録中
                                    </Text>
                                </Animated.View>
                            ) : (
                                <View style={styles.stoppedBadge}>
                                    <View style={styles.stoppedDot} />
                                    <Text style={styles.stoppedBadgeText}>
                                        停止中
                                    </Text>
                                </View>
                            )}
                        </View>
                    </View>

                    {recordingStartedAt && (
                        <View style={styles.recordingTimeBox}>
                            <Text style={styles.autoRecordStatus}>
                                開始時刻: {formatDateTime(recordingStartedAt)}
                            </Text>

                            <Text style={styles.autoRecordStatus}>
                                経過時間: {formatElapsedTime(elapsedSeconds)}
                            </Text>
                        </View>
                    )}

                    <View style={styles.settingBlock}>
                        <Text style={styles.settingTitle}>記録頻度</Text>

                        <View style={styles.optionRow}>
                            {RECORD_INTERVAL_OPTIONS.map((option) => {
                                const selected =
                                    recordIntervalMs === option.value;

                                return (
                                    <Pressable
                                        key={option.value}
                                        disabled={isRecording}
                                        style={[
                                            styles.optionButton,
                                            selected &&
                                                styles.optionButtonSelected,
                                            isRecording &&
                                                styles.optionButtonDisabled,
                                        ]}
                                        onPress={() =>
                                            setRecordIntervalMs(option.value)
                                        }
                                    >
                                        <Text
                                            style={[
                                                styles.optionButtonText,
                                                selected &&
                                                    styles.optionButtonTextSelected,
                                            ]}
                                        >
                                            {option.label}
                                        </Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                    </View>

                    <View style={styles.settingBlock}>
                        <Text style={styles.settingTitle}>
                            記録する移動距離
                        </Text>

                        <View style={styles.optionRow}>
                            {DISTANCE_OPTIONS.map((option) => {
                                const selected =
                                    recordDistanceMeters === option.value;

                                return (
                                    <Pressable
                                        key={option.value}
                                        disabled={isRecording}
                                        style={[
                                            styles.optionButton,
                                            selected &&
                                                styles.optionButtonSelected,
                                            isRecording &&
                                                styles.optionButtonDisabled,
                                        ]}
                                        onPress={() =>
                                            setRecordDistanceMeters(
                                                option.value,
                                            )
                                        }
                                    >
                                        <Text
                                            style={[
                                                styles.optionButtonText,
                                                selected &&
                                                    styles.optionButtonTextSelected,
                                            ]}
                                        >
                                            {option.label}
                                        </Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                    </View>
                    {isRecording ? (
                        <Pressable
                            style={({ pressed }) => [
                                styles.autoRecordStopButton,
                                pressed && styles.buttonPressed,
                            ]}
                            onPress={handleStopRecording}
                        >
                            <Text style={styles.autoRecordButtonText}>
                                自動記録停止
                            </Text>
                        </Pressable>
                    ) : (
                        <Pressable
                            style={({ pressed }) => [
                                styles.autoRecordStartButton,
                                pressed && styles.buttonPressed,
                            ]}
                            onPress={startRecording}
                        >
                            <Text style={styles.autoRecordButtonText}>
                                自動記録開始
                            </Text>
                        </Pressable>
                    )}
                </View>

                <View style={styles.buttonSpace}>
                    <AppButton
                        title="プロフィール"
                        onPress={() => navigation.navigate("Profile")}
                    />
                </View>

                <View style={styles.signOutButtonSpace}>
                    <Pressable
                        style={({ pressed }) => [
                            styles.signOutButton,
                            pressed && styles.appButtonPressed,
                        ]}
                        onPress={handleSignOut}
                    >
                        <Text style={styles.signOutButtonText}>
                            サインアウト
                        </Text>
                    </Pressable>
                </View>

                <Modal
                    visible={sessionNameModalVisible}
                    transparent
                    animationType="fade"
                    onRequestClose={() => {
                        if (!savingSessionName) {
                            void saveSessionName("");
                        }
                    }}
                >
                    <View style={styles.modalOverlay}>
                        <View style={styles.modalContent}>
                            <Text style={styles.modalTitle}>
                                セッション名を入力
                            </Text>

                            <Text style={styles.modalDescription}>
                                この自動記録セッションの名前を入力してください。
                            </Text>

                            <TextInput
                                style={styles.sessionNameModalInput}
                                value={sessionNameInput}
                                onChangeText={setSessionNameInput}
                                placeholder="例：朝の散歩"
                                editable={!savingSessionName}
                                autoFocus
                            />

                            <View style={styles.modalButtonRow}>
                                <Pressable
                                    style={[
                                        styles.modalSecondaryButton,
                                        savingSessionName &&
                                            styles.appButtonDisabled,
                                    ]}
                                    disabled={savingSessionName}
                                    onPress={() => saveSessionName("")}
                                >
                                    <Text
                                        style={styles.modalSecondaryButtonText}
                                    >
                                        名前なしで保存
                                    </Text>
                                </Pressable>

                                <Pressable
                                    style={[
                                        styles.modalPrimaryButton,
                                        savingSessionName &&
                                            styles.appButtonDisabled,
                                    ]}
                                    disabled={savingSessionName}
                                    onPress={() =>
                                        saveSessionName(sessionNameInput)
                                    }
                                >
                                    <Text style={styles.modalPrimaryButtonText}>
                                        {savingSessionName
                                            ? "保存中..."
                                            : "保存"}
                                    </Text>
                                </Pressable>
                            </View>
                        </View>
                    </View>
                </Modal>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

function formatDateTime(value: string) {
    const date = new Date(value);

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mi = String(date.getMinutes()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function formatElapsedTime(totalSeconds: number) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");

    return `${hh}:${mm}:${ss}`;
}

function AppButton({ title, onPress, disabled = false }: AppButtonProps) {
    return (
        <Pressable
            style={({ pressed }) => [
                styles.appButton,
                pressed && !disabled && styles.appButtonPressed,
                disabled && styles.appButtonDisabled,
            ]}
            onPress={onPress}
            disabled={disabled}
        >
            <Text style={styles.appButtonText}>{title}</Text>
        </Pressable>
    );
}

const styles = StyleSheet.create({
    keyboardAvoiding: {
        flex: 1,
        backgroundColor: "#fff",
    },
    container: {
        padding: 20,
        paddingBottom: 40,
        gap: 12,
    },
    title: {
        fontSize: 16,
        fontWeight: "bold",
        marginBottom: 12,
    },
    loading: {
        marginTop: 16,
    },
    locationBox: {
        marginTop: 20,
        padding: 16,
        borderWidth: 1,
        borderColor: "#ccc",
        borderRadius: 8,
        gap: 6,
    },
    memoArea: {
        marginTop: 12,
    },
    label: {
        fontSize: 15,
        fontWeight: "bold",
        marginBottom: 6,
    },
    memoInput: {
        height: 44,
        minHeight: 44,
        maxHeight: 44,
        borderWidth: 1,
        borderColor: "#ccc",
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 0,
        fontSize: 16,
        lineHeight: 20,
        backgroundColor: "#fff",
    },
    buttonSpace: {
        marginTop: 4,
    },
    appButton: {
        backgroundColor: "#4b6f8f",
        borderRadius: 8,
        paddingVertical: 8,
        paddingHorizontal: 16,
        alignItems: "center",
        justifyContent: "center",
        marginTop: 10,
    },
    appButtonPressed: {
        opacity: 0.75,
    },
    appButtonDisabled: {
        opacity: 0.5,
    },
    appButtonText: {
        color: "#fff",
        fontSize: 16,
        fontWeight: "bold",
    },
    autoRecordBox: {
        marginTop: 16,
        padding: 14,
        borderWidth: 1,
        borderColor: "#ddd",
        borderRadius: 10,
        backgroundColor: "#fff",
    },
    autoRecordTitle: {
        fontSize: 16,
        fontWeight: "bold",
    },
    autoRecordStatus: {
        fontSize: 13,
        color: "#555",
        marginBottom: 6,
    },
    autoRecordStartButton: {
        marginTop: 10,
        backgroundColor: "#4b6f8f",
        borderRadius: 8,
        paddingVertical: 10,
        alignItems: "center",
    },
    autoRecordStopButton: {
        marginTop: 10,
        backgroundColor: "#8f4b4b",
        borderRadius: 8,
        paddingVertical: 10,
        alignItems: "center",
    },
    autoRecordButtonText: {
        color: "#fff",
        fontSize: 15,
        fontWeight: "bold",
    },
    buttonPressed: {
        opacity: 0.75,
    },
    settingBlock: {
        marginTop: 12,
    },
    settingTitle: {
        fontSize: 13,
        fontWeight: "bold",
        color: "#444",
        marginBottom: 6,
    },
    optionRow: {
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 8,
    },
    optionButton: {
        paddingVertical: 7,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "#4b6f8f",
        backgroundColor: "#fff",
    },
    optionButtonSelected: {
        backgroundColor: "#4b6f8f",
    },
    optionButtonDisabled: {
        opacity: 0.5,
    },
    optionButtonText: {
        color: "#4b6f8f",
        fontSize: 13,
        fontWeight: "bold",
    },
    optionButtonTextSelected: {
        color: "#fff",
    },
    recordingStatusArea: {
        alignItems: "flex-end",
    },
    recordingBadge: {
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 999,
        backgroundColor: "#ffecec",
        borderWidth: 1,
        borderColor: "#d9534f",
    },
    recordingDot: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: "#d9534f",
        marginRight: 6,
    },
    recordingBadgeText: {
        color: "#d9534f",
        fontSize: 13,
        fontWeight: "bold",
    },
    stoppedBadge: {
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 999,
        backgroundColor: "#f0f0f0",
        borderWidth: 1,
        borderColor: "#ccc",
    },
    stoppedDot: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: "#999",
        marginRight: 6,
    },
    stoppedBadgeText: {
        color: "#666",
        fontSize: 13,
        fontWeight: "bold",
    },
    autoRecordHeader: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 8,
    },
    recordingTimeBox: {
        marginTop: 4,
        marginBottom: 6,
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: "rgba(0,0,0,0.35)",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
    },
    modalContent: {
        width: "100%",
        borderRadius: 12,
        padding: 18,
        backgroundColor: "#fff",
    },
    modalTitle: {
        fontSize: 18,
        fontWeight: "bold",
        marginBottom: 8,
    },
    modalDescription: {
        fontSize: 13,
        color: "#555",
        marginBottom: 12,
    },
    sessionNameModalInput: {
        height: 44,
        borderWidth: 1,
        borderColor: "#ccc",
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 0,
        fontSize: 16,
        backgroundColor: "#fff",
    },
    modalButtonRow: {
        flexDirection: "row",
        gap: 8,
        marginTop: 16,
    },
    modalPrimaryButton: {
        flex: 1,
        backgroundColor: "#4b6f8f",
        borderRadius: 8,
        paddingVertical: 10,
        alignItems: "center",
    },
    modalPrimaryButtonText: {
        color: "#fff",
        fontSize: 14,
        fontWeight: "bold",
    },
    modalSecondaryButton: {
        flex: 1,
        backgroundColor: "#e6edf3",
        borderRadius: 8,
        paddingVertical: 10,
        alignItems: "center",
    },
    modalSecondaryButtonText: {
        color: "#2f4f66",
        fontSize: 14,
        fontWeight: "bold",
    },
    signOutButton: {
        backgroundColor: "#e6edf3",
        borderRadius: 8,
        paddingVertical: 8,
        paddingHorizontal: 16,
        alignItems: "center",
        justifyContent: "center",
        marginTop: 10,
        borderWidth: 1,
        borderColor: "#c8d6e0",
    },
    signOutButtonText: {
        color: "#2f4f66",
        fontSize: 16,
        fontWeight: "bold",
    },
    signOutButtonSpace: {
        marginTop: 12,
        marginBottom: 36,
    },
    userInfoBox: {
        padding: 12,
        marginBottom: 12,
        borderRadius: 10,
        backgroundColor: "#eef3f7",
        borderWidth: 1,
        borderColor: "#c8d6e0",
    },
    userInfoLabel: {
        fontSize: 12,
        color: "#4b6f8f",
        marginBottom: 2,
    },
    userInfoName: {
        fontSize: 16,
        fontWeight: "bold",
        color: "#2f4f66",
    },
});
