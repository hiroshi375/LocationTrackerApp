import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { getCurrentUser, signOut } from "aws-amplify/auth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Animated,
    Image,
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
import { getUrl } from "aws-amplify/storage";
import { useForegroundLocationRecorder } from "../hooks/useForegroundLocationRecorder";
import { client } from "../lib/client";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { upsertRecordingSessionSummary } from "../services/recordingSessionService";
import {
    ensureUserProfile,
    getCurrentUserProfile,
} from "../services/userProfileService";

type Props = NativeStackScreenProps<RootStackParamList, "LocationHome">;

type AppButtonProps = {
    title: string;
    onPress: () => void;
    disabled?: boolean;
};

type UserProfileItem = {
    id: string;
    userId: string;
    email?: string | null;
    displayName?: string | null;
    ownerValue?: string | null;
    searchText?: string | null;
};

type UserProfileListResult = {
    data?: any[] | null;
    errors?: unknown;
};

type LocationLogListResult = {
    data?: any[] | null;
    errors?: unknown;
    nextToken?: string | null;
};

// 現在地の記録と保存を行うホーム画面コンポーネント
export default function LocationHomeScreen({ navigation }: Props) {
    const [loginUserName, setLoginUserName] = useState("ユーザー");
    const [loginUserIconUrl, setLoginUserIconUrl] = useState<string | null>(
        null,
    );

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

    const [liveShareModalVisible, setLiveShareModalVisible] = useState(false);
    const [liveShareSearchText, setLiveShareSearchText] = useState("");
    const [liveShareUsers, setLiveShareUsers] = useState<UserProfileItem[]>([]);
    const [selectedLiveShareUser, setSelectedLiveShareUser] =
        useState<UserProfileItem | null>(null);
    const [loadingLiveShareUsers, setLoadingLiveShareUsers] = useState(false);
    const [liveShareStatusMessage, setLiveShareStatusMessage] = useState("");

    const {
        isRecording,
        recordingStartedAt,
        activeRecordingSessionId,
        startRecording,
        stopRecording,
    } = useForegroundLocationRecorder({
        intervalMs: recordIntervalMs,
        distanceMeters: recordDistanceMeters,
        liveShareOwnerValue: selectedLiveShareUser?.ownerValue ?? null,
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

            if (profile?.iconImagePath) {
                const urlResult = await getUrl({
                    path: profile.iconImagePath,
                    options: {
                        expiresIn: 3600,
                    },
                });

                setLoginUserIconUrl(urlResult.url.toString());
            } else {
                setLoginUserIconUrl(null);
            }
        } catch (error) {
            console.error("Load login user name error:", error);
            setLoginUserName("ユーザー");
            setLoginUserIconUrl(null);
        }
    }, []);

    const loadLiveShareUsers = useCallback(async () => {
        try {
            setLoadingLiveShareUsers(true);

            const currentUser = await getCurrentUser();

            const userProfileModel = client.models.UserProfile as any;

            const result = (await userProfileModel.list({
                limit: 1000,
            })) as UserProfileListResult;

            if (result.errors) {
                console.error("UserProfile list errors:", result.errors);
                Alert.alert(
                    "取得エラー",
                    "共有先ユーザーを取得できませんでした。",
                );
                return;
            }

            const users: UserProfileItem[] = (result.data ?? [])
                .map((user) => ({
                    id: user.id,
                    userId: user.userId,
                    email: user.email ?? null,
                    displayName: user.displayName ?? null,
                    ownerValue: user.ownerValue ?? null,
                    searchText: user.searchText ?? null,
                }))
                .filter((user) => {
                    if (!user.ownerValue) {
                        return false;
                    }

                    // 自分自身は候補から除外
                    return user.userId !== currentUser.userId;
                })
                .sort((a, b) => {
                    const aName = a.displayName || a.email || "";
                    const bName = b.displayName || b.email || "";
                    return aName.localeCompare(bName);
                });

            setLiveShareUsers(users);
        } catch (error) {
            console.error("Load live share users error:", error);
            Alert.alert("取得エラー", "共有先ユーザーの取得に失敗しました。");
        } finally {
            setLoadingLiveShareUsers(false);
        }
    }, []);

    const filteredLiveShareUsers = useMemo(() => {
        const keyword = liveShareSearchText.trim().toLowerCase();

        if (!keyword) {
            return liveShareUsers;
        }

        return liveShareUsers.filter((user) => {
            return (
                (user.displayName ?? "").toLowerCase().includes(keyword) ||
                (user.email ?? "").toLowerCase().includes(keyword)
            );
        });
    }, [liveShareUsers, liveShareSearchText]);

    const openLiveShareModal = () => {
        if (isRecording) {
            Alert.alert(
                "自動記録中",
                "共有先ユーザーは自動記録開始前に選択してください。",
            );
            return;
        }

        setLiveShareSearchText("");
        setLiveShareModalVisible(true);
        void loadLiveShareUsers();
    };

    const clearLiveShareUser = () => {
        if (isRecording) {
            Alert.alert(
                "自動記録中",
                "共有先ユーザーは自動記録停止後に変更してください。",
            );
            return;
        }

        setSelectedLiveShareUser(null);
        setLiveShareStatusMessage("");
    };

    const liveShareUserName =
        selectedLiveShareUser?.displayName ||
        selectedLiveShareUser?.email ||
        "";

    const handleStartRecording = async () => {
        setLiveShareStatusMessage("");

        await startRecording();
    };

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

    //
    const handleSignOut = async () => {
        try {
            await signOut();
        } catch (error) {
            console.error("Sign out error:", error);
            Alert.alert("サインアウトエラー", "サインアウトできませんでした。");
        }
    };

    const listLocationLogsBySessionId = useCallback(
        async (recordingSessionId: string) => {
            const allData: any[] = [];
            let nextToken: string | null = null;

            const locationLogModel = client.models.LocationLog as any;

            do {
                const listParams: {
                    filter: {
                        recordingSessionId: {
                            eq: string;
                        };
                    };
                    limit: number;
                    nextToken?: string;
                } = {
                    filter: {
                        recordingSessionId: {
                            eq: recordingSessionId,
                        },
                    },
                    limit: 1000,
                };

                if (nextToken) {
                    listParams.nextToken = nextToken;
                }

                const result = (await locationLogModel.list(
                    listParams,
                )) as LocationLogListResult;

                if (result.errors) {
                    console.error(
                        "LocationLog session list errors:",
                        result.errors,
                    );
                    throw new Error("LocationLog session list failed");
                }

                allData.push(...(result.data ?? []));
                nextToken = result.nextToken ?? null;
            } while (nextToken);

            return allData;
        },
        [],
    );

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

            const sessionLogs =
                await listLocationLogsBySessionId(pendingSessionId);

            const locationLogModel = client.models.LocationLog as any;

            const updateResults = await Promise.all(
                sessionLogs.map((log) =>
                    locationLogModel.update({
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

            await upsertRecordingSessionSummary(pendingSessionId, sessionName);

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
        const stoppedShareUserName = liveShareUserName;

        const finishedSessionId = await stopRecording();

        if (stoppedShareUserName) {
            setLiveShareStatusMessage(
                `現在地共有を停止しました: ${stoppedShareUserName}`,
            );
        } else {
            setLiveShareStatusMessage("");
        }

        if (!finishedSessionId) {
            return;
        }

        try {
            await upsertRecordingSessionSummary(finishedSessionId, null);
        } catch (error) {
            console.error("RecordingSession summary save error:", error);
        }

        setPendingSessionId(finishedSessionId);
        setSessionNameInput("");
        setSessionNameModalVisible(true);
    };

    const canOpenRecordingMap =
        isRecording && Boolean(activeRecordingSessionId);

    const handleOpenRecordingMap = () => {
        if (!activeRecordingSessionId) {
            return;
        }

        navigation.navigate("LocationMap", {
            recordingSessionId: activeRecordingSessionId,
            recordingIntervalMs: recordIntervalMs,
            recordingDistanceMeters: recordDistanceMeters,
        });
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
                    <Text style={styles.userInfoLabel}>ログインユーザー：</Text>
                    <Text style={styles.userInfoName}>{loginUserName}</Text>
                    {loginUserIconUrl ? (
                        <Image
                            source={{ uri: loginUserIconUrl }}
                            style={styles.userIcon}
                        />
                    ) : (
                        <View style={styles.userIconPlaceholder}>
                            <Text style={styles.userIconPlaceholderText}>
                                {loginUserName.slice(0, 1)}
                            </Text>
                        </View>
                    )}
                </View>
                <View style={styles.buttonSpace}>
                    <AppButton
                        title="セッション履歴を見る"
                        onPress={() => navigation.navigate("LocationLog")}
                    />
                </View>

                <View style={styles.buttonSpace}>
                    <AppButton
                        title="共有中の現在地を見る"
                        onPress={() => navigation.navigate("LiveLocationMap")}
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
                    <View style={styles.settingBlock}>
                        <Text style={styles.settingTitle}>
                            リアルタイム共有先
                        </Text>

                        <Pressable
                            style={[
                                styles.liveShareSelectButton,
                                isRecording && styles.appButtonDisabled,
                            ]}
                            onPress={openLiveShareModal}
                            disabled={isRecording}
                        >
                            <Text style={styles.liveShareSelectButtonText}>
                                {selectedLiveShareUser
                                    ? selectedLiveShareUser.displayName ||
                                      selectedLiveShareUser.email ||
                                      "名前未設定ユーザー"
                                    : "共有先ユーザーを選択"}
                            </Text>
                        </Pressable>

                        {selectedLiveShareUser?.email && (
                            <Text style={styles.liveShareSelectedEmail}>
                                {selectedLiveShareUser.email}
                            </Text>
                        )}

                        {selectedLiveShareUser && !isRecording && (
                            <Pressable
                                style={styles.liveShareClearButton}
                                onPress={clearLiveShareUser}
                            >
                                <Text style={styles.liveShareClearButtonText}>
                                    共有先を解除
                                </Text>
                            </Pressable>
                        )}
                    </View>
                    {isRecording && selectedLiveShareUser && (
                        <View style={styles.liveShareStatusActiveBox}>
                            <Text style={styles.liveShareStatusActiveText}>
                                現在地を共有中: {liveShareUserName}
                            </Text>
                        </View>
                    )}
                    {!isRecording && liveShareStatusMessage.length > 0 && (
                        <View style={styles.liveShareStatusStoppedBox}>
                            <Text style={styles.liveShareStatusStoppedText}>
                                {liveShareStatusMessage}
                            </Text>
                        </View>
                    )}
                    <View style={styles.autoRecordMapButtonSpace}>
                        <AppButton
                            title="地図で見る"
                            onPress={handleOpenRecordingMap}
                            disabled={!canOpenRecordingMap}
                        />
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
                            onPress={handleStartRecording}
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

                <Modal
                    visible={liveShareModalVisible}
                    transparent
                    animationType="fade"
                    onRequestClose={() => setLiveShareModalVisible(false)}
                >
                    <View style={styles.modalOverlay}>
                        <View style={styles.modalContent}>
                            <Text style={styles.modalTitle}>
                                リアルタイム共有先を選択
                            </Text>

                            <Text style={styles.modalDescription}>
                                自動記録中の現在地を共有するユーザーを選択してください。
                            </Text>

                            <TextInput
                                style={styles.liveShareSearchInput}
                                value={liveShareSearchText}
                                onChangeText={setLiveShareSearchText}
                                placeholder="ユーザー名またはメールで絞り込み"
                                autoCapitalize="none"
                                autoCorrect={false}
                            />

                            <ScrollView
                                style={styles.liveShareUserList}
                                contentContainerStyle={
                                    styles.liveShareUserListContent
                                }
                                keyboardShouldPersistTaps="handled"
                            >
                                {loadingLiveShareUsers ? (
                                    <ActivityIndicator
                                        style={{ marginVertical: 20 }}
                                    />
                                ) : filteredLiveShareUsers.length === 0 ? (
                                    <Text style={styles.liveShareEmptyText}>
                                        共有先ユーザーが見つかりません。
                                        {"\n"}
                                        UserProfile
                                        に他のユーザーが存在するか確認してください。
                                    </Text>
                                ) : (
                                    filteredLiveShareUsers.map((user) => {
                                        const selected =
                                            selectedLiveShareUser?.id ===
                                            user.id;

                                        return (
                                            <Pressable
                                                key={user.id}
                                                style={[
                                                    styles.liveShareUserItem,
                                                    selected &&
                                                        styles.liveShareUserItemSelected,
                                                ]}
                                                onPress={() => {
                                                    setSelectedLiveShareUser(
                                                        user,
                                                    );
                                                    setLiveShareStatusMessage(
                                                        "",
                                                    );
                                                    setLiveShareModalVisible(
                                                        false,
                                                    );
                                                }}
                                            >
                                                <Text
                                                    style={
                                                        styles.liveShareUserName
                                                    }
                                                >
                                                    {user.displayName ||
                                                        "名前未設定"}
                                                </Text>

                                                <Text
                                                    style={
                                                        styles.liveShareUserEmail
                                                    }
                                                >
                                                    {user.email || "メールなし"}
                                                </Text>
                                            </Pressable>
                                        );
                                    })
                                )}
                            </ScrollView>

                            <View style={styles.modalButtonRow}>
                                <Pressable
                                    style={styles.modalSecondaryButton}
                                    onPress={() =>
                                        setLiveShareModalVisible(false)
                                    }
                                >
                                    <Text
                                        style={styles.modalSecondaryButtonText}
                                    >
                                        キャンセル
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
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
    },
    userInfoLabel: {
        fontSize: 14,
        color: "#4b6f8f",
        fontWeight: "bold",
    },
    userInfoName: {
        fontSize: 16,
        fontWeight: "bold",
        color: "#2f4f66",
    },
    liveShareSelectButton: {
        minHeight: 44,
        borderWidth: 1,
        borderColor: "#c8d6e0",
        borderRadius: 8,
        paddingHorizontal: 12,
        justifyContent: "center",
        backgroundColor: "#fff",
    },
    liveShareSelectButtonText: {
        fontSize: 15,
        color: "#2f4f66",
        fontWeight: "bold",
    },
    liveShareSelectedEmail: {
        marginTop: 4,
        fontSize: 12,
        color: "#666",
    },
    liveShareClearButton: {
        marginTop: 8,
        alignSelf: "flex-start",
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: "#eef3f7",
        borderWidth: 1,
        borderColor: "#c8d6e0",
    },
    liveShareClearButtonText: {
        color: "#2f4f66",
        fontSize: 12,
        fontWeight: "bold",
    },
    liveShareSearchInput: {
        height: 44,
        borderWidth: 1,
        borderColor: "#ccc",
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 0,
        fontSize: 16,
        backgroundColor: "#fff",
        marginBottom: 10,
    },
    liveShareUserList: {
        marginTop: 8,
        minHeight: 160,
        maxHeight: 260,
        borderWidth: 1,
        borderColor: "#c8d6e0",
        borderRadius: 8,
        backgroundColor: "#f9fbfd",
    },
    liveShareUserListContent: {
        padding: 8,
    },
    liveShareEmptyText: {
        textAlign: "center",
        color: "#777",
        paddingVertical: 20,
        lineHeight: 20,
    },
    liveShareUserItem: {
        padding: 10,
        borderWidth: 1,
        borderColor: "#ddd",
        borderRadius: 8,
        marginBottom: 8,
        backgroundColor: "#fff",
    },
    liveShareUserItemSelected: {
        borderColor: "#4b6f8f",
        backgroundColor: "#eef3f7",
    },
    liveShareUserName: {
        fontSize: 15,
        fontWeight: "bold",
        color: "#333",
    },
    liveShareUserEmail: {
        marginTop: 2,
        fontSize: 12,
        color: "#666",
    },
    liveShareStatusActiveBox: {
        marginTop: 10,
        padding: 10,
        borderRadius: 8,
        backgroundColor: "#ffecec",
        borderWidth: 1,
        borderColor: "#d9534f",
    },
    liveShareStatusActiveText: {
        color: "#d9534f",
        fontSize: 13,
        fontWeight: "bold",
    },
    liveShareStatusStoppedBox: {
        marginTop: 10,
        padding: 10,
        borderRadius: 8,
        backgroundColor: "#eef3f7",
        borderWidth: 1,
        borderColor: "#c8d6e0",
    },
    liveShareStatusStoppedText: {
        color: "#2f4f66",
        fontSize: 13,
        fontWeight: "bold",
    },
    userIcon: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: "#e6edf3",
    },
    userIconPlaceholder: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: "#dbe7f0",
        alignItems: "center",
        justifyContent: "center",
    },
    userIconPlaceholderText: {
        color: "#2f4f66",
        fontSize: 16,
        fontWeight: "bold",
    },
    autoRecordMapButtonSpace: {
        marginTop: 10,
    },
});
