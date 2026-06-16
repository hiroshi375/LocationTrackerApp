import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { getCurrentUser } from "aws-amplify/auth";
import { useCallback, useMemo, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Modal,
    Pressable,
    RefreshControl,
    ScrollView,
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
    recordingSessionId?: string | null;
    recordingSessionName?: string | null;
    sharedOwners?: string[] | null;
};

type LocationLogSingleDisplayItem = LocationLogItem & {
    kind: "single";
    sortAt: string;
};

type LocationLogSessionDisplayItem = {
    kind: "session";
    id: string;
    recordingSessionId: string;
    recordingSessionName: string;
    logs: LocationLogItem[];
    startLog: LocationLogItem;
    endLog: LocationLogItem;
    startAt: string;
    endAt: string;
    pointCount: number;
    sortAt: string;
};

type LocationLogDisplayItem =
    | LocationLogSingleDisplayItem
    | LocationLogSessionDisplayItem;

type UserProfileItem = {
    id: string;
    userId: string;
    email?: string | null;
    displayName?: string | null;
    ownerValue?: string | null;
    searchText?: string | null;
};

export default function LocationLogScreen({ navigation }: Props) {
    const [logs, setLogs] = useState<LocationLogItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [searchText, setSearchText] = useState("");

    const [shareModalVisible, setShareModalVisible] = useState(false);
    const [shareSearchText, setShareSearchText] = useState("");
    const [shareUsers, setShareUsers] = useState<UserProfileItem[]>([]);
    const [selectedShareUser, setSelectedShareUser] =
        useState<UserProfileItem | null>(null);
    const [sharingSession, setSharingSession] =
        useState<LocationLogSessionDisplayItem | null>(null);
    const [shareSearching, setShareSearching] = useState(false);
    const [sharing, setSharing] = useState(false);

    const loadLogs = useCallback(async () => {
        try {
            setLoading(true);

            const result = await client.models.LocationLog.list({});

            if (result.errors) {
                console.error("LocationLog list errors:", result.errors);
                return;
            }

            const items = (result.data ?? [])
                .map((item) => ({
                    id: item.id,
                    latitude: Number(item.latitude),
                    longitude: Number(item.longitude),
                    accuracy: item.accuracy,
                    recordedAt: item.recordedAt,
                    memo: item.memo,
                    recordingSessionId: item.recordingSessionId ?? null,
                    recordingSessionName: item.recordingSessionName ?? null,
                    sharedOwners: Array.isArray(item.sharedOwners)
                        ? item.sharedOwners.filter(
                              (owner: unknown): owner is string =>
                                  typeof owner === "string" && owner.length > 0,
                          )
                        : [],
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
    }, []);

    const clearSearchText = () => {
        setSearchText("");
    };

    const displayItems = useMemo(() => {
        return buildDisplayItems(logs);
    }, [logs]);

    const filteredItems = useMemo(() => {
        const keyword = searchText.trim().toLowerCase();

        if (!keyword) {
            return displayItems;
        }

        return displayItems.filter((item) => {
            if (item.kind === "single") {
                return (item.memo ?? "").toLowerCase().includes(keyword);
            }

            return (
                item.recordingSessionName.toLowerCase().includes(keyword) ||
                "自動記録セッション".toLowerCase().includes(keyword) ||
                item.recordingSessionId.toLowerCase().includes(keyword) ||
                item.logs.some((log) =>
                    (log.memo ?? "").toLowerCase().includes(keyword),
                )
            );
        });
    }, [displayItems, searchText]);

    const filteredShareUsers = useMemo(() => {
        const keyword = shareSearchText.trim().toLowerCase();

        if (!keyword) {
            return shareUsers;
        }

        return shareUsers.filter((user) => {
            return (
                (user.displayName ?? "").toLowerCase().includes(keyword) ||
                (user.email ?? "").toLowerCase().includes(keyword)
            );
        });
    }, [shareUsers, shareSearchText]);

    const handleOpenDetail = (log: LocationLogItem) => {
        navigation.navigate("LocationLogDetail", {
            locationLogId: log.id,
        });
    };

    const handleOpenSessionMap = (item: LocationLogSessionDisplayItem) => {
        const selectedLocation: LocationLogItem = {
            id: item.endLog.id,
            latitude: item.endLog.latitude,
            longitude: item.endLog.longitude,
            accuracy: item.endLog.accuracy ?? null,
            recordedAt: item.endLog.recordedAt,
            memo: item.endLog.memo ?? null,
            recordingSessionId: item.recordingSessionId,
            recordingSessionName: item.recordingSessionName,
            sharedOwners: item.endLog.sharedOwners ?? [],
        };

        navigation.push("LocationMap", {
            selectedLocation,
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

    const handleDeleteSession = (item: LocationLogSessionDisplayItem) => {
        Alert.alert(
            "自動記録セッションを削除",
            `${formatDateTime(item.startAt)} 〜 ${formatDateTime(
                item.endAt,
            )} の自動記録セッションを削除しますか？\n\n記録ポイント ${item.pointCount}件が削除されます。`,
            [
                {
                    text: "キャンセル",
                    style: "cancel",
                },
                {
                    text: "削除",
                    style: "destructive",
                    onPress: async () => {
                        await deleteSession(item);
                    },
                },
            ],
        );
    };

    const deleteSession = async (item: LocationLogSessionDisplayItem) => {
        try {
            setDeletingId(item.id);

            const results = await Promise.all(
                item.logs.map((log) =>
                    client.models.LocationLog.delete({
                        id: log.id,
                    }),
                ),
            );

            const hasErrors = results.some((result) => result.errors);

            if (hasErrors) {
                console.error("LocationLog session delete errors:", results);
                Alert.alert(
                    "削除エラー",
                    "自動記録セッションを削除できませんでした。",
                );
                return;
            }

            setLogs((currentLogs) =>
                currentLogs.filter(
                    (log) => log.recordingSessionId !== item.recordingSessionId,
                ),
            );
        } catch (error) {
            console.error("LocationLog session delete error:", error);
            Alert.alert(
                "削除エラー",
                "自動記録セッションの削除に失敗しました。",
            );
        } finally {
            setDeletingId(null);
        }
    };

    const openShareModal = (item: LocationLogSessionDisplayItem) => {
        setSharingSession(item);
        setShareSearchText("");
        setShareUsers([]);
        setSelectedShareUser(null);
        setShareModalVisible(true);

        void loadShareUsers();
    };

    const closeShareModal = () => {
        if (sharing) {
            return;
        }

        setShareModalVisible(false);
        setSharingSession(null);
        setShareSearchText("");
        setShareUsers([]);
        setSelectedShareUser(null);
    };

    const loadShareUsers = useCallback(async () => {
        try {
            setShareSearching(true);

            const currentUser = await getCurrentUser();

            const result = await client.models.UserProfile.list({
                limit: 1000,
            });

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

                    // 自分自身は共有先候補から除外
                    return user.userId !== currentUser.userId;
                })
                .sort((a, b) => {
                    const aName = a.displayName || a.email || "";
                    const bName = b.displayName || b.email || "";

                    return aName.localeCompare(bName);
                });

            setShareUsers(users);
            setSelectedShareUser(null);
        } catch (error) {
            console.error("UserProfile list error:", error);
            Alert.alert("取得エラー", "共有先ユーザーの取得に失敗しました。");
        } finally {
            setShareSearching(false);
        }
    }, []);

    const shareSessionWithSelectedUser = async () => {
        if (!sharingSession) {
            return;
        }

        if (!selectedShareUser?.ownerValue) {
            Alert.alert("共有先未選択", "共有するユーザーを選択してください。");
            return;
        }

        try {
            setSharing(true);

            const sharedOwner = selectedShareUser.ownerValue;

            const updateResults = await Promise.all(
                sharingSession.logs.map((log) => {
                    const currentSharedOwners = log.sharedOwners ?? [];

                    const nextSharedOwners = Array.from(
                        new Set([...currentSharedOwners, sharedOwner]),
                    );

                    return client.models.LocationLog.update({
                        id: log.id,
                        sharedOwners: nextSharedOwners,
                    });
                }),
            );

            const hasErrors = updateResults.some((result) => result.errors);

            if (hasErrors) {
                console.error("Share session errors:", updateResults);
                Alert.alert("共有エラー", "位置情報の共有に失敗しました。");
                return;
            }

            setLogs((currentLogs) =>
                currentLogs.map((log) => {
                    if (
                        log.recordingSessionId !==
                        sharingSession.recordingSessionId
                    ) {
                        return log;
                    }

                    const currentSharedOwners = log.sharedOwners ?? [];

                    return {
                        ...log,
                        sharedOwners: Array.from(
                            new Set([...currentSharedOwners, sharedOwner]),
                        ),
                    };
                }),
            );

            Alert.alert("共有完了", "選択したユーザーに共有しました。");
            closeShareModal();
        } catch (error) {
            console.error("Share session error:", error);
            Alert.alert("共有エラー", "位置情報の共有に失敗しました。");
        } finally {
            setSharing(false);
        }
    };

    useFocusEffect(
        useCallback(() => {
            loadLogs();
        }, [loadLogs]),
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
                        表示件数: {filteredItems.length} / {displayItems.length}
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
                    data={filteredItems}
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
                    renderItem={({ item }) => {
                        const isDeleting = deletingId === item.id;

                        if (item.kind === "session") {
                            return (
                                <View style={styles.card}>
                                    <View style={styles.cardContent}>
                                        <View style={styles.row}>
                                            <Text style={styles.dateText}>
                                                {item.recordingSessionName}
                                            </Text>
                                        </View>

                                        <Text style={styles.memoText}>
                                            開始: {formatDateTime(item.startAt)}
                                        </Text>

                                        <Text style={styles.memoText}>
                                            終了: {formatDateTime(item.endAt)}
                                        </Text>

                                        <Text style={styles.memoText}>
                                            記録ポイント: {item.pointCount}件
                                        </Text>
                                    </View>

                                    <View style={styles.actionRow}>
                                        <Pressable
                                            style={({ pressed }) => [
                                                styles.detailButton,
                                                pressed &&
                                                    styles.detailButtonPressed,
                                            ]}
                                            onPress={() =>
                                                handleOpenSessionMap(item)
                                            }
                                        >
                                            <Text
                                                style={styles.detailButtonText}
                                            >
                                                地図で表示
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
                                            onPress={() =>
                                                handleDeleteSession(item)
                                            }
                                        >
                                            <Text
                                                style={styles.deleteButtonText}
                                            >
                                                {isDeleting
                                                    ? "削除中..."
                                                    : "削除"}
                                            </Text>
                                        </Pressable>
                                    </View>

                                    <Pressable
                                        style={({ pressed }) => [
                                            styles.shareButton,
                                            pressed &&
                                                styles.detailButtonPressed,
                                        ]}
                                        onPress={() => openShareModal(item)}
                                    >
                                        <Text style={styles.shareButtonText}>
                                            共有
                                        </Text>
                                    </Pressable>
                                </View>
                            );
                        }

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

            <Modal
                visible={shareModalVisible}
                transparent
                animationType="fade"
                onRequestClose={closeShareModal}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>
                            共有先ユーザーを選択
                        </Text>

                        {/*
                        <TextInput
                            style={styles.shareSearchInput}
                            value={shareSearchText}
                            onChangeText={setShareSearchText}
                            placeholder="ユーザー名またはメールで絞り込み"
                            autoCapitalize="none"
                            autoCorrect={false}
                            editable={!sharing}
                        /> */}

                        <ScrollView
                            style={styles.shareUserList}
                            contentContainerStyle={styles.shareUserListContent}
                            keyboardShouldPersistTaps="handled"
                        >
                            {shareSearching ? (
                                <ActivityIndicator
                                    style={{ marginVertical: 20 }}
                                />
                            ) : filteredShareUsers.length === 0 ? (
                                <Text style={styles.shareEmptyText}>
                                    共有先ユーザーが見つかりません。
                                    {"\n"}
                                    UserProfile
                                    に他のユーザーが存在するか確認してください。
                                </Text>
                            ) : (
                                filteredShareUsers.map((user) => {
                                    const selected =
                                        selectedShareUser?.id === user.id;

                                    return (
                                        <Pressable
                                            key={user.id}
                                            style={[
                                                styles.shareUserItem,
                                                selected &&
                                                    styles.shareUserItemSelected,
                                            ]}
                                            onPress={() =>
                                                setSelectedShareUser(user)
                                            }
                                            disabled={sharing}
                                        >
                                            <Text style={styles.shareUserName}>
                                                {user.displayName ||
                                                    "名前未設定"}
                                            </Text>
                                            <Text style={styles.shareUserEmail}>
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
                                onPress={closeShareModal}
                                disabled={sharing}
                            >
                                <Text style={styles.modalSecondaryButtonText}>
                                    キャンセル
                                </Text>
                            </Pressable>

                            <Pressable
                                style={[
                                    styles.modalPrimaryButton,
                                    sharing && styles.deleteButtonDisabled,
                                ]}
                                onPress={shareSessionWithSelectedUser}
                                disabled={sharing}
                            >
                                <Text style={styles.modalPrimaryButtonText}>
                                    {sharing ? "共有中..." : "共有する"}
                                </Text>
                            </Pressable>
                        </View>
                    </View>
                </View>
            </Modal>
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

function buildDisplayItems(logs: LocationLogItem[]): LocationLogDisplayItem[] {
    const sessionMap = new Map<string, LocationLogItem[]>();
    const displayItems: LocationLogDisplayItem[] = [];

    logs.forEach((log) => {
        if (log.recordingSessionId) {
            const current = sessionMap.get(log.recordingSessionId) ?? [];
            current.push(log);
            sessionMap.set(log.recordingSessionId, current);
            return;
        }

        displayItems.push({
            ...log,
            kind: "single",
            sortAt: log.recordedAt,
        });
    });

    sessionMap.forEach((sessionLogs, recordingSessionId) => {
        const sortedLogs = sessionLogs.slice().sort((a, b) => {
            return (
                new Date(a.recordedAt).getTime() -
                new Date(b.recordedAt).getTime()
            );
        });

        const startLog = sortedLogs[0];
        const endLog = sortedLogs[sortedLogs.length - 1];

        if (!startLog || !endLog) {
            return;
        }

        const recordingSessionName =
            sortedLogs
                .find((log) => log.recordingSessionName?.trim())
                ?.recordingSessionName?.trim() ?? "自動記録セッション";

        displayItems.push({
            kind: "session",
            id: `session-${recordingSessionId}`,
            recordingSessionId,
            recordingSessionName,
            logs: sortedLogs,
            startLog,
            endLog,
            startAt: startLog.recordedAt,
            endAt: endLog.recordedAt,
            pointCount: sortedLogs.length,
            sortAt: endLog.recordedAt,
        });
    });

    return displayItems.sort((a, b) => {
        return new Date(b.sortAt).getTime() - new Date(a.sortAt).getTime();
    });
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
    emptyText: {
        textAlign: "center",
        marginTop: 40,
        color: "#666",
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
    shareButton: {
        marginHorizontal: 14,
        marginBottom: 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: "#eef3f7",
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: "#c8d6e0",
    },
    shareButtonText: {
        color: "#2f4f66",
        fontSize: 13,
        fontWeight: "bold",
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
        maxHeight: "80%",
        borderRadius: 12,
        padding: 18,
        backgroundColor: "#fff",
    },
    modalTitle: {
        fontSize: 18,
        fontWeight: "bold",
        marginBottom: 12,
    },
    shareSearchInput: {
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
    searchButton: {
        backgroundColor: "#4b6f8f",
        borderRadius: 8,
        paddingVertical: 10,
        alignItems: "center",
    },
    searchButtonText: {
        color: "#fff",
        fontSize: 14,
        fontWeight: "bold",
    },
    shareUserList: {
        marginTop: 10,
        minHeight: 160,
        maxHeight: 260,
        borderWidth: 1,
        borderColor: "#c8d6e0",
        borderRadius: 8,
        backgroundColor: "#f9fbfd",
    },
    shareUserListContent: {
        padding: 8,
    },
    shareEmptyText: {
        textAlign: "center",
        color: "#777",
        paddingVertical: 20,
    },
    shareUserItem: {
        padding: 10,
        borderWidth: 1,
        borderColor: "#ddd",
        borderRadius: 8,
        marginBottom: 8,
        backgroundColor: "#fff",
    },
    shareUserItemSelected: {
        borderColor: "#4b6f8f",
        backgroundColor: "#eef3f7",
    },
    shareUserName: {
        fontSize: 15,
        fontWeight: "bold",
        color: "#333",
    },
    shareUserEmail: {
        marginTop: 2,
        fontSize: 12,
        color: "#666",
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
});
