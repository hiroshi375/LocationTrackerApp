// src/screens/LiveLocationMapScreen.tsx

import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";

import { client } from "../lib/client";

type LiveLocationItem = {
    id: string;
    userId: string;
    recordingSessionId: string;
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    updatedAt: string;
    isActive: boolean;
    sharedOwners?: string[] | null;
};

export default function LiveLocationMapScreen() {
    const [liveLocations, setLiveLocations] = useState<LiveLocationItem[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
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
                            userId: item.userId,
                            recordingSessionId: item.recordingSessionId,
                            latitude: Number(item.latitude),
                            longitude: Number(item.longitude),
                            accuracy: item.accuracy ?? null,
                            updatedAt: item.updatedAt,
                            isActive: Boolean(item.isActive),
                            sharedOwners: Array.isArray(item.sharedOwners)
                                ? item.sharedOwners
                                : [],
                        }))
                        .filter(
                            (item) =>
                                item.isActive &&
                                Number.isFinite(item.latitude) &&
                                Number.isFinite(item.longitude),
                        );

                    setLiveLocations(normalizedItems);
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
    }, []);

    const latestLiveLocation = useMemo(() => {
        if (liveLocations.length === 0) {
            return null;
        }

        return liveLocations.slice().sort((a, b) => {
            return (
                new Date(b.updatedAt).getTime() -
                new Date(a.updatedAt).getTime()
            );
        })[0];
    }, [liveLocations]);

    if (loading) {
        return (
            <View style={styles.center}>
                <ActivityIndicator />
            </View>
        );
    }

    if (!latestLiveLocation) {
        return (
            <View style={styles.center}>
                <Text>共有中の現在地はありません。</Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <MapView
                provider={PROVIDER_GOOGLE}
                style={styles.map}
                initialRegion={{
                    latitude: latestLiveLocation.latitude,
                    longitude: latestLiveLocation.longitude,
                    latitudeDelta: 0.01,
                    longitudeDelta: 0.01,
                }}
            >
                {liveLocations.map((location) => (
                    <Marker
                        key={location.id}
                        coordinate={{
                            latitude: location.latitude,
                            longitude: location.longitude,
                        }}
                        title="共有中の現在地"
                        description={`更新: ${formatDateTime(
                            location.updatedAt,
                        )}`}
                    >
                        <View style={styles.liveMarkerOuter}>
                            <View style={styles.liveMarkerInner} />
                        </View>
                    </Marker>
                ))}
            </MapView>

            <View style={styles.infoBox}>
                <Text style={styles.infoTitle}>共有中の現在地</Text>
                <Text style={styles.infoText}>
                    更新日時: {formatDateTime(latestLiveLocation.updatedAt)}
                </Text>
                <Text style={styles.infoText}>
                    緯度: {latestLiveLocation.latitude.toFixed(6)}
                </Text>
                <Text style={styles.infoText}>
                    経度: {latestLiveLocation.longitude.toFixed(6)}
                </Text>
                <Text style={styles.infoText}>
                    精度:{" "}
                    {latestLiveLocation.accuracy !== null &&
                    latestLiveLocation.accuracy !== undefined
                        ? `${Math.round(latestLiveLocation.accuracy)}m`
                        : "不明"}
                </Text>
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
    liveMarkerOuter: {
        width: 30,
        height: 30,
        borderRadius: 15,
        backgroundColor: "rgba(0, 122, 255, 0.25)",
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 2,
        borderColor: "rgba(0, 122, 255, 0.9)",
    },
    liveMarkerInner: {
        width: 12,
        height: 12,
        borderRadius: 6,
        backgroundColor: "rgba(0, 122, 255, 1)",
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
});
