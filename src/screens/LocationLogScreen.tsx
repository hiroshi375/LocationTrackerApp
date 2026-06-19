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

type LocationLogSingleDisplayItem = LocationLogItem & {
    kind: "single";
    sortAt: string;
};

type LocationLogSessionDisplayItem = {
    kind: "session";
    id: string;
    userId: string;
    recordingSessionId: string;
    recordingSessionName: string;
    logs: LocationLogItem[];
    startLog: LocationLogItem;
    endLog: LocationLogItem;
    startAt: string;
    endAt: string;
    distanceMeters: number;
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

export default function LocationLogScreen({ navigation }: Props) {
    const [logs, setLogs] = useState<LocationLogItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [searchText, setSearchText] = useState("");

    const [userProfiles, setUserProfiles] = useState<UserProfileItem[]>([]);

    const [shareModalVisible, setShareModalVisible] = useState(false);
    const [shareSearchText, setShareSearchText] = useState("");
    const [shareUsers, setShareUsers] = useState<UserProfileItem[]>([]);
    const [selectedShareUser, setSelectedShareUser] =
        useState<UserProfileItem | null>(null);
    const [sharingSession, setSharingSession] =
        useState<LocationLogSessionDisplayItem | null>(null);
    const [shareSearching, setShareSearching] = useState(false);
    const [sharing, setSharing] = useState(false);

    const [editNameModalVisible, setEditNameModalVisible] = useState(false);
    const [editingSession, setEditingSession] =
        useState<LocationLogSessionDisplayItem | null>(null);
    const [editSessionNameInput, setEditSessionNameInput] = useState("");
    const [savingEditSessionName, setSavingEditSessionName] = useState(false);

    const loadLogs = useCallback(async () => {
        try {
            setLoading(true);

            const allData: any[] = [];
            let nextToken: string | null = null;

            const locationLogModel = client.models.LocationLog as any;

            do {
                const listParams: {
                    limit: number;
                    nextToken?: string;
                } = {
                    limit: 1000,
                };

                if (nextToken) {
                    listParams.nextToken = nextToken;
                }

                const result = (await locationLogModel.list(
                    listParams,
                )) as LocationLogListResult;

                if (result.errors) {
                    console.error("LocationLog list errors:", result.errors);
                    return;
                }

                allData.push(...(result.data ?? []));
                nextToken = result.nextToken ?? null;
            } while (nextToken);

            const items = allData
                .map((item) => ({
                    id: item.id,
                    userId: item.userId ?? "",
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

                    batteryLevel:
                        item.batteryLevel !== null &&
                        item.batteryLevel !== undefined
                            ? Number(item.batteryLevel)
                            : null,
                    batteryState: item.batteryState ?? null,
                    lowPowerMode: item.lowPowerMode ?? null,
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
            userId: item.endLog.userId,
            latitude: item.endLog.latitude,
            longitude: item.endLog.longitude,
            accuracy: item.endLog.accuracy ?? null,
            recordedAt: item.endLog.recordedAt,
            memo: item.endLog.memo ?? null,
            recordingSessionId: item.recordingSessionId,
            recordingSessionName: item.recordingSessionName,
            sharedOwners: item.endLog.sharedOwners ?? [],
            batteryLevel: item.endLog.batteryLevel ?? null,
            batteryState: item.endLog.batteryState ?? null,
            lowPowerMode: item.endLog.lowPowerMode ?? null,
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

    const deleteRecordingSessionSummaries = async (
        recordingSessionId: string,
    ) => {
        try {
            const recordingSessionModel = client.models.RecordingSession as any;

            const summaries: any[] = [];
            let nextToken: string | null = null;

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

                const result = (await recordingSessionModel.list(
                    listParams,
                )) as RecordingSessionListResult;

                if (result.errors) {
                    console.error(
                        "RecordingSession list errors:",
                        result.errors,
                    );
                    return false;
                }

                summaries.push(...(result.data ?? []));
                nextToken = result.nextToken ?? null;
            } while (nextToken);

            if (summaries.length === 0) {
                return true;
            }

            const deleteResults = await Promise.all(
                summaries.map((summary) =>
                    recordingSessionModel.delete({
                        id: summary.id,
                    }),
                ),
            );

            const hasErrors = deleteResults.some((result) => result.errors);

            if (hasErrors) {
                console.error("RecordingSession delete errors:", deleteResults);
                return false;
            }

            return true;
        } catch (error) {
            console.error("RecordingSession delete error:", error);
            return false;
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

            const recordingSessionDeleted =
                await deleteRecordingSessionSummaries(item.recordingSessionId);

            if (!recordingSessionDeleted) {
                Alert.alert(
                    "一部削除エラー",
                    "位置履歴は削除しましたが、セッション集計情報の削除に失敗しました。",
                );
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

    const openEditNameModal = (item: LocationLogSessionDisplayItem) => {
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

            const recordingSessionModel = client.models.RecordingSession as any;

            const recordingSessionResult = (await recordingSessionModel.list({
                filter: {
                    recordingSessionId: {
                        eq: sharingSession.recordingSessionId,
                    },
                },
                limit: 1000,
            })) as RecordingSessionListResult;

            if (recordingSessionResult.errors) {
                console.error(
                    "RecordingSession share list errors:",
                    recordingSessionResult.errors,
                );
            } else {
                const recordingSessions = recordingSessionResult.data ?? [];

                const recordingSessionUpdateResults = await Promise.all(
                    recordingSessions.map((session: any) => {
                        const currentSharedOwners = Array.isArray(
                            session.sharedOwners,
                        )
                            ? session.sharedOwners.filter(
                                  (owner: unknown): owner is string =>
                                      typeof owner === "string" &&
                                      owner.length > 0,
                              )
                            : [];

                        const nextSharedOwners = Array.from(
                            new Set([...currentSharedOwners, sharedOwner]),
                        );

                        return recordingSessionModel.update({
                            id: session.id,
                            sharedOwners: nextSharedOwners,
                        });
                    }),
                );

                const hasRecordingSessionErrors =
                    recordingSessionUpdateResults.some(
                        (result) => result.errors,
                    );

                if (hasRecordingSessionErrors) {
                    console.error(
                        "RecordingSession share update errors:",
                        recordingSessionUpdateResults,
                    );
                }
            }

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

    const saveEditedSessionName = async () => {
        if (!editingSession) {
            return;
        }

        const trimmedName = editSessionNameInput.trim();
        const nextSessionName = trimmedName || "自動記録セッション";

        try {
            setSavingEditSessionName(true);

            const locationLogModel = client.models.LocationLog as any;
            const recordingSessionModel = client.models.RecordingSession as any;

            const locationLogUpdateResults = await Promise.all(
                editingSession.logs.map((log) =>
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
                Alert.alert(
                    "保存エラー",
                    "LocationLog のセッション名を更新できませんでした。",
                );
                return;
            }

            const recordingSessionResult = (await recordingSessionModel.list({
                filter: {
                    recordingSessionId: {
                        eq: editingSession.recordingSessionId,
                    },
                },
                limit: 1000,
            })) as RecordingSessionListResult;

            if (recordingSessionResult.errors) {
                console.error(
                    "RecordingSession list errors:",
                    recordingSessionResult.errors,
                );
            } else {
                const recordingSessions = recordingSessionResult.data ?? [];

                const recordingSessionUpdateResults = await Promise.all(
                    recordingSessions.map((session: any) =>
                        recordingSessionModel.update({
                            id: session.id,
                            recordingSessionName: nextSessionName,
                        }),
                    ),
                );

                const hasRecordingSessionErrors =
                    recordingSessionUpdateResults.some(
                        (result) => result.errors,
                    );

                if (hasRecordingSessionErrors) {
                    console.error(
                        "RecordingSession name update errors:",
                        recordingSessionUpdateResults,
                    );
                    Alert.alert(
                        "保存エラー",
                        "RecordingSession のセッション名を更新できませんでした。",
                    );
                    return;
                }
            }

            setLogs((currentLogs) =>
                currentLogs.map((log) => {
                    if (
                        log.recordingSessionId !==
                        editingSession.recordingSessionId
                    ) {
                        return log;
                    }

                    return {
                        ...log,
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

    useFocusEffect(
        useCallback(() => {
            void loadLogs();
            void loadUserProfiles();
        }, [loadLogs, loadUserProfiles]),
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
                                ? "検索条件に一致するセッション履歴がありません。"
                                : "まだセッション履歴がありません。"}
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
                                            ユーザー:{" "}
                                            {getUserDisplayName(item.userId)}
                                        </Text>
                                        <Text style={styles.memoText}>
                                            期間:{" "}
                                            {formatPeriod(
                                                item.startAt,
                                                item.endAt,
                                            )}
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
                                                記録ポイント: {item.pointCount}
                                                件
                                            </Text>
                                        </View>

                                        <Text style={styles.memoText}>
                                            {formatSessionBatterySummary(
                                                item.startLog.batteryLevel,
                                                item.endLog.batteryLevel,
                                                item.endLog.batteryState,
                                                item.endLog.lowPowerMode,
                                            )}
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
                                                styles.detailButton,
                                                pressed &&
                                                    styles.detailButtonPressed,
                                            ]}
                                            onPress={() =>
                                                openEditNameModal(item)
                                            }
                                            disabled={isDeleting}
                                        >
                                            <Text
                                                style={styles.detailButtonText}
                                            >
                                                タイトル変更
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
                                    <Text style={styles.memoText}>
                                        ユーザー:{" "}
                                        {getUserDisplayName(item.userId)}
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
                                    <Text style={styles.memoText}>
                                        {formatSingleBatterySummary(
                                            item.batteryLevel,
                                            item.batteryState,
                                            item.lowPowerMode,
                                        )}
                                    </Text>
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
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>
                            セッション名を編集
                        </Text>

                        <Text style={styles.modalDescription}>
                            この自動記録セッションの名前を変更します。
                        </Text>

                        <TextInput
                            style={styles.sessionNameInput}
                            value={editSessionNameInput}
                            onChangeText={setEditSessionNameInput}
                            placeholder="例：朝のランニング"
                            autoCapitalize="none"
                            autoCorrect={false}
                            editable={!savingEditSessionName}
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
                                <Text style={styles.modalSecondaryButtonText}>
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

    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");

    return `${hh}:${mm}`;
}

function calculateDistanceMeters(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
) {
    const earthRadiusMeters = 6371000;

    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadians(lat1)) *
            Math.cos(toRadians(lat2)) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return earthRadiusMeters * c;
}

function calculateRouteDistanceMeters(logs: LocationLogItem[]) {
    if (logs.length < 2) {
        return 0;
    }

    return logs.reduce((total, currentLog, index) => {
        if (index === 0) {
            return total;
        }

        const previousLog = logs[index - 1];

        if (
            !Number.isFinite(previousLog.latitude) ||
            !Number.isFinite(previousLog.longitude) ||
            !Number.isFinite(currentLog.latitude) ||
            !Number.isFinite(currentLog.longitude)
        ) {
            return total;
        }

        const distance = calculateDistanceMeters(
            previousLog.latitude,
            previousLog.longitude,
            currentLog.latitude,
            currentLog.longitude,
        );

        if (distance < 3) {
            return total;
        }

        return total + distance;
    }, 0);
}

function toRadians(value: number) {
    return (value * Math.PI) / 180;
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

function buildDisplayItems(logs: LocationLogItem[]): LocationLogDisplayItem[] {
    const sessionMap = new Map<string, LocationLogItem[]>();
    const displayItems: LocationLogDisplayItem[] = [];

    logs.forEach((log) => {
        if (!log.recordingSessionId) {
            return;
        }

        const current = sessionMap.get(log.recordingSessionId) ?? [];
        current.push(log);
        sessionMap.set(log.recordingSessionId, current);
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

        const distanceMeters = calculateRouteDistanceMeters(sortedLogs);

        displayItems.push({
            kind: "session",
            id: `session-${recordingSessionId}`,
            userId: startLog.userId,
            recordingSessionId,
            recordingSessionName,
            logs: sortedLogs,
            startLog,
            endLog,
            startAt: startLog.recordedAt,
            endAt: endLog.recordedAt,
            distanceMeters,
            pointCount: sortedLogs.length,
            sortAt: endLog.recordedAt,
        });
    });

    return displayItems.sort((a, b) => {
        return new Date(b.sortAt).getTime() - new Date(a.sortAt).getTime();
    });
}

function formatBatteryLevel(value?: number | null) {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "-";
    }

    return `${Math.round(value * 100)}%`;
}

function formatBatteryStateLabel(value?: string | null) {
    switch (value) {
        case "charging":
            return "充電中";
        case "full":
            return "満充電";
        case "unplugged":
            return "放電中";
        case "unknown":
        default:
            return "不明";
    }
}

function formatSessionBatterySummary(
    startBatteryLevel?: number | null,
    endBatteryLevel?: number | null,
    endBatteryState?: string | null,
    lowPowerMode?: boolean | null,
) {
    const batteryText = `バッテリー：${formatBatteryLevel(
        startBatteryLevel,
    )} → ${formatBatteryLevel(endBatteryLevel)}`;

    const stateText = `バッテリー状態：${formatBatteryStateLabel(
        endBatteryState,
    )}`;

    const lowPowerModeText = lowPowerMode ? "、低電力モード：ON" : "";

    return `${batteryText}  ${stateText}${lowPowerModeText}`;
}

function formatSingleBatterySummary(
    batteryLevel?: number | null,
    batteryState?: string | null,
    lowPowerMode?: boolean | null,
) {
    const batteryText = `バッテリー：${formatBatteryLevel(batteryLevel)}`;
    const stateText = `バッテリー状態：${formatBatteryStateLabel(
        batteryState,
    )}`;

    const lowPowerModeText = lowPowerMode ? "、低電力モード：ON" : "";

    return `${batteryText}  ${stateText}${lowPowerModeText}`;
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
});
