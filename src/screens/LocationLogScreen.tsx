import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { getCurrentUser } from "aws-amplify/auth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    FlatList,
    KeyboardAvoidingView,
    Modal,
    Platform,
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
    userId: string;
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    recordedAt: string;
    memo?: string | null;
    recordingSessionId?: string | null;
    recordingSessionName?: string | null;
    sharedOwners?: string[] | null;

    batteryLevel?: number | null;
    batteryState?: string | null;
    lowPowerMode?: boolean | null;
};

type RecordingSessionDisplayItem = {
    kind: "session";
    id: string;
    userId: string;
    recordingSessionId: string;
    recordingSessionName: string;
    startAt: string;
    endAt: string;
    distanceMeters: number;
    pointCount: number;
    sharedOwners: string[];
    sortAt: string;
};

type UserProfileItem = {
    id: string;
    userId: string;
    email?: string | null;
    displayName?: string | null;
    ownerValue?: string | null;
    searchText?: string | null;
};

type LocationLogListResult = {
    data?: any[] | null;
    errors?: unknown;
    nextToken?: string | null;
};

type RecordingSessionListResult = {
    data?: any[] | null;
    errors?: unknown;
    nextToken?: string | null;
};

const SESSION_PAGE_SIZE = 15;

export default function LocationLogScreen({ navigation }: Props) {
    const [loading, setLoading] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [searchText, setSearchText] = useState("");
    const [userProfiles, setUserProfiles] = useState<UserProfileItem[]>([]);
    const [recordingSessions, setRecordingSessions] = useState<
        RecordingSessionDisplayItem[]
    >([]);
    const [recordingSessionNextToken, setRecordingSessionNextToken] = useState<
        string | null
    >(null);
    const [loadingMore, setLoadingMore] = useState(false);

    const [shareModalVisible, setShareModalVisible] = useState(false);
    const [shareSearchText, setShareSearchText] = useState("");
    const [shareUsers, setShareUsers] = useState<UserProfileItem[]>([]);
    const [selectedShareUser, setSelectedShareUser] =
        useState<UserProfileItem | null>(null);
    const [sharingSession, setSharingSession] =
        useState<RecordingSessionDisplayItem | null>(null);
    const [shareSearching, setShareSearching] = useState(false);
    const [sharing, setSharing] = useState(false);

    const [editNameModalVisible, setEditNameModalVisible] = useState(false);
    const [editingSession, setEditingSession] =
        useState<RecordingSessionDisplayItem | null>(null);
    const [editSessionNameInput, setEditSessionNameInput] = useState("");
    const [savingEditSessionName, setSavingEditSessionName] = useState(false);

    const editSessionNameInputRef = useRef<TextInput | null>(null);

    const loadRecordingSessions = useCallback(
        async ({
            reset,
            nextToken,
        }: {
            reset: boolean;
            nextToken?: string | null;
        }) => {
            try {
                if (reset) {
                    setLoading(true);
                } else {
                    setLoadingMore(true);
                }

                const recordingSessionModel = client.models
                    .RecordingSession as any;

                const listParams: {
                    limit: number;
                    nextToken?: string;
                } = {
                    limit: SESSION_PAGE_SIZE,
                };

                if (!reset && nextToken) {
                    listParams.nextToken = nextToken;
                }

                const result = (await recordingSessionModel.list(
                    listParams,
                )) as RecordingSessionListResult;

                if (result.errors) {
                    console.error(
                        "RecordingSession list errors:",
                        result.errors,
                    );
                    Alert.alert(
                        "取得エラー",
                        "セッション履歴を取得できませんでした。",
                    );
                    return;
                }

                const nextItems: RecordingSessionDisplayItem[] = (
                    result.data ?? []
                )
                    .map((item: any) => ({
                        kind: "session" as const,
                        id: item.id,
                        userId: item.userId ?? "",
                        recordingSessionId: item.recordingSessionId,
                        recordingSessionName:
                            item.recordingSessionName ?? "自動記録セッション",
                        startAt: item.startedAt,
                        endAt: item.endedAt,
                        distanceMeters: Number(item.distanceMeters ?? 0),
                        pointCount: Number(item.pointCount ?? 0),
                        sharedOwners: Array.isArray(item.sharedOwners)
                            ? item.sharedOwners.filter(
                                  (owner: unknown): owner is string =>
                                      typeof owner === "string" &&
                                      owner.length > 0,
                              )
                            : [],
                        sortAt: item.endedAt,
                    }))
                    .filter(
                        (item) =>
                            !!item.recordingSessionId &&
                            !!item.startAt &&
                            !!item.endAt,
                    )
                    .sort(
                        (a, b) =>
                            new Date(b.endAt).getTime() -
                            new Date(a.endAt).getTime(),
                    );

                setRecordingSessions((current) =>
                    reset ? nextItems : [...current, ...nextItems],
                );

                setRecordingSessionNextToken(result.nextToken ?? null);
            } catch (error) {
                console.error("RecordingSession load error:", error);
                Alert.alert(
                    "取得エラー",
                    "セッション履歴の取得に失敗しました。",
                );
            } finally {
                setLoading(false);
                setLoadingMore(false);
            }
        },
        [],
    );

    const loadUserProfiles = useCallback(async () => {
        try {
            const userProfileModel = client.models.UserProfile as any;

            const result = await userProfileModel.list({
                limit: 1000,
            });

            if (result.errors) {
                console.error("UserProfile list errors:", result.errors);
                return;
            }

            const profiles: UserProfileItem[] = (result.data ?? []).map(
                (profile: any) => ({
                    id: profile.id,
                    userId: profile.userId,
                    email: profile.email ?? null,
                    displayName: profile.displayName ?? null,
                    ownerValue: profile.ownerValue ?? null,
                    searchText: profile.searchText ?? null,
                }),
            );

            setUserProfiles(profiles);
        } catch (error) {
            console.error("UserProfile load error:", error);
        }
    }, []);

    const clearSearchText = () => {
        setSearchText("");
    };

    const userNameMap = useMemo(() => {
        const map = new Map<string, string>();

        userProfiles.forEach((profile) => {
            const name =
                profile.displayName?.trim() ||
                profile.email?.trim() ||
                "ユーザー";

            if (profile.userId) {
                map.set(profile.userId, name);
            }
        });

        return map;
    }, [userProfiles]);

    const getUserDisplayName = useCallback(
        (userId: string) => {
            return userNameMap.get(userId) ?? "ユーザー";
        },
        [userNameMap],
    );

    const filteredItems = useMemo(() => {
        const keyword = searchText.trim().toLowerCase();

        if (!keyword) {
            return recordingSessions;
        }

        return recordingSessions.filter((item) => {
            return (
                item.recordingSessionName.toLowerCase().includes(keyword) ||
                item.recordingSessionId.toLowerCase().includes(keyword)
            );
        });
    }, [recordingSessions, searchText]);

    const hasMoreItems =
        searchText.trim().length === 0 && recordingSessionNextToken !== null;

    const loadMoreItems = useCallback(() => {
        if (loadingMore || !recordingSessionNextToken) {
            return;
        }

        void loadRecordingSessions({
            reset: false,
            nextToken: recordingSessionNextToken,
        });
    }, [loadingMore, recordingSessionNextToken, loadRecordingSessions]);

    const handleRefresh = useCallback(() => {
        setRecordingSessionNextToken(null);

        void loadRecordingSessions({
            reset: true,
            nextToken: null,
        });
    }, [loadRecordingSessions]);

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

    const handleOpenSessionMap = (item: RecordingSessionDisplayItem) => {
        navigation.push("LocationMap", {
            recordingSessionId: item.recordingSessionId,
        });
    };

    const listLocationLogsBySessionId = useCallback(
        async (recordingSessionId: string): Promise<LocationLogItem[]> => {
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

            return allData
                .map(
                    (log: any): LocationLogItem => ({
                        id: log.id,
                        userId: log.userId ?? "",
                        latitude: Number(log.latitude),
                        longitude: Number(log.longitude),
                        accuracy: log.accuracy ?? null,
                        recordedAt: log.recordedAt,
                        memo: log.memo ?? null,
                        recordingSessionId: log.recordingSessionId ?? null,
                        recordingSessionName: log.recordingSessionName ?? null,
                        sharedOwners: Array.isArray(log.sharedOwners)
                            ? log.sharedOwners.filter(
                                  (owner: unknown): owner is string =>
                                      typeof owner === "string" &&
                                      owner.length > 0,
                              )
                            : [],
                        batteryLevel:
                            log.batteryLevel !== null &&
                            log.batteryLevel !== undefined
                                ? Number(log.batteryLevel)
                                : null,
                        batteryState: log.batteryState ?? null,
                        lowPowerMode: log.lowPowerMode ?? null,
                    }),
                )
                .filter(
                    (log: LocationLogItem) =>
                        Number.isFinite(log.latitude) &&
                        Number.isFinite(log.longitude),
                );
        },
        [],
    );

    const handleDeleteSession = (item: RecordingSessionDisplayItem) => {
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

    const deleteSession = async (item: RecordingSessionDisplayItem) => {
        try {
            setDeletingId(item.id);

            const sessionLogs = await listLocationLogsBySessionId(
                item.recordingSessionId,
            );

            const locationLogDeleteResults = await Promise.all(
                sessionLogs.map((log: LocationLogItem) =>
                    client.models.LocationLog.delete({
                        id: log.id,
                    }),
                ),
            );

            const hasLocationLogErrors = locationLogDeleteResults.some(
                (result) => result.errors,
            );

            if (hasLocationLogErrors) {
                console.error(
                    "LocationLog session delete errors:",
                    locationLogDeleteResults,
                );
                Alert.alert(
                    "削除エラー",
                    "自動記録セッションを削除できませんでした。",
                );
                return;
            }

            const recordingSessionModel = client.models.RecordingSession as any;

            const recordingSessionDeleteResult =
                await recordingSessionModel.delete({
                    id: item.id,
                });

            if (recordingSessionDeleteResult.errors) {
                console.error(
                    "RecordingSession delete errors:",
                    recordingSessionDeleteResult.errors,
                );
                Alert.alert(
                    "一部削除エラー",
                    "位置履歴は削除しましたが、セッション集計情報の削除に失敗しました。",
                );
                return;
            }

            setRecordingSessions((currentSessions) =>
                currentSessions.filter((session) => session.id !== item.id),
            );
        } catch (error) {
            console.error("RecordingSession delete error:", error);
            Alert.alert(
                "削除エラー",
                "自動記録セッションの削除に失敗しました。",
            );
        } finally {
            setDeletingId(null);
        }
    };

    const openShareModal = (item: RecordingSessionDisplayItem) => {
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

    const openEditNameModal = (item: RecordingSessionDisplayItem) => {
        setEditingSession(item);
        setEditSessionNameInput(item.recordingSessionName);
        setEditNameModalVisible(true);
    };

    const closeEditNameModal = () => {
        if (savingEditSessionName) {
            return;
        }

        setEditNameModalVisible(false);
        setEditingSession(null);
        setEditSessionNameInput("");
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

            const sessionLogs = await listLocationLogsBySessionId(
                sharingSession.recordingSessionId,
            );

            const updateResults = await Promise.all(
                sessionLogs.map((log: LocationLogItem) => {
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

            const recordingSessionModel = client.models.RecordingSession as any;

            const currentSessionSharedOwners =
                sharingSession.sharedOwners ?? [];

            const nextSessionSharedOwners = Array.from(
                new Set([...currentSessionSharedOwners, sharedOwner]),
            );

            const recordingSessionUpdateResult =
                await recordingSessionModel.update({
                    id: sharingSession.id,
                    sharedOwners: nextSessionSharedOwners,
                });

            if (recordingSessionUpdateResult.errors) {
                console.error(
                    "RecordingSession share update errors:",
                    recordingSessionUpdateResult.errors,
                );
            }

            setRecordingSessions((currentSessions) =>
                currentSessions.map((session) => {
                    if (session.id !== sharingSession.id) {
                        return session;
                    }

                    return {
                        ...session,
                        sharedOwners: nextSessionSharedOwners,
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

    const saveEditedSessionName = async () => {
        if (!editingSession) {
            return;
        }

        const trimmedName = editSessionNameInput.trim();
        const nextSessionName = trimmedName || "自動記録セッション";

        try {
            setSavingEditSessionName(true);

            const recordingSessionModel = client.models.RecordingSession as any;

            const recordingSessionUpdateResult =
                await recordingSessionModel.update({
                    id: editingSession.id,
                    recordingSessionName: nextSessionName,
                });

            if (recordingSessionUpdateResult.errors) {
                console.error(
                    "RecordingSession name update errors:",
                    recordingSessionUpdateResult.errors,
                );
                Alert.alert(
                    "保存エラー",
                    "セッション名を更新できませんでした。",
                );
                return;
            }

            const sessionLogs = await listLocationLogsBySessionId(
                editingSession.recordingSessionId,
            );

            const locationLogModel = client.models.LocationLog as any;

            const locationLogUpdateResults = await Promise.all(
                sessionLogs.map((log: LocationLogItem) =>
                    locationLogModel.update({
                        id: log.id,
                        recordingSessionName: nextSessionName,
                    }),
                ),
            );

            const hasLocationLogErrors = locationLogUpdateResults.some(
                (result) => result.errors,
            );

            if (hasLocationLogErrors) {
                console.error(
                    "LocationLog session name update errors:",
                    locationLogUpdateResults,
                );
            }

            setRecordingSessions((currentSessions) =>
                currentSessions.map((session) => {
                    if (session.id !== editingSession.id) {
                        return session;
                    }

                    return {
                        ...session,
                        recordingSessionName: nextSessionName,
                    };
                }),
            );

            Alert.alert("保存完了", "セッション名を更新しました。");
            closeEditNameModal();
        } catch (error) {
            console.error("Edit session name error:", error);
            Alert.alert("保存エラー", "セッション名の更新に失敗しました。");
        } finally {
            setSavingEditSessionName(false);
        }
    };

    useEffect(() => {
        if (!editNameModalVisible) {
            return;
        }

        const timerId = setTimeout(() => {
            editSessionNameInputRef.current?.focus();
        }, 300);

        return () => {
            clearTimeout(timerId);
        };
    }, [editNameModalVisible]);

    useFocusEffect(
        useCallback(() => {
            setRecordingSessionNextToken(null);

            void loadRecordingSessions({
                reset: true,
                nextToken: null,
            });

            void loadUserProfiles();
        }, [loadRecordingSessions, loadUserProfiles]),
    );

    return (
        <View style={styles.container}>
            <View style={styles.searchBox}>
                <Text style={styles.searchLabel}>セッション検索</Text>

                <TextInput
                    style={styles.searchInput}
                    value={searchText}
                    onChangeText={setSearchText}
                    placeholder="セッション名で検索"
                    autoCapitalize="none"
                    autoCorrect={false}
                />

                <View style={styles.searchInfoRow}>
                    <Text style={styles.searchInfoText}>
                        表示件数: {filteredItems.length}
                    </Text>

                    {searchText.trim().length > 0 && (
                        <Pressable onPress={clearSearchText}>
                            <Text style={styles.clearText}>クリア</Text>
                        </Pressable>
                    )}
                </View>
            </View>

            {loading && recordingSessions.length === 0 ? (
                <ActivityIndicator />
            ) : (
                <FlatList
                    data={filteredItems}
                    keyExtractor={(item) => item.id}
                    refreshControl={
                        <RefreshControl
                            refreshing={loading}
                            onRefresh={handleRefresh}
                        />
                    }
                    ListEmptyComponent={
                        <Text style={styles.emptyText}>
                            {searchText.trim().length > 0
                                ? "検索条件に一致するセッション履歴がありません。"
                                : "まだセッション履歴がありません。"}
                        </Text>
                    }
                    ListFooterComponent={
                        hasMoreItems ? (
                            <Pressable
                                style={({ pressed }) => [
                                    styles.loadMoreButton,
                                    pressed && styles.loadMoreButtonPressed,
                                    loadingMore && styles.deleteButtonDisabled,
                                ]}
                                onPress={loadMoreItems}
                                disabled={loadingMore}
                            >
                                <Text style={styles.loadMoreButtonText}>
                                    {loadingMore
                                        ? "読み込み中..."
                                        : "もっと見る"}
                                </Text>
                                <Text style={styles.loadMoreSubText}>
                                    次の{SESSION_PAGE_SIZE}件を取得
                                </Text>
                            </Pressable>
                        ) : filteredItems.length > 0 ? (
                            <Text style={styles.listEndText}>
                                すべてのセッション履歴を表示しました。
                            </Text>
                        ) : null
                    }
                    renderItem={({ item }) => {
                        const isDeleting = deletingId === item.id;

                        return (
                            <View style={styles.card}>
                                <View style={styles.cardContent}>
                                    <View style={styles.row}>
                                        <Text style={styles.dateText}>
                                            {item.recordingSessionName}
                                        </Text>
                                    </View>

                                    <Text style={styles.memoText}>
                                        ユーザー:{" "}
                                        {getUserDisplayName(item.userId)}
                                    </Text>

                                    <Text style={styles.memoText}>
                                        期間:{" "}
                                        {formatPeriod(item.startAt, item.endAt)}
                                    </Text>

                                    <View style={styles.sessionStatsRow}>
                                        <Text
                                            style={[
                                                styles.memoText,
                                                styles.sessionStatsText,
                                            ]}
                                        >
                                            距離:{" "}
                                            {formatDistance(
                                                item.distanceMeters,
                                            )}
                                        </Text>

                                        <Text
                                            style={[
                                                styles.memoText,
                                                styles.sessionStatsText,
                                            ]}
                                        >
                                            記録ポイント: {item.pointCount}件
                                        </Text>
                                    </View>
                                </View>

                                <View style={styles.sessionActionRow}>
                                    <Pressable
                                        style={({ pressed }) => [
                                            styles.sessionActionButton,
                                            pressed &&
                                                styles.detailButtonPressed,
                                        ]}
                                        onPress={() =>
                                            handleOpenSessionMap(item)
                                        }
                                        disabled={isDeleting}
                                    >
                                        <Text
                                            style={
                                                styles.sessionActionButtonText
                                            }
                                            numberOfLines={1}
                                            adjustsFontSizeToFit
                                        >
                                            地図で表示
                                        </Text>
                                    </Pressable>

                                    <Pressable
                                        style={({ pressed }) => [
                                            styles.sessionActionButton,
                                            pressed &&
                                                styles.detailButtonPressed,
                                        ]}
                                        onPress={() => openEditNameModal(item)}
                                        disabled={isDeleting}
                                    >
                                        <Text
                                            style={
                                                styles.sessionActionButtonText
                                            }
                                            numberOfLines={1}
                                            adjustsFontSizeToFit
                                        >
                                            タイトル変更
                                        </Text>
                                    </Pressable>

                                    <Pressable
                                        style={({ pressed }) => [
                                            styles.sessionActionButton,
                                            pressed &&
                                                styles.detailButtonPressed,
                                        ]}
                                        onPress={() => openShareModal(item)}
                                        disabled={isDeleting}
                                    >
                                        <Text
                                            style={
                                                styles.sessionActionButtonText
                                            }
                                            numberOfLines={1}
                                            adjustsFontSizeToFit
                                        >
                                            共有
                                        </Text>
                                    </Pressable>

                                    <Pressable
                                        style={({ pressed }) => [
                                            styles.sessionDeleteButton,
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
                                            style={
                                                styles.sessionDeleteButtonText
                                            }
                                            numberOfLines={1}
                                            adjustsFontSizeToFit
                                        >
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

                        <TextInput
                            style={styles.shareSearchInput}
                            value={shareSearchText}
                            onChangeText={setShareSearchText}
                            placeholder="ユーザー名またはメールで絞り込み"
                            autoCapitalize="none"
                            autoCorrect={false}
                            editable={!sharing}
                        />

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

            <Modal
                visible={editNameModalVisible}
                transparent
                animationType="fade"
                onRequestClose={closeEditNameModal}
            >
                <KeyboardAvoidingView
                    style={styles.modalKeyboardAvoidingView}
                    behavior={Platform.OS === "ios" ? "padding" : "height"}
                >
                    <View style={styles.modalOverlay}>
                        <View style={styles.modalContent}>
                            <Text style={styles.modalTitle}>
                                セッション名を編集
                            </Text>

                            <Text style={styles.modalDescription}>
                                この自動記録セッションの名前を変更します。
                            </Text>

                            <TextInput
                                ref={editSessionNameInputRef}
                                style={styles.sessionNameInput}
                                value={editSessionNameInput}
                                onChangeText={setEditSessionNameInput}
                                placeholder="例：朝のランニング"
                                autoCapitalize="none"
                                autoCorrect={false}
                                editable={!savingEditSessionName}
                                autoFocus
                                returnKeyType="done"
                                onSubmitEditing={saveEditedSessionName}
                            />

                            <View style={styles.modalButtonRow}>
                                <Pressable
                                    style={[
                                        styles.modalSecondaryButton,
                                        savingEditSessionName &&
                                            styles.deleteButtonDisabled,
                                    ]}
                                    onPress={closeEditNameModal}
                                    disabled={savingEditSessionName}
                                >
                                    <Text
                                        style={styles.modalSecondaryButtonText}
                                    >
                                        キャンセル
                                    </Text>
                                </Pressable>

                                <Pressable
                                    style={[
                                        styles.modalPrimaryButton,
                                        savingEditSessionName &&
                                            styles.deleteButtonDisabled,
                                    ]}
                                    onPress={saveEditedSessionName}
                                    disabled={savingEditSessionName}
                                >
                                    <Text style={styles.modalPrimaryButtonText}>
                                        {savingEditSessionName
                                            ? "保存中..."
                                            : "保存"}
                                    </Text>
                                </Pressable>
                            </View>
                        </View>
                    </View>
                </KeyboardAvoidingView>
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

function formatDate(value: string) {
    const date = new Date(value);

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd}`;
}

function formatTime(value: string) {
    const date = new Date(value);

    const hh = String(date.getHours()).padStart(2, "0");
    const mi = String(date.getMinutes()).padStart(2, "0");

    return `${hh}:${mi}`;
}

function formatPeriod(startValue: string, endValue: string) {
    const startDate = formatDate(startValue);
    const endDate = formatDate(endValue);
    const durationText = formatDuration(startValue, endValue);

    if (startDate === endDate) {
        return `${startDate} ${formatTime(startValue)} - ${formatTime(
            endValue,
        )}（${durationText}）`;
    }

    return `${formatDateTime(startValue)} - ${formatDateTime(
        endValue,
    )}（${durationText}）`;
}

function formatDuration(startValue: string, endValue: string) {
    const startTime = new Date(startValue).getTime();
    const endTime = new Date(endValue).getTime();

    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
        return "--:--";
    }

    const diffMs = Math.max(0, endTime - startTime);
    const totalMinutes = Math.floor(diffMs / 1000 / 60);

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    const mm = String(minutes).padStart(2, "0");

    return `${hours}h:${mm}m`;
}

function formatDistance(value: number) {
    if (!Number.isFinite(value)) {
        return "-";
    }

    if (value >= 1000) {
        return `${(value / 1000).toFixed(2)}km`;
    }

    return `${Math.round(value)}m`;
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
        gap: 0,
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
        marginTop: 0,
        color: "#333",
    },
    sessionStatsRow: {
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 12,
        marginTop: 4,
    },
    sessionStatsText: {
        marginTop: 0,
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
    sessionActionRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 14,
        paddingBottom: 12,
    },

    sessionActionButton: {
        flex: 1,
        minWidth: 0,
        paddingVertical: 9,
        paddingHorizontal: 4,
        borderRadius: 8,
        backgroundColor: "#e6edf3",
        alignItems: "center",
        justifyContent: "center",
    },

    sessionActionButtonText: {
        color: "#2f4f66",
        fontSize: 12,
        fontWeight: "bold",
    },

    sessionDeleteButton: {
        flex: 1,
        minWidth: 0,
        paddingVertical: 9,
        paddingHorizontal: 4,
        borderRadius: 8,
        backgroundColor: "#4b6f8f",
        alignItems: "center",
        justifyContent: "center",
    },

    sessionDeleteButtonText: {
        color: "#fff",
        fontSize: 12,
        fontWeight: "bold",
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
    modalDescription: {
        fontSize: 13,
        color: "#555",
        marginBottom: 10,
    },
    sessionNameInput: {
        height: 44,
        borderWidth: 1,
        borderColor: "#ccc",
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 0,
        fontSize: 16,
        backgroundColor: "#fff",
    },
    modalKeyboardAvoidingView: {
        flex: 1,
    },
    loadMoreButton: {
        marginTop: 8,
        marginBottom: 24,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderRadius: 8,
        backgroundColor: "#e6edf3",
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: "#c8d6e0",
    },

    loadMoreButtonPressed: {
        opacity: 0.75,
    },

    loadMoreButtonText: {
        color: "#2f4f66",
        fontSize: 15,
        fontWeight: "bold",
    },

    loadMoreSubText: {
        marginTop: 2,
        color: "#666",
        fontSize: 12,
    },

    listEndText: {
        textAlign: "center",
        color: "#777",
        fontSize: 13,
        marginTop: 8,
        marginBottom: 24,
    },
});
