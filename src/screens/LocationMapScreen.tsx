import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Location from "expo-location";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    ActivityIndicator,
    Animated,
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

export default function LocationMapScreen({ route }: Props) {
    const mapRef = useRef<MapView | null>(null);

    const [logs, setLogs] = useState<LocationLogItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [showPoints, setShowPoints] = useState(false);
    const [mapReady, setMapReady] = useState(false);

    const selectedLocation = route.params?.selectedLocation ?? null;
    const routeRecordingSessionId = route.params?.recordingSessionId ?? null;

    const activeSessionId =
        selectedLocation?.recordingSessionId ?? routeRecordingSessionId ?? null;

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

    const currentLocationOpacity = useRef(new Animated.Value(1)).current;

    const loadLogs = useCallback(async (showLoading: boolean = true) => {
        try {
            if (showLoading) {
                setLoading(true);
            }

            const result = await client.models.LocationLog.list({});
            console.log("LocationLog sample:", result.data?.[0]);

            if (result.errors) {
                console.error("LocationLog list errors:", result.errors);
                return;
            }

            const items = normalizeLocationLogs(result.data ?? []);
            setLogs(items);
        } catch (error) {
            console.error("Map loadLogs error:", error);
        } finally {
            if (showLoading) {
                setLoading(false);
            }

            setHasLoaded(true);
        }
    }, []);

    useEffect(() => {
        if (!activeSessionId) {
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
    }, [activeSessionId]);

    useEffect(() => {
        if (!activeSessionId || !currentLocation) {
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
        };
    }, [activeSessionId, currentLocation, currentLocationOpacity]);

    useEffect(() => {
        if (!mapReady) {
            return;
        }

        if (!activeSessionId) {
            return;
        }

        if (!currentLocation) {
            return;
        }

        mapRef.current?.animateToRegion(
            {
                latitude: currentLocation.latitude,
                longitude: currentLocation.longitude,
                latitudeDelta: 0.005,
                longitudeDelta: 0.005,
            },
            500,
        );
    }, [mapReady, activeSessionId, currentLocation]);

    useFocusEffect(
        useCallback(() => {
            void loadLogs(true);

            const timerId = setInterval(() => {
                void loadLogs(false);
            }, 5000);

            return () => {
                clearInterval(timerId);
            };
        }, [loadLogs]),
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
        activeSessionId && latestRecordedLog && currentLocation
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

    const moveToLocation = (location: LocationLogItem) => {
        if (
            !Number.isFinite(location.latitude) ||
            !Number.isFinite(location.longitude)
        ) {
            return;
        }

        mapRef.current?.animateToRegion?.(
            {
                latitude: location.latitude,
                longitude: location.longitude,
                latitudeDelta: 0.01,
                longitudeDelta: 0.01,
            },
            500,
        );
    };

    const moveToLatestLocation = () => {
        if (activeSessionId && currentLocation) {
            mapRef.current?.animateToRegion(
                {
                    latitude: currentLocation.latitude,
                    longitude: currentLocation.longitude,
                    latitudeDelta: 0.005,
                    longitudeDelta: 0.005,
                },
                500,
            );
            return;
        }

        if (!latest) {
            return;
        }

        moveToLocation(latest);
    };

    const moveToDisplayLocation = () => {
        moveToLocation(displayLocation);
    };

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

    const startLog =
        activeSessionId && routeLogs.length > 0 ? routeLogs[0] : null;

    const endLog =
        activeSessionId && routeLogs.length > 1
            ? routeLogs[routeLogs.length - 1]
            : null;

    return (
        <View style={styles.container}>
            <MapView
                ref={mapRef}
                provider={PROVIDER_GOOGLE}
                style={styles.map}
                mapType="standard"
                onMapReady={() => setMapReady(true)}
                initialRegion={{
                    latitude: displayLocation.latitude,
                    longitude: displayLocation.longitude,
                    latitudeDelta: 0.01,
                    longitudeDelta: 0.01,
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

                {activeSessionId && currentLocation && (
                    <Marker
                        coordinate={currentLocation}
                        anchor={{ x: 0.5, y: 0.5 }}
                        tracksViewChanges
                    >
                        <Animated.View
                            style={[
                                styles.currentLocationMarkerOuter,
                                {
                                    opacity: currentLocationOpacity,
                                },
                            ]}
                        >
                            <View style={styles.currentLocationMarkerInner} />
                        </Animated.View>
                    </Marker>
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
                                title={isSelected ? "選択した位置" : "記録地点"}
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
                            title="選択した位置"
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

            <View style={styles.infoBox}>
                <Text style={styles.infoTitle}>
                    {isSelectedMode ? "選択した位置" : "最新位置"}
                </Text>

                <Text style={styles.infoText}>
                    日時: {formatDateTime(displayLocation.recordedAt)}
                </Text>

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

                <View style={styles.buttonRow}>
                    <Pressable
                        style={styles.secondaryButton}
                        onPress={moveToDisplayLocation}
                    >
                        <Text style={styles.secondaryButtonText}>
                            表示位置へ戻る
                        </Text>
                    </Pressable>

                    {latest && (
                        <Pressable
                            style={styles.primaryButton}
                            onPress={moveToLatestLocation}
                        >
                            <Text style={styles.primaryButtonText}>
                                最新位置へ戻る
                            </Text>
                        </Pressable>
                    )}
                </View>
            </View>
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
        bottom: 24,
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
    buttonRow: {
        flexDirection: "row",
        gap: 8,
        marginTop: 10,
    },
    primaryButton: {
        flex: 1,
        paddingVertical: 10,
        borderRadius: 8,
        backgroundColor: "#4b6f8f",
        alignItems: "center",
    },
    primaryButtonText: {
        color: "#fff",
        fontWeight: "bold",
        fontSize: 13,
    },
    secondaryButton: {
        flex: 1,
        paddingVertical: 10,
        borderRadius: 8,
        backgroundColor: "#e6edf3",
        alignItems: "center",
    },
    secondaryButtonText: {
        color: "#2f4f66",
        fontWeight: "bold",
        fontSize: 13,
    },
    historyMarker: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: "#4b6f8f",
        borderWidth: 1,
        borderColor: "#fff",
    },
    currentMarkerOuter: {
        width: 22,
        height: 22,
        borderRadius: 11,
        backgroundColor: "rgba(75,111,143,0.25)",
        alignItems: "center",
        justifyContent: "center",
    },
    currentMarkerInner: {
        width: 12,
        height: 12,
        borderRadius: 6,
        backgroundColor: "#4b6f8f",
        borderWidth: 2,
        borderColor: "#fff",
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
    currentLocationMarkerOuter: {
        width: 30,
        height: 30,
        borderRadius: 15,
        backgroundColor: "rgba(0, 122, 255, 0.25)",
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 2,
        borderColor: "rgba(0, 122, 255, 0.9)",
    },
    currentLocationMarkerInner: {
        width: 12,
        height: 12,
        borderRadius: 6,
        backgroundColor: "rgba(0, 122, 255, 1)",
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
});
