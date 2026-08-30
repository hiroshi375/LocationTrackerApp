import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { signOut } from "aws-amplify/auth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Animated,
    AppState,
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
import * as Location from "expo-location";
import * as Updates from "expo-updates";
import { useForegroundLocationRecorder } from "../hooks/useForegroundLocationRecorder";
import { client } from "../lib/client";
import type { RootStackParamList } from "../navigation/RootNavigator";
import {
    getBackgroundLocationTaskHeartbeatStatus,
    getBackgroundRecordingStatus,
    isBackgroundLocationDisclosureDeclined,
    isBackgroundLocationPermissionError,
    isForegroundLocationPermissionError,
    stopBackgroundLocationRecording,
    type BackgroundLocationHeartbeatStatus,
} from "../services/backgroundLocationService";
import {
    debugPrintLocationQueueRecoverySummary,
    debugPrintLocationQueueSkipReasons,
    debugPrintSaveConditionNotMetDetails,
    debugPrintSaveThresholdTimeline,
} from "../services/locationLocationQueueService";
import {
    clearRecordingContinuationState,
    getRecordingContinuationState,
} from "../services/recordingContinuationService";
import {
    backfillRecordingSessionsFromLocationLogs,
    upsertRecordingSessionSummary,
    type RecordingSessionBackfillProgress,
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
    version?: number;
    recordIntervalMs?: number;
    recordDistanceMeters?: number;
    selectedLiveShareUsers?: UserProfileItem[];
};

type EasUpdateInfo = {
    updateId: string | null;
    channel: string | null;
    runtimeVersion: string | null;
    createdAt: string | null;
    isEmbeddedLaunch: boolean;
    isEnabled: boolean;
};

type ShareCandidateItem = {
    userId: string;
    ownerValue: string;
    displayName?: string | null;
    email?: string | null;
    iconImagePath?: string | null;
};

type ShareCandidateQueryResult = {
    data?: (ShareCandidateItem | null)[] | null;
    errors?: readonly unknown[];
};

