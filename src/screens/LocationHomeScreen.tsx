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

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect } from "@react-navigation/native";
import { getUrl } from "aws-amplify/storage";
import { useForegroundLocationRecorder } from "../hooks/useForegroundLocationRecorder";
import { client } from "../lib/client";
import type { RootStackParamList } from "../navigation/RootNavigator";
import {
    backfillRecordingSessionsFromLocationLogs,
    upsertRecordingSessionSummary,
} from "../services/recordingSessionService";
import {
    ensureUserProfile,
    getCurrentUserProfile,
} from "../services/userProfileService";

type Props = NativeStackScreenProps<RootStackParamList, "LocationHome">;

type AppButtonProps = {
    title: string;
    onPress: () => void;
    disabled?: boolean;
    backgroundColor?: string;
};

type UserProfileItem = {
    id: string;
    userId: string;
    email?: string | null;
    displayName?: string | null;
    ownerValue?: string | null;
    searchText?: string | null;
    iconImagePath?: string | null;
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

type LiveLocationItem = {
    id: string;
    userId: string;
    recordingSessionId?: string | null;
    isRecording?: boolean | null;
    latitude?: number | null;
    longitude?: number | null;
    updatedAt?: string | null;
    recordedAt?: string | null;
    isActive?: boolean | null;
    sharedOwners?: string[] | null;
};

type LiveLocationListResult = {
    data?: any[] | null;
    errors?: unknown;
    nextToken?: string | null;
};

const LOCATION_HOME_SETTINGS_STORAGE_KEY = "location-tracker-home-settings";

type SavedLocationHomeSettings = {
    recordIntervalMs?: number;
    recordDistanceMeters?: number;
    selectedLiveShareUsers?: UserProfileItem[];
};

// 現在地の記録と保存を行うホーム画面コンポーネント
export default function LocationHomeScreen({ navigation }: Props) {
    const [loginUserName, setLoginUserName] = useState("ユーザー");
    const [loginUserIconUrl, setLoginUserIconUrl] = useState<string | null>(
        null,
    );
    const [isAdmin, setIsAdmin] = useState(false);

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
    const [recordDistanceMeters, setRecordDistanceMeters] = useState(50);
    const [hasLoadedSavedHomeSettings, setHasLoadedSavedHomeSettings] =
        useState(false);

    const [liveShareModalVisible, setLiveShareModalVisible] = useState(false);
    const [liveShareSearchText, setLiveShareSearchText] = useState("");
    const [liveShareUsers, setLiveShareUsers] = useState<UserProfileItem[]>([]);
    const [selectedLiveShareUsers, setSelectedLiveShareUsers] = useState<
        UserProfileItem[]
    >([]);
    const [liveShareUserIconUrls, setLiveShareUserIconUrls] = useState<
        Record<string, string | null>
    >({});
    const [draftLiveShareUsers, setDraftLiveShareUsers] = useState<
        UserProfileItem[]
    >([]);

    const [loadingLiveShareUsers, setLoadingLiveShareUsers] = useState(false);
    const [liveShareStatusMessage, setLiveShareStatusMessage] = useState("");
    const [openingSharedLiveMap, setOpeningSharedLiveMap] = useState(false);
    const [backfillingSessions, setBackfillingSessions] = useState(false);

    useEffect(() => {
        const loadSavedHomeSettings = async () => {
            try {
                const raw = await AsyncStorage.getItem(
                    LOCATION_HOME_SETTINGS_STORAGE_KEY,
                );

                if (!raw) {
                    return;
                }

                const savedSettings = JSON.parse(
                    raw,
                ) as SavedLocationHomeSettings;

                if (
                    typeof savedSettings.recordIntervalMs === "number" &&
                    [10000, 30000, 60000, 180000, 300000].includes(
                        savedSettings.recordIntervalMs,
                    )
                ) {
                    setRecordIntervalMs(savedSettings.recordIntervalMs);
                }

                if (
                    typeof savedSettings.recordDistanceMeters === "number" &&
                    [10, 20, 50, 100].includes(
                        savedSettings.recordDistanceMeters,
                    )
                ) {
                    setRecordDistanceMeters(savedSettings.recordDistanceMeters);
                }

                if (Array.isArray(savedSettings.selectedLiveShareUsers)) {
                    const savedUsers =
                        savedSettings.selectedLiveShareUsers.filter(
                            (user) => !!user.ownerValue,
                        );

                    try {
                        const userProfileModel = client.models
                            .UserProfile as any;

                        const profileResult = (await userProfileModel.list({
                            limit: 1000,
                        })) as UserProfileListResult;

                        if (profileResult.errors) {
                            console.error(
                                "Restore live share users profile errors:",
                                profileResult.errors,
                            );

                            setSelectedLiveShareUsers(savedUsers);
                        } else {
                            const latestProfileMap = new Map(
                                (profileResult.data ?? [])
                                    .filter(
                                        (profile: any) =>
                                            profile?.id && profile?.userId,
                                    )
                                    .map((profile: any) => [
                                        profile.userId,
                                        profile,
                                    ]),
                            );

                            const restoredUsers: UserProfileItem[] =
                                savedUsers.map((savedUser) => {
                                    const latestProfile = latestProfileMap.get(
                                        savedUser.userId,
                                    );

                                    if (!latestProfile) {
                                        return savedUser;
                                    }

                                    return {
                                        id: latestProfile.id,
                                        userId: latestProfile.userId,
                                        email: latestProfile.email ?? null,
                                        displayName:
                                            latestProfile.displayName ?? null,
                                        ownerValue:
                                            latestProfile.ownerValue ?? null,
                                        searchText:
                                            latestProfile.searchText ?? null,
                                        iconImagePath:
                                            latestProfile.iconImagePath ?? null,
                                    };
                                });

                            setSelectedLiveShareUsers(
                                restoredUsers.filter(
                                    (user) => !!user.ownerValue,
                                ),
                            );
                        }
                    } catch (error) {
                        console.error("Restore live share users error:", error);

                        setSelectedLiveShareUsers(savedUsers);
                    }
                }
            } catch (error) {
                console.error("Load saved home settings error:", error);
            } finally {
                setHasLoadedSavedHomeSettings(true);
            }
        };

        void loadSavedHomeSettings();
    }, []);

    useEffect(() => {
        if (!hasLoadedSavedHomeSettings) {
            return;
        }

        const saveHomeSettings = async () => {
            try {
                const settings: SavedLocationHomeSettings = {
                    recordIntervalMs,
                    recordDistanceMeters,
                    selectedLiveShareUsers,
                };

                await AsyncStorage.setItem(
                    LOCATION_HOME_SETTINGS_STORAGE_KEY,
                    JSON.stringify(settings),
                );
            } catch (error) {
                console.error("Save home settings error:", error);
            }
        };

        void saveHomeSettings();
    }, [
        hasLoadedSavedHomeSettings,
        recordIntervalMs,
        recordDistanceMeters,
        selectedLiveShareUsers,
    ]);

    const liveShareOwnerValues = useMemo(() => {
        return selectedLiveShareUsers
            .map((user) => user.ownerValue)
            .filter((ownerValue): ownerValue is string => !!ownerValue);
    }, [selectedLiveShareUsers]);

    useEffect(() => {
        let cancelled = false;

        const loadSelectedLiveShareUserIcons = async () => {
            const iconEntries = await Promise.all(
                selectedLiveShareUsers.map(async (user) => {
                    if (!user.iconImagePath) {
                        return [user.id, null] as const;
                    }

                    try {
                        const result = await getUrl({
                            path: user.iconImagePath,
                            options: {
                                expiresIn: 3600,
                            },
                        });

                        return [user.id, result.url.toString()] as const;
                    } catch (error) {
                        console.error("Load live share user icon error:", {
                            userId: user.userId,
                            iconImagePath: user.iconImagePath,
                            error,
                        });

                        return [user.id, null] as const;
                    }
                }),
            );

            if (cancelled) {
                return;
            }

            setLiveShareUserIconUrls(Object.fromEntries(iconEntries));
        };

        void loadSelectedLiveShareUserIcons();

        return () => {
            cancelled = true;
        };
    }, [selectedLiveShareUsers]);

    const {
        isRecording,
        recordingStartedAt,
        activeRecordingSessionId,
        startRecording,
        stopRecording,
    } = useForegroundLocationRecorder({
        intervalMs: recordIntervalMs,
        distanceMeters: recordDistanceMeters,
        liveShareOwnerValues,
    });

    const recordingBlinkAnim = useRef(new Animated.Value(1)).current;
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    const [stoppingRecording, setStoppingRecording] = useState(false);

    const [sessionNameModalVisible, setSessionNameModalVisible] =
        useState(false);
    const [sessionNameInput, setSessionNameInput] = useState("");
    const [pendingSessionId, setPendingSessionId] = useState<string | null>(
        null,
    );
    const [pendingSessionShareOwnerValues, setPendingSessionShareOwnerValues] =
        useState<string[]>([]);
    const [pendingRecordingIntervalMs, setPendingRecordingIntervalMs] =
        useState<number | null>(null);
    const [pendingRecordingDistanceMeters, setPendingRecordingDistanceMeters] =
        useState<number | null>(null);
    const [savingSessionName, setSavingSessionName] = useState(false);

    const loadLoginUserName = useCallback(async () => {
        try {
            const profile = await getCurrentUserProfile();

            const name =
                profile?.displayName?.trim() ||
                profile?.email?.trim() ||
                "ユーザー";

            setLoginUserName(name);

            // 追加
            setIsAdmin(profile?.role === "admin");

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

            // 追加
            setIsAdmin(false);
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
                    iconImagePath: user.iconImagePath ?? null,
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
        setDraftLiveShareUsers(selectedLiveShareUsers);
        setLiveShareSearchText("");
        setLiveShareModalVisible(true);
        void loadLiveShareUsers();
    };

    const clearLiveShareUsers = () => {
        setSelectedLiveShareUsers([]);
        setLiveShareStatusMessage("");
    };

    const toggleLiveShareUser = (user: UserProfileItem) => {
        setDraftLiveShareUsers((currentUsers) => {
            const exists = currentUsers.some(
                (currentUser) => currentUser.id === user.id,
            );

            if (exists) {
                return currentUsers.filter(
                    (currentUser) => currentUser.id !== user.id,
                );
            }

            return [...currentUsers, user];
        });
    };

    const liveShareUserName =
        selectedLiveShareUsers.length === 0
            ? ""
            : selectedLiveShareUsers
                  .map((user) => user.displayName || user.email || "名前未設定")
                  .join("、");

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
            if (!stoppingRecording) {
                setElapsedSeconds(0);
            }

            return;
        }

        // 停止ボタン押下後は、保存処理中でもカウントアップしない
        if (stoppingRecording) {
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
    }, [isRecording, recordingStartedAt, stoppingRecording]);

    //
    const handleSignOut = async () => {
        if (isRecording) {
            Alert.alert(
                "自動記録中です",
                "サインアウトする前に自動記録を停止してください。",
            );
            return;
        }

        if (selectedLiveShareUsers.length > 0) {
            Alert.alert(
                "現在地を共有中です",
                "サインアウトする前に「共有先をすべて解除」してください。",
            );
            return;
        }

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

            await upsertRecordingSessionSummary(
                pendingSessionId,
                sessionName,
                pendingSessionShareOwnerValues,
                pendingRecordingIntervalMs,
                pendingRecordingDistanceMeters,
            );

            setSessionNameModalVisible(false);
            setSessionNameInput("");
            setPendingSessionId(null);
            setPendingSessionShareOwnerValues([]);
            setPendingRecordingIntervalMs(null);
            setPendingRecordingDistanceMeters(null);
        } catch (error) {
            console.error("Save session name error:", error);
            Alert.alert("保存エラー", "セッション名の保存に失敗しました。");
        } finally {
            setSavingSessionName(false);
        }
    };

    const handleDiscardSession = async () => {
        if (!pendingSessionId || savingSessionName) {
            return;
        }

        try {
            setSavingSessionName(true);

            const sessionLogs =
                await listLocationLogsBySessionId(pendingSessionId);

            const locationLogModel = client.models.LocationLog as any;

            const deleteResults = await Promise.all(
                sessionLogs.map((log) =>
                    locationLogModel.delete({
                        id: log.id,
                    }),
                ),
            );

            const hasErrors = deleteResults.some((deleteResult) => {
                return deleteResult.errors;
            });

            if (hasErrors) {
                console.error(
                    "LocationLog session delete errors:",
                    deleteResults,
                );
                Alert.alert(
                    "削除エラー",
                    "位置情報ログを削除できませんでした。",
                );
                return;
            }

            setSessionNameModalVisible(false);
            setSessionNameInput("");
            setPendingSessionId(null);
            setPendingSessionShareOwnerValues([]);
            setPendingRecordingIntervalMs(null);
            setPendingRecordingDistanceMeters(null);
        } catch (error) {
            console.error("Discard session error:", error);
            Alert.alert("削除エラー", "位置情報ログの削除に失敗しました。");
        } finally {
            setSavingSessionName(false);
        }
    };

    const confirmStopRecording = () => {
        if (stoppingRecording) {
            return;
        }

        Alert.alert(
            "自動記録を停止しますか？",
            "自動記録を停止すると、このセッションの位置情報記録が終了します。",
            [
                {
                    text: "キャンセル",
                    style: "cancel",
                },
                {
                    text: "停止する",
                    style: "destructive",
                    onPress: () => {
                        void handleStopRecording();
                    },
                },
            ],
        );
    };

    // セッションIDに紐づくLocationLogを全件取得してセッション名を更新する
    const handleStopRecording = async () => {
        if (stoppingRecording) {
            return;
        }

        if (recordingStartedAt) {
            const startedAtTime = new Date(recordingStartedAt).getTime();
            const stoppedSeconds = Math.floor(
                (Date.now() - startedAtTime) / 1000,
            );
            setElapsedSeconds(stoppedSeconds);
        }

        setStoppingRecording(true);

        const stoppedShareUserName = liveShareUserName;
        const stoppedShareOwnerValues = selectedLiveShareUsers
            .map((user) => user.ownerValue)
            .filter((ownerValue): ownerValue is string => !!ownerValue);

        try {
            const finishedSessionId = await stopRecording();

            if (stoppedShareUserName) {
                setLiveShareStatusMessage(
                    `自動記録を停止しました。現在地共有は継続中です: ${stoppedShareUserName}`,
                );
            } else {
                setLiveShareStatusMessage("自動記録を停止しました。");
            }

            if (!finishedSessionId) {
                return;
            }

            setPendingSessionId(finishedSessionId);
            setPendingSessionShareOwnerValues(stoppedShareOwnerValues);
            setPendingRecordingIntervalMs(recordIntervalMs);
            setPendingRecordingDistanceMeters(recordDistanceMeters);
            setSessionNameInput("");
            setSessionNameModalVisible(true);
        } catch (error) {
            console.error("Stop recording error:", error);
            Alert.alert("停止エラー", "自動記録の停止処理に失敗しました。");
        } finally {
            setStoppingRecording(false);
        }
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

    const handleOpenSharedLiveLocationMap = async () => {
        if (openingSharedLiveMap) {
            return;
        }

        try {
            setOpeningSharedLiveMap(true);

            const profile = await getCurrentUserProfile();
            const ownerValue = profile?.ownerValue;

            if (!ownerValue) {
                Alert.alert(
                    "共有情報がありません",
                    "現在のユーザーの共有用情報を取得できませんでした。",
                );
                return;
            }

            console.log(
                "[SharedLive] viewer ownerValue:",
                JSON.stringify(ownerValue),
            );

            const liveLocationModel = client.models.LiveLocation as any;

            const allData: any[] = [];
            let nextToken: string | null = null;

            do {
                const listParams: {
                    filter: {
                        isActive: {
                            eq: boolean;
                        };
                    };
                    limit: number;
                    nextToken?: string;
                } = {
                    filter: {
                        isActive: {
                            eq: true,
                        },
                    },
                    limit: 1000,
                };

                if (nextToken) {
                    listParams.nextToken = nextToken;
                }

                const result = (await liveLocationModel.list(
                    listParams,
                )) as LiveLocationListResult;

                console.log("[SharedLive] list result:", {
                    dataCount: result.data?.length ?? 0,
                    errors: result.errors,
                    nextToken: result.nextToken,
                });

                console.log(
                    "[SharedLive] records:",
                    (result.data ?? []).map((item) => ({
                        id: item.id,
                        userId: item.userId,
                        owner: item.owner,
                        sharedOwners: item.sharedOwners,
                        isActive: item.isActive,
                        isRecording: item.isRecording,
                        recordingSessionId: item.recordingSessionId,
                        latitude: item.latitude,
                        longitude: item.longitude,
                    })),
                );

                if (result.errors) {
                    console.error("LiveLocation list errors:", result.errors);
                    Alert.alert(
                        "取得エラー",
                        "共有中の現在地を取得できませんでした。",
                    );
                    return;
                }

                allData.push(...(result.data ?? []));
                nextToken = result.nextToken ?? null;
            } while (nextToken);

            const sharedLiveLocations: LiveLocationItem[] = allData
                .filter(
                    (item): item is NonNullable<typeof item> => item != null,
                )
                .map((item) => ({
                    id: item.id,
                    userId: item.userId,
                    recordingSessionId: item.recordingSessionId ?? null,
                    isRecording:
                        typeof item.isRecording === "boolean"
                            ? item.isRecording
                            : Boolean(item.recordingSessionId),
                    latitude: item.latitude,
                    longitude: item.longitude,
                    updatedAt: item.updatedAt ?? null,
                    recordedAt: item.recordedAt ?? null,
                    isActive: item.isActive ?? null,
                    sharedOwners: Array.isArray(item.sharedOwners)
                        ? item.sharedOwners
                        : [],
                }))
                .filter((item) => {
                    if (!item.isActive) {
                        return false;
                    }

                    if (
                        !Number.isFinite(Number(item.latitude)) ||
                        !Number.isFinite(Number(item.longitude))
                    ) {
                        return false;
                    }

                    return item.sharedOwners?.includes(ownerValue);
                })
                .sort((a, b) => {
                    const aTime = new Date(
                        a.updatedAt ?? a.recordedAt ?? 0,
                    ).getTime();
                    const bTime = new Date(
                        b.updatedAt ?? b.recordedAt ?? 0,
                    ).getTime();

                    return bTime - aTime;
                });

            console.log("[SharedLive] allData:", allData);

            console.log(
                "[SharedLive] null item count:",
                allData.filter((item) => item == null).length,
            );

            const latest = sharedLiveLocations[0];

            if (!latest) {
                Alert.alert(
                    "共有中の現在地なし",
                    "現在共有されているLiveLocationが見つかりませんでした。",
                );
                return;
            }
            const sharedLiveIsRecording =
                latest.isRecording === true &&
                Boolean(latest.recordingSessionId);

            navigation.navigate("LocationMap", {
                sharedLiveUserId: latest.userId,
                sharedLiveLocationId: latest.id,
                recordingSessionId: latest.recordingSessionId ?? null,
                sharedLiveIsRecording,
            });
        } catch (error) {
            console.error("Open shared live location map error:", error);
            Alert.alert(
                "取得エラー",
                "共有中の現在地を開く処理に失敗しました。",
            );
        } finally {
            setOpeningSharedLiveMap(false);
        }
    };

    useEffect(() => {
        void ensureUserProfile();
    }, []);

    const handleBackfillRecordingSessions = async () => {
        if (backfillingSessions || isRecording) {
            return;
        }

        Alert.alert(
            "セッション履歴を作成",
            "過去の位置情報ログからセッション履歴を作成しますか？",
            [
                {
                    text: "キャンセル",
                    style: "cancel",
                },
                {
                    text: "実行",
                    onPress: async () => {
                        try {
                            setBackfillingSessions(true);

                            const result =
                                await backfillRecordingSessionsFromLocationLogs();

                            Alert.alert(
                                "作成完了",
                                [
                                    `LocationLog: ${result.locationLogCount}件`,
                                    `対象セッション: ${result.targetSessionCount}件`,
                                    `作成・更新: ${result.createdOrUpdatedCount}件`,
                                    `失敗: ${result.failedCount}件`,
                                    `対象外ログ: ${result.skippedLogCount}件`,
                                ].join("\n"),
                            );
                        } catch (error) {
                            console.error(
                                "RecordingSession backfill error:",
                                error,
                            );

                            Alert.alert(
                                "作成エラー",
                                "過去ログからセッション履歴を作成できませんでした。",
                            );
                        } finally {
                            setBackfillingSessions(false);
                        }
                    },
                },
            ],
        );
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

                <View style={styles.liveShareBox}>
                    <Text style={styles.liveShareTitle}>
                        リアルタイム共有先
                    </Text>

                    <Pressable
                        style={styles.liveShareSelectButton}
                        onPress={openLiveShareModal}
                    >
                        <Text style={styles.liveShareSelectButtonText}>
                            {selectedLiveShareUsers.length > 0
                                ? `${selectedLiveShareUsers.length}人を選択中`
                                : "共有先ユーザーを選択"}
                        </Text>
                    </Pressable>

                    {selectedLiveShareUsers.length > 0 && (
                        <Text style={styles.liveShareSelectedUserName}>
                            共有先ユーザー
                        </Text>
                    )}

                    {selectedLiveShareUsers.length > 0 && (
                        <View style={styles.liveShareUserIconRow}>
                            {selectedLiveShareUsers.map((user) => {
                                const userName =
                                    user.displayName ||
                                    user.email ||
                                    "名前未設定";

                                const iconUrl = liveShareUserIconUrls[user.id];

                                return (
                                    <View
                                        key={user.id}
                                        style={styles.liveShareUserIconItem}
                                    >
                                        {iconUrl ? (
                                            <Image
                                                source={{ uri: iconUrl }}
                                                style={styles.liveShareUserIcon}
                                                resizeMode="cover"
                                            />
                                        ) : (
                                            <View
                                                style={
                                                    styles.liveShareUserIconPlaceholder
                                                }
                                            >
                                                <Text
                                                    style={
                                                        styles.liveShareUserIconPlaceholderText
                                                    }
                                                >
                                                    {userName.slice(0, 1)}
                                                </Text>
                                            </View>
                                        )}

                                        <Text
                                            style={styles.liveShareUserIconName}
                                            numberOfLines={1}
                                        >
                                            {userName}
                                        </Text>
                                    </View>
                                );
                            })}
                        </View>
                    )}

                    {selectedLiveShareUsers.length > 0 && (
                        <Pressable
                            style={styles.liveShareClearButton}
                            onPress={clearLiveShareUsers}
                        >
                            <Text style={styles.liveShareClearButtonText}>
                                共有先をすべて解除
                            </Text>
                        </Pressable>
                    )}

                    {selectedLiveShareUsers.length > 0 && (
                        <View style={styles.liveShareStatusActiveBox}>
                            <Text style={styles.liveShareStatusActiveText}>
                                現在地を共有中: {liveShareUserName}
                            </Text>
                        </View>
                    )}

                    {selectedLiveShareUsers.length === 0 &&
                        liveShareStatusMessage.length > 0 && (
                            <View style={styles.liveShareStatusStoppedBox}>
                                <Text style={styles.liveShareStatusStoppedText}>
                                    {liveShareStatusMessage}
                                </Text>
                            </View>
                        )}
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
                    {stoppingRecording && (
                        <View style={styles.stoppingRecordingBox}>
                            <Text style={styles.stoppingRecordingText}>
                                自動記録を停止中です。しばらくお待ちください...
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
                                pressed &&
                                    !stoppingRecording &&
                                    styles.buttonPressed,
                                stoppingRecording && styles.appButtonDisabled,
                            ]}
                            onPress={confirmStopRecording}
                            disabled={stoppingRecording}
                        >
                            <Text style={styles.autoRecordButtonText}>
                                {stoppingRecording
                                    ? "停止処理中..."
                                    : "自動記録停止"}
                            </Text>
                        </Pressable>
                    ) : (
                        <Pressable
                            style={({ pressed }) => [
                                styles.autoRecordStartButton,
                                pressed &&
                                    hasLoadedSavedHomeSettings &&
                                    styles.buttonPressed,
                                !hasLoadedSavedHomeSettings &&
                                    styles.appButtonDisabled,
                            ]}
                            onPress={handleStartRecording}
                            disabled={!hasLoadedSavedHomeSettings}
                        >
                            <Text style={styles.autoRecordButtonText}>
                                {!hasLoadedSavedHomeSettings
                                    ? "設定を読み込み中..."
                                    : selectedLiveShareUsers.length > 0
                                      ? "自動記録開始＋共有"
                                      : "自動記録開始"}
                            </Text>
                        </Pressable>
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
                        title="活動ランキングを見る"
                        onPress={() => navigation.navigate("ActivityRanking")}
                    />
                </View>
                <View style={styles.buttonSpace}>
                    <AppButton
                        title={
                            openingSharedLiveMap
                                ? "共有中の現在地を取得中..."
                                : "共有中の現在地を見る"
                        }
                        onPress={handleOpenSharedLiveLocationMap}
                        disabled={openingSharedLiveMap}
                    />
                </View>

                <View style={styles.buttonSpace}>
                    <AppButton
                        title="プロフィール"
                        onPress={() => navigation.navigate("Profile")}
                    />
                </View>

                {isAdmin && (
                    <View style={styles.buttonSpace}>
                        <AppButton
                            title={
                                backfillingSessions
                                    ? "セッション履歴を作成中..."
                                    : "過去ログからセッション履歴を作成"
                            }
                            onPress={handleBackfillRecordingSessions}
                            disabled={backfillingSessions || isRecording}
                            backgroundColor="#27445c"
                        />
                    </View>
                )}
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
                                        styles.modalSecondaryButton,
                                        savingSessionName &&
                                            styles.appButtonDisabled,
                                    ]}
                                    disabled={savingSessionName}
                                    onPress={handleDiscardSession}
                                >
                                    <Text
                                        style={styles.modalSecondaryButtonText}
                                    >
                                        保存しない
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
                    onRequestClose={() => {
                        setDraftLiveShareUsers(selectedLiveShareUsers);
                        setLiveShareModalVisible(false);
                    }}
                >
                    <View style={styles.modalOverlay}>
                        <View style={styles.modalContent}>
                            <Text style={styles.modalTitle}>
                                リアルタイム共有先を選択
                            </Text>

                            <Text style={styles.modalDescription}>
                                現在地をリアルタイム共有するユーザーを選択してください。
                                自動記録中でなくても共有できます。
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
                                            draftLiveShareUsers.some(
                                                (selectedUser) =>
                                                    selectedUser.id === user.id,
                                            );

                                        return (
                                            <Pressable
                                                key={user.id}
                                                style={[
                                                    styles.liveShareUserItem,
                                                    selected &&
                                                        styles.liveShareUserItemSelected,
                                                ]}
                                                onPress={() =>
                                                    toggleLiveShareUser(user)
                                                }
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
                                    onPress={() => {
                                        setDraftLiveShareUsers(
                                            selectedLiveShareUsers,
                                        );
                                        setLiveShareModalVisible(false);
                                    }}
                                >
                                    <Text
                                        style={styles.modalSecondaryButtonText}
                                    >
                                        キャンセル
                                    </Text>
                                </Pressable>

                                <Pressable
                                    style={styles.modalPrimaryButton}
                                    onPress={() => {
                                        setSelectedLiveShareUsers(
                                            draftLiveShareUsers,
                                        );
                                        setLiveShareStatusMessage("");
                                        setLiveShareModalVisible(false);
                                    }}
                                >
                                    <Text style={styles.modalPrimaryButtonText}>
                                        保存
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

function AppButton({
    title,
    onPress,
    disabled = false,
    backgroundColor,
}: AppButtonProps) {
    return (
        <Pressable
            style={({ pressed }) => [
                styles.appButton,
                backgroundColor ? { backgroundColor } : null,
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
        marginBottom: 12,
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
    stoppingRecordingBox: {
        marginTop: 8,
        padding: 10,
        borderRadius: 8,
        backgroundColor: "#eef3f7",
        borderWidth: 1,
        borderColor: "#c8d6e0",
    },

    stoppingRecordingText: {
        color: "#2f4f66",
        fontSize: 13,
        fontWeight: "bold",
    },
    liveShareBox: {
        marginTop: 4,
        padding: 14,
        borderWidth: 1,
        borderColor: "#ddd",
        borderRadius: 10,
        backgroundColor: "#fff",
    },

    liveShareTitle: {
        fontSize: 16,
        fontWeight: "bold",
        color: "#333",
        marginBottom: 10,
    },

    liveShareSelectedUserName: {
        marginTop: 8,
        fontSize: 13,
        color: "#555",
        lineHeight: 19,
    },
    liveShareUserIconRow: {
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 12,
        marginTop: 10,
    },

    liveShareUserIconItem: {
        width: 64,
        alignItems: "center",
    },

    liveShareUserIcon: {
        width: 48,
        height: 48,
        borderRadius: 24,
        backgroundColor: "#e6edf3",
    },

    liveShareUserIconPlaceholder: {
        width: 48,
        height: 48,
        borderRadius: 24,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#dbe7f0",
        borderWidth: 1,
        borderColor: "#c8d6e0",
    },

    liveShareUserIconPlaceholderText: {
        color: "#2f4f66",
        fontSize: 18,
        fontWeight: "bold",
    },

    liveShareUserIconName: {
        width: 64,
        marginTop: 4,
        color: "#555",
        fontSize: 11,
        textAlign: "center",
    },
});
