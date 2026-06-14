import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useRef, useState } from "react";
import {
    ActivityIndicator,
    Pressable,
    StyleSheet,
    Text,
    View,
} from "react-native";
import MapView, {
    Circle,
    Marker,
    Polyline,
    PROVIDER_GOOGLE,
} from "react-native-maps";

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
};

export default function LocationMapScreen({ route }: Props) {
    const mapRef = useRef<MapView | null>(null);

    const [logs, setLogs] = useState<LocationLogItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [showRouteLine, setShowRouteLine] = useState(false);

    const selectedLocation = route.params?.selectedLocation ?? null;

    const loadLogs = async () => {
        try {
            setLoading(true);

            const result = await client.models.LocationLog.list({});

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
            console.error("Map loadLogs error:", error);
        } finally {
            setLoading(false);
            setHasLoaded(true);
        }
    };

    useFocusEffect(
        useCallback(() => {
            loadLogs();
        }, []),
    );

    if (!hasLoaded || loading) {
        return (
            <View style={styles.center}>
                <ActivityIndicator />
            </View>
        );
    }

    if (logs.length === 0 && !selectedLocation) {
        return (
            <View style={styles.center}>
                <Text>表示できる位置履歴がありません。</Text>
            </View>
        );
    }

    const latest = logs[0] ?? null;
    const displayLocation = selectedLocation ?? latest;

    if (!displayLocation) {
        return (
            <View style={styles.center}>
                <Text>表示できる位置情報がありません。</Text>
            </View>
        );
    }

    const isSelectedMode = selectedLocation !== undefined;

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
        if (!latest) {
            return;
        }

        moveToLocation(latest);
    };

    const moveToDisplayLocation = () => {
        moveToLocation(displayLocation);
    };

    const routeCoordinates = logs
        .filter(
            (log) =>
                Number.isFinite(log.latitude) && Number.isFinite(log.longitude),
        )
        .slice(0, 100)
        .sort((a, b) => {
            return (
                new Date(a.recordedAt).getTime() -
                new Date(b.recordedAt).getTime()
            );
        })
        .map((log) => ({
            latitude: log.latitude,
            longitude: log.longitude,
        }))
        .filter((coordinate, index, array) => {
            if (index === 0) {
                return true;
            }

            const previous = array[index - 1];

            return (
                Math.abs(previous.latitude - coordinate.latitude) > 0.000001 ||
                Math.abs(previous.longitude - coordinate.longitude) > 0.000001
            );
        });

    return (
        <View style={styles.container}>
            <MapView
                ref={mapRef}
                provider={PROVIDER_GOOGLE}
                style={styles.map}
                mapType="standard"
                initialRegion={{
                    latitude: displayLocation.latitude,
                    longitude: displayLocation.longitude,
                    latitudeDelta: 0.01,
                    longitudeDelta: 0.01,
                }}
            >
                {showRouteLine && routeCoordinates.length >= 2 && (
                    <Polyline
                        coordinates={routeCoordinates}
                        strokeColor="rgba(75,111,143,0.7)"
                        strokeWidth={4}
                    />
                )}

                {logs.map((log) => {
                    const isSelected = selectedLocation?.id === log.id;

                    if (isSelected) {
                        return (
                            <Marker
                                key={log.id}
                                coordinate={{
                                    latitude: log.latitude,
                                    longitude: log.longitude,
                                }}
                                title="選択した位置"
                                description={buildMarkerDescription(log)}
                                pinColor="#4b6f8f"
                            />
                        );
                    }

                    return (
                        <Circle
                            key={log.id}
                            center={{
                                latitude: log.latitude,
                                longitude: log.longitude,
                            }}
                            radius={12}
                            fillColor="rgba(75,111,143,0.85)"
                            strokeColor="#ffffff"
                            strokeWidth={3}
                        />
                    );
                })}

                {selectedLocation &&
                    !logs.some((log) => log.id === selectedLocation.id) && (
                        <Marker
                            coordinate={{
                                latitude: selectedLocation.latitude,
                                longitude: selectedLocation.longitude,
                            }}
                            title="選択した位置"
                            description={buildMarkerDescription(
                                selectedLocation,
                            )}
                            pinColor="#4b6f8f"
                        />
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

                <Text style={styles.infoText}>
                    メモ: {displayLocation.memo ? displayLocation.memo : "なし"}
                </Text>

                <Pressable
                    style={styles.routeToggleButton}
                    onPress={() => setShowRouteLine((current) => !current)}
                >
                    <Text style={styles.routeToggleButtonText}>
                        ルート線表示: {showRouteLine ? "ON" : "OFF"}
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
});
