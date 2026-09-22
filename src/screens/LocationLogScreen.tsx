import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTour, useTourTarget } from "guideway";
import { getCurrentUser } from "aws-amplify/auth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Image,
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
import { useSubscription } from "../hooks/useSubscription";
import type { RootStackParamList } from "../navigation/RootNavigator";
import {
    ACTIVITY_TYPES,
    ACTIVITY_TYPE_LABELS,
    type ActivityType,
    normalizeActivityType,
} from "../services/activityClassificationService";
import {
    recalculateCurrentUserActivityAggregates,
    recalculateCurrentUserSubscriptionUsage,
    updateRecordingSessionActivityType,
} from "../services/recordingSessionService";
import { getUrl } from "aws-amplify/storage";

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
    source?: string | null;
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
    foregroundPointCount: number;
    backgroundPointCount: number;
    recordingIntervalMs?: number | null;
    recordingDistanceMeters?: number | null;
    startBatteryLevel?: number | null;
    endBatteryLevel?: number | null;
    sharedOwners: string[];
    sortAt: string;
    activityType: ActivityType;
    isAggregationTarget: boolean;
    classificationSource?: string | null;
    classificationReason?: string | null;
    averageSpeedKmh?: number | null;
    maxSpeedKmh?: number | null;
    movingDurationSeconds?: number | null;
};

