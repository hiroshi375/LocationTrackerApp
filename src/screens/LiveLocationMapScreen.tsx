import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    ActivityIndicator,
    Image,
    Pressable,
    StyleSheet,
    Text,
    View,
} from "react-native";
import MapView, { PROVIDER_GOOGLE } from "react-native-maps";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { useSafeAreaInsets } from "react-native-safe-area-context";
import { client } from "../lib/client";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { getCurrentUserProfile } from "../services/userProfileService";
import { getUrl } from "aws-amplify/storage";

type Props = NativeStackScreenProps<RootStackParamList, "LiveLocationMap">;

type LiveLocationItem = {
    id: string;
    userId: string;
    recordingSessionId?: string | null;
    recordingSessionName?: string | null;
    isRecording?: boolean | null;
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    updatedAt: string;
    recordedAt?: string | null;
    isActive: boolean;
    sharedOwners?: string[] | null;
};

export default function LiveLocationMapScreen({ navigation }: Props) {
    const insets = useSafeAreaInsets();
    const isFocused = useIsFocused();
    const mapRef = useRef<MapView | null>(null);
    const [mapReady, setMapReady] = useState(false);
    const [liveLocations, setLiveLocations] = useState<LiveLocationItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [liveLocationScreenPoints, setLiveLocationScreenPoints] = useState<
        Record<string, { x: number; y: number }>
    >({});
    const [userIconUrls, setUserIconUrls] = useState<
        Record<string, string | null>
    >({});
    const [currentOwnerValue, setCurrentOwnerValue] = useState<string | null>(
        null,
    );

    useLayoutEffect(() => {
        navigation.setOptions({
            headerShown: false,
        });
    }, [navigation]);

    useEffect(() => {
        let mounted = true;

        const loadCurrentOwnerValue = async () => {
            try {
                const profile = await getCurrentUserProfile();

                if (mounted) {
                    setCurrentOwnerValue(profile?.ownerValue ?? null);
                }
            } catch (error) {
                console.error("Load current user owner value error:", error);

                if (mounted) {
                    setCurrentOwnerValue(null);
                }
            }
        };

        void loadCurrentOwnerValue();

        return () => {
            mounted = false;
        };
    }, []);

    useEffect(() => {
        if (!currentOwnerValue) {
            setLiveLocations([]);
            setLoading(false);
            return;
        }

        setLoading(true);

        const liveLocationModel = client.models.LiveLocation as any;

        const subscription = liveLocationModel
            .observeQuery({
                filter: {
                    isActive: {
                        eq: true,
                    },
                },
            })
            .subscribe({
                next: ({ items }: { items: any[] }) => {
                    const normalizedItems: LiveLocationItem[] = items
                        .map((item) => ({
                            id: item.id,
                            userId: item.userId ?? "",
                            recordingSessionId: item.recordingSessionId ?? null,
                            recordingSessionName:
                                item.recordingSessionName ?? null,
                            isRecording:
                                typeof item.isRecording === "boolean"
                                    ? item.isRecording
                                    : Boolean(item.recordingSessionId),
                            latitude: Number(item.latitude),
                            longitude: Number(item.longitude),
                            accuracy: item.accuracy ?? null,
                            updatedAt:
                                item.updatedAt ??
                                item.recordedAt ??
                                new Date().toISOString(),
                            recordedAt: item.recordedAt ?? null,
                            isActive: Boolean(item.isActive),
                            sharedOwners: Array.isArray(item.sharedOwners)
                                ? item.sharedOwners
                                : [],
                        }))
                        .filter((item) => {
                            if (!item.isActive) {
                                return false;
                            }

                            if (!item.userId) {
                                return false;
                            }

                            if (
                                !Number.isFinite(item.latitude) ||
                                !Number.isFinite(item.longitude)
                            ) {
                                return false;
                            }

                            return item.sharedOwners?.includes(
                                currentOwnerValue,
                            );
                        })
                        .sort((a, b) => {
                            return (
                                new Date(b.updatedAt).getTime() -
                                new Date(a.updatedAt).getTime()
                            );
                        });

                    /*
                     * 同一ユーザーのLiveLocationが複数isActive=trueで
                     * 残っている場合でも、最新の1件だけ表示する。
                     *
                     * normalizedItemsはupdatedAt降順なので、
                     * 最初に出てきたレコードがそのユーザーの最新。
                     */
                    const latestLocationByUser = new Map<
                        string,
                        LiveLocationItem
                    >();

                    for (const item of normalizedItems) {
                        if (!latestLocationByUser.has(item.userId)) {
                            latestLocationByUser.set(item.userId, item);
                        }
                    }

                    const uniqueLiveLocations = Array.from(
                        latestLocationByUser.values(),
                    );

                    setLiveLocations(uniqueLiveLocations);
                    setLoading(false);
                },
                error: (error: unknown) => {
                    console.error("LiveLocation observe error:", error);
                    setLoading(false);
                },
            });

        return () => {
            subscription.unsubscribe();
        };
    }, [currentOwnerValue]);

    useEffect(() => {
        if (liveLocations.length === 0) {
            setUserIconUrls({});
            return;
        }

        let cancelled = false;

        const loadUserIcons = async () => {
            const uniqueUserIds = [
                ...new Set(
                    liveLocations
                        .map((location) => location.userId)
                        .filter(Boolean),
                ),
            ];

            const entries = await Promise.all(
                uniqueUserIds.map(async (userId) => {
                    try {
                        const userProfileModel = client.models
                            .UserProfile as any;

                        const result = await userProfileModel.list({
                            filter: {
                                userId: {
                                    eq: userId,
                                },
                            },
                            limit: 1000,
                        });

                        if (result.errors) {
                            console.error(
                                "UserProfile icon load errors:",
                                result.errors,
                            );

                            return [userId, null] as const;
                        }

                        const profile =
                            (result.data ?? []).find(
                                (item: any) =>
                                    item.userId === userId &&
                                    !!item.iconImagePath,
                            ) ?? null;

                        if (!profile?.iconImagePath) {
                            return [userId, null] as const;
                        }

                        const urlResult = await getUrl({
                            path: profile.iconImagePath,
                            options: {
                                expiresIn: 3600,
                            },
                        });

                        return [userId, urlResult.url.toString()] as const;
                    } catch (error) {
                        console.error(
                            "Shared user profile icon load error:",
                            userId,
                            error,
                        );

                        return [userId, null] as const;
                    }
                }),
            );

            if (cancelled) {
                return;
            }

            setUserIconUrls(Object.fromEntries(entries));
        };

        void loadUserIcons();

        return () => {
            cancelled = true;
        };
    }, [liveLocations]);

    const latestLiveLocation = useMemo(() => {
        if (liveLocations.length === 0) {
            return null;
        }

        return liveLocations[0];
    }, [liveLocations]);

    useEffect(() => {
        if (isFocused) {
            return;
        }

        setMapReady(false);
        setLiveLocationScreenPoints({});
    }, [isFocused]);

    const updateLiveLocationScreenPoints = useCallback(async () => {
        const currentMap = mapRef.current;

        if (
            !isFocused ||
            !mapReady ||
            !currentMap ||
            liveLocations.length === 0
        ) {
            return;
        }

        try {
            const entries = await Promise.all(
                liveLocations.map(async (location) => {
                    const point = await currentMap.pointForCoordinate({
                        latitude: location.latitude,
                        longitude: location.longitude,
                    });

                    return [
                        location.id,
                        {
                            x: point.x,
                            y: point.y,
                        },
                    ] as const;
                }),
            );

            if (!isFocused) {
                return;
            }

            setLiveLocationScreenPoints(Object.fromEntries(entries));
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);

            if (message.includes("AirMapView.map is not valid") || !isFocused) {
                return;
            }

            console.error("Live location screen point error:", error);
        }
    }, [isFocused, mapReady, liveLocations]);

    useEffect(() => {
        void updateLiveLocationScreenPoints();
    }, [updateLiveLocationScreenPoints]);

    const openLocationMap = (liveLocation: LiveLocationItem) => {
        const sharedLiveIsRecording =
            liveLocation.isRecording === true &&
            Boolean(liveLocation.recordingSessionId);

        navigation.navigate("LocationMap", {
            recordingSessionId: liveLocation.recordingSessionId ?? null,
            sharedLiveUserId: liveLocation.userId,
            sharedLiveLocationId: liveLocation.id,
            sharedLiveIsRecording,
        });
    };

    if (loading) {
        return (
            <View style={styles.center}>
                <ActivityIndicator />
            </View>
        );
    }

    if (!currentOwnerValue) {
        return (
            <View style={styles.center}>
                <Text style={styles.emptyText}>
                    共有用ユーザー情報を取得できませんでした。
                </Text>
            </View>
        );
    }

    if (!latestLiveLocation) {
        return (
            <View style={styles.center}>
                <View style={styles.emptyIconCircle}>
                    <MaterialCommunityIcons
                        name="map-marker-off-outline"
                        size={38}
                        color="#7b8b96"
                    />
                </View>

                <Text style={styles.emptyTitle}>
                    共有中の現在地はありません
                </Text>

                <Text style={styles.emptyDescription}>
                    グループメンバーが現在地の共有を開始すると、
                    ここに表示されます。
                </Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {isFocused ? (
                <MapView
                    ref={mapRef}
                    provider={PROVIDER_GOOGLE}
                    style={styles.map}
                    onMapReady={() => {
                        setMapReady(true);
                    }}
                    onRegionChangeComplete={() => {
                        if (!isFocused) {
                            return;
                        }

                        void updateLiveLocationScreenPoints();
                    }}
                    initialRegion={{
                        latitude: latestLiveLocation.latitude,
                        longitude: latestLiveLocation.longitude,
                        latitudeDelta: 0.01,
                        longitudeDelta: 0.01,
                    }}
                />
            ) : (
                <View style={styles.map} />
            )}

            {isFocused &&
                liveLocations.map((location) => {
                    const screenPoint = liveLocationScreenPoints[location.id];

                    if (!screenPoint) {
                        return null;
                    }

                    const iconUrl = userIconUrls[location.userId] ?? null;

                    return (
                        <Pressable
                            key={location.id}
                            style={[
                                styles.profileOverlayMarker,
                                {
                                    left: screenPoint.x - 35,
                                    top: screenPoint.y - 35,
                                },
                            ]}
                            onPress={() => openLocationMap(location)}
                        >
                            {iconUrl ? (
                                <Image
                                    source={{ uri: iconUrl }}
                                    style={styles.profileOverlayMarkerImage}
                                    resizeMode="cover"
                                    fadeDuration={0}
                                />
                            ) : (
                                <View
                                    style={styles.profileOverlayMarkerFallback}
                                >
                                    <MaterialCommunityIcons
                                        name="account"
                                        size={28}
                                        color="#ffffff"
                                    />
                                </View>
                            )}
                        </Pressable>
                    );
                })}

            <View
                style={[
                    styles.screenHeader,
                    {
                        paddingTop: Math.max(insets.top, 8),
                    },
                ]}
            >
                <Pressable
                    style={styles.screenHeaderButton}
                    onPress={() => navigation.goBack()}
                >
                    <Text style={styles.screenHeaderBackText}>‹</Text>
                </Pressable>

                <Text style={styles.screenHeaderTitle} numberOfLines={1}>
                    共有中の現在地
                </Text>

                <View style={styles.screenHeaderButton} />
            </View>

            <View
                style={[
                    styles.infoBox,
                    {
                        bottom: Math.max(insets.bottom + 8, 16),
                    },
                ]}
            >
                {/* タイトル */}
                <View style={styles.infoHeaderRow}>
                    <View style={styles.infoTitleRow}>
                        <MaterialCommunityIcons
                            name="map-marker-radius-outline"
                            size={23}
                            color="#06395f"
                        />

                        <Text style={styles.infoTitle}>共有中の現在地</Text>
                    </View>

                    <View style={styles.liveBadge}>
                        <View style={styles.liveBadgeDot} />

                        <Text style={styles.liveBadgeText}>LIVE</Text>
                    </View>
                </View>

                {/* 主要情報 */}
                <View style={styles.liveStatsRow}>
                    <View style={styles.liveStatItem}>
                        <MaterialCommunityIcons
                            name="clock-outline"
                            size={22}
                            color="#12b8aa"
                        />

                        <Text style={styles.liveStatLabel}>最終更新</Text>

                        <Text style={styles.liveStatValue}>
                            {formatTime(latestLiveLocation.updatedAt)}
                        </Text>
                    </View>

                    <View style={styles.liveStatsDivider} />

                    <View style={styles.liveStatItem}>
                        <MaterialCommunityIcons
                            name="crosshairs-gps"
                            size={22}
                            color="#12b8aa"
                        />

                        <Text style={styles.liveStatLabel}>精度</Text>

                        <Text style={styles.liveStatValue}>
                            {latestLiveLocation.accuracy !== null &&
                            latestLiveLocation.accuracy !== undefined
                                ? `${Math.round(latestLiveLocation.accuracy)} m`
                                : "-"}
                        </Text>
                    </View>
                </View>

                {/* 詳細情報 */}
                <View style={styles.locationDetailBox}>
                    <View style={styles.locationDetailRow}>
                        <Text style={styles.locationDetailLabel}>更新日時</Text>

                        <Text style={styles.locationDetailValue}>
                            {formatDateTime(latestLiveLocation.updatedAt)}
                        </Text>
                    </View>
                </View>

                {/* ルート表示 */}
                <Pressable
                    style={({ pressed }) => [
                        styles.openMapButton,
                        pressed && styles.openMapButtonPressed,
                    ]}
                    onPress={() => openLocationMap(latestLiveLocation)}
                >
                    <MaterialCommunityIcons
                        name="map-outline"
                        size={21}
                        color="#ffffff"
                    />

                    <Text style={styles.openMapButtonText}>
                        {latestLiveLocation.isRecording
                            ? "ルート地図を表示"
                            : "現在地を地図で表示"}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
}

function formatDateTime(value: string) {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "日時不明";
    }

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mi = String(date.getMinutes()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function formatTime(value: string) {
    const date = new Date(value);

    const hh = String(date.getHours()).padStart(2, "0");
    const mi = String(date.getMinutes()).padStart(2, "0");

    return `${hh}:${mi}`;
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#f3f6f8",
    },
    map: {
        ...StyleSheet.absoluteFillObject,
    },
    emptyText: {
        color: "#555",
        fontSize: 14,
        textAlign: "center",
    },
    infoBox: {
        position: "absolute",
        left: 0,
        right: 0,

        paddingTop: 16,
        paddingHorizontal: 18,
        paddingBottom: 22,

        backgroundColor: "rgba(255,255,255,0.98)",

        borderTopWidth: 1,
        borderTopColor: "#dce4e9",

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: -2,
        },
        shadowOpacity: 0.08,
        shadowRadius: 6,

        elevation: 8,
    },
    infoText: {
        fontSize: 13,
        marginBottom: 2,
        color: "#333",
    },
    openMapButton: {
        minHeight: 48,

        marginTop: 14,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,

        borderRadius: 10,

        backgroundColor: "#06395f",
    },

    openMapButtonPressed: {
        opacity: 0.78,
    },

    openMapButtonText: {
        color: "#ffffff",
        fontSize: 15,
        fontWeight: "700",
    },
    liveMarkerOuter: {
        width: 46,
        height: 46,
        borderRadius: 23,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "rgba(18,184,170,0.18)",
    },

    liveMarkerMiddle: {
        width: 28,
        height: 28,
        borderRadius: 14,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#ffffff",

        borderWidth: 3,
        borderColor: "#12b8aa",

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.18,
        shadowRadius: 3,

        elevation: 4,
    },

    liveMarkerInner: {
        width: 12,
        height: 12,
        borderRadius: 6,

        backgroundColor: "#12b8aa",
    },
    infoHeaderRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
    },

    infoTitleRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
    },

    infoTitle: {
        color: "#06395f",
        fontSize: 18,
        fontWeight: "700",
    },

    liveBadge: {
        flexDirection: "row",
        alignItems: "center",

        paddingHorizontal: 10,
        paddingVertical: 5,

        borderRadius: 999,

        backgroundColor: "#e7f8f6",
    },

    liveBadgeDot: {
        width: 8,
        height: 8,
        borderRadius: 4,

        marginRight: 5,

        backgroundColor: "#12b8aa",
    },

    liveBadgeText: {
        color: "#087f75",
        fontSize: 12,
        fontWeight: "700",
    },

    liveStatsRow: {
        flexDirection: "row",
        alignItems: "stretch",

        marginTop: 16,
        marginBottom: 14,
    },

    liveStatItem: {
        flex: 1,
        alignItems: "center",
    },

    liveStatsDivider: {
        width: 1,
        marginVertical: 3,
        backgroundColor: "#dce4e9",
    },

    liveStatLabel: {
        marginTop: 4,

        color: "#667681",
        fontSize: 12,
        fontWeight: "600",
    },

    liveStatValue: {
        marginTop: 2,

        color: "#06395f",
        fontSize: 20,
        fontWeight: "700",
    },

    locationDetailBox: {
        paddingVertical: 10,
        paddingHorizontal: 12,

        borderRadius: 10,

        backgroundColor: "#f5f8fa",
    },

    locationDetailRow: {
        minHeight: 24,

        flexDirection: "row",
        alignItems: "center",
    },

    locationDetailLabel: {
        width: 76,

        color: "#667681",
        fontSize: 12,
    },

    locationDetailValue: {
        flex: 1,

        color: "#263b49",
        fontSize: 12,
        fontWeight: "600",

        textAlign: "right",
    },

    center: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",

        paddingHorizontal: 32,

        backgroundColor: "#f3f6f8",
    },

    emptyIconCircle: {
        width: 74,
        height: 74,
        borderRadius: 37,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#e8eef2",
    },

    emptyTitle: {
        marginTop: 16,

        color: "#06395f",
        fontSize: 17,
        fontWeight: "700",
    },

    emptyDescription: {
        marginTop: 7,

        color: "#667681",
        fontSize: 13,
        lineHeight: 20,

        textAlign: "center",
    },

    screenHeader: {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,

        minHeight: 58,

        paddingHorizontal: 10,
        paddingBottom: 8,

        flexDirection: "row",
        alignItems: "flex-end",

        backgroundColor: "#06395f",

        zIndex: 2000,
        elevation: 20,
    },

    screenHeaderButton: {
        width: 46,
        height: 44,

        alignItems: "center",
        justifyContent: "center",
    },

    screenHeaderBackText: {
        color: "#ffffff",

        fontSize: 42,
        lineHeight: 42,
        fontWeight: "300",
    },

    screenHeaderTitle: {
        flex: 1,

        paddingBottom: 9,

        textAlign: "center",

        color: "#ffffff",

        fontSize: 17,
        fontWeight: "600",
    },

    profileOverlayMarker: {
        position: "absolute",

        width: 70,
        height: 70,
        borderRadius: 35,

        backgroundColor: "#ffffff",

        borderWidth: 4,
        borderColor: "#4b6f8f",

        overflow: "hidden",

        alignItems: "center",
        justifyContent: "center",

        zIndex: 1000,
        elevation: 1000,
    },

    profileOverlayMarkerImage: {
        width: "100%",
        height: "100%",
    },

    profileOverlayMarkerFallback: {
        width: "100%",
        height: "100%",

        backgroundColor: "#4b6f8f",

        alignItems: "center",
        justifyContent: "center",
    },
});
