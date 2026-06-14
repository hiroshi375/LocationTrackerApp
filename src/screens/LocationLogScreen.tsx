import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Button,
    FlatList,
    Pressable,
    RefreshControl,
    StyleSheet,
    Text,
    View,
} from "react-native";

import { client } from "../lib/client";
import type { RootStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<RootStackParamList, "LocationLog">;

type LocationLogItem = {
    id: string;
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    recordedAt: string;
    memo?: string | null;
};

export default function LocationLogScreen({ navigation }: Props) {
    const [logs, setLogs] = useState<LocationLogItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);

    const loadLogs = async () => {
        try {
            setLoading(true);

            const result = await client.models.LocationLog.list();

            if (result.errors) {
                console.error("LocationLog list errors:", result.errors);
                return;
            }

            const items = result.data
                .map((item) => ({
                    id: item.id,
                    latitude: Number(item.latitude),
                    longitude: Number(item.longitude),
                    accuracy: item.accuracy,
                    recordedAt: item.recordedAt,
                    memo: item.memo ?? null,
                }))
                .filter(
                    (item) =>
                        Number.isFinite(item.latitude) &&
                        Number.isFinite(item.longitude),
                )
                .sort((a, b) => {
                    return (
                        new Date(b.recordedAt).getTime() -
                        new Date(a.recordedAt).getTime()
                    );
                });

            setLogs(items);
        } catch (error) {
            console.error("LocationLog load error:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleOpenDetail = (log: LocationLogItem) => {
        navigation.navigate("LocationLogDetail", {
            locationLogId: log.id,
        });
    };

    const handleDeleteLog = (log: LocationLogItem) => {
        Alert.alert(
            "位置履歴を削除",
            `${formatDateTime(log.recordedAt)} の位置履歴を削除しますか？`,
            [
                {
                    text: "キャンセル",
                    style: "cancel",
                },
                {
                    text: "削除",
                    style: "destructive",
                    onPress: async () => {
                        await deleteLog(log.id);
                    },
                },
            ],
        );
    };

    const deleteLog = async (id: string) => {
        try {
            setDeletingId(id);

            const result = await client.models.LocationLog.delete({
                id,
            });

            if (result.errors) {
                console.error("LocationLog delete errors:", result.errors);
                Alert.alert("削除エラー", "位置履歴を削除できませんでした。");
                return;
            }

            setLogs((currentLogs) =>
                currentLogs.filter((log) => log.id !== id),
            );
        } catch (error) {
            console.error("LocationLog delete error:", error);
            Alert.alert("削除エラー", "位置履歴の削除に失敗しました。");
        } finally {
            setDeletingId(null);
        }
    };

    useFocusEffect(
        useCallback(() => {
            loadLogs();
        }, []),
    );

    return (
        <View style={styles.container}>
            {loading && logs.length === 0 ? (
                <ActivityIndicator />
            ) : (
                <FlatList
                    data={logs}
                    keyExtractor={(item) => item.id}
                    refreshControl={
                        <RefreshControl
                            refreshing={loading}
                            onRefresh={loadLogs}
                        />
                    }
                    ListEmptyComponent={
                        <Text style={styles.emptyText}>
                            まだ位置履歴がありません。
                        </Text>
                    }
                    renderItem={({ item, index }) => {
                        const isDeleting = deletingId === item.id;

                        return (
                            <View style={styles.card}>
                                <Pressable
                                    style={({ pressed }) => [
                                        styles.cardContent,
                                        pressed && styles.cardPressed,
                                    ]}
                                    onPress={() => handleOpenDetail(item)}
                                >
                                    <View style={styles.row}>
                                        <Text style={styles.dateText}>
                                            {index === 0 ? "最新 " : ""}
                                            {formatDateTime(item.recordedAt)}
                                        </Text>
                                    </View>

                                    <Text>緯度: {item.latitude}</Text>
                                    <Text>経度: {item.longitude}</Text>
                                    <Text>
                                        精度:{" "}
                                        {item.accuracy !== null &&
                                        item.accuracy !== undefined
                                            ? `${item.accuracy}m`
                                            : "不明"}
                                    </Text>
                                    {item.memo ? (
                                        <Text style={styles.memoText}>
                                            メモ: {item.memo}
                                        </Text>
                                    ) : (
                                        <Text style={styles.noMemoText}>
                                            メモなし
                                        </Text>
                                    )}
                                    <Text style={styles.tapHint}>
                                        タップして詳細を表示
                                    </Text>
                                </Pressable>

                                <View style={styles.deleteButtonArea}>
                                    <Button
                                        title={
                                            isDeleting ? "削除中..." : "削除"
                                        }
                                        color="#b00020"
                                        disabled={isDeleting}
                                        onPress={() => handleDeleteLog(item)}
                                    />
                                </View>
                            </View>
                        );
                    }}
                />
            )}
        </View>
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
        flex: 1,
        padding: 16,
        backgroundColor: "#f7f7f7",
    },
    card: {
        borderWidth: 1,
        borderColor: "#ddd",
        borderRadius: 8,
        marginBottom: 10,
        backgroundColor: "#fff",
        overflow: "hidden",
    },
    cardContent: {
        padding: 14,
        gap: 4,
    },
    cardPressed: {
        opacity: 0.7,
    },
    row: {
        flexDirection: "row",
        alignItems: "center",
    },
    dateText: {
        fontSize: 16,
        fontWeight: "bold",
        marginBottom: 4,
    },
    tapHint: {
        marginTop: 6,
        color: "#4b6f8f",
        fontSize: 13,
        fontWeight: "bold",
    },
    emptyText: {
        textAlign: "center",
        marginTop: 40,
        color: "#666",
    },
    deleteButtonArea: {
        paddingHorizontal: 14,
        paddingBottom: 12,
        alignSelf: "flex-end",
        minWidth: 100,
    },
    memoText: {
        marginTop: 4,
        color: "#333",
    },
    noMemoText: {
        marginTop: 4,
        color: "#999",
    },
});