type SessionPointCounts = {
    pointCount: number;
    foregroundPointCount: number;
    backgroundPointCount: number;
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

type RecordingSessionListResult = {
    data?: any[] | null;
    errors?: unknown;
    nextToken?: string | null;
};

type HistoryViewMode = "mine" | "shared";

const SESSION_PAGE_SIZE = 15;

export default function LocationLogScreen({ navigation, route }: Props) {
    const { start: startTour } = useTour();
    const { isPremium } = useSubscription();
    const activityHistorySearchTourRef = useTourTarget(
        "activity-history-search",
    );
    const activityHistoryListTourRef = useTourTarget("activity-history-list");
    const activityHistoryCardTourRef = useTourTarget("activity-history-card");
    const activityHistoryActionsTourRef = useTourTarget(
        "activity-history-actions",
    );
    const [loading, setLoading] = useState(false);
    const [historyViewMode, setHistoryViewMode] =
        useState<HistoryViewMode>("mine");
    const [sharedRecordingSessions, setSharedRecordingSessions] = useState<
        RecordingSessionDisplayItem[]
    >([]);
    const [
        sharedRecordingSessionTotalCount,
        setSharedRecordingSessionTotalCount,
    ] = useState(0);
    const [loadingSharedSessions, setLoadingSharedSessions] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [searchText, setSearchText] = useState("");
    const [userProfiles, setUserProfiles] = useState<UserProfileItem[]>([]);
    const [recordingSessions, setRecordingSessions] = useState<
        RecordingSessionDisplayItem[]
    >([]);
    const [recordingSessionTotalCount, setRecordingSessionTotalCount] =
        useState<number | null>(null);
    const [recordingSessionNextToken, setRecordingSessionNextToken] = useState<
        string | null
    >(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [updatingActivitySessionId, setUpdatingActivitySessionId] = useState<
        string | null
    >(null);
    const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(
        () => new Set(),
    );

    const toggleSessionExpanded = useCallback((sessionId: string) => {
        setExpandedSessionIds((current) => {
            const next = new Set(current);

            if (next.has(sessionId)) {
                next.delete(sessionId);
            } else {
                next.add(sessionId);
            }

            return next;
        });
    }, []);
    const [shareModalVisible, setShareModalVisible] = useState(false);
    const [shareSearchText, setShareSearchText] = useState("");
    const [shareUsers, setShareUsers] = useState<UserProfileItem[]>([]);
    const [selectedShareUsers, setSelectedShareUsers] = useState<
        UserProfileItem[]
    >([]);
    const [shareUserIconUrls, setShareUserIconUrls] = useState<
        Record<string, string | null>
    >({});
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
    /*
     * 地図から戻ったときに、
     * 参照していたアクティビティを一覧の先頭へ戻すために保持する。
     */
    const returnAnchorSessionRef = useRef<RecordingSessionDisplayItem | null>(
        null,
    );

    /*
     * 地図から戻った後の一覧で、
     * 「もっと見る」を押した場合も同じ時点より過去を取得するための上限。
     *
     * null:
     *   通常の最新履歴表示
     *
     * string:
     *   このendedAtより古い履歴だけを取得
     */
    const [recordingSessionBeforeEndAt, setRecordingSessionBeforeEndAt] =
        useState<string | null>(null);
    /*
     * アクティビティ一覧のスクロール制御用。
     */
    const recordingSessionListRef =
        useRef<FlatList<RecordingSessionDisplayItem> | null>(null);

    /*
     * 地図から戻ったあと、一覧データの反映後に
     * 先頭へスクロールする必要があるかを保持する。
     */
    const shouldScrollToReturnAnchorRef = useRef(false);

    const loadRecordingSessions = useCallback(
        async ({
            reset,
            nextToken,
            beforeEndAt = null,
            prependSession = null,
        }: {
            reset: boolean;
            nextToken?: string | null;
            beforeEndAt?: string | null;
            prependSession?: RecordingSessionDisplayItem | null;
        }) => {
            try {
                if (reset) {
                    setLoading(true);
                    setRecordingSessionNextToken(null);
                } else {
                    setLoadingMore(true);
                }

                const currentUser = await getCurrentUser();

                const recordingSessionModel = client.models
                    .RecordingSession as any;

                /*
                 * 地図から戻った直後は、
                 *
                 *   選択したsession 1件
                 *   +
                 *   それより古いsession 14件
                 *
                 * の合計15件にする。
                 */
                const pageLimit =
                    reset && prependSession
                        ? Math.max(1, SESSION_PAGE_SIZE - 1)
                        : SESSION_PAGE_SIZE;

                const queryParams: {
                    userId: string;
                    endedAt?: {
                        lt: string;
                    };
                    sortDirection: "DESC";
                    limit: number;
                    nextToken?: string;
                } = {
                    userId: currentUser.userId,
                    sortDirection: "DESC",
                    limit: pageLimit,
                };

                if (beforeEndAt) {
                    queryParams.endedAt = {
                        lt: beforeEndAt,
                    };
                }

                if (!reset && nextToken) {
                    queryParams.nextToken = nextToken;
                }

                const result =
                    (await recordingSessionModel.listRecordingSessionsByUserAndEndedAt(
                        queryParams,
                    )) as RecordingSessionListResult;

                if (result.errors) {
                    console.error(
                        "RecordingSession index query errors:",
                        result.errors,
                    );

                    Alert.alert(
                        "取得エラー",
                        "アクティビティ履歴を取得できませんでした。",
                    );

                    return;
                }

                const loadedItems = await Promise.all(
                    (result.data ?? []).map(
                        async (
                            item: any,
                        ): Promise<RecordingSessionDisplayItem> => {
                            const pointCounts = await loadSessionPointCounts(
                                item.recordingSessionId,
                            );

                            return {
                                kind: "session",
                                id: item.id,
                                userId: item.userId ?? "",
                                recordingSessionId: item.recordingSessionId,

                                recordingSessionName:
                                    item.recordingSessionName ??
                                    "自動記録アクティビティ",

                                startAt: item.startedAt,
                                endAt: item.endedAt,

                                distanceMeters: Number(
                                    item.distanceMeters ?? 0,
                                ),

                                pointCount: pointCounts.pointCount,

                                foregroundPointCount:
                                    pointCounts.foregroundPointCount,

                                backgroundPointCount:
                                    pointCounts.backgroundPointCount,

                                recordingIntervalMs:
                                    item.recordingIntervalMs !== null &&
                                    item.recordingIntervalMs !== undefined &&
                                    Number.isFinite(
                                        Number(item.recordingIntervalMs),
                                    )
                                        ? Number(item.recordingIntervalMs)
                                        : null,

                                recordingDistanceMeters:
                                    item.recordingDistanceMeters !== null &&
                                    item.recordingDistanceMeters !==
                                        undefined &&
                                    Number.isFinite(
                                        Number(item.recordingDistanceMeters),
                                    )
                                        ? Number(item.recordingDistanceMeters)
                                        : null,

                                startBatteryLevel:
                                    item.startBatteryLevel !== null &&
                                    item.startBatteryLevel !== undefined &&
                                    Number.isFinite(
                                        Number(item.startBatteryLevel),
                                    )
                                        ? Number(item.startBatteryLevel)
                                        : null,

                                endBatteryLevel:
                                    item.endBatteryLevel !== null &&
                                    item.endBatteryLevel !== undefined &&
                                    Number.isFinite(
                                        Number(item.endBatteryLevel),
                                    )
                                        ? Number(item.endBatteryLevel)
                                        : null,

                                sharedOwners: Array.isArray(item.sharedOwners)
                                    ? item.sharedOwners.filter(
                                          (owner: unknown): owner is string =>
                                              typeof owner === "string" &&
                                              owner.length > 0,
                                      )
                                    : [],

                                activityType: normalizeActivityType(
                                    item.activityType,
                                ),

                                isAggregationTarget:
                                    item.isAggregationTarget === true,

                                classificationSource:
                                    item.classificationSource ?? null,

                                classificationReason:
                                    item.classificationReason ?? null,

                                averageSpeedKmh:
                                    item.averageSpeedKmh == null
                                        ? null
                                        : Number(item.averageSpeedKmh),

                                maxSpeedKmh:
                                    item.maxSpeedKmh == null
                                        ? null
                                        : Number(item.maxSpeedKmh),

                                movingDurationSeconds:
                                    item.movingDurationSeconds == null
                                        ? null
                                        : Number(item.movingDurationSeconds),

                                sortAt: item.endedAt,
                            };
                        },
                    ),
                );

                const nextItems = loadedItems.filter(
                    (item) =>
                        Boolean(item.recordingSessionId) &&
                        Boolean(item.startAt) &&
                        Boolean(item.endAt),
                );

                /*
                 * 地図から戻った場合、
                 * prependSession は地図を開く前の古い表示データなので、
                 * LocationLogの最新件数を再取得して更新する。
                 */
                let refreshedPrependSession: RecordingSessionDisplayItem | null =
                    null;

                if (prependSession) {
                    const pointCounts = await loadSessionPointCounts(
                        prependSession.recordingSessionId,
                    );

                    refreshedPrependSession = {
                        ...prependSession,
                        pointCount: pointCounts.pointCount,
                        foregroundPointCount: pointCounts.foregroundPointCount,
                        backgroundPointCount: pointCounts.backgroundPointCount,
                    };

                    console.log(
                        "[LocationLogScreen] Refreshed return session point count:",
                        {
                            recordingSessionId:
                                prependSession.recordingSessionId,
                            oldPointCount: prependSession.pointCount,
                            newPointCount: pointCounts.pointCount,
                            foregroundPointCount:
                                pointCounts.foregroundPointCount,
                            backgroundPointCount:
                                pointCounts.backgroundPointCount,
                        },
                    );
                }

                setRecordingSessions((currentItems) => {
                    if (reset) {
                        /*
                         * 地図から戻った場合は、
                         * 最新ポイント数へ更新した参照sessionを先頭に置く。
                         */
                        if (refreshedPrependSession) {
                            return [
                                refreshedPrependSession,
                                ...nextItems,
                            ].slice(0, SESSION_PAGE_SIZE);
                        }

                        /*
                         * 通常表示では最新15件。
                         */
                        return nextItems;
                    }

                    const itemMap = new Map<
                        string,
                        RecordingSessionDisplayItem
                    >();

                    currentItems.forEach((item) => {
                        itemMap.set(item.id, item);
                    });

                    nextItems.forEach((item) => {
                        itemMap.set(item.id, item);
                    });

                    return Array.from(itemMap.values());
                });

                setRecordingSessionNextToken(result.nextToken ?? null);
            } catch (error) {
                console.error("RecordingSession index query error:", error);

                Alert.alert(
                    "取得エラー",
                    "アクティビティ履歴の取得に失敗しました。",
                );
            } finally {
                setLoading(false);
                setLoadingMore(false);
            }
        },
        [],
    );

    const loadSharedRecordingSessions = useCallback(async () => {
        try {
            setLoadingSharedSessions(true);

            const currentUser = await getCurrentUser();

            /*
             * 現在ユーザーの共有用ownerValueを取得する。
             */
            const userProfileModel = client.models.UserProfile as any;

            const profileResult = await userProfileModel.list({
                filter: {
                    userId: {
                        eq: currentUser.userId,
                    },
                },
                limit: 10,
            });

            if (profileResult.errors) {
                console.error(
                    "Current UserProfile load errors:",
                    profileResult.errors,
                );

                Alert.alert(
                    "取得エラー",
                    "共有用ユーザー情報を取得できませんでした。",
                );

                return;
            }

            const currentProfile =
                (profileResult.data ?? []).find(
                    (profile: any) =>
                        profile?.userId === currentUser.userId &&
                        typeof profile?.ownerValue === "string" &&
                        profile.ownerValue.length > 0,
                ) ?? null;

            const currentOwnerValue = currentProfile?.ownerValue ?? null;

            if (!currentOwnerValue) {
                console.warn(
                    "[LocationLogScreen] Current ownerValue not found.",
                    {
                        userId: currentUser.userId,
                    },
                );

                setSharedRecordingSessions([]);
                setSharedRecordingSessionTotalCount(0);

                return;
            }

            const recordingSessionModel = client.models.RecordingSession as any;

            const allData: any[] = [];

            let nextToken: string | null = null;

            /*
             * RecordingSessionを取得する。
             *
             * authルールによって、
             * 現在ユーザーが参照可能なRecordingSessionだけが
             * 返される前提。
             *
             * sharedOwnersの判定は下で明示的に行う。
             */
            do {
                const result = (await recordingSessionModel.list({
                    limit: 1000,
                    nextToken: nextToken ?? undefined,
                })) as RecordingSessionListResult;

                if (result.errors) {
                    console.error(
                        "Shared RecordingSession list errors:",
                        result.errors,
                    );

                    Alert.alert(
                        "取得エラー",
                        "共有されたアクティビティ履歴を取得できませんでした。",
                    );

                    return;
                }

                allData.push(...(result.data ?? []));

                nextToken = result.nextToken ?? null;
            } while (nextToken);

            /*
             * 自分以外のユーザーが所有し、
             * かつsharedOwnersに自分のownerValueが
             * 入っているものだけを対象にする。
             */
            const sharedRawSessions = allData
                .filter((item: any) => {
                    if (!item) {
                        return false;
                    }

                    /*
                     * 自分自身のRecordingSessionは
                     * 「共有された履歴」には出さない。
                     */
                    if (item.userId === currentUser.userId) {
                        return false;
                    }

                    if (!Array.isArray(item.sharedOwners)) {
                        return false;
                    }

                    if (!item.sharedOwners.includes(currentOwnerValue)) {
                        return false;
                    }

                    return (
                        typeof item.recordingSessionId === "string" &&
                        item.recordingSessionId.length > 0 &&
                        typeof item.startedAt === "string" &&
                        typeof item.endedAt === "string"
                    );
                })
                .sort((a: any, b: any) => {
                    return (
                        new Date(b.endedAt).getTime() -
                        new Date(a.endedAt).getTime()
                    );
                });

            /*
             * RecordingSessionDisplayItemへ変換する。
             */
            const loadedItems = await Promise.all(
                sharedRawSessions.map(
                    async (item: any): Promise<RecordingSessionDisplayItem> => {
                        /*
                         * LocationLog側もsharedOwnersで共有されているため、
                         * 共有先ユーザーでもGSIからポイント数を取得できる。
                         */
                        const pointCounts = await loadSessionPointCounts(
                            item.recordingSessionId,
                        );

                        return {
                            kind: "session",

                            id: item.id,

                            userId: item.userId ?? "",

                            recordingSessionId: item.recordingSessionId,

                            recordingSessionName:
                                item.recordingSessionName ??
                                "共有アクティビティ",

                            startAt: item.startedAt,

                            endAt: item.endedAt,

                            distanceMeters: Number(item.distanceMeters ?? 0),

                            pointCount: pointCounts.pointCount,

                            foregroundPointCount:
                                pointCounts.foregroundPointCount,

                            backgroundPointCount:
                                pointCounts.backgroundPointCount,

                            recordingIntervalMs:
                                item.recordingIntervalMs != null &&
                                Number.isFinite(
                                    Number(item.recordingIntervalMs),
                                )
                                    ? Number(item.recordingIntervalMs)
                                    : null,

                            recordingDistanceMeters:
                                item.recordingDistanceMeters != null &&
                                Number.isFinite(
                                    Number(item.recordingDistanceMeters),
                                )
                                    ? Number(item.recordingDistanceMeters)
                                    : null,

                            startBatteryLevel:
                                item.startBatteryLevel != null &&
                                Number.isFinite(Number(item.startBatteryLevel))
                                    ? Number(item.startBatteryLevel)
                                    : null,

                            endBatteryLevel:
                                item.endBatteryLevel != null &&
                                Number.isFinite(Number(item.endBatteryLevel))
                                    ? Number(item.endBatteryLevel)
                                    : null,

                            sharedOwners: Array.isArray(item.sharedOwners)
                                ? item.sharedOwners.filter(
                                      (owner: unknown): owner is string =>
                                          typeof owner === "string" &&
                                          owner.length > 0,
                                  )
                                : [],

                            activityType: normalizeActivityType(
                                item.activityType,
                            ),

                            isAggregationTarget:
                                item.isAggregationTarget === true,

                            classificationSource:
                                item.classificationSource ?? null,

                            classificationReason:
                                item.classificationReason ?? null,

                            averageSpeedKmh:
                                item.averageSpeedKmh == null
                                    ? null
                                    : Number(item.averageSpeedKmh),

                            maxSpeedKmh:
                                item.maxSpeedKmh == null
                                    ? null
                                    : Number(item.maxSpeedKmh),

                            movingDurationSeconds:
                                item.movingDurationSeconds == null
                                    ? null
                                    : Number(item.movingDurationSeconds),

                            sortAt: item.endedAt,
                        };
                    },
                ),
            );

            console.log("[LocationLogScreen] Shared sessions loaded:", {
                ownerValue: currentOwnerValue,
                totalReadableSessionCount: allData.length,
                sharedSessionCount: loadedItems.length,
            });

            setSharedRecordingSessions(loadedItems);

            setSharedRecordingSessionTotalCount(loadedItems.length);
        } catch (error) {
            console.error("Shared RecordingSession load error:", error);

            Alert.alert(
                "取得エラー",
                "共有されたアクティビティ履歴の取得に失敗しました。",
            );
        } finally {
            setLoadingSharedSessions(false);
        }
    }, []);

    const loadRecordingSessionTotalCount = useCallback(async () => {
        try {
            const currentUser = await getCurrentUser();

            const recordingSessionModel = client.models.RecordingSession as any;

            let nextToken: string | null = null;
            let totalCount = 0;

            do {
                const result =
                    (await recordingSessionModel.listRecordingSessionsByUserAndEndedAt(
                        {
                            userId: currentUser.userId,
                            sortDirection: "DESC",
                            limit: 1000,
                            nextToken: nextToken ?? undefined,
                        },
                    )) as RecordingSessionListResult;

                if (result.errors) {
                    console.error(
                        "RecordingSession total count index errors:",
                        result.errors,
                    );
                    return;
                }

                const validItems = (result.data ?? []).filter(
                    (item: any) =>
                        !!item.recordingSessionId &&
                        !!item.startedAt &&
                        !!item.endedAt,
                );

                totalCount += validItems.length;
                nextToken = result.nextToken ?? null;
            } while (nextToken);

            setRecordingSessionTotalCount(totalCount);
        } catch (error) {
            console.error("RecordingSession total count load error:", error);
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

    const filteredItems = useMemo(() => {
        const sourceItems =
            historyViewMode === "mine"
                ? recordingSessions
                : sharedRecordingSessions;

        const keyword = searchText.trim().toLowerCase();

        if (!keyword) {
            return sourceItems;
        }

        return sourceItems.filter((item) => {
            const ownerName = getUserDisplayName(item.userId).toLowerCase();

            return (
                item.recordingSessionName.toLowerCase().includes(keyword) ||
                item.recordingSessionId.toLowerCase().includes(keyword) ||
                ownerName.includes(keyword)
            );
        });
    }, [
        historyViewMode,
        recordingSessions,
        sharedRecordingSessions,
        searchText,
        getUserDisplayName,
    ]);

    const hasMoreItems =
        historyViewMode === "mine" &&
        searchText.trim().length === 0 &&
        recordingSessionNextToken !== null;

    const loadMoreItems = useCallback(() => {
        if (
            historyViewMode !== "mine" ||
            loadingMore ||
            !recordingSessionNextToken
        ) {
            return;
        }

        void loadRecordingSessions({
            reset: false,
            nextToken: recordingSessionNextToken,
            beforeEndAt: recordingSessionBeforeEndAt,
            prependSession: null,
        });
    }, [
        historyViewMode,
        loadingMore,
        recordingSessionNextToken,
        recordingSessionBeforeEndAt,
        loadRecordingSessions,
    ]);

    const handleRefresh = useCallback(() => {
        returnAnchorSessionRef.current = null;
        shouldScrollToReturnAnchorRef.current = false;

        if (historyViewMode === "shared") {
            void loadSharedRecordingSessions();
            void loadUserProfiles();

            return;
        }

        setRecordingSessionNextToken(null);
        setRecordingSessionBeforeEndAt(null);

        void loadRecordingSessions({
            reset: true,
            nextToken: null,
            beforeEndAt: null,
            prependSession: null,
        });

        void loadRecordingSessionTotalCount();
        void loadUserProfiles();
    }, [
        historyViewMode,
        loadRecordingSessions,
        loadRecordingSessionTotalCount,
        loadSharedRecordingSessions,
        loadUserProfiles,
    ]);

    const handleChangeHistoryViewMode = useCallback(
        (mode: HistoryViewMode) => {
            if (mode === historyViewMode) {
                return;
            }

            setHistoryViewMode(mode);

            setSearchText("");

            setExpandedSessionIds(new Set());

            returnAnchorSessionRef.current = null;

            shouldScrollToReturnAnchorRef.current = false;

            recordingSessionListRef.current?.scrollToOffset({
                offset: 0,
                animated: false,
            });

            if (mode === "shared") {
                void loadSharedRecordingSessions();
            }
        },
        [historyViewMode, loadSharedRecordingSessions],
    );

    const toggleShareUser = useCallback((user: UserProfileItem) => {
        setSelectedShareUsers((currentUsers) => {
            const alreadySelected = currentUsers.some(
                (selectedUser) => selectedUser.id === user.id,
            );

            if (alreadySelected) {
                return currentUsers.filter(
                    (selectedUser) => selectedUser.id !== user.id,
                );
            }

            return [...currentUsers, user];
        });
    }, []);

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
        if (historyViewMode === "mine") {
            returnAnchorSessionRef.current = item;
        } else {
            returnAnchorSessionRef.current = null;
        }

        navigation.push("LocationMap", {
            recordingSessionId: item.recordingSessionId,

            isSharedActivityHistory: historyViewMode === "shared",
        });
    };

    const listLocationLogsBySessionId = useCallback(
        async (recordingSessionId: string): Promise<LocationLogItem[]> => {
            const allData: any[] = [];
            let nextToken: string | null = null;

            const locationLogModel = client.models.LocationLog as any;

            do {
                const result =
                    (await locationLogModel.listLocationLogsBySessionAndRecordedAt(
                        {
                            recordingSessionId,
                            sortDirection: "ASC",
                            limit: 1000,
                            nextToken: nextToken ?? undefined,
                        },
                    )) as LocationLogListResult;

                if (result.errors) {
                    console.error(
                        "LocationLog session GSI query errors:",
                        result.errors,
                        {
                            recordingSessionId,
                        },
                    );

                    throw new Error("LocationLog session query failed");
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
                        source: log.source ?? null,
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
                .sort(
                    (a, b) =>
                        new Date(a.recordedAt).getTime() -
                        new Date(b.recordedAt).getTime(),
                );
        },
        [],
    );

    const handleChangeActivityType = (item: RecordingSessionDisplayItem) => {
        if (!isPremium) {
            Alert.alert(
                "Premium機能",
                "アクティビティの区分変更はPremiumプランで利用できます。",
            );

            return;
        }

        Alert.alert(
            "アクティビティ区分を変更",
            "徒歩・ランニングはランキング集計対象です。自転車・乗り物・複合移動・未判定は集計対象外です。",
            [
                ...ACTIVITY_TYPES.map((activityType) => ({
                    text: ACTIVITY_TYPE_LABELS[activityType],
                    onPress: () => {
                        void saveActivityType(item, activityType);
                    },
                })),
                {
                    text: "キャンセル",
                    style: "cancel" as const,
                },
            ],
        );
    };

    const saveActivityType = async (
        item: RecordingSessionDisplayItem,
        activityType: ActivityType,
    ) => {
        if (!isPremium) {
            return;
        }

        try {
            setUpdatingActivitySessionId(item.id);

            await updateRecordingSessionActivityType(
                item.recordingSessionId,
                activityType,
            );

            setRecordingSessions((currentSessions) =>
                currentSessions.map((session) =>
                    session.id === item.id
                        ? {
                              ...session,
                              activityType,
                              isAggregationTarget:
                                  activityType === "WALKING" ||
                                  activityType === "RUNNING",
                              classificationSource: "MANUAL",
                              classificationReason:
                                  "ユーザーが手動で区分を変更しました。",
                          }
                        : session,
                ),
            );
        } catch (error) {
            console.error("Activity type update error:", error);
            Alert.alert(
                "区分変更エラー",
                "アクティビティ区分を変更できませんでした。",
            );
        } finally {
            setUpdatingActivitySessionId(null);
        }
    };

    const handleDeleteSession = (item: RecordingSessionDisplayItem) => {
        Alert.alert(
            "自動記録アクティビティを削除",
            `${formatDateTime(item.startAt)} 〜 ${formatDateTime(
                item.endAt,
            )} の自動記録アクティビティを削除しますか？\n\n記録ポイント ${item.pointCount}件が削除されます。`,
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
                    "自動記録アクティビティを削除できませんでした。",
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
                    "位置履歴は削除しましたが、アクティビティ集計情報の削除に失敗しました。",
                );
                return;
            }

            setRecordingSessions((currentSessions) =>
                currentSessions.filter((session) => session.id !== item.id),
            );

            setRecordingSessionTotalCount((currentCount) =>
                currentCount === null ? null : Math.max(0, currentCount - 1),
            );
            await recalculateCurrentUserSubscriptionUsage();
            await recalculateCurrentUserActivityAggregates();
        } catch (error) {
            console.error("RecordingSession delete error:", error);
            Alert.alert(
                "削除エラー",
                "自動記録アクティビティの削除に失敗しました。",
            );
        } finally {
            setDeletingId(null);
        }
    };

    const openShareModal = (item: RecordingSessionDisplayItem) => {
        setSharingSession(item);
        setShareSearchText("");
        setShareUsers([]);
        setSelectedShareUsers([]);
        setShareUserIconUrls({});
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
        setSelectedShareUsers([]);
        setShareUserIconUrls({});
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
                    iconImagePath: user.iconImagePath ?? null,
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

            const iconEntries = await Promise.all(
                users.map(async (user) => {
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
                        console.error("Load share user icon error:", {
                            userId: user.userId,
                            iconImagePath: user.iconImagePath,
                            error,
                        });

                        return [user.id, null] as const;
                    }
                }),
            );

            setShareUserIconUrls(Object.fromEntries(iconEntries));

            setShareUsers(users);
            setSelectedShareUsers([]);
        } catch (error) {
            console.error("UserProfile list error:", error);
            Alert.alert("取得エラー", "共有先ユーザーの取得に失敗しました。");
        } finally {
            setShareSearching(false);
        }
    }, []);

    const shareSessionWithSelectedUsers = async () => {
        if (!sharingSession) {
            return;
        }

        const selectedOwnerValues = selectedShareUsers
            .map((user) => user.ownerValue)
            .filter(
                (ownerValue): ownerValue is string =>
                    typeof ownerValue === "string" && ownerValue.length > 0,
            );

        if (selectedOwnerValues.length === 0) {
            Alert.alert(
                "共有先未選択",
                "共有するユーザーを1人以上選択してください。",
            );
            return;
        }

        try {
            setSharing(true);

            const sessionLogs = await listLocationLogsBySessionId(
                sharingSession.recordingSessionId,
            );

            const updateResults = await Promise.all(
                sessionLogs.map((log: LocationLogItem) => {
                    const currentSharedOwners = log.sharedOwners ?? [];

                    const nextSharedOwners = Array.from(
                        new Set([
                            ...currentSharedOwners,
                            ...selectedOwnerValues,
                        ]),
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
                new Set([
                    ...currentSessionSharedOwners,
                    ...selectedOwnerValues,
                ]),
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

                Alert.alert(
                    "共有エラー",
                    "アクティビティ情報の共有に失敗しました。",
                );

                return;
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

            Alert.alert(
                "共有完了",
                `${selectedOwnerValues.length}人のユーザーに共有しました。`,
            );

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
        const nextSessionName = trimmedName || "アクティビティ";

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
                    "アクティビティ名を更新できませんでした。",
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

            Alert.alert("保存完了", "アクティビティ名を更新しました。");
            closeEditNameModal();
        } catch (error) {
            console.error("Edit session name error:", error);
            Alert.alert("保存エラー", "アクティビティ名の更新に失敗しました。");
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

    /*
     * 地図から戻った場合、
     * 新しい一覧データがFlatListへ反映されたあとで
     * 参照したアクティビティ（index 0）へスクロールする。
     */
    useEffect(() => {
        if (!shouldScrollToReturnAnchorRef.current) {
            return;
        }

        if (recordingSessions.length === 0) {
            return;
        }

        /*
         * setRecordingSessions直後ではFlatListの描画が
         * まだ完了していない可能性があるため、
         * 次の描画タイミングでスクロールする。
         */
        const frameId = requestAnimationFrame(() => {
            recordingSessionListRef.current?.scrollToOffset({
                offset: 0,
                animated: false,
            });

            shouldScrollToReturnAnchorRef.current = false;
        });

        return () => {
            cancelAnimationFrame(frameId);
        };
    }, [recordingSessions]);

    useFocusEffect(
        useCallback(() => {
            /*
             * 共有履歴表示中は、従来どおり共有履歴を再取得する。
             */
            if (historyViewMode === "shared") {
                returnAnchorSessionRef.current = null;
                shouldScrollToReturnAnchorRef.current = false;

                void loadSharedRecordingSessions();
                void loadUserProfiles();

                return;
            }

            const returnAnchorSession = returnAnchorSessionRef.current;

            /*
             * 一度だけ使用する。
             */
            returnAnchorSessionRef.current = null;

            /*
             * 地図から戻った場合。
             *
             * LocationLogScreen自体はNavigation Stack上に残っているため、
             * 地図を開く前のrecordingSessionsとスクロール位置は保持されている。
             *
             * そのため、
             *
             *   ・RecordingSession 15件の再取得
             *   ・各sessionのLocationLogポイント数再取得
             *   ・総件数の再取得
             *   ・UserProfileの再取得
             *
             * は行わない。
             *
             * 地図画面でポイントを削除した可能性だけを考慮し、
             * 表示していたsession 1件のポイント数だけを更新する。
             */
            if (returnAnchorSession) {
                shouldScrollToReturnAnchorRef.current = false;

                void (async () => {
                    try {
                        const pointCounts = await loadSessionPointCounts(
                            returnAnchorSession.recordingSessionId,
                        );

                        setRecordingSessions((currentSessions) =>
                            currentSessions.map((session) => {
                                if (session.id !== returnAnchorSession.id) {
                                    return session;
                                }

                                return {
                                    ...session,
                                    pointCount: pointCounts.pointCount,
                                    foregroundPointCount:
                                        pointCounts.foregroundPointCount,
                                    backgroundPointCount:
                                        pointCounts.backgroundPointCount,
                                };
                            }),
                        );

                        console.log(
                            "[LocationLogScreen] Refreshed return session only:",
                            {
                                recordingSessionId:
                                    returnAnchorSession.recordingSessionId,
                                oldPointCount: returnAnchorSession.pointCount,
                                newPointCount: pointCounts.pointCount,
                                foregroundPointCount:
                                    pointCounts.foregroundPointCount,
                                backgroundPointCount:
                                    pointCounts.backgroundPointCount,
                            },
                        );
                    } catch (error) {
                        /*
                         * 地図から戻る操作自体は成功させる。
                         * ポイント数更新失敗だけで一覧画面をエラーにしない。
                         */
                        console.error(
                            "[LocationLogScreen] Return session point count refresh error:",
                            error,
                        );
                    }
                })();

                return;
            }

            /*
             * 地図から戻った場合ではない通常focus。
             *
             * 初回表示などでは従来どおり最新15件を取得する。
             */
            shouldScrollToReturnAnchorRef.current = false;

            setRecordingSessionNextToken(null);
            setRecordingSessionBeforeEndAt(null);

            void loadRecordingSessions({
                reset: true,
                nextToken: null,
                beforeEndAt: null,
                prependSession: null,
            });

            void loadRecordingSessionTotalCount();
            void loadUserProfiles();
        }, [
            historyViewMode,
            loadSharedRecordingSessions,
            loadRecordingSessions,
            loadRecordingSessionTotalCount,
            loadUserProfiles,
        ]),
    );

    /*
     * 「アプリ情報」→「使い方を見る」などから
     * 明示的に指定された場合だけアクティビティ履歴Tourを再生する。
     */
    useEffect(() => {
        if (!route.params?.startTutorial) {
            return;
        }

        if (historyViewMode !== "mine") {
            return;
        }

        if (loading) {
            return;
        }

        if (recordingSessions.length === 0) {
            return;
        }

        const firstSession = recordingSessions[0];

        /*
         * 操作ボタンのTour targetを表示するため、
         * 先頭アクティビティを展開する。
         */
        setExpandedSessionIds((current) => {
            if (current.has(firstSession.id)) {
                return current;
            }

            const next = new Set(current);
            next.add(firstSession.id);

            return next;
        });

        const timerId = setTimeout(() => {
            /*
             * 二重起動防止のため先にパラメータを解除する。
             */
            navigation.setParams({
                startTutorial: false,
            });

            startTour("activity-history-tutorial");
        }, 500);

        return () => {
            clearTimeout(timerId);
        };
    }, [
        route.params?.startTutorial,
        historyViewMode,
        loading,
        recordingSessions,
        navigation,
        startTour,
    ]);

    return (
        <View style={styles.container}>
            <View style={styles.historyTabContainer}>
                <Pressable
                    style={[
                        styles.historyTabButton,
                        historyViewMode === "mine" &&
                            styles.historyTabButtonActive,
                    ]}
                    onPress={() => handleChangeHistoryViewMode("mine")}
                >
                    <Text
                        style={[
                            styles.historyTabText,
                            historyViewMode === "mine" &&
                                styles.historyTabTextActive,
                        ]}
                    >
                        自分の履歴
                    </Text>
                </Pressable>

                <Pressable
                    style={[
                        styles.historyTabButton,
                        historyViewMode === "shared" &&
                            styles.historyTabButtonActive,
                    ]}
                    onPress={() => handleChangeHistoryViewMode("shared")}
                >
                    <Text
                        style={[
                            styles.historyTabText,
                            historyViewMode === "shared" &&
                                styles.historyTabTextActive,
                        ]}
                    >
                        共有された履歴
                    </Text>
                </Pressable>
            </View>

            <View
                ref={activityHistorySearchTourRef}
                collapsable={false}
                style={styles.searchBox}
            >
                <Text style={styles.searchLabel}>アクティビティ検索</Text>

                <TextInput
                    style={styles.searchInput}
                    value={searchText}
                    onChangeText={setSearchText}
                    placeholder="アクティビティ名で検索"
                    autoCapitalize="none"
                    autoCorrect={false}
                />

                <View style={styles.searchInfoRow}>
                    <Text style={styles.searchInfoText}>
                        表示件数: {filteredItems.length} /{" "}
                        {historyViewMode === "mine"
                            ? (recordingSessionTotalCount ?? "-")
                            : sharedRecordingSessionTotalCount}
                    </Text>

                    {searchText.trim().length > 0 && (
                        <Pressable onPress={clearSearchText}>
                            <Text style={styles.clearText}>クリア</Text>
                        </Pressable>
                    )}
                </View>
            </View>

            {(
                historyViewMode === "mine"
                    ? loading && recordingSessions.length === 0
                    : loadingSharedSessions &&
                      sharedRecordingSessions.length === 0
            ) ? (
                <ActivityIndicator />
            ) : (
                <View
                    ref={activityHistoryListTourRef}
                    collapsable={false}
                    style={styles.historyListContainer}
                >
                    <FlatList
                        ref={recordingSessionListRef}
                        data={filteredItems}
                        keyExtractor={(item) => item.id}
                        refreshControl={
                            <RefreshControl
                                refreshing={
                                    historyViewMode === "mine"
                                        ? loading
                                        : loadingSharedSessions
                                }
                                onRefresh={handleRefresh}
                            />
                        }
                        ListEmptyComponent={
                            <Text style={styles.emptyText}>
                                {searchText.trim().length > 0
                                    ? "検索条件に一致するアクティビティ履歴がありません。"
                                    : historyViewMode === "shared"
                                      ? "共有されたアクティビティはありません。"
                                      : "まだアクティビティ履歴がありません。"}
                            </Text>
                        }
                        ListFooterComponent={
                            hasMoreItems ? (
                                <Pressable
                                    style={({ pressed }) => [
                                        styles.loadMoreButton,
                                        pressed &&
                                            !loadingMore &&
                                            styles.loadMoreButtonPressed,
                                        loadingMore &&
                                            styles.deleteButtonDisabled,
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
                                    すべてのアクティビティ履歴を表示しました。
                                </Text>
                            ) : null
                        }
                        renderItem={({ item, index }) => {
                            const isDeleting = deletingId === item.id;
                            const isExpanded = expandedSessionIds.has(item.id);

                            return (
                                <Pressable
                                    ref={
                                        index === 0
                                            ? activityHistoryCardTourRef
                                            : undefined
                                    }
                                    collapsable={false}
                                    style={({ pressed }) => [
                                        styles.card,
                                        pressed && styles.cardPressed,
                                    ]}
                                    onPress={() =>
                                        toggleSessionExpanded(item.id)
                                    }
                                >
                                    <View style={styles.cardContent}>
                                        {/* タイトル */}
                                        <View style={styles.cardTitleRow}>
                                            <Text
                                                style={styles.dateText}
                                                numberOfLines={1}
                                            >
                                                {item.recordingSessionName}
                                            </Text>

                                            <Text style={styles.expandIcon}>
                                                {isExpanded ? "▲" : "▼"}
                                            </Text>
                                        </View>

                                        {/* 展開時のみユーザーを表示 */}
                                        {(isExpanded ||
                                            historyViewMode === "shared") && (
                                            <Text style={styles.memoText}>
                                                {historyViewMode === "shared"
                                                    ? "共有元"
                                                    : "ユーザー"}
                                                :{" "}
                                                {getUserDisplayName(
                                                    item.userId,
                                                )}
                                            </Text>
                                        )}

                                        {/* 期間：折りたたみ・展開の両方で表示 */}
                                        <Text style={styles.memoText}>
                                            期間:{" "}
                                            {formatPeriod(
                                                item.startAt,
                                                item.endAt,
                                            )}
                                        </Text>

                                        {/* 距離・ポイント：折りたたみ・展開の両方で表示 */}
                                        <Text style={styles.memoText}>
                                            距離:{" "}
                                            {formatDistance(
                                                item.distanceMeters,
                                            )}{" "}
                                            記録ポイント: {item.pointCount}
                                            件（F:
                                            {item.foregroundPointCount}件、B:
                                            {item.backgroundPointCount}件）
                                        </Text>

                                        {/* 以下は展開時のみ表示 */}
                                        {isExpanded && (
                                            <>
                                                <View
                                                    style={
                                                        styles.recordingSettingsBox
                                                    }
                                                >
                                                    <Text
                                                        style={
                                                            styles.recordingSettingsText
                                                        }
                                                    >
                                                        記録頻度:{" "}
                                                        {formatRecordingInterval(
                                                            item.recordingIntervalMs,
                                                        )}
                                                    </Text>

                                                    <Text
                                                        style={
                                                            styles.recordingSettingsText
                                                        }
                                                    >
                                                        記録する移動距離:{" "}
                                                        {formatRecordingDistance(
                                                            item.recordingDistanceMeters,
                                                        )}
                                                    </Text>
                                                </View>

                                                <View
                                                    style={styles.activityBox}
                                                >
                                                    <View
                                                        style={
                                                            styles.activityHeaderRow
                                                        }
                                                    >
                                                        <Text
                                                            style={
                                                                styles.activityLabel
                                                            }
                                                        >
                                                            区分:{" "}
                                                            {
                                                                ACTIVITY_TYPE_LABELS[
                                                                    item
                                                                        .activityType
                                                                ]
                                                            }
                                                        </Text>

                                                        <Text
                                                            style={[
                                                                styles.aggregationBadge,
                                                                item.isAggregationTarget
                                                                    ? styles.aggregationTargetBadge
                                                                    : styles.aggregationExcludedBadge,
                                                            ]}
                                                        >
                                                            {item.isAggregationTarget
                                                                ? "集計対象"
                                                                : "集計対象外"}
                                                        </Text>
                                                    </View>

                                                    {historyViewMode ===
                                                        "mine" && (
                                                        <Text
                                                            style={
                                                                styles.activitySubText
                                                            }
                                                        >
                                                            判定:{" "}
                                                            {item.classificationSource ===
                                                            "MANUAL"
                                                                ? "手動"
                                                                : "自動"}
                                                            {typeof item.averageSpeedKmh ===
                                                                "number" &&
                                                                ` / 平均 ${item.averageSpeedKmh.toFixed(
                                                                    1,
                                                                )}km/h`}
                                                        </Text>
                                                    )}

                                                    {historyViewMode ===
                                                        "mine" && (
                                                        <Pressable
                                                            style={({
                                                                pressed,
                                                            }) => [
                                                                styles.activityChangeButton,
                                                                !isPremium &&
                                                                    styles.activityChangeButtonPremiumLocked,
                                                                pressed &&
                                                                    styles.detailButtonPressed,
                                                                updatingActivitySessionId ===
                                                                    item.id &&
                                                                    styles.deleteButtonDisabled,
                                                            ]}
                                                            onPress={(
                                                                event,
                                                            ) => {
                                                                event.stopPropagation();

                                                                handleChangeActivityType(
                                                                    item,
                                                                );
                                                            }}
                                                            disabled={
                                                                isDeleting ||
                                                                updatingActivitySessionId ===
                                                                    item.id
                                                            }
                                                        >
                                                            <Text
                                                                style={
                                                                    styles.activityChangeButtonText
                                                                }
                                                            >
                                                                {updatingActivitySessionId ===
                                                                item.id
                                                                    ? "区分を更新中..."
                                                                    : isPremium
                                                                      ? "区分を変更"
                                                                      : "区分を変更 ★"}
                                                            </Text>
                                                        </Pressable>
                                                    )}
                                                </View>

                                                {historyViewMode === "mine" &&
                                                    hasBatteryRange(
                                                        item.startBatteryLevel,
                                                        item.endBatteryLevel,
                                                    ) && (
                                                        <Text
                                                            style={
                                                                styles.batteryText
                                                            }
                                                        >
                                                            バッテリー消費:{" "}
                                                            {formatBatteryPercent(
                                                                item.startBatteryLevel,
                                                            )}{" "}
                                                            →{" "}
                                                            {formatBatteryPercent(
                                                                item.endBatteryLevel,
                                                            )}
                                                        </Text>
                                                    )}
                                            </>
                                        )}
                                    </View>

                                    {/* 操作ボタンも展開時のみ表示 */}
                                    {isExpanded && (
                                        <View
                                            ref={
                                                index === 0
                                                    ? activityHistoryActionsTourRef
                                                    : undefined
                                            }
                                            collapsable={false}
                                            style={styles.sessionActionRow}
                                        >
                                            <Pressable
                                                style={({ pressed }) => [
                                                    styles.sessionActionButton,
                                                    pressed &&
                                                        styles.detailButtonPressed,
                                                ]}
                                                onPress={(event) => {
                                                    event.stopPropagation();

                                                    handleOpenSessionMap(item);
                                                }}
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

                                            {historyViewMode === "mine" && (
                                                <>
                                                    <Pressable
                                                        style={({
                                                            pressed,
                                                        }) => [
                                                            styles.sessionActionButton,
                                                            pressed &&
                                                                styles.detailButtonPressed,
                                                        ]}
                                                        onPress={(event) => {
                                                            event.stopPropagation();

                                                            openEditNameModal(
                                                                item,
                                                            );
                                                        }}
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
                                                        style={({
                                                            pressed,
                                                        }) => [
                                                            styles.sessionActionButton,
                                                            pressed &&
                                                                styles.detailButtonPressed,
                                                        ]}
                                                        onPress={(event) => {
                                                            event.stopPropagation();

                                                            openShareModal(
                                                                item,
                                                            );
                                                        }}
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
                                                        style={({
                                                            pressed,
                                                        }) => [
                                                            styles.sessionDeleteButton,
                                                            pressed &&
                                                                !isDeleting &&
                                                                styles.deleteButtonPressed,
                                                            isDeleting &&
                                                                styles.deleteButtonDisabled,
                                                        ]}
                                                        disabled={isDeleting}
                                                        onPress={(event) => {
                                                            event.stopPropagation();

                                                            handleDeleteSession(
                                                                item,
                                                            );
                                                        }}
                                                    >
                                                        <Text
                                                            style={
                                                                styles.sessionDeleteButtonText
                                                            }
                                                            numberOfLines={1}
                                                            adjustsFontSizeToFit
                                                        >
                                                            {isDeleting
                                                                ? "削除中..."
                                                                : "削除"}
                                                        </Text>
                                                    </Pressable>
                                                </>
                                            )}
                                        </View>
                                    )}
                                </Pressable>
                            );
                        }}
                    />
                </View>
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

                        <Text style={styles.shareSelectionText}>
                            選択中: {selectedShareUsers.length}人
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
                                    const selected = selectedShareUsers.some(
                                        (selectedUser) =>
                                            selectedUser.id === user.id,
                                    );

                                    const iconUrl =
                                        shareUserIconUrls[user.id] ?? null;

                                    return (
                                        <Pressable
                                            key={user.id}
                                            style={[
                                                styles.shareUserItem,
                                                selected &&
                                                    styles.shareUserItemSelected,
                                            ]}
                                            onPress={() =>
                                                toggleShareUser(user)
                                            }
                                            disabled={sharing}
                                        >
                                            <View style={styles.shareUserRow}>
                                                {iconUrl ? (
                                                    <Image
                                                        source={{
                                                            uri: iconUrl,
                                                        }}
                                                        style={
                                                            styles.shareUserIcon
                                                        }
                                                    />
                                                ) : (
                                                    <View
                                                        style={
                                                            styles.shareUserIconPlaceholder
                                                        }
                                                    >
                                                        <Text
                                                            style={
                                                                styles.shareUserIconPlaceholderText
                                                            }
                                                        >
                                                            {(
                                                                user.displayName ||
                                                                user.email ||
                                                                "?"
                                                            )
                                                                .trim()
                                                                .slice(0, 1)
                                                                .toUpperCase()}
                                                        </Text>
                                                    </View>
                                                )}

                                                <View
                                                    style={
                                                        styles.shareUserTextContainer
                                                    }
                                                >
                                                    <Text
                                                        style={
                                                            styles.shareUserName
                                                        }
                                                    >
                                                        {user.displayName ||
                                                            "名前未設定"}
                                                    </Text>

                                                    <Text
                                                        style={
                                                            styles.shareUserEmail
                                                        }
                                                    >
                                                        {user.email ||
                                                            "メールなし"}
                                                    </Text>
                                                </View>

                                                <View
                                                    style={[
                                                        styles.shareUserCheckbox,
                                                        selected &&
                                                            styles.shareUserCheckboxSelected,
                                                    ]}
                                                >
                                                    {selected && (
                                                        <Text
                                                            style={
                                                                styles.shareUserCheckboxText
                                                            }
                                                        >
                                                            ✓
                                                        </Text>
                                                    )}
                                                </View>
                                            </View>
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
                                    (sharing ||
                                        selectedShareUsers.length === 0) &&
                                        styles.deleteButtonDisabled,
                                ]}
                                onPress={shareSessionWithSelectedUsers}
                                disabled={
                                    sharing || selectedShareUsers.length === 0
                                }
                            >
                                <Text style={styles.modalPrimaryButtonText}>
                                    {sharing
                                        ? "共有中..."
                                        : selectedShareUsers.length > 0
                                          ? `${selectedShareUsers.length}人に共有する`
                                          : "共有する"}
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
                                アクティビティ名を編集
                            </Text>

                            <Text style={styles.modalDescription}>
                                この自動記録アクティビティの名前を変更します。
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

function formatRecordingInterval(value: number | null | undefined) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "記録なし";
    }

    if (value < 60 * 1000) {
        return `${Math.round(value / 1000)}秒`;
    }

    const minutes = value / 1000 / 60;

    if (Number.isInteger(minutes)) {
        return `${minutes}分`;
    }

    return `${minutes.toFixed(1)}分`;
}

function formatRecordingDistance(value: number | null | undefined) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "記録なし";
    }

    return `${Math.round(value)}m`;
}

function hasBatteryRange(
    startBatteryLevel: number | null | undefined,
    endBatteryLevel: number | null | undefined,
) {
    return (
        typeof startBatteryLevel === "number" &&
        Number.isFinite(startBatteryLevel) &&
        typeof endBatteryLevel === "number" &&
        Number.isFinite(endBatteryLevel)
    );
}

function formatBatteryPercent(value: number | null | undefined) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "-";
    }

    /*
     * expo-battery の batteryLevel は通常0〜1。
     * 過去データが0〜100で保存されていても表示できるようにする。
     */
    const percent = value <= 1 ? value * 100 : value;

    return `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
}

async function loadSessionPointCounts(
    recordingSessionId: string,
): Promise<SessionPointCounts> {
    const locationLogModel = client.models.LocationLog as any;

    const logs: {
        source?: string | null;
    }[] = [];

    let nextToken: string | null = null;

    do {
        /*
         * recordingSessionId + recordedAt のGSIを利用して、
         * 対象アクティビティのLocationLogだけを直接取得する。
         *
         * 従来の
         *   LocationLog.list() + filter(recordingSessionId)
         * ではLocationLog全体を走査する可能性があるため、
         * 一覧表示時のポイント数集計が遅くなりやすい。
         */
        const result =
            (await locationLogModel.listLocationLogsBySessionAndRecordedAt({
                recordingSessionId,
                sortDirection: "ASC",
                limit: 1000,
                nextToken: nextToken ?? undefined,
            })) as LocationLogListResult;

        console.log("[LocationLogScreen] LocationLog point count GSI query:", {
            recordingSessionId,
            dataCount: result.data?.length ?? 0,
            nextToken: result.nextToken ?? null,
            errors: result.errors ?? null,
        });

        if (result.errors) {
            console.error(
                "LocationLog point count GSI query errors:",
                result.errors,
                {
                    recordingSessionId,
                },
            );

            return {
                pointCount: 0,
                foregroundPointCount: 0,
                backgroundPointCount: 0,
            };
        }

        logs.push(...(result.data ?? []));
        nextToken = result.nextToken ?? null;
    } while (nextToken);

    const foregroundPointCount = logs.filter(
        (log) => log.source !== "background",
    ).length;

    const backgroundPointCount = logs.filter(
        (log) => log.source === "background",
    ).length;

    return {
        pointCount: foregroundPointCount + backgroundPointCount,
        foregroundPointCount,
        backgroundPointCount,
    };
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 16,
        backgroundColor: "#f7f7f7",
    },
    historyListContainer: {
        flex: 1,
    },
    historyTabContainer: {
        flexDirection: "row",
        marginBottom: 12,
        padding: 3,
        borderRadius: 10,
        backgroundColor: "#e6e9ec",
    },

    historyTabButton: {
        flex: 1,
        paddingVertical: 10,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
    },

    historyTabButtonActive: {
        backgroundColor: "#4b6f8f",
    },

    historyTabText: {
        color: "#555",
        fontSize: 14,
        fontWeight: "bold",
    },

    historyTabTextActive: {
        color: "#fff",
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
        paddingHorizontal: 14,
        paddingVertical: 10,
        gap: 0,
    },
    cardPressed: {
        opacity: 0.85,
    },

    cardTitleRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
    },

    expandIcon: {
        fontSize: 12,
        color: "#666",
        marginLeft: 8,
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
        marginBottom: 80,
        paddingVertical: 12,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "transparent",
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

    activityBox: {
        marginTop: 8,
        paddingTop: 8,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: "#d9e1e7",
    },
    activityHeaderRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
    },
    activityLabel: {
        flex: 1,
        color: "#333",
        fontSize: 13,
        fontWeight: "bold",
    },
    aggregationBadge: {
        overflow: "hidden",
        paddingVertical: 3,
        paddingHorizontal: 8,
        borderRadius: 999,
        fontSize: 11,
        fontWeight: "bold",
    },
    aggregationTargetBadge: {
        color: "#256029",
        backgroundColor: "#e4f5e6",
    },
    aggregationExcludedBadge: {
        color: "#7a4b00",
        backgroundColor: "#fff2d6",
    },
    activitySubText: {
        marginTop: 4,
        color: "#666",
        fontSize: 12,
    },
    activityChangeButton: {
        alignSelf: "flex-start",
        marginTop: 7,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: "#4b6f8f",
        backgroundColor: "#fff",
    },
    activityChangeButtonPremiumLocked: {
        opacity: 0.55,
        borderStyle: "dashed",
    },
    activityChangeButtonText: {
        color: "#4b6f8f",
        fontSize: 12,
        fontWeight: "bold",
    },
    batteryText: {
        marginTop: 6,
        color: "#555",
        fontSize: 13,
    },
    recordingSettingsBox: {
        marginTop: 6,
        paddingTop: 6,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: "#e0e0e0",

        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 12,
    },

    recordingSettingsText: {
        color: "#555",
        fontSize: 13,
    },

    shareSelectionText: {
        marginTop: -6,
        marginBottom: 10,
        fontSize: 13,
        color: "#666",
    },

    shareUserRow: {
        flexDirection: "row",
        alignItems: "center",
    },

    shareUserIcon: {
        width: 44,
        height: 44,
        borderRadius: 22,
        marginRight: 10,
        backgroundColor: "#e6edf3",
    },

    shareUserIconPlaceholder: {
        width: 44,
        height: 44,
        borderRadius: 22,
        marginRight: 10,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#dbe5ec",
    },

    shareUserIconPlaceholderText: {
        fontSize: 18,
        fontWeight: "bold",
        color: "#2f4f66",
    },

    shareUserTextContainer: {
        flex: 1,
        minWidth: 0,
    },

    shareUserCheckbox: {
        width: 24,
        height: 24,
        marginLeft: 10,
        borderRadius: 12,
        borderWidth: 2,
        borderColor: "#9aaab6",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#fff",
    },

    shareUserCheckboxSelected: {
        borderColor: "#4b6f8f",
        backgroundColor: "#4b6f8f",
    },

    shareUserCheckboxText: {
        color: "#fff",
        fontSize: 15,
        fontWeight: "bold",
    },
});
