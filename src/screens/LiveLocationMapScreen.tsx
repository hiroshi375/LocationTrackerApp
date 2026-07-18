import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useMemo, useState } from "react";
import {
    ActivityIndicator,
    Pressable,
    StyleSheet,
    Text,
    View,
} from "react-native";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";

import { client } from "../lib/client";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { getCurrentUserProfile } from "../services/userProfileService";

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
    const [liveLocations, setLiveLocations] = useState<LiveLocationItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [currentOwnerValue, setCurrentOwnerValue] = useState<string | null>(
        null,
    );

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
    }, [currentOwnerValue]);

    const latestLiveLocation = useMemo(() => {
        if (liveLocations.length === 0) {
            return null;
        }

        return liveLocations[0];
    }, [liveLocations]);

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
                <Text style={styles.emptyText}>
                    共有中の現在地はありません。
                </Text>
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
                        title={
                            location.isRecording
                                ? "自動記録中の現在地"
                                : "共有中の現在地"
                        }
                        description={`更新: ${formatDateTime(
                            location.updatedAt,
                        )}`}
                        onPress={() => openLocationMap(location)}
                    />
                ))}
            </MapView>

            <View style={styles.infoBox}>
                <Text style={styles.infoTitle}>
                    {latestLiveLocation.isRecording
                        ? "自動記録中の現在地"
                        : "共有中の現在地"}
                </Text>

                <Text style={styles.infoText}>
                    更新日時: {formatDateTime(latestLiveLocation.updatedAt)}
                </Text>

                <Text style={styles.infoText}>
                    記録状態:{" "}
                    {latestLiveLocation.isRecording
                        ? "自動記録中"
                        : "現在地共有のみ"}
                </Text>

                <Text style={styles.infoText}>
                    セッションID:{" "}
                    {latestLiveLocation.recordingSessionId ?? "なし"}
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

                <Pressable
                    style={styles.openMapButton}
                    onPress={() => openLocationMap(latestLiveLocation)}
                >
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
        padding: 24,
    },
    emptyText: {
        color: "#555",
        fontSize: 14,
        textAlign: "center",
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
    openMapButton: {
        marginTop: 10,
        backgroundColor: "#4b6f8f",
        borderRadius: 8,
        paddingVertical: 9,
        alignItems: "center",
    },
    openMapButtonText: {
        color: "#fff",
        fontSize: 14,
        fontWeight: "bold",
    },
});
