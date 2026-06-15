import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    TextInput,
    View,
} from "react-native";
import { Text } from "react-native-paper";
import { client } from "../lib/client";

import type { RootStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<RootStackParamList, "LocationLogDetail">;

type LocationLogDetail = {
    id: string;
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    recordedAt: string;
    memo?: string | null;
    recordingSessionId: string | null;
};

export default function LocationLogDetailScreen({ route, navigation }: Props) {
    const { locationLogId } = route.params;

    const [log, setLog] = useState<LocationLogDetail | null>(null);
    const [memo, setMemo] = useState("");
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    //const [locationLog, setLocationLog] = useState<any | null>(null);

    const loadLog = useCallback(async () => {
        try {
            setLoading(true);

            const result = await client.models.LocationLog.list({
                filter: {
                    id: {
                        eq: locationLogId,
                    },
                },
            });

            if (result.errors) {
                console.error("LocationLog get errors:", result.errors);
                Alert.alert("取得エラー", "位置履歴を取得できませんでした。");
                return;
            }

            const log = result.data[0];

            if (!log) {
                Alert.alert("データなし", "位置履歴が見つかりませんでした。");
                navigation.goBack();
                console.log("LocationLog not found");
                return;
            }

            {
                /*
            setLocationLog({
                id: log.id,
                latitude: log.latitude,
                longitude: log.longitude,
                memo: log.memo,
                createdAt: log.createdAt,
            });
            */
            }

            if (result.errors) {
                console.error("LocationLog get errors:", result.errors);
                Alert.alert("取得エラー", "位置履歴を取得できませんでした。");
                return;
            }

            if (!result.data) {
                Alert.alert("データなし", "位置履歴が見つかりませんでした。");
                navigation.goBack();
                return;
            }

            const item: LocationLogDetail = {
                id: log.id,
                latitude: Number(log.latitude),
                longitude: Number(log.longitude),
                accuracy: log.accuracy,
                recordedAt: log.recordedAt,
                memo: log.memo,
                recordingSessionId: log.recordingSessionId ?? null,
            };

            setLog(item);
            setMemo(item.memo ?? "");
        } catch (error) {
            console.error("LocationLog get error:", error);
            Alert.alert("取得エラー", "位置履歴の取得に失敗しました。");
        } finally {
            setLoading(false);
        }
    }, [locationLogId, navigation]);

    const handleSaveMemo = async () => {
        if (!log) {
            return;
        }

        try {
            setSaving(true);

            const nextMemo = memo.trim();

            const result = await client.models.LocationLog.update({
                id: log.id,
                memo: nextMemo || null,
            });

            if (result.errors) {
                console.error("LocationLog update errors:", result.errors);
                Alert.alert("保存エラー", "メモを保存できませんでした。");
                return;
            }

            setLog({
                ...log,
                memo: nextMemo || null,
            });

            Alert.alert("保存完了", "メモを保存しました。");
        } catch (error) {
            console.error("LocationLog update error:", error);
            Alert.alert("保存エラー", "メモの保存に失敗しました。");
        } finally {
            setSaving(false);
        }
    };

    const handleOpenMap = () => {
        if (!log) {
            return;
        }

        navigation.navigate("LocationMap", {
            selectedLocation: {
                id: log.id,
                latitude: log.latitude,
                longitude: log.longitude,
                accuracy: log.accuracy,
                recordedAt: log.recordedAt,
                memo: memo.trim() || null,
                recordingSessionId: log.recordingSessionId ?? null,
            },
        });
    };

    useEffect(() => {
        loadLog();
    }, [loadLog]);

    if (loading && !log) {
        return (
            <View style={styles.center}>
                <ActivityIndicator />
            </View>
        );
    }

    if (!log) {
        return (
            <View style={styles.center}>
                <Text>位置履歴がありません。</Text>
            </View>
        );
    }

    return (
        <ScrollView contentContainerStyle={styles.container}>
            <View style={styles.card}>
                <Text style={styles.title}>位置履歴詳細</Text>

                <View style={styles.row}>
                    <Text style={styles.label}>日時</Text>
                    <Text style={styles.value}>
                        {formatDateTime(log.recordedAt)}
                    </Text>
                </View>

                <View style={styles.row}>
                    <Text style={styles.label}>緯度</Text>
                    <Text style={styles.value}>{log.latitude.toFixed(6)}</Text>
                </View>

                <View style={styles.row}>
                    <Text style={styles.label}>経度</Text>
                    <Text style={styles.value}>{log.longitude.toFixed(6)}</Text>
                </View>

                <View style={styles.row}>
                    <Text style={styles.label}>精度</Text>
                    <Text style={styles.value}>
                        {log.accuracy !== null && log.accuracy !== undefined
                            ? `${Math.round(log.accuracy)}m`
                            : "不明"}
                    </Text>
                </View>
            </View>

            <View style={styles.card}>
                <Text style={styles.sectionTitle}>メモ</Text>

                <TextInput
                    style={styles.memoInput}
                    value={memo}
                    onChangeText={setMemo}
                    placeholder="メモを入力"
                    multiline
                    numberOfLines={4}
                    textAlignVertical="top"
                />

                <View style={styles.buttonSpace}>
                    <Pressable
                        style={({ pressed }) => [
                            styles.primaryButton,
                            pressed && !saving && styles.primaryButtonPressed,
                            saving && styles.primaryButtonDisabled,
                        ]}
                        onPress={handleSaveMemo}
                        disabled={saving}
                    >
                        <Text style={styles.primaryButtonText}>
                            {saving ? "保存中..." : "メモを保存"}
                        </Text>
                    </Pressable>
                </View>
            </View>

            <View style={styles.buttonSpace}>
                <Pressable
                    style={({ pressed }) => [
                        styles.primaryButton,
                        pressed && styles.primaryButtonPressed,
                    ]}
                    onPress={handleOpenMap}
                >
                    <Text style={styles.primaryButtonText}>
                        この位置を地図で表示
                    </Text>
                </Pressable>
            </View>
        </ScrollView>
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

const styles = StyleSheet.create({
    container: {
        padding: 16,
        paddingBottom: 40,
        backgroundColor: "#f7f7f7",
    },
    center: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
    },
    card: {
        padding: 16,
        borderWidth: 1,
        borderColor: "#ddd",
        borderRadius: 10,
        backgroundColor: "#fff",
        marginBottom: 14,
    },
    title: {
        fontSize: 20,
        fontWeight: "bold",
        marginBottom: 14,
    },
    sectionTitle: {
        fontSize: 17,
        fontWeight: "bold",
        marginBottom: 10,
    },
    row: {
        marginBottom: 10,
    },
    label: {
        fontSize: 13,
        color: "#666",
        marginBottom: 2,
    },
    value: {
        fontSize: 16,
        color: "#222",
    },
    memoInput: {
        minHeight: 110,
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
    primaryButton: {
        backgroundColor: "#4b6f8f",
        borderRadius: 8,
        paddingVertical: 10,
        paddingHorizontal: 16,
        alignItems: "center",
        justifyContent: "center",
    },
    primaryButtonPressed: {
        opacity: 0.75,
    },
    primaryButtonDisabled: {
        opacity: 0.5,
    },
    primaryButtonText: {
        color: "#fff",
        fontSize: 15,
        fontWeight: "bold",
    },
});
