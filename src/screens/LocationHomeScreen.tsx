import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { getCurrentUser } from "aws-amplify/auth";
import * as Location from "expo-location";
import { useEffect, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Animated,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";

import { useForegroundLocationRecorder } from "../hooks/useForegroundLocationRecorder";
import { client } from "../lib/client";
import type { RootStackParamList } from "../navigation/RootNavigator";

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

    const RECORD_INTERVAL_OPTIONS = [
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

    const { isRecording, lastRecordedAtText, startRecording, stopRecording } =
        useForegroundLocationRecorder({
            intervalMs: recordIntervalMs,
            distanceMeters: recordDistanceMeters,
        });

    const recordingBlinkAnim = useRef(new Animated.Value(1)).current;

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

    return (
        <KeyboardAvoidingView
            style={styles.keyboardAvoiding}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
            <ScrollView
                contentContainerStyle={styles.container}
                keyboardShouldPersistTaps="handled"
            >
                <Text style={styles.title}>現在地を手動記録</Text>

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
                        multiline
                        numberOfLines={3}
                        textAlignVertical="top"
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
                        onPress={() => navigation.navigate("LocationMap")}
                    />
                </View>
                <View style={styles.autoRecordBox}>
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

                    {lastRecordedAtText && (
                        <Text style={styles.autoRecordStatus}>
                            最終記録: {lastRecordedAtText}
                        </Text>
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
                            onPress={stopRecording}
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
        fontSize: 22,
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
        minHeight: 90,
        borderWidth: 1,
        borderColor: "#ccc",
        borderRadius: 8,
        padding: 12,
        fontSize: 16,
        backgroundColor: "#fff",
    },
    buttonSpace: {
        marginTop: 12,
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
        marginBottom: 8,
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
        marginTop: 6,
        marginBottom: 8,
        alignItems: "flex-start",
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
});
