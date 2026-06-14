import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useMemo, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Pressable,
    RefreshControl,
    StyleSheet,
    Text,
    TextInput,
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
    const [searchText, setSearchText] = useState("");

    const loadLogs = async () => {
        try {
            setLoading(true);

            const result = await client.models.LocationLog.list({
                filter: {
                    memo: {
                        contains: searchText,
                    },
                },
            });

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
                    memo: item.memo,
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

    const filteredLogs = useMemo(() => {
        const keyword = searchText.trim().toLowerCase();

        if (!keyword) {
            return logs;
        }

        return logs.filter((log) => {
            const memo = log.memo?.toLowerCase() ?? "";
            return memo.includes(keyword);
        });
    }, [logs, searchText]);

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

    const result = await client.models.

const result = await client.models.LocationLog.get({
        id: locationLogId,
    };

    setLocationLog({
  id: result.data.id,
});

    useFocusEffect(
        useCallback(() => {
            loadLogs();
        }, []),
    );

    return (
        <View style={styles.container}>
            <View style={styles.searchBox}>
                <Text style={styles.searchLabel}>メモ検索</Text>

                <TextInput
                    style={styles.searchInput}
                    value={searchText}
                    onChangeText={setSearchText}
                    placeholder="メモで検索"
                    autoCapitalize="none"
                    autoCorrect={false}
                />

                <View style={styles.searchInfoRow}>
                    <Text style={styles.searchInfoText}>
                        表示件数: {filteredLogs.length} / {logs.length}
                    </Text>

                    {searchText.trim().length > 0 && (
                        <Pressable onPress={clearSearchText}>
                            <Text style={styles.clearText}>クリア</Text>
                        </Pressable>
                    )}
                </View>
            </View>

            {loading && logs.length === 0 ? (
                <ActivityIndicator />
            ) : (
                <FlatList
                    data={filteredLogs}
                    keyExtractor={(item) => item.id}
                    refreshControl={
                        <RefreshControl
                            refreshing={loading}
                            onRefresh={loadLogs}
                        />
                    }
                    ListEmptyComponent={
                        <Text style={styles.emptyText}>
                            {searchText.trim().length > 0
                                ? "検索条件に一致する位置履歴がありません。"
                                : "まだ位置履歴がありません。"}
                        </Text>
                    }
                    renderItem={({ item, index }) => {
                        const isDeleting = deletingId === item.id;
                        const isLatest =
                            logs.length > 0 && item.id === logs[0].id;

                        return (
                            <View style={styles.card}>
                                <View style={styles.cardContent}>
                                    <View style={styles.row}>
                                        <Text style={styles.dateText}>
                                            {isLatest ? "最新 " : ""}
                                            {formatDateTime(item.recordedAt)}
                                        </Text>
                                    </View>
                                    {/* <Text style={styles.tapHint}>
                                    <Text>緯度: {item.latitude}</Text>
                                    <Text>経度: {item.longitude}</Text>
                                    <Text>
                                        精度:{" "}
                                        {item.accuracy !== null &&
                                        item.accuracy !== undefined
                                            ? `${item.accuracy}m`
                                            : "不明"}
                                    </Text>
                                    </Text> */}
                                    {item.memo ? (
                                        <Text style={styles.memoText}>
                                            メモ: {item.memo}
                                        </Text>
                                    ) : (
                                        <Text style={styles.noMemoText}>
                                            メモなし
                                        </Text>
                                    )}
                                </View>

                                <View style={styles.actionRow}>
                                    <Pressable
                                        style={({ pressed }) => [
                                            styles.detailButton,
                                            pressed &&
                                                styles.detailButtonPressed,
                                        ]}
                                        onPress={() => handleOpenDetail(item)}
                                    >
                                        <Text style={styles.detailButtonText}>
                                            タップして詳細を表示
                                        </Text>
                                    </Pressable>

                                    <Pressable
                                        style={({ pressed }) => [
                                            styles.deleteButton,
                                            pressed &&
                                                !isDeleting &&
                                                styles.deleteButtonPressed,
                                            isDeleting &&
                                                styles.deleteButtonDisabled,
                                        ]}
                                        disabled={isDeleting}
                                        onPress={() => handleDeleteLog(item)}
                                    >
                                        <Text style={styles.deleteButtonText}>
                                            {isDeleting ? "削除中..." : "削除"}
                                        </Text>
                                    </Pressable>
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
    searchBox: {
        padding: 12,
        borderWidth: 1,
        borderColor: "#ddd",
        borderRadius: 10,
        backgroundColor: "#fff",
        marginBottom: 12,
    },
    searchLabel: {
        fontSize: 15,
        fontWeight: "bold",
        marginBottom: 6,
    },
    searchInput: {
        height: 44,
        borderWidth: 1,
        borderColor: "#ccc",
        borderRadius: 8,
        paddingHorizontal: 12,
        fontSize: 16,
        backgroundColor: "#fff",
    },
    searchInfoRow: {
        marginTop: 8,
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
    },
    searchInfoText: {
        fontSize: 13,
        color: "#666",
    },
    clearText: {
        fontSize: 13,
        color: "#4b6f8f",
        fontWeight: "bold",
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
    memoText: {
        marginTop: 4,
        color: "#333",
    },
    noMemoText: {
        marginTop: 4,
        color: "#999",
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
    deleteButton: {
        minWidth: 90,
        paddingVertical: 10,
        paddingHorizontal: 18,
        borderRadius: 8,
        backgroundColor: "#4b6f8f",
        alignItems: "center",
        justifyContent: "center",
    },
    deleteButtonPressed: {
        opacity: 0.75,
    },
    deleteButtonDisabled: {
        opacity: 0.5,
    },
    deleteButtonText: {
        color: "#fff",
        fontSize: 14,
        fontWeight: "bold",
    },
    actionRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        paddingHorizontal: 14,
        paddingBottom: 12,
    },
    detailButton: {
        flex: 1,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: "#e6edf3",
        alignItems: "center",
        justifyContent: "center",
    },
    detailButtonPressed: {
        opacity: 0.75,
    },
    detailButtonText: {
        color: "#2f4f66",
        fontSize: 13,
        fontWeight: "bold",
    },
});
