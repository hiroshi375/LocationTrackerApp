import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { getCurrentUser } from "aws-amplify/auth";
import { getUrl } from "aws-amplify/storage";
import * as Location from "expo-location";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    ActivityIndicator,
    Animated,
    Image,
    Pressable,
    StyleSheet,
    Text,
    View,
} from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import { client } from "../lib/client";
import type { RootStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<RootStackParamList, "LocationMap">;

type LocationLogItem = {
    id: string;
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    recordedAt: string;
    memo?: string | null;
    recordingSessionId?: string | null;
    recordingSessionName?: string | null;
};

type RecordingSessionItem = {
    id: string;
    recordingSessionId: string;
    userId: string;
    recordingSessionName?: string | null;
    startedAt: string;
    endedAt: string;
    distanceMeters: number;
    pointCount: number;
    sharedOwners?: string[] | null;
};

type UserProfileItem = {
    id: string;
    userId: string;
    email?: string | null;
    displayName?: string | null;
    iconImagePath?: string | null;
};

type RecordingSessionListResult = {
    data?: any[] | null;
    errors?: unknown;
};

type LocationLogListResult = {
    data?: any[] | null;
    errors?: unknown;
    nextToken?: string | null;
};

const DEFAULT_LATITUDE_DELTA = 0.01;
const DEFAULT_LONGITUDE_DELTA = 0.01;

// 現在地を画面中央付近に見せるため、カメラ中心を少し南へずらす
const CAMERA_CENTER_LATITUDE_OFFSET = 0.0025;

export default function LocationMapScreen({ route }: Props) {
    const mapRef = useRef<MapView | null>(null);
    const hasFittedInitialRouteRef = useRef(false);

    const [logs, setLogs] = useState<LocationLogItem[]>([]);
    const [recordingSessionSummary, setRecordingSessionSummary] =
        useState<RecordingSessionItem | null>(null);
    const [loading, setLoading] = useState(true);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [showPoints, setShowPoints] = useState(false);
    const [mapReady, setMapReady] = useState(false);
    const [currentUserIconUrl, setCurrentUserIconUrl] = useState<string | null>(
        null,
    );

    const selectedLocation = route.params?.selectedLocation ?? null;
    const routeRecordingSessionId = route.params?.recordingSessionId ?? null;

    const activeSessionId =
        selectedLocation?.recordingSessionId ?? routeRecordingSessionId ?? null;

    const isLiveRecordingMap = Boolean(routeRecordingSessionId);

    const recordingIntervalMs = route.params?.recordingIntervalMs ?? null;
    const recordingDistanceMeters =
        route.params?.recordingDistanceMeters ?? null;

    const recordingIntervalSeconds =
        typeof recordingIntervalMs === "number"
            ? Math.round(recordingIntervalMs / 1000)
            : null;

    const shouldShowRecordingSettings =
        Boolean(activeSessionId) &&
        recordingIntervalSeconds !== null &&
        typeof recordingDistanceMeters === "number";

    const [currentLocation, setCurrentLocation] = useState<{
        latitude: number;
        longitude: number;
    } | null>(null);
    const [currentLocationScreenPoint, setCurrentLocationScreenPoint] =
        useState<{
            x: number;
            y: number;
        } | null>(null);

    const currentLocationOpacity = useRef(new Animated.Value(1)).current;

    const updateCurrentLocationScreenPoint = useCallback(async () => {
        if (
            !mapReady ||
            !isLiveRecordingMap ||
            !currentLocation ||
            !mapRef.current
        ) {
            setCurrentLocationScreenPoint(null);
            return;
        }

        try {
            const point =
                await mapRef.current.pointForCoordinate(currentLocation);

            setCurrentLocationScreenPoint({
                x: point.x,
                y: point.y,
            });
        } catch (error) {
            console.error("Current location screen point error:", error);
            setCurrentLocationScreenPoint(null);
        }
    }, [mapReady, isLiveRecordingMap, currentLocation]);

    const loadLogs = useCallback(
        async (showLoading: boolean = true) => {
            try {
                if (showLoading) {
                    setLoading(true);
                }

                const allData: any[] = [];
                let nextToken: string | null = null;

                const locationLogModel = client.models.LocationLog as any;

                do {
                    const listParams: {
                        limit: number;
                        nextToken?: string;
                        filter?: {
                            recordingSessionId: {
                                eq: string;
                            };
                        };
                    } = {
                        limit: 1000,
                    };

                    if (nextToken) {
                        listParams.nextToken = nextToken;
                    }

                    if (activeSessionId) {
                        listParams.filter = {
                            recordingSessionId: {
                                eq: activeSessionId,
                            },
                        };
                    }

                    const result = (await locationLogModel.list(
                        listParams,
                    )) as LocationLogListResult;

                    if (result.errors) {
                        console.error(
                            "LocationLog list errors:",
                            result.errors,
                        );
                        return;
                    }

                    allData.push(...(result.data ?? []));
                    nextToken = result.nextToken ?? null;
                } while (nextToken);

                const items = normalizeLocationLogs(allData);
                setLogs(items);
            } catch (error) {
                console.error("Map loadLogs error:", error);
            } finally {
                if (showLoading) {
                    setLoading(false);
                }

                setHasLoaded(true);
            }
        },
        [activeSessionId],
    );

    const loadRecordingSessionSummary = useCallback(
        async (recordingSessionId: string) => {
            try {
                const recordingSessionModel = client.models
                    .RecordingSession as any;

                const result = (await recordingSessionModel.list({
                    filter: {
                        recordingSessionId: {
                            eq: recordingSessionId,
                        },
                    },
                    limit: 1000,
                })) as RecordingSessionListResult;

                if (result.errors) {
                    console.error(
                        "RecordingSession summary load errors:",
                        result.errors,
                    );
                    return;
                }

                const items = result.data ?? [];

                const item = items[0];

                if (!item) {
                    setRecordingSessionSummary(null);
                    return;
                }

                setRecordingSessionSummary({
                    id: item.id,
                    recordingSessionId: item.recordingSessionId,
                    userId: item.userId,
                    recordingSessionName: item.recordingSessionName ?? null,
                    startedAt: item.startedAt,
                    endedAt: item.endedAt,
                    distanceMeters: Number(item.distanceMeters ?? 0),
                    pointCount: Number(item.pointCount ?? 0),
                    sharedOwners: Array.isArray(item.sharedOwners)
                        ? item.sharedOwners
                        : [],
                });
            } catch (error) {
                console.error("RecordingSession summary load error:", error);
            }
        },
        [],
    );

    const loadCurrentUserProfileIcon = useCallback(async () => {
        try {
            const currentUser = await getCurrentUser();

            const userProfileModel = client.models.UserProfile as any;

            const result = await userProfileModel.list({
                filter: {
                    userId: {
                        eq: currentUser.userId,
                    },
                },
                limit: 1000,
            });

            if (result.errors) {
                console.error("UserProfile icon load errors:", result.errors);
                setCurrentUserIconUrl(null);
                return;
            }

            const profiles = (result.data ?? []) as UserProfileItem[];

            const profileWithIcon = profiles.find(
                (profile) => !!profile.iconImagePath,
            );

            if (!profileWithIcon?.iconImagePath) {
                setCurrentUserIconUrl(null);
                return;
            }

            const urlResult = await getUrl({
                path: profileWithIcon.iconImagePath,
                options: {
                    expiresIn: 3600,
                },
            });

            const iconUrl = urlResult.url.toString();

            setCurrentUserIconUrl(iconUrl);
        } catch (error) {
            console.error("Current user profile icon load error:", error);
            setCurrentUserIconUrl(null);
        }
    }, []);

    useEffect(() => {
        if (!isLiveRecordingMap) {
            setCurrentLocation(null);
            return;
        }

        let subscription: Location.LocationSubscription | null = null;
        let cancelled = false;

        const startWatchingCurrentLocation = async () => {
            try {
                const permission =
                    await Location.requestForegroundPermissionsAsync();

                if (permission.status !== "granted") {
                    console.log("Location permission not granted");
                    return;
                }

                const servicesEnabled =
                    await Location.hasServicesEnabledAsync();

                if (!servicesEnabled) {
                    console.log("Location services are disabled");
                    return;
                }

                try {
                    const firstLocation =
                        await Location.getCurrentPositionAsync({
                            accuracy: Location.Accuracy.Balanced,
                        });

                    if (!cancelled) {
                        setCurrentLocation({
                            latitude: firstLocation.coords.latitude,
                            longitude: firstLocation.coords.longitude,
                        });
                    }
                } catch (error) {
                    console.log(
                        "Initial current location unavailable. Trying last known location.",
                        error,
                    );

                    const lastKnownLocation =
                        await Location.getLastKnownPositionAsync();

                    if (!cancelled && lastKnownLocation) {
                        setCurrentLocation({
                            latitude: lastKnownLocation.coords.latitude,
                            longitude: lastKnownLocation.coords.longitude,
                        });
                    }
                }

                subscription = await Location.watchPositionAsync(
                    {
                        accuracy: Location.Accuracy.Balanced,
                        timeInterval: 2000,
                        distanceInterval: 1,
                    },
                    (location) => {
                        setCurrentLocation({
                            latitude: location.coords.latitude,
                            longitude: location.coords.longitude,
                        });
                    },
                );
            } catch (error) {
                console.error("Watch current location error:", error);
            }
        };

        void startWatchingCurrentLocation();

        return () => {
            cancelled = true;
            subscription?.remove();
        };
    }, [isLiveRecordingMap]);

    useEffect(() => {
        if (!isLiveRecordingMap || !currentLocationScreenPoint) {
            currentLocationOpacity.setValue(1);
            return;
        }

        const animation = Animated.loop(
            Animated.sequence([
                Animated.timing(currentLocationOpacity, {
                    toValue: 0.25,
                    duration: 600,
                    useNativeDriver: true,
                }),
                Animated.timing(currentLocationOpacity, {
                    toValue: 1,
                    duration: 600,
                    useNativeDriver: true,
                }),
            ]),
        );

        animation.start();

        return () => {
            animation.stop();
            currentLocationOpacity.setValue(1);
        };
    }, [
        isLiveRecordingMap,
        currentLocationScreenPoint,
        currentLocationOpacity,
    ]);

    useEffect(() => {
        if (!mapReady) {
            return;
        }

        if (!isLiveRecordingMap) {
            return;
        }

        if (!currentLocation) {
            return;
        }

        mapRef.current?.animateCamera(
            {
                center: getAdjustedMapCenter(currentLocation),
            },
            {
                duration: 500,
            },
        );
    }, [mapReady, isLiveRecordingMap, currentLocation]);

    useEffect(() => {
        hasFittedInitialRouteRef.current = false;
    }, [activeSessionId, isLiveRecordingMap]);

    useEffect(() => {
        if (!mapReady) {
            return;
        }

        if (!hasLoaded || loading) {
            return;
        }

        if (!activeSessionId) {
            return;
        }

        // 自動記録中は対象外
        if (isLiveRecordingMap) {
            return;
        }

        if (hasFittedInitialRouteRef.current) {
            return;
        }

        const sessionRouteLogs = logs
            .filter((log) => log.recordingSessionId === activeSessionId)
            .filter(
                (log) =>
                    Number.isFinite(log.latitude) &&
                    Number.isFinite(log.longitude),
            )
            .sort((a, b) => {
                return (
                    new Date(a.recordedAt).getTime() -
                    new Date(b.recordedAt).getTime()
                );
            })
            .filter((log, index, array) => {
                if (index === 0) {
                    return true;
                }

                const previous = array[index - 1];

                return (
                    Math.abs(previous.latitude - log.latitude) > 0.000001 ||
                    Math.abs(previous.longitude - log.longitude) > 0.000001
                );
            });

        const coordinates = sessionRouteLogs.map((log) => ({
            latitude: log.latitude,
            longitude: log.longitude,
        }));

        if (coordinates.length === 0) {
            return;
        }

        hasFittedInitialRouteRef.current = true;

        const timerId = setTimeout(() => {
            if (coordinates.length === 1) {
                mapRef.current?.animateCamera(
                    {
                        center: coordinates[0],
                    },
                    {
                        duration: 500,
                    },
                );
                return;
            }

            mapRef.current?.fitToCoordinates(coordinates, {
                edgePadding: {
                    top: 80,
                    right: 40,
                    bottom: 260,
                    left: 40,
                },
                animated: true,
            });
        }, 300);

        return () => {
            clearTimeout(timerId);
        };
    }, [
        mapReady,
        hasLoaded,
        loading,
        activeSessionId,
        isLiveRecordingMap,
        logs,
    ]);

    useEffect(() => {
        if (!activeSessionId) {
            setRecordingSessionSummary(null);
            return;
        }

        void loadRecordingSessionSummary(activeSessionId);
    }, [activeSessionId, loadRecordingSessionSummary]);

    useEffect(() => {
        void updateCurrentLocationScreenPoint();
    }, [updateCurrentLocationScreenPoint]);

    useFocusEffect(
        useCallback(() => {
            void loadLogs(true);
            void loadCurrentUserProfileIcon();

            const timerId = setInterval(() => {
                void loadLogs(false);
            }, 5000);

            return () => {
                clearInterval(timerId);
            };
        }, [loadLogs, loadCurrentUserProfileIcon]),
    );

    if (!hasLoaded || loading) {
        return (
            <View style={styles.center}>
                <ActivityIndicator />
            </View>
        );
    }

    const visibleLogs = activeSessionId
        ? logs.filter((log) => log.recordingSessionId === activeSessionId)
        : logs;

    const latestRecordedLog = visibleLogs.length > 0 ? visibleLogs[0] : null;

    const currentLocationLineCoordinates =
        isLiveRecordingMap && latestRecordedLog && currentLocation
            ? [
                  {
                      latitude: latestRecordedLog.latitude,
                      longitude: latestRecordedLog.longitude,
                  },
                  currentLocation,
              ]
            : [];

    if (visibleLogs.length === 0 && !selectedLocation) {
        return (
            <View style={styles.center}>
                <Text>表示できる位置履歴がありません。</Text>
            </View>
        );
    }

    const latest = visibleLogs[0] ?? null;
    const displayLocation = selectedLocation ?? latest;

    if (!displayLocation) {
        return (
            <View style={styles.center}>
                <Text>表示できる位置情報がありません。</Text>
            </View>
        );
    }

    const isSelectedMode = selectedLocation !== null;

    const routeLogs = visibleLogs
        .filter(
            (log) =>
                Number.isFinite(log.latitude) && Number.isFinite(log.longitude),
        )
        .sort((a, b) => {
            return (
                new Date(a.recordedAt).getTime() -
                new Date(b.recordedAt).getTime()
            );
        })
        .filter((log, index, array) => {
            if (index === 0) {
                return true;
            }

            const previous = array[index - 1];

            return (
                Math.abs(previous.latitude - log.latitude) > 0.000001 ||
                Math.abs(previous.longitude - log.longitude) > 0.000001
            );
        });

    const routeCoordinates = routeLogs.map((log) => ({
        latitude: log.latitude,
        longitude: log.longitude,
    }));

    const fitTargetCoordinates =
        isLiveRecordingMap && currentLocation
            ? [...routeCoordinates, currentLocation]
            : routeCoordinates;

    const fitToRoute = () => {
        if (fitTargetCoordinates.length === 0) {
            return;
        }

        if (fitTargetCoordinates.length === 1) {
            mapRef.current?.animateCamera(
                {
                    center: getAdjustedMapCenter(fitTargetCoordinates[0]),
                },
                {
                    duration: 500,
                },
            );
            return;
        }

        mapRef.current?.fitToCoordinates(fitTargetCoordinates, {
            edgePadding: {
                top: 100,
                right: 60,
                bottom: 320,
                left: 60,
            },
            animated: true,
        });
    };

    const routeDistanceMeters =
        activeSessionId && routeLogs.length >= 2
            ? calculateRouteDistanceMeters(routeLogs)
            : null;

    const displayDistanceText =
        typeof recordingSessionSummary?.distanceMeters === "number"
            ? formatDistance(recordingSessionSummary.distanceMeters)
            : routeDistanceMeters !== null
              ? formatDistance(routeDistanceMeters)
              : "集計情報なし";

    const startLog =
        activeSessionId && routeLogs.length > 0 ? routeLogs[0] : null;

    const endLog =
        activeSessionId && !isLiveRecordingMap && routeLogs.length > 1
            ? routeLogs[routeLogs.length - 1]
            : null;

    const recordPointCount =
        recordingSessionSummary?.pointCount ?? visibleLogs.length;

    const displayedPointCount = showPoints
        ? routeLogs.filter(
              (log) => log.id !== startLog?.id && log.id !== endLog?.id,
          ).length
        : 0;

    const sessionStartAt =
        activeSessionId && routeLogs.length > 0
            ? routeLogs[0].recordedAt
            : null;

    const sessionEndAt =
        activeSessionId && routeLogs.length > 0
            ? routeLogs[routeLogs.length - 1].recordedAt
            : null;

    const shouldShowSessionPeriod =
        isSelectedMode &&
        Boolean(activeSessionId) &&
        !isLiveRecordingMap &&
        Boolean(sessionStartAt) &&
        Boolean(sessionEndAt);

    const adjustedInitialCenter = getAdjustedMapCenter(displayLocation);

    return (
        <View style={styles.container}>
            <StatusBar
                style="dark"
                hidden={false}
                backgroundColor="#ffffff"
                translucent={false}
            />

            <MapView
                ref={mapRef}
                provider={PROVIDER_GOOGLE}
                style={styles.map}
                mapType="standard"
                onMapReady={() => setMapReady(true)}
                onRegionChangeComplete={() => {
                    void updateCurrentLocationScreenPoint();
                }}
                initialRegion={{
                    latitude: adjustedInitialCenter.latitude,
                    longitude: adjustedInitialCenter.longitude,
                    latitudeDelta: DEFAULT_LATITUDE_DELTA,
                    longitudeDelta: DEFAULT_LONGITUDE_DELTA,
                }}
            >
                {routeCoordinates.length >= 2 && (
                    <Polyline
                        coordinates={routeCoordinates}
                        strokeColor="rgba(22, 91, 112, 0.85)"
                        strokeWidth={6}
                    />
                )}

                {currentLocationLineCoordinates.length === 2 && (
                    <Polyline
                        coordinates={currentLocationLineCoordinates}
                        strokeColor="rgba(22, 91, 112, 0.85)"
                        strokeWidth={6}
                        lineDashPattern={[8, 6]}
                    />
                )}

                {showPoints &&
                    routeLogs.map((log) => {
                        const isSelected = selectedLocation?.id === log.id;
                        const isStartOrEnd =
                            log.id === startLog?.id || log.id === endLog?.id;

                        if (isStartOrEnd) {
                            return null;
                        }

                        return (
                            <Marker
                                key={log.id}
                                coordinate={{
                                    latitude: log.latitude,
                                    longitude: log.longitude,
                                }}
                                title={isSelected ? "記録サマリー" : "記録地点"}
                                description={buildMarkerDescription(log)}
                                anchor={{ x: 0.5, y: 0.5 }}
                                centerOffset={{ x: 0, y: 0 }}
                                tracksViewChanges
                            >
                                <View
                                    collapsable={false}
                                    style={styles.pointMarkerContainer}
                                >
                                    <View
                                        collapsable={false}
                                        style={
                                            isSelected
                                                ? styles.selectedPointMarker
                                                : styles.logPointMarker
                                        }
                                    />
                                </View>
                            </Marker>
                        );
                    })}

                {startLog && (
                    <Marker
                        coordinate={{
                            latitude: startLog.latitude,
                            longitude: startLog.longitude,
                        }}
                        title="開始位置"
                        description={buildMarkerDescription(startLog)}
                        anchor={{ x: 0.5, y: 0.5 }}
                        centerOffset={{ x: 0, y: 0 }}
                        tracksViewChanges
                        zIndex={100}
                    >
                        <View
                            collapsable={false}
                            style={styles.endpointMarkerContainer}
                        >
                            <View
                                collapsable={false}
                                style={styles.startPointMarker}
                            >
                                <Text style={styles.endpointMarkerText}>S</Text>
                            </View>
                        </View>
                    </Marker>
                )}

                {endLog && (
                    <Marker
                        coordinate={{
                            latitude: endLog.latitude,
                            longitude: endLog.longitude,
                        }}
                        title="終了位置"
                        description={buildMarkerDescription(endLog)}
                        anchor={{ x: 0.5, y: 0.5 }}
                        centerOffset={{ x: 0, y: 0 }}
                        tracksViewChanges
                        zIndex={100}
                    >
                        <View
                            collapsable={false}
                            style={styles.endpointMarkerContainer}
                        >
                            <View
                                collapsable={false}
                                style={styles.endPointMarker}
                            >
                                <Text style={styles.endpointMarkerText}>G</Text>
                            </View>
                        </View>
                    </Marker>
                )}

                {showPoints &&
                    selectedLocation &&
                    !visibleLogs.some(
                        (log) => log.id === selectedLocation.id,
                    ) && (
                        <Marker
                            coordinate={{
                                latitude: selectedLocation.latitude,
                                longitude: selectedLocation.longitude,
                            }}
                            title="記録サマリー"
                            description={buildMarkerDescription(
                                selectedLocation,
                            )}
                            anchor={{ x: 0.5, y: 0.5 }}
                            tracksViewChanges={false}
                        >
                            <View style={styles.selectedPointMarker} />
                        </Marker>
                    )}
            </MapView>

            {isLiveRecordingMap && currentLocationScreenPoint && (
                <Animated.View
                    pointerEvents="none"
                    style={[
                        styles.currentUserOverlayMarker,
                        {
                            left: currentLocationScreenPoint.x - 35,
                            top: currentLocationScreenPoint.y - 35,
                            opacity: currentLocationOpacity,
                        },
                    ]}
                >
                    {currentUserIconUrl ? (
                        <Image
                            source={{ uri: currentUserIconUrl }}
                            style={styles.currentUserOverlayMarkerImage}
                            resizeMode="cover"
                            fadeDuration={0}
                        />
                    ) : (
                        <View style={styles.currentUserOverlayMarkerFallback}>
                            <Text
                                style={
                                    styles.currentUserOverlayMarkerFallbackText
                                }
                            >
                                自
                            </Text>
                        </View>
                    )}
                </Animated.View>
            )}

            <View style={styles.infoBox}>
                <Text style={styles.infoTitle}>
                    {isSelectedMode ? "記録サマリー" : "最新位置"}
                </Text>

                {recordingSessionSummary ? (
                    <Text style={styles.infoText}>
                        期間:{" "}
                        {formatPeriod(
                            recordingSessionSummary.startedAt,
                            recordingSessionSummary.endedAt,
                        )}
                    </Text>
                ) : (
                    <Text style={styles.infoText}>
                        {shouldShowSessionPeriod ? "期間: " : "日時: "}
                        {shouldShowSessionPeriod &&
                        sessionStartAt &&
                        sessionEndAt
                            ? formatPeriod(sessionStartAt, sessionEndAt)
                            : formatDateTime(displayLocation.recordedAt)}
                    </Text>
                )}
                <Text style={styles.infoText}>距離: {displayDistanceText}</Text>
                <View style={styles.pointCountRow}>
                    <Text style={[styles.infoText, styles.pointCountText]}>
                        記録ポイント: {recordPointCount}件
                    </Text>

                    <Text style={[styles.infoText, styles.pointCountText]}>
                        表示ポイント: {displayedPointCount}件
                    </Text>
                </View>
                {/*
                <Text style={styles.infoText}>
                    緯度: {displayLocation.latitude.toFixed(6)}
                </Text>

                <Text style={styles.infoText}>
                    経度: {displayLocation.longitude.toFixed(6)}
                </Text>

                <Text style={styles.infoText}>
                    精度:{" "}
                    {displayLocation.accuracy !== null &&
                    displayLocation.accuracy !== undefined
                        ? `${Math.round(displayLocation.accuracy)}m`
                        : "不明"}
                </Text>
                */}
                <View style={styles.memoRow}>
                    <Text style={[styles.infoText, styles.memoTextInRow]}>
                        メモ:{" "}
                        {displayLocation.memo ? displayLocation.memo : "なし"}
                    </Text>

                    {shouldShowRecordingSettings && (
                        <View style={styles.recordingSettingBadge}>
                            <Text style={styles.recordingSettingBadgeText}>
                                頻度: {recordingIntervalSeconds}秒 / 距離:{" "}
                                {recordingDistanceMeters}m
                            </Text>
                        </View>
                    )}
                </View>

                <Pressable
                    style={styles.routeToggleButton}
                    onPress={() => setShowPoints((current) => !current)}
                >
                    <Text style={styles.routeToggleButtonText}>
                        ポイント表示: {showPoints ? "OFF" : "ON"}
                    </Text>
                </Pressable>

                <Pressable style={styles.routeFitButton} onPress={fitToRoute}>
                    <Text style={styles.routeFitButtonText}>
                        ルート全体を表示
                    </Text>
                </Pressable>
            </View>
        </View>
    );
}

function getAdjustedMapCenter(location: {
    latitude: number;
    longitude: number;
}) {
    return {
        latitude: location.latitude - CAMERA_CENTER_LATITUDE_OFFSET,
        longitude: location.longitude,
    };
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

        return total + distance;
    }, 0);
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

