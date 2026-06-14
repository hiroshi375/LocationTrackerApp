import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { getCurrentUser } from "aws-amplify/auth";
import * as Location from "expo-location";
import { useState } from "react";
import {
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";

import { client } from "../lib/client";
import type { RootStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<RootStackParamList, "LocationHome">;

type CurrentLocation = {
    latitude: number;
    longitude: number;
    accuracy: number | null;
    recordedAt: string;
};

type AppButtonProps = {
    title: string;
    onPress: () => void;
    disabled?: boolean;
};

// 現在地の記録と保存を行うホーム画面コンポーネント
export default function LocationHomeScreen({ navigation }: Props) {
    const [currentLocation, setCurrentLocation] =
        useState<CurrentLocation | null>(null);
    const [memo, setMemo] = useState("");
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    const handleGetLocation = async () => {
        try {
            setLoading(true);

            const { status } =
                await Location.requestForegroundPermissionsAsync();

            if (status !== "granted") {
                Alert.alert(
                    "位置情報の許可が必要です",
                    "現在地を記録するには位置情報の許可が必要です。",
                );
                return;
            }

            const location = await Location.getCurrentPositionAsync({
                accuracy: Location.Accuracy.High,
            });

            const nextLocation: CurrentLocation = {
                latitude: location.coords.latitude,
                longitude: location.coords.longitude,
                accuracy: location.coords.accuracy,
                recordedAt: new Date().toISOString(),
            };

            setCurrentLocation(nextLocation);
        } catch (error) {
            console.error(error);
            Alert.alert("エラー", "現在地を取得できませんでした。");
        } finally {
            setLoading(false);
        }
    };

    // 位置情報を保存する処理
    const handleSaveLocation = async () => {
        if (!currentLocation) {
            Alert.alert("未取得", "先に現在地を取得してください。");
            return;
        }

        try {
            setSaving(true);

            const user = await getCurrentUser();

            const result = await client.models.LocationLog.create({
                userId: user.userId,
                latitude: currentLocation.latitude,
                longitude: currentLocation.longitude,
                accuracy: currentLocation.accuracy ?? undefined,
                recordedAt: currentLocation.recordedAt,
                memo: memo.trim() || undefined,
            });

            if (result.errors) {
                console.error(result.errors);
                Alert.alert("保存エラー", "位置情報を保存できませんでした。");
                return;
            }

            setMemo("");

            Alert.alert("保存完了", "現在地を記録しました。");
        } catch (error) {
            console.error(error);
            Alert.alert("エラー", "位置情報の保存に失敗しました。");
        } finally {
            setSaving(false);
        }
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
                <Text style={styles.title}>現在地を手動記録</Text>

                <AppButton title="現在地を取得" onPress={handleGetLocation} />

                {loading && <ActivityIndicator style={styles.loading} />}

                {currentLocation && (
                    <View style={styles.locationBox}>
                        <Text>緯度: {currentLocation.latitude}</Text>
                        <Text>経度: {currentLocation.longitude}</Text>
                        <Text>
                            精度:{" "}
                            {currentLocation.accuracy !== null
                                ? `${currentLocation.accuracy}m`
                                : "不明"}
                        </Text>
                        <Text>
                            記録日時:{" "}
                            {formatDateTime(currentLocation.recordedAt)}
                        </Text>
                    </View>
                )}

                <View style={styles.memoArea}>
                    <Text style={styles.label}>メモ</Text>
                    <TextInput
                        style={styles.memoInput}
                        value={memo}
                        onChangeText={setMemo}
                        placeholder="例：東京駅で打ち合わせ"
                        multiline
                        numberOfLines={3}
                        textAlignVertical="top"
                    />
                </View>

                <View style={styles.buttonSpace}>
                    <AppButton
                        title={saving ? "保存中..." : "この位置を保存"}
                        onPress={handleSaveLocation}
                        disabled={saving}
                    />
                </View>

                <View style={styles.buttonSpace}>
                    <AppButton
                        title="位置履歴を見る"
                        onPress={() => navigation.navigate("LocationLog")}
                    />
                </View>

                <View style={styles.buttonSpace}>
                    <AppButton
                        title="地図で見る"
                        onPress={() => navigation.navigate("LocationMap")}
                    />
                </View>
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

function AppButton({ title, onPress, disabled = false }: AppButtonProps) {
    return (
        <Pressable
            style={({ pressed }) => [
                styles.appButton,
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
    title: {
        fontSize: 22,
        fontWeight: "bold",
        marginBottom: 12,
    },
    loading: {
        marginTop: 16,
    },
    locationBox: {
        marginTop: 20,
        padding: 16,
        borderWidth: 1,
        borderColor: "#ccc",
        borderRadius: 8,
        gap: 6,
    },
    memoArea: {
        marginTop: 12,
    },
    label: {
        fontSize: 15,
        fontWeight: "bold",
        marginBottom: 6,
    },
    memoInput: {
        minHeight: 90,
        borderWidth: 1,
        borderColor: "#ccc",
        borderRadius: 8,
        padding: 12,
        fontSize: 16,
        backgroundColor: "#fff",
    },
    buttonSpace: {
        marginTop: 12,
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
});