const LOCATION_HOME_SETTINGS_VERSION = 2;
const DEFAULT_RECORD_DISTANCE_METERS = 50;

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
    const [forcingEasUpdate, setForcingEasUpdate] = useState(false);
    const [backfillProgress, setBackfillProgress] =
        useState<RecordingSessionBackfillProgress | null>(null);
    const [
        hasBackgroundLocationPermission,
        setHasBackgroundLocationPermission,
    ] = useState(false);

    const [
        checkingBackgroundLocationPermission,
        setCheckingBackgroundLocationPermission,
    ] = useState(true);

    const handleForceEasUpdate = useCallback(async (): Promise<void> => {
        /*
         * 連打による二重実行を防止する。
         */
        if (forcingEasUpdate) {
            return;
        }

        try {
            setForcingEasUpdate(true);

            if (!Updates.isEnabled) {
                Alert.alert(
                    "EAS Update",
                    "expo-updates が無効になっています。",
                );
                return;
            }

            console.log("EAS Update check started:", {
                updateId: Updates.updateId,
                channel: Updates.channel,
                runtimeVersion: Updates.runtimeVersion,
                createdAt: Updates.createdAt,
            });

            const checkResult = await Updates.checkForUpdateAsync();

            console.log("EAS Update check result:", checkResult);

            if (!checkResult.isAvailable) {
                Alert.alert("EAS Update", "新しいUpdateはありません。");
                return;
            }

            const fetchResult = await Updates.fetchUpdateAsync();

            console.log("EAS Update fetch result:", fetchResult);

            /*
             * Background Location稼働中のFull JS Reloadによって、
             * background location callbackが停止するため、
             * 自動記録中または現在地共有中はUpdateを適用しない。
             *
             * UI側stateではなく、background taskと共有している
             * 保存済みstateを参照する。
             */
            const backgroundStatus = await getBackgroundRecordingStatus();
            const backgroundState = backgroundStatus.state;

            const isBackgroundLocationInUse =
                backgroundState?.isRecording === true ||
                (backgroundState?.liveShareOwnerValues?.length ?? 0) > 0;

            if (isBackgroundLocationInUse) {
                Alert.alert(
                    "EAS Update",
                    "最新Updateを取得しましたが、現在位置情報をバックグラウンドで使用中のため適用できません。\n\n" +
                        "自動記録と現在地共有を停止してから、もう一度Updateを適用してください。",
                );
                return;
            }

            Alert.alert(
                "EAS Update",
                "最新Updateを取得しました。今すぐ適用します。",
                [
                    {
                        text: "キャンセル",
                        style: "cancel",
                    },
                    {
                        text: "適用",
                        onPress: () => {
                            void (async () => {
                                try {
                                    /*
                                     * Alert表示後から「適用」押下までの間に
                                     * Background Locationが開始される可能性があるため、
                                     * reload直前でも必ず再確認する。
                                     */
                                    const latestBackgroundStatus =
                                        await getBackgroundRecordingStatus();

                                    const latestBackgroundState =
                                        latestBackgroundStatus.state;

                                    const isLatestBackgroundLocationInUse =
                                        latestBackgroundState?.isRecording ===
                                            true ||
                                        (latestBackgroundState
                                            ?.liveShareOwnerValues?.length ??
                                            0) > 0;

                                    if (isLatestBackgroundLocationInUse) {
                                        Alert.alert(
                                            "EAS Update",
                                            "位置情報のバックグラウンド処理が開始されているため、Updateを適用できません。\n\n" +
                                                "自動記録と現在地共有を停止してから、もう一度Updateを適用してください。",
                                        );
                                        return;
                                    }

                                    await Updates.reloadAsync();
                                } catch (error) {
                                    const message =
                                        error instanceof Error
                                            ? error.message
                                            : String(error);

                                    console.error(
                                        "EAS Update reload error:",
                                        error,
                                    );

                                    Alert.alert("EAS Updateエラー", message);
                                }
                            })();
                        },
                    },
                ],
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);

            console.error("Force EAS Update error:", error);

            Alert.alert("EAS Updateエラー", message);
        } finally {
            setForcingEasUpdate(false);
        }
    }, [forcingEasUpdate]);

    useEffect(() => {
        void debugPrintLocationQueueRecoverySummary();
    }, []);

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

                if (savedSettings.version === LOCATION_HOME_SETTINGS_VERSION) {
                    if (
                        typeof savedSettings.recordDistanceMeters ===
                            "number" &&
                        [10, 20, 50, 100].includes(
                            savedSettings.recordDistanceMeters,
                        )
                    ) {
                        setRecordDistanceMeters(
                            savedSettings.recordDistanceMeters,
                        );
                    }
                } else {
                    setRecordDistanceMeters(DEFAULT_RECORD_DISTANCE_METERS);
                }

                if (Array.isArray(savedSettings.selectedLiveShareUsers)) {
                    const savedUsers =
                        savedSettings.selectedLiveShareUsers.filter(
                            (user): user is UserProfileItem =>
                                typeof user?.id === "string" &&
                                typeof user?.userId === "string" &&
                                typeof user?.ownerValue === "string" &&
                                user.ownerValue.length > 0,
                        );

                    /*
                     * ここでは一旦ローカル保存値を復元する。
                     *
                     * 画面Focus時のloadLiveShareUsers()で
                     * 現在のグループメンバーと照合し、
                     * 有効な共有先だけに絞り込む。
                     */
                    setSelectedLiveShareUsers(savedUsers);
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
                    version: LOCATION_HOME_SETTINGS_VERSION,
                    recordIntervalMs,
                    recordDistanceMeters,
                    selectedLiveShareUsers: selectedLiveShareUsers.map(
                        (user) => ({
                            id: user.id,
                            userId: user.userId,
                            email: user.email ?? null,
                            displayName: user.displayName ?? null,
                            ownerValue: user.ownerValue ?? null,
                            searchText: user.searchText ?? null,
                            iconImagePath: user.iconImagePath ?? null,
                        }),
                    ),
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
        continuationPrompt,
        autoStoppedSessionId,
        startRecording,
        stopRecording,
        confirmContinuation,
        clearAutoStoppedSession,
    } = useForegroundLocationRecorder({
        intervalMs: recordIntervalMs,
        distanceMeters: recordDistanceMeters,
        liveShareOwnerValues,
    });

    const recordingBlinkAnim = useRef(new Animated.Value(1)).current;
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    const [startingRecording, setStartingRecording] = useState(false);
    const [stoppingRecording, setStoppingRecording] = useState(false);
    const recordingControlsLocked = isRecording || startingRecording;
    const [checkingBackgroundHeartbeat, setCheckingBackgroundHeartbeat] =
        useState(false);

    const [backgroundHeartbeatStatus, setBackgroundHeartbeatStatus] =
        useState<BackgroundLocationHeartbeatStatus | null>(null);

    const [backgroundHeartbeatCheckedAt, setBackgroundHeartbeatCheckedAt] =
        useState<number | null>(null);
    const [checkingEasUpdateInfo, setCheckingEasUpdateInfo] = useState(false);
    const [easUpdateInfo, setEasUpdateInfo] = useState<EasUpdateInfo | null>(
        null,
    );
    const continuationAlertKeyRef = useRef<string | null>(null);
    const handledAutoStoppedSessionIdRef = useRef<string | null>(null);
    /*
     * Foreground高速queue回収の多重実行を防止する。
     */
    const foregroundQueueDrainRunningRef = useRef(false);

    /*
     * background / inactive → active の遷移を判定する。
     */
    const appStateRef = useRef(AppState.currentState);
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

            /*
             * UserProfile全件ではなく、
             * 自分と同じShareGroupに所属するユーザーだけを取得する。
             */
            const result = (await (client.queries.listMyShareCandidates as any)(
                {},
            )) as ShareCandidateQueryResult;

            if (result.errors?.length) {
                console.error("listMyShareCandidates errors:", result.errors);

                /*
                 * 取得失敗時に古い共有先をそのまま使わない。
                 * プライバシー優先で共有先を空にする。
                 */
                setLiveShareUsers([]);
                setSelectedLiveShareUsers([]);
                setDraftLiveShareUsers([]);

                Alert.alert(
                    "取得エラー",
                    "共有可能なグループメンバーを取得できませんでした。",
                );

                return;
            }

            const users: UserProfileItem[] = (result.data ?? [])
                .filter(
                    (user): user is ShareCandidateItem =>
                        user !== null &&
                        typeof user.userId === "string" &&
                        typeof user.ownerValue === "string" &&
                        user.ownerValue.length > 0,
                )
                .map(
                    (user: ShareCandidateItem): UserProfileItem => ({
                        id: user.userId,
                        userId: user.userId,
                        email: user.email ?? null,
                        displayName: user.displayName ?? null,
                        ownerValue: user.ownerValue,
                        searchText: null,
                        iconImagePath: user.iconImagePath ?? null,
                    }),
                )
                .sort((a, b) => {
                    const aName = a.displayName || a.email || "";

                    const bName = b.displayName || b.email || "";

                    return aName.localeCompare(bName, "ja");
                });

            setLiveShareUsers(users);

            /*
             * 以前選択していた共有先が
             * 現在も同じグループに所属している場合だけ残す。
             *
             * グループを抜けたユーザーなどは自動的に除外する。
             */
            setSelectedLiveShareUsers((currentSelectedUsers) => {
                const candidateMap = new Map(
                    users.map((user) => [user.userId, user]),
                );

                return currentSelectedUsers
                    .map((selectedUser) =>
                        candidateMap.get(selectedUser.userId),
                    )
                    .filter(
                        (user): user is UserProfileItem => user !== undefined,
                    );
            });

            setDraftLiveShareUsers((currentDraftUsers) => {
                const candidateMap = new Map(
                    users.map((user) => [user.userId, user]),
                );

                return currentDraftUsers
                    .map((draftUser) => candidateMap.get(draftUser.userId))
                    .filter(
                        (user): user is UserProfileItem => user !== undefined,
                    );
            });
        } catch (error) {
            console.error("Load live share users error:", error);

            /*
             * 知らない／過去のユーザーへ
             * 誤って共有し続けないため、
             * エラー時はfail closedとする。
             */
            setLiveShareUsers([]);
            setSelectedLiveShareUsers([]);
            setDraftLiveShareUsers([]);

            Alert.alert(
                "取得エラー",
                "共有可能なグループメンバーの取得に失敗しました。",
            );
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
        if (recordingControlsLocked) {
            return;
        }

        setDraftLiveShareUsers(selectedLiveShareUsers);
        setLiveShareSearchText("");
        setLiveShareModalVisible(true);
        void loadLiveShareUsers();
    };

    const clearLiveShareUsers = async (): Promise<void> => {
        if (recordingControlsLocked) {
            return;
        }

        try {
            /*
             * 自動記録停止後も現在地共有が継続している場合、
             * UI上の共有先を空にするだけでは、
             * background側のliveShareOwnerValuesと
             * Background Location taskが残ってしまう。
             *
             * 「共有先をすべて解除」した場合は、
             * Background Locationも完全停止する。
             */
            await stopBackgroundLocationRecording({
                continueLiveSharing: false,
            });

            /*
             * Background側の停止に成功してから
             * UI側の共有状態も解除する。
             */
            setSelectedLiveShareUsers([]);
            setDraftLiveShareUsers([]);
            setLiveShareStatusMessage("");
        } catch (error) {
            console.error("Clear live sharing error:", error);

            Alert.alert(
                "現在地共有の停止エラー",
                "現在地共有を停止できませんでした。もう一度お試しください。",
            );
        }
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

    const refreshBackgroundLocationPermission =
        useCallback(async (): Promise<void> => {
            try {
                setCheckingBackgroundLocationPermission(true);

                const permission =
                    await Location.getBackgroundPermissionsAsync();

                setHasBackgroundLocationPermission(
                    permission.status === Location.PermissionStatus.GRANTED,
                );
            } catch (error) {
                console.error(
                    "Check background location permission error:",
                    error,
                );

                setHasBackgroundLocationPermission(false);
            } finally {
                setCheckingBackgroundLocationPermission(false);
            }
        }, []);

    const handleStartRecording = async () => {
        if (startingRecording) {
            return;
        }

        try {
            setStartingRecording(true);
            setLiveShareStatusMessage("");

            await startRecording();
        } catch (error) {
            if (isBackgroundLocationDisclosureDeclined(error)) {
                /*
                 * 事前説明で「キャンセル」を選択した場合。
                 * ユーザーによる通常操作なのでエラー表示はしない。
                 */
                return;
            }

            if (isForegroundLocationPermissionError(error)) {
                return;
            }

            if (isBackgroundLocationPermissionError(error)) {
                /*
                 * backgroundLocationService側で、
                 * 「常に許可」や設定画面への案内を表示済み。
                 */
                return;
            }

            console.error("Start recording error:", error);

            Alert.alert(
                "自動記録開始エラー",
                "自動記録を開始できませんでした。",
            );
        } finally {
            setStartingRecording(false);
        }
    };

    const handleCheckBackgroundHeartbeat =
        useCallback(async (): Promise<void> => {
            if (checkingBackgroundHeartbeat) {
                return;
            }

            try {
                setCheckingBackgroundHeartbeat(true);

                const status = await getBackgroundLocationTaskHeartbeatStatus();

                setBackgroundHeartbeatStatus(status);
                setBackgroundHeartbeatCheckedAt(Date.now());

                console.log("Background location heartbeat status:", status);
            } catch (error) {
                console.error(
                    "Check background location heartbeat error:",
                    error,
                );

                Alert.alert(
                    "確認エラー",
                    "バックグラウンドタスクの実行状況を確認できませんでした。",
                );
            } finally {
                setCheckingBackgroundHeartbeat(false);
            }
        }, [checkingBackgroundHeartbeat]);

    const handleCheckEasUpdateInfo = useCallback(async (): Promise<void> => {
        if (checkingEasUpdateInfo) {
            return;
        }

        try {
            setCheckingEasUpdateInfo(true);

            const info: EasUpdateInfo = {
                updateId: Updates.updateId ?? null,
                channel: Updates.channel ?? null,
                runtimeVersion: Updates.runtimeVersion ?? null,
                createdAt:
                    Updates.createdAt instanceof Date
                        ? Updates.createdAt.toISOString()
                        : null,
                isEmbeddedLaunch: Updates.isEmbeddedLaunch,
                isEnabled: Updates.isEnabled,
            };

            setEasUpdateInfo(info);

            console.log("EAS Update info:", info);
        } catch (error) {
            console.error("Check EAS Update info error:", error);

            Alert.alert("確認エラー", "EAS Update情報を確認できませんでした。");
        } finally {
            setCheckingEasUpdateInfo(false);
        }
    }, [checkingEasUpdateInfo]);

    const drainCurrentLocationQueueInForeground =
        useCallback(async (): Promise<void> => {
            /*
             * 同じForeground期間中に多重起動しない。
             */
            if (foregroundQueueDrainRunningRef.current) {
                return;
            }

            foregroundQueueDrainRunningRef.current = true;

            try {
                /*
                 * UI側のstateではなく、
                 * background taskと共有している保存済みstateを参照する。
                 *
                 * userId / sessionId / interval / distanceの不一致を防ぐ。
                 */
                const backgroundStatus = await getBackgroundRecordingStatus();

                const backgroundState = backgroundStatus.state;

                if (
                    !backgroundState?.isRecording ||
                    !backgroundState.recordingSessionId ||
                    !backgroundState.userId
                ) {
                    return;
                }

                const { drainLocationQueueRepeatedly } =
                    await import("../services/locationQueueUploadService");

                /*
                 * Foregroundではbackground callbackとは異なり、
                 * SQLite pendingを連続して回収する。
                 *
                 * drainLocationQueueSafely() 1回あたりの最大2件という
                 * background側の安全制限はそのまま利用し、
                 * それを短い間隔で繰り返す。
                 *
                 * 1 pass:
                 *   最大50 iteration × 2件 = 最大100件程度
                 *
                 * 最大3 passまで実行するため、
                 * 1回のForeground復帰で最大約300件を回収できる。
                 */
                const MAX_FOREGROUND_DRAIN_PASSES = 3;

                for (
                    let passIndex = 0;
                    passIndex < MAX_FOREGROUND_DRAIN_PASSES;
                    passIndex += 1
                ) {
                    /*
                     * drain中に再びbackgroundへ移った場合は、
                     * その時点で高速回収を終了する。
                     */
                    if (AppState.currentState !== "active") {
                        break;
                    }

                    const result = await drainLocationQueueRepeatedly({
                        userId: backgroundState.userId,
                        recordingSessionId: backgroundState.recordingSessionId,
                        intervalMs: backgroundState.intervalMs,
                        distanceMeters: backgroundState.distanceMeters,

                        fallbackSharedOwners:
                            backgroundState.liveShareOwnerValues ?? [],

                        /*
                         * Foreground復帰時は直近60秒分も対象にする。
                         *
                         * direct保存済みの場合は決定的IDによって
                         * duplicateとして安全に処理される。
                         *
                         * direct保存に失敗してSQLiteだけに残った
                         * 最新地点も回収対象にできる。
                         */
                        forceIncludeRecent: true,

                        /*
                         * foregroundでは1回に最大10行処理する。
                         * background callbackは未指定なので従来通り2行。
                         */
                        maxItems: 10,
                        maxIterations: 50,
                    });

                    console.log("Foreground SQLite queue drain completed:", {
                        passIndex: passIndex + 1,
                        recordingSessionId: backgroundState.recordingSessionId,
                        ...result,
                    });

                    /*
                     * empty/completedなら回収終了。
                     */
                    if (
                        result.stopReason === "empty" ||
                        result.stopReason === "completed"
                    ) {
                        break;
                    }

                    /*
                     * 通信エラー・timeout・別drain実行中の場合は、
                     * このForeground復帰では無理に続行しない。
                     */
                    if (
                        result.stopReason === "alreadyRunning" ||
                        result.stopReason === "createFailed" ||
                        result.stopReason === "createTimedOut" ||
                        result.stopReason === "timeBudgetExceeded"
                    ) {
                        break;
                    }

                    /*
                     * maxIterationsReached かつpendingが残っている場合だけ
                     * 次passへ進む。
                     */
                    if (
                        result.stopReason !== "maxIterationsReached" ||
                        !result.remainingPendingCount ||
                        result.remainingPendingCount <= 0
                    ) {
                        break;
                    }
                }
            } catch (error) {
                /*
                 * Foreground queue回収失敗で
                 * Home画面や自動記録を失敗させない。
                 */
                console.error(
                    "Foreground SQLite location queue drain error:",
                    error,
                );
            } finally {
                foregroundQueueDrainRunningRef.current = false;
            }
        }, []);

    useEffect(() => {
        const subscription = AppState.addEventListener(
            "change",
            (nextAppState) => {
                const previousAppState = appStateRef.current;

                appStateRef.current = nextAppState;

                /*
                 * background / inactive
                 *          ↓
                 *        active
                 *
                 * になった時だけSQLite pendingを高速回収する。
                 */
                if (
                    previousAppState !== "active" &&
                    nextAppState === "active"
                ) {
                    /*
                     * 設定画面から戻った場合も、
                     * 「常に許可」状態を再確認する。
                     */
                    void refreshBackgroundLocationPermission();

                    void drainCurrentLocationQueueInForeground();
                }
            },
        );

        return () => {
            subscription.remove();
        };
    }, [
        drainCurrentLocationQueueInForeground,
        refreshBackgroundLocationPermission,
    ]);

    useEffect(() => {
        void refreshBackgroundLocationPermission();
    }, [refreshBackgroundLocationPermission]);

    useFocusEffect(
        useCallback(() => {
            void loadLoginUserName();
            void loadLiveShareUsers();
        }, [loadLoginUserName, loadLiveShareUsers]),
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
                    "アクティビティ名を保存できませんでした。",
                );
                return;
            }

            const continuationState = await getRecordingContinuationState();

            const matchingContinuationState =
                continuationState?.recordingSessionId === pendingSessionId
                    ? continuationState
                    : null;

            await upsertRecordingSessionSummary(
                pendingSessionId,
                sessionName,
                pendingSessionShareOwnerValues,
                pendingRecordingIntervalMs,
                pendingRecordingDistanceMeters,
                {
                    lastContinuationConfirmedAt:
                        matchingContinuationState?.lastConfirmedAt ?? undefined,

                    continuationConfirmationCount:
                        matchingContinuationState?.confirmationCount ??
                        undefined,

                    autoStoppedAt:
                        matchingContinuationState?.autoStoppedAt ?? undefined,

                    autoStopReason: matchingContinuationState?.autoStoppedAt
                        ? "CONTINUATION_TIMEOUT"
                        : undefined,
                },
            );

            await clearRecordingContinuationState(pendingSessionId);

            setSessionNameModalVisible(false);
            setSessionNameInput("");
            setPendingSessionId(null);
            setPendingSessionShareOwnerValues([]);
            setPendingRecordingIntervalMs(null);
            setPendingRecordingDistanceMeters(null);
        } catch (error) {
            console.error("Save session name error:", error);
            Alert.alert("保存エラー", "アクティビティ名の保存に失敗しました。");
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

    // セッションIDに紐づくLocationLogを全件取得してセッション名を更新する
    const handleStopRecording: () => Promise<void> =
        useCallback(async (): Promise<void> => {
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
        }, [
            liveShareUserName,
            recordDistanceMeters,
            recordIntervalMs,
            recordingStartedAt,
            selectedLiveShareUsers,
            stopRecording,
            stoppingRecording,
        ]);

    const handleDebugSQLiteSkipReasons = async () => {
        try {
            const recordingSessionId = "session-1786392243158-zldkkj1c";

            await debugPrintLocationQueueSkipReasons(recordingSessionId);

            await debugPrintSaveConditionNotMetDetails(recordingSessionId);

            await debugPrintSaveThresholdTimeline(recordingSessionId);
        } catch (error) {
            console.error("SQLite skip reason debug failed:", error);
        }
    };

    const confirmStopRecording = useCallback((): void => {
        if (stoppingRecording) {
            return;
        }

        Alert.alert(
            "自動記録を停止しますか？",
            "自動記録を停止すると、このアクティビティの位置情報記録が終了します。",
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
    }, [handleStopRecording, stoppingRecording]);

    useEffect(() => {
        if (!continuationPrompt?.confirmationRequired) {
            continuationAlertKeyRef.current = null;
            return;
        }

        const alertKey = `${continuationPrompt.recordingSessionId}:${
            continuationPrompt.confirmationRequestedAt ?? ""
        }`;

        if (continuationAlertKeyRef.current === alertKey) {
            return;
        }

        continuationAlertKeyRef.current = alertKey;

        const messageLines: string[] = [];

        if (continuationPrompt.requestedElapsedHours > 0) {
            messageLines.push(
                `記録開始から${continuationPrompt.requestedElapsedHours}時間経過しています。`,
            );
        }

        if (continuationPrompt.requestedPointMilestone > 0) {
            messageLines.push(
                `${continuationPrompt.savedPointCount.toLocaleString()}ポイント記録しています。`,
            );
        }

        messageLines.push(
            "継続しますか？",
            "3分以内に「継続します」を押さない場合は、自動記録を停止します。",
        );

        Alert.alert(
            "自動記録を継続しますか？",
            messageLines.join("\n"),
            [
                {
                    text: "停止する",
                    style: "destructive",
                    onPress: () => {
                        continuationAlertKeyRef.current = null;
                        void handleStopRecording();
                    },
                },
                {
                    text: "継続します",
                    onPress: () => {
                        continuationAlertKeyRef.current = null;
                        void confirmContinuation();
                    },
                },
            ],
            { cancelable: false },
        );
    }, [continuationPrompt, confirmContinuation, handleStopRecording]);

    useEffect(() => {
        if (!autoStoppedSessionId) {
            handledAutoStoppedSessionIdRef.current = null;
            return;
        }

        if (handledAutoStoppedSessionIdRef.current === autoStoppedSessionId) {
            return;
        }

        handledAutoStoppedSessionIdRef.current = autoStoppedSessionId;

        const finalizeAutoStoppedSession = async () => {
            const stoppedShareOwnerValues = selectedLiveShareUsers
                .map((user) => user.ownerValue)
                .filter((ownerValue): ownerValue is string => !!ownerValue);

            try {
                const continuationState = await getRecordingContinuationState();

                const matchingContinuationState =
                    continuationState?.recordingSessionId ===
                    autoStoppedSessionId
                        ? continuationState
                        : null;

                /*
                 * セッション名入力前でも、自動停止状態を先にDBへ確定する。
                 * 後から名前を保存した場合は同じRecordingSessionを更新する。
                 */
                await upsertRecordingSessionSummary(
                    autoStoppedSessionId,
                    null,
                    stoppedShareOwnerValues,
                    recordIntervalMs,
                    recordDistanceMeters,
                    {
                        lastContinuationConfirmedAt:
                            matchingContinuationState?.lastConfirmedAt ?? null,

                        continuationConfirmationCount:
                            matchingContinuationState?.confirmationCount ?? 0,

                        autoStoppedAt:
                            matchingContinuationState?.autoStoppedAt ??
                            new Date().toISOString(),

                        autoStopReason: "CONTINUATION_TIMEOUT",
                    },
                );
            } catch (error) {
                console.error(
                    "Finalize auto-stopped RecordingSession error:",
                    error,
                );

                /*
                 * RecordingSession更新に失敗しても、
                 * セッション名入力と停止通知は表示する。
                 */
            }

            setPendingSessionId(autoStoppedSessionId);
            setPendingSessionShareOwnerValues(stoppedShareOwnerValues);
            setPendingRecordingIntervalMs(recordIntervalMs);
            setPendingRecordingDistanceMeters(recordDistanceMeters);
            setSessionNameInput("");
            setSessionNameModalVisible(true);

            setLiveShareStatusMessage(
                selectedLiveShareUsers.length > 0
                    ? "継続確認がなかったため自動記録を停止しました。現在地共有は継続中です。"
                    : "継続確認がなかったため自動記録を停止しました。",
            );

            Alert.alert(
                "自動記録を停止しました",
                "継続確認から3分以内に操作がなかったため、自動記録を停止しました。",
            );

            await clearAutoStoppedSession();
        };

        void finalizeAutoStoppedSession();
    }, [
        autoStoppedSessionId,
        clearAutoStoppedSession,
        recordDistanceMeters,
        recordIntervalMs,
        selectedLiveShareUsers,
    ]);

    const backgroundHeartbeatDisplay = useMemo(() => {
        if (!backgroundHeartbeatStatus) {
            return null;
        }

        if (backgroundHeartbeatStatus.invalidStoredValue) {
            return {
                statusText: "保存されたheartbeatが不正です",
                detailLines: [],
            };
        }

        const heartbeat = backgroundHeartbeatStatus.heartbeat;

        if (!heartbeat) {
            return {
                statusText: "heartbeatはまだ記録されていません",
                detailLines: [
                    "バックグラウンドタスクが一度も呼ばれていない可能性があります。",
                ],
            };
        }

        const ageSeconds =
            backgroundHeartbeatStatus.ageMs === null
                ? null
                : Math.floor(backgroundHeartbeatStatus.ageMs / 1000);

        const detailLines = [
            `最終実行: ${formatDateTime(heartbeat.taskFiredAt)}`,
            `経過時間: ${
                ageSeconds === null
                    ? "不明"
                    : ageSeconds < 60
                      ? `${ageSeconds}秒`
                      : `${Math.floor(ageSeconds / 60)}分${ageSeconds % 60}秒`
            }`,
            `受信地点数: ${heartbeat.locationsLength}件`,
            `最終heartbeat時の記録中判定: ${
                heartbeat.isRecording ? "はい" : "いいえ"
            }`,
            `最終heartbeat時のタスクエラー: ${heartbeat.hasTaskError ? "あり" : "なし"}`,
            `セッション一致: ${
                activeRecordingSessionId &&
                heartbeat.recordingSessionId === activeRecordingSessionId
                    ? "一致"
                    : heartbeat.recordingSessionId
                      ? "不一致"
                      : "セッションIDなし"
            }`,
        ];

        return {
            statusText: "heartbeatを取得しました",
            detailLines,
        };
    }, [activeRecordingSessionId, backgroundHeartbeatStatus]);

    const backgroundHeartbeatCheckedAtText =
        backgroundHeartbeatCheckedAt === null
            ? null
            : formatDateTime(
                  new Date(backgroundHeartbeatCheckedAt).toISOString(),
              );

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

    const backfillProgressText = useMemo(() => {
        if (!backfillingSessions) {
            return "";
        }

        if (!backfillProgress) {
            return "処理を開始しています...";
        }

        switch (backfillProgress.phase) {
            case "loadingLocationLogs":
                return backfillProgress.loadedLocationLogCount > 0
                    ? `LocationLogを取得中... ${backfillProgress.loadedLocationLogCount.toLocaleString()}件`
                    : "LocationLogを取得中...";

            case "processingSessions":
                return `${backfillProgress.processedSessionCount} / ${backfillProgress.totalSessionCount} セッション処理中`;

            case "recalculatingAggregates":
                return "月間・トータル集計を更新中...";

            default:
                return "アクティビティ履歴を作成中...";
        }
    }, [backfillingSessions, backfillProgress]);

    const handleBackfillRecordingSessions = async () => {
        if (backfillingSessions || isRecording) {
            return;
        }

        Alert.alert(
            "アクティビティ履歴を作成",
            "過去の位置情報ログからアクティビティ履歴を作成しますか？",
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
                            setBackfillProgress({
                                phase: "loadingLocationLogs",
                                loadedLocationLogCount: 0,
                                processedSessionCount: 0,
                                totalSessionCount: 0,
                                createdOrUpdatedCount: 0,
                                failedCount: 0,
                                currentRecordingSessionId: null,
                            });

                            const result =
                                await backfillRecordingSessionsFromLocationLogs(
                                    (progress) => {
                                        setBackfillProgress(progress);
                                    },
                                );

                            const failureDetails =
                                result.failures.length > 0
                                    ? [
                                          "",
                                          "失敗内容:",
                                          ...result.failures
                                              .slice(0, 3)
                                              .map(
                                                  (failure) =>
                                                      `${failure.recordingSessionId}: ${failure.errorMessage}`,
                                              ),
                                      ]
                                    : [];

                            Alert.alert(
                                "作成完了",
                                [
                                    `LocationLog: ${result.locationLogCount}件`,
                                    `対象セッション: ${result.targetSessionCount}件`,
                                    `作成・更新: ${result.createdOrUpdatedCount}件`,
                                    `失敗: ${result.failedCount}件`,
                                    `対象外ログ: ${result.skippedLogCount}件`,
                                    ...failureDetails,
                                ].join("\n"),
                            );
                        } catch (error) {
                            console.error(
                                "RecordingSession backfill error:",
                                error,
                            );

                            Alert.alert(
                                "作成エラー",
                                "過去ログからアクティビティ履歴を作成できませんでした。",
                            );
                        } finally {
                            setBackfillingSessions(false);
                            setBackfillProgress(null);
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
                        style={[
                            styles.liveShareGroupManageButton,
                            startingRecording && styles.appButtonDisabled,
                        ]}
                        disabled={startingRecording}
                        onPress={() => {
                            navigation.navigate("ShareGroupManagement");
                        }}
                    >
                        <Text style={styles.liveShareGroupManageButtonText}>
                            共有グループを管理
                        </Text>
                    </Pressable>

                    <Pressable
                        style={[
                            styles.liveShareSelectButton,
                            recordingControlsLocked && styles.appButtonDisabled,
                        ]}
                        onPress={openLiveShareModal}
                        disabled={recordingControlsLocked}
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
                            style={[
                                styles.liveShareClearButton,
                                recordingControlsLocked &&
                                    styles.appButtonDisabled,
                            ]}
                            onPress={clearLiveShareUsers}
                            disabled={recordingControlsLocked}
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
                                        disabled={recordingControlsLocked}
                                        style={[
                                            styles.optionButton,
                                            selected &&
                                                styles.optionButtonSelected,
                                            recordingControlsLocked &&
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
                                        disabled={recordingControlsLocked}
                                        style={[
                                            styles.optionButton,
                                            selected &&
                                                styles.optionButtonSelected,
                                            recordingControlsLocked &&
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

                    <View style={styles.backgroundHeartbeatBox}>
                        <Text style={styles.backgroundHeartbeatTitle}>
                            バックグラウンドタスク診断
                        </Text>

                        <Pressable
                            style={({ pressed }) => [
                                styles.backgroundHeartbeatButton,
                                pressed &&
                                    !checkingBackgroundHeartbeat &&
                                    styles.buttonPressed,
                                checkingBackgroundHeartbeat &&
                                    styles.appButtonDisabled,
                            ]}
                            onPress={() => {
                                void handleCheckBackgroundHeartbeat();
                            }}
                            disabled={checkingBackgroundHeartbeat}
                        >
                            <Text style={styles.backgroundHeartbeatButtonText}>
                                {checkingBackgroundHeartbeat
                                    ? "heartbeat確認中..."
                                    : "heartbeatを確認"}
                            </Text>
                        </Pressable>

                        {backgroundHeartbeatDisplay && (
                            <View style={styles.backgroundHeartbeatResult}>
                                <Text
                                    style={styles.backgroundHeartbeatStatusText}
                                >
                                    {backgroundHeartbeatDisplay.statusText}
                                </Text>

                                {backgroundHeartbeatDisplay.detailLines.map(
                                    (line) => (
                                        <Text
                                            key={line}
                                            style={
                                                styles.backgroundHeartbeatDetailText
                                            }
                                        >
                                            {line}
                                        </Text>
                                    ),
                                )}

                                {backgroundHeartbeatCheckedAtText && (
                                    <Text
                                        style={
                                            styles.backgroundHeartbeatCheckedText
                                        }
                                    >
                                        確認時刻:{" "}
                                        {backgroundHeartbeatCheckedAtText}
                                    </Text>
                                )}
                            </View>
                        )}

                        {/* EAS Update診断 */}
                        <Pressable
                            style={({ pressed }) => [
                                styles.easUpdateButton,
                                pressed &&
                                    !checkingEasUpdateInfo &&
                                    styles.buttonPressed,
                                checkingEasUpdateInfo &&
                                    styles.appButtonDisabled,
                            ]}
                            onPress={() => {
                                void handleCheckEasUpdateInfo();
                            }}
                            disabled={checkingEasUpdateInfo}
                        >
                            <Text style={styles.easUpdateButtonText}>
                                {checkingEasUpdateInfo
                                    ? "EAS Update確認中..."
                                    : "EAS Update情報を確認"}
                            </Text>
                        </Pressable>

                        <Pressable
                            style={({ pressed }) => [
                                styles.easUpdateButton,
                                pressed &&
                                    !forcingEasUpdate &&
                                    styles.buttonPressed,
                                forcingEasUpdate && styles.appButtonDisabled,
                            ]}
                            onPress={() => {
                                void handleForceEasUpdate();
                            }}
                            disabled={forcingEasUpdate}
                        >
                            <Text style={styles.easUpdateButtonText}>
                                {forcingEasUpdate
                                    ? "最新EAS Updateを確認中..."
                                    : "最新EAS Updateを適用【確認用3】"}
                            </Text>
                        </Pressable>

                        {easUpdateInfo && (
                            <View style={styles.easUpdateInfoContainer}>
                                <Text style={styles.easUpdateInfoTitle}>
                                    EAS Update情報
                                </Text>

                                <Text style={styles.easUpdateInfoText}>
                                    適用状態:{" "}
                                    {easUpdateInfo.isEmbeddedLaunch
                                        ? "ビルド内蔵版"
                                        : "EAS Update適用済み"}
                                </Text>

                                <Text style={styles.easUpdateInfoText}>
                                    Channel:{" "}
                                    {easUpdateInfo.channel ?? "取得不可"}
                                </Text>

                                <Text style={styles.easUpdateInfoText}>
                                    Runtime Version:{" "}
                                    {easUpdateInfo.runtimeVersion ?? "取得不可"}
                                </Text>

                                <Text
                                    style={styles.easUpdateInfoText}
                                    selectable
                                >
                                    Update ID:{" "}
                                    {easUpdateInfo.updateId ?? "取得不可"}
                                </Text>

                                <Text style={styles.easUpdateInfoText}>
                                    Update作成日時:{" "}
                                    {easUpdateInfo.createdAt
                                        ? formatEasUpdateDateTime(
                                              easUpdateInfo.createdAt,
                                          )
                                        : "取得不可"}
                                </Text>

                                <Text style={styles.easUpdateInfoText}>
                                    expo-updates:{" "}
                                    {easUpdateInfo.isEnabled ? "有効" : "無効"}
                                </Text>
                            </View>
                        )}
                    </View>

                    <View style={styles.autoRecordMapButtonSpace}>
                        <AppButton
                            title="地図で見る"
                            onPress={handleOpenRecordingMap}
                            disabled={!canOpenRecordingMap}
                        />
                    </View>

                    {startingRecording && (
                        <View style={styles.recordingStartingBox}>
                            <ActivityIndicator size="small" />

                            <View style={styles.recordingStartingTextBox}>
                                <Text style={styles.recordingStartingTitle}>
                                    自動記録を開始しています…
                                </Text>

                                <Text
                                    style={styles.recordingStartingDescription}
                                >
                                    バックグラウンド位置情報の準備を確認しています。
                                    この画面を開いたままお待ちください。
                                </Text>
                            </View>
                        </View>
                    )}
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
                        <>
                            <Pressable
                                style={({ pressed }) => [
                                    styles.autoRecordStartButton,
                                    pressed &&
                                        hasLoadedSavedHomeSettings &&
                                        !startingRecording &&
                                        styles.buttonPressed,
                                    (!hasLoadedSavedHomeSettings ||
                                        startingRecording ||
                                        checkingBackgroundLocationPermission ||
                                        !hasBackgroundLocationPermission) &&
                                        styles.appButtonDisabled,
                                ]}
                                onPress={handleStartRecording}
                                disabled={
                                    !hasLoadedSavedHomeSettings ||
                                    startingRecording ||
                                    checkingBackgroundLocationPermission ||
                                    !hasBackgroundLocationPermission
                                }
                            >
                                <Text style={styles.autoRecordButtonText}>
                                    {!hasLoadedSavedHomeSettings
                                        ? "設定を読み込み中..."
                                        : startingRecording
                                          ? "自動記録を開始中..."
                                          : selectedLiveShareUsers.length > 0
                                            ? "自動記録開始＋共有"
                                            : "自動記録開始"}
                                </Text>
                            </Pressable>

                            {!checkingBackgroundLocationPermission &&
                                !hasBackgroundLocationPermission && (
                                    <Text style={styles.permissionWarningText}>
                                        自動記録を開始するには、端末の設定で
                                        位置情報を「常に許可」にしてください。
                                    </Text>
                                )}
                        </>
                    )}
                </View>

                <View style={styles.buttonSpace}>
                    <AppButton
                        title="アクティビティ履歴を見る"
                        onPress={() => navigation.navigate("LocationLog")}
                    />
                </View>
                <View style={styles.buttonSpace}>
                    <AppButton
                        title="アクティビティカレンダー"
                        onPress={() => navigation.navigate("ActivityCalendar")}
                    />
                </View>
                <View style={styles.buttonSpace}>
                    <AppButton
                        title="アクティビティランキングを見る"
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

                <View style={styles.buttonSpace}>
                    <AppButton
                        title="アプリ情報"
                        onPress={() => navigation.navigate("AppInfo")}
                    />
                </View>

                {isAdmin && (
                    <View style={styles.buttonSpace}>
                        <AppButton
                            title="LocationLog CSVインポート"
                            onPress={() =>
                                navigation.navigate("AdminLocationLogImport")
                            }
                            disabled={isRecording}
                            backgroundColor="#27445c"
                        />
                        <AppButton
                            title="SQLite skip理由を確認"
                            onPress={handleDebugSQLiteSkipReasons}
                            backgroundColor="#27445c"
                        />
                        <AppButton
                            title={
                                backfillingSessions
                                    ? backfillProgressText
                                    : "過去ログからアクティビティ履歴を作成"
                            }
                            onPress={handleBackfillRecordingSessions}
                            disabled={backfillingSessions || isRecording}
                            backgroundColor="#27445c"
                        />

                        {backfillingSessions && backfillProgress && (
                            <View style={styles.backfillProgressContainer}>
                                <ActivityIndicator size="small" />

                                <Text style={styles.backfillProgressText}>
                                    {backfillProgressText}
                                </Text>

                                {backfillProgress.phase ===
                                    "processingSessions" &&
                                    backfillProgress.totalSessionCount > 0 && (
                                        <>
                                            <View
                                                style={
                                                    styles.backfillProgressTrack
                                                }
                                            >
                                                <View
                                                    style={[
                                                        styles.backfillProgressBar,
                                                        {
                                                            width: `${Math.min(
                                                                100,
                                                                Math.max(
                                                                    0,
                                                                    (backfillProgress.processedSessionCount /
                                                                        backfillProgress.totalSessionCount) *
                                                                        100,
                                                                ),
                                                            )}%`,
                                                        },
                                                    ]}
                                                />
                                            </View>

                                            <Text
                                                style={
                                                    styles.backfillProgressDetail
                                                }
                                            >
                                                成功:{" "}
                                                {
                                                    backfillProgress.createdOrUpdatedCount
                                                }
                                                件　失敗:{" "}
                                                {backfillProgress.failedCount}件
                                            </Text>
                                        </>
                                    )}
                            </View>
                        )}
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
                                        共有できるグループメンバーがいません。
                                        {"\n"}
                                        「共有グループを管理」からグループを作成するか、
                                        招待コードでグループに参加してください。
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

/*
 * EAS Updateの作成日時表示用。
 * Updateの識別に使うため秒まで表示する。
 */
function formatEasUpdateDateTime(value: string): string {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return value;
    }

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mi = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
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
    recordingStartingBox: {
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        marginTop: 10,
        marginBottom: 4,
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: "#eef3f7",
        borderWidth: 1,
        borderColor: "#c8d6e0",
    },
    recordingStartingTextBox: {
        flex: 1,
    },
    recordingStartingTitle: {
        fontSize: 15,
        fontWeight: "bold",
        color: "#2f4f66",
    },
    recordingStartingDescription: {
        marginTop: 3,
        fontSize: 12,
        lineHeight: 18,
        color: "#666",
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
    backgroundHeartbeatBox: {
        marginTop: 12,
        padding: 12,
        borderWidth: 1,
        borderColor: "#c8d6e0",
        borderRadius: 8,
        backgroundColor: "#f9fbfd",
    },

    backgroundHeartbeatTitle: {
        color: "#333",
        fontSize: 14,
        fontWeight: "bold",
    },

    backgroundHeartbeatButton: {
        marginTop: 8,
        minHeight: 40,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#4b6f8f",
        paddingHorizontal: 12,
        paddingVertical: 8,
    },

    backgroundHeartbeatButtonText: {
        color: "#fff",
        fontSize: 14,
        fontWeight: "bold",
    },

    backgroundHeartbeatResult: {
        marginTop: 10,
        padding: 10,
        borderRadius: 8,
        backgroundColor: "#eef3f7",
    },

    backgroundHeartbeatStatusText: {
        color: "#2f4f66",
        fontSize: 13,
        fontWeight: "bold",
    },

    backgroundHeartbeatDetailText: {
        marginTop: 4,
        color: "#444",
        fontSize: 12,
        lineHeight: 18,
    },

    backgroundHeartbeatCheckedText: {
        marginTop: 8,
        color: "#777",
        fontSize: 11,
    },

    easUpdateButton: {
        marginTop: 12,
        minHeight: 40,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#4b6f8f",
        paddingHorizontal: 12,
        paddingVertical: 8,
    },

    easUpdateButtonText: {
        color: "#fff",
        fontSize: 14,
        fontWeight: "bold",
    },

    easUpdateInfoContainer: {
        marginTop: 10,
        padding: 10,
        borderRadius: 8,
        backgroundColor: "#eef3f7",
    },

    easUpdateInfoTitle: {
        color: "#2f4f66",
        fontSize: 13,
        fontWeight: "bold",
        marginBottom: 4,
    },

    easUpdateInfoText: {
        marginTop: 4,
        color: "#444",
        fontSize: 12,
        lineHeight: 18,
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

    backfillProgressContainer: {
        marginTop: 10,
        alignItems: "center",
    },

    backfillProgressText: {
        marginTop: 8,
        fontSize: 14,
        fontWeight: "600",
        color: "#27445c",
        textAlign: "center",
    },

    backfillProgressTrack: {
        width: "100%",
        height: 8,
        marginTop: 10,
        overflow: "hidden",
        borderRadius: 4,
        backgroundColor: "#d9e1e8",
    },

    backfillProgressBar: {
        height: "100%",
        borderRadius: 4,
        backgroundColor: "#27445c",
    },

    backfillProgressDetail: {
        marginTop: 6,
        fontSize: 12,
        color: "#5f6f7c",
        textAlign: "center",
    },

    permissionWarningText: {
        marginTop: 8,
        fontSize: 12,
        color: "#b42318",
        lineHeight: 18,
    },

    liveShareGroupManageButton: {
        borderWidth: 1,
        borderColor: "#4b6f8f",
        borderRadius: 8,
        paddingVertical: 8,
        paddingHorizontal: 12,
        alignItems: "center",
        backgroundColor: "#fff",
    },

    liveShareGroupManageButtonText: {
        color: "#4b6f8f",
        fontSize: 14,
        fontWeight: "bold",
    },
});