function buildMarkerDescription(log: LocationLogItem) {
    const dateText = formatDateTime(log.recordedAt);

    if (!log.memo) {
        return dateText;
    }

    return `${dateText} / ${log.memo}`;
}

function normalizeLocationLogs(data: any[]): LocationLogItem[] {
    return (data ?? [])
        .map((item) => ({
            id: item.id,
            latitude: Number(item.latitude),
            longitude: Number(item.longitude),
            accuracy: item.accuracy,
            recordedAt: item.recordedAt,
            memo: item.memo,
            recordingSessionId: item.recordingSessionId ?? null,
            recordingSessionName: item.recordingSessionName ?? null,
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
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#fff",
    },
    map: {
        ...StyleSheet.absoluteFillObject,
    },
    center: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
    },
    infoBox: {
        position: "absolute",
        left: 16,
        right: 16,
        bottom: 48,
        padding: 14,
        backgroundColor: "rgba(255,255,255,0.94)",
        borderRadius: 12,
        borderWidth: 1,
        borderColor: "#ddd",
    },
    infoTitle: {
        fontSize: 16,
        fontWeight: "bold",
        marginBottom: 6,
    },
    infoText: {
        fontSize: 13,
        marginBottom: 2,
        color: "#333",
    },
    routeToggleButton: {
        marginTop: 10,
        paddingVertical: 9,
        borderRadius: 8,
        backgroundColor: "#eef3f7",
        alignItems: "center",
        borderWidth: 1,
        borderColor: "#c8d6e0",
    },
    routeToggleButtonText: {
        color: "#2f4f66",
        fontWeight: "bold",
        fontSize: 13,
    },
    logPointMarker: {
        width: 12,
        height: 12,
        borderRadius: 6,
        backgroundColor: "rgba(75,111,143,0.9)",
        borderWidth: 2,
        borderColor: "#ffffff",
    },
    selectedPointMarker: {
        width: 18,
        height: 18,
        borderRadius: 9,
        backgroundColor: "rgba(0, 122, 255, 0.95)",
        borderWidth: 3,
        borderColor: "#ffffff",
    },
    pointMarkerContainer: {
        width: 28,
        height: 28,
        alignItems: "center",
        justifyContent: "center",
    },
    endpointMarkerContainer: {
        width: 36,
        height: 36,
        alignItems: "center",
        justifyContent: "center",
    },
    startPointMarker: {
        width: 30,
        height: 30,
        borderRadius: 15,
        backgroundColor: "rgba(31, 92, 90, 0.95)",
        borderWidth: 3,
        borderColor: "#ffffff",
        alignItems: "center",
        justifyContent: "center",
    },
    endPointMarker: {
        width: 30,
        height: 30,
        borderRadius: 15,
        backgroundColor: "rgba(22, 91, 112, 0.95)",
        borderWidth: 3,
        borderColor: "#ffffff",
        alignItems: "center",
        justifyContent: "center",
    },
    endpointMarkerText: {
        color: "#ffffff",
        fontSize: 13,
        fontWeight: "bold",
    },
    memoRow: {
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 6,
        marginTop: 2,
    },
    memoTextInRow: {
        flexShrink: 1,
    },
    recordingSettingBadge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: "#eef3f7",
        borderWidth: 1,
        borderColor: "#c8d6e0",
    },
    recordingSettingBadgeText: {
        color: "#2f4f66",
        fontSize: 12,
        fontWeight: "bold",
    },
    routeFitButton: {
        marginTop: 8,
        paddingVertical: 9,
        borderRadius: 8,
        backgroundColor: "#e6edf3",
        alignItems: "center",
        borderWidth: 1,
        borderColor: "#c8d6e0",
    },
    routeFitButtonText: {
        color: "#2f4f66",
        fontWeight: "bold",
        fontSize: 13,
    },
    pointCountRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        marginTop: 2,
        marginBottom: 2,
    },
    pointCountText: {
        marginBottom: 0,
    },
    currentUserOverlayMarker: {
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

    currentUserOverlayMarkerImage: {
        width: "100%",
        height: "100%",
    },

    currentUserOverlayMarkerFallback: {
        width: "100%",
        height: "100%",
        backgroundColor: "#4b6f8f",
        alignItems: "center",
        justifyContent: "center",
    },

    currentUserOverlayMarkerFallbackText: {
        color: "#ffffff",
        fontSize: 18,
        fontWeight: "bold",
    },
});
