import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Image,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";

import { getUrl, uploadData } from "aws-amplify/storage";
import * as ImagePicker from "expo-image-picker";
import { client } from "../lib/client";
import type { RootStackParamList } from "../navigation/RootNavigator";
import {
    getCurrentUserProfile,
    updateUserProfileDisplayName,
} from "../services/userProfileService";

type Props = NativeStackScreenProps<RootStackParamList, "Profile">;

type UserProfileItem = {
    id: string;
    userId: string;
    email?: string | null;
    displayName?: string | null;
    ownerValue?: string | null;
    owner?: string | null;
    searchText?: string | null;
    iconImagePath?: string | null;
};

export default function ProfileScreen({ navigation }: Props) {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [profileId, setProfileId] = useState<string | null>(null);
    const [email, setEmail] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [iconImagePath, setIconImagePath] = useState<string | null>(null);
    const [iconImageUrl, setIconImageUrl] = useState<string | null>(null);
    const [uploadingIcon, setUploadingIcon] = useState(false);
    const [selectedIconUri, setSelectedIconUri] = useState<string | null>(null);

    const loadProfile = useCallback(async () => {
        try {
            setLoading(true);

            const profile = await getCurrentUserProfile();

            setProfileId(profile.id);
            setEmail(profile.email ?? "");
            setDisplayName(profile.displayName ?? "");

            const nextIconImagePath = profile.iconImagePath ?? null;
            setIconImagePath(nextIconImagePath);

            if (nextIconImagePath) {
                const urlResult = await getUrl({
                    path: nextIconImagePath,
                    options: {
                        expiresIn: 3600,
                    },
                });

                setIconImageUrl(urlResult.url.toString());
            } else {
                setIconImageUrl(null);
            }
        } catch (error) {
            console.error("Load profile error:", error);
            Alert.alert(
                "読み込みエラー",
                "プロフィールの読み込みに失敗しました。",
            );
        } finally {
            setLoading(false);
        }
    }, []);

    const saveProfile = async () => {
        const trimmedDisplayName = displayName.trim();

        if (!trimmedDisplayName) {
            Alert.alert("入力エラー", "ユーザー名を入力してください。");
            return;
        }

        try {
            setSaving(true);

            await updateUserProfileDisplayName(trimmedDisplayName);

            setDisplayName(trimmedDisplayName);

            Alert.alert("保存完了", "プロフィールを保存しました。");
            navigation.goBack();
        } catch (error) {
            console.error("Save profile error:", error);
            Alert.alert("保存エラー", "プロフィールの保存に失敗しました。");
        } finally {
            setSaving(false);
        }
    };

    const pickProfileIcon = async () => {
        try {
            const pickerResult = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ["images"],
                allowsEditing: true,
                aspect: [1, 1],
                quality: 0.7,
            });

            if (pickerResult.canceled) {
                return;
            }

            const asset = pickerResult.assets[0];

            if (!asset?.uri) {
                Alert.alert("選択エラー", "画像を取得できませんでした。");
                return;
            }

            setSelectedIconUri(asset.uri);
        } catch (error) {
            console.error("Pick profile icon error:", error);
            Alert.alert("選択エラー", "画像の選択に失敗しました。");
        }
    };

    const saveSelectedProfileIcon = async () => {
        if (!profileId) {
            Alert.alert(
                "プロフィール未読込",
                "プロフィール情報を読み込んでから再度お試しください。",
            );
            return;
        }

        if (!selectedIconUri) {
            Alert.alert("画像未選択", "先に画像を選択してください。");
            return;
        }

        try {
            setUploadingIcon(true);

            const response = await fetch(selectedIconUri);
            const blob = await response.blob();

            const uploadResult = await uploadData({
                path: ({ identityId }) =>
                    `profile-icons/${identityId}/profile-icon-${Date.now()}.jpg`,
                data: blob,
                options: {
                    contentType: "image/jpeg",
                },
            }).result;

            const nextIconImagePath = uploadResult.path;

            const updateResult = await client.models.UserProfile.update({
                id: profileId,
                iconImagePath: nextIconImagePath,
            });

            if (updateResult.errors) {
                console.error(
                    "UserProfile icon update errors:",
                    updateResult.errors,
                );
                Alert.alert(
                    "保存エラー",
                    "アイコン情報を保存できませんでした。",
                );
                return;
            }

            const urlResult = await getUrl({
                path: nextIconImagePath,
                options: {
                    expiresIn: 3600,
                },
            });

            setIconImagePath(nextIconImagePath);
            setIconImageUrl(urlResult.url.toString());
            setSelectedIconUri(null);

            Alert.alert("保存完了", "プロフィールアイコンを更新しました。");
        } catch (error) {
            console.error("Profile icon upload error:", error);
            Alert.alert(
                "保存エラー",
                "プロフィールアイコンの保存に失敗しました。",
            );
        } finally {
            setUploadingIcon(false);
        }
    };

    useFocusEffect(
        useCallback(() => {
            void loadProfile();
        }, [loadProfile]),
    );

    if (loading) {
        return (
            <View style={styles.center}>
                <ActivityIndicator />
            </View>
        );
    }

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
            <View style={styles.card}>
                <Text style={styles.title}>プロフィール</Text>

                <View style={styles.iconSection}>
                    {selectedIconUri || iconImageUrl ? (
                        <Image
                            source={{
                                uri: selectedIconUri ?? iconImageUrl ?? "",
                            }}
                            style={styles.profileIcon}
                        />
                    ) : (
                        <View style={styles.profileIconPlaceholder}>
                            <Text style={styles.profileIconPlaceholderText}>
                                アイコン未登録
                            </Text>
                        </View>
                    )}

                    <Pressable
                        style={[
                            styles.iconButton,
                            uploadingIcon && styles.disabledButton,
                        ]}
                        onPress={pickProfileIcon}
                        disabled={uploadingIcon || saving}
                    >
                        <Text style={styles.iconButtonText}>画像を選択</Text>
                    </Pressable>

                    {selectedIconUri && (
                        <>
                            <Pressable
                                style={[
                                    styles.iconSaveButton,
                                    uploadingIcon && styles.disabledButton,
                                ]}
                                onPress={saveSelectedProfileIcon}
                                disabled={uploadingIcon || saving}
                            >
                                <Text style={styles.iconButtonText}>
                                    {uploadingIcon
                                        ? "アップロード中..."
                                        : "このアイコンを保存"}
                                </Text>
                            </Pressable>

                            <Pressable
                                style={styles.iconCancelButton}
                                onPress={() => setSelectedIconUri(null)}
                                disabled={uploadingIcon}
                            >
                                <Text style={styles.iconCancelButtonText}>
                                    選択を取り消す
                                </Text>
                            </Pressable>
                        </>
                    )}
                </View>

                <Text style={styles.label}>メールアドレス</Text>
                <TextInput
                    style={[styles.input, styles.readOnlyInput]}
                    value={email}
                    editable={false}
                />

                <Text style={styles.label}>ユーザー名</Text>
                <TextInput
                    style={styles.input}
                    value={displayName}
                    onChangeText={setDisplayName}
                    placeholder="例：佐藤"
                    editable={!saving}
                />

                <Text style={styles.description}>
                    このユーザー名は、共有先ユーザー検索で表示されます。
                </Text>

                <Pressable
                    style={[styles.saveButton, saving && styles.disabledButton]}
                    onPress={saveProfile}
                    disabled={saving}
                >
                    <Text style={styles.saveButtonText}>
                        {saving ? "保存中..." : "保存"}
                    </Text>
                </Pressable>

                <Pressable
                    style={styles.backButton}
                    onPress={() => navigation.goBack()}
                    disabled={saving}
                >
                    <Text style={styles.backButtonText}>戻る</Text>
                </Pressable>
            </View>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 20,
        backgroundColor: "#f7f7f7",
    },
    center: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
    },
    card: {
        padding: 18,
        borderRadius: 12,
        backgroundColor: "#fff",
        borderWidth: 1,
        borderColor: "#ddd",
    },
    title: {
        fontSize: 20,
        fontWeight: "bold",
        marginBottom: 18,
        color: "#333",
    },
    label: {
        fontSize: 14,
        fontWeight: "bold",
        marginBottom: 6,
        color: "#333",
    },
    input: {
        height: 44,
        borderWidth: 1,
        borderColor: "#ccc",
        borderRadius: 8,
        paddingHorizontal: 12,
        fontSize: 16,
        backgroundColor: "#fff",
        marginBottom: 14,
    },
    readOnlyInput: {
        backgroundColor: "#f0f0f0",
        color: "#666",
    },
    description: {
        fontSize: 13,
        color: "#666",
        marginBottom: 18,
        lineHeight: 18,
    },
    saveButton: {
        backgroundColor: "#4b6f8f",
        borderRadius: 8,
        paddingVertical: 11,
        alignItems: "center",
        marginBottom: 10,
    },
    saveButtonText: {
        color: "#fff",
        fontSize: 16,
        fontWeight: "bold",
    },
    backButton: {
        backgroundColor: "#e6edf3",
        borderRadius: 8,
        paddingVertical: 11,
        alignItems: "center",
        borderWidth: 1,
        borderColor: "#c8d6e0",
    },
    backButtonText: {
        color: "#2f4f66",
        fontSize: 16,
        fontWeight: "bold",
    },
    disabledButton: {
        opacity: 0.5,
    },
    iconSection: {
        alignItems: "center",
        marginBottom: 20,
    },
    profileIcon: {
        width: 96,
        height: 96,
        borderRadius: 48,
        backgroundColor: "#e6edf3",
    },
    profileIconPlaceholder: {
        width: 96,
        height: 96,
        borderRadius: 48,
        backgroundColor: "#e6edf3",
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: "#c8d6e0",
    },
    profileIconPlaceholderText: {
        color: "#4b6f8f",
        fontSize: 12,
        fontWeight: "bold",
    },
    iconButton: {
        marginTop: 12,
        backgroundColor: "#4b6f8f",
        borderRadius: 8,
        paddingVertical: 10,
        paddingHorizontal: 16,
        alignItems: "center",
    },
    iconButtonText: {
        color: "#fff",
        fontSize: 14,
        fontWeight: "bold",
    },
    iconSaveButton: {
        marginTop: 10,
        backgroundColor: "#4b6f8f",
        borderRadius: 8,
        paddingVertical: 10,
        paddingHorizontal: 16,
        alignItems: "center",
    },
    iconCancelButton: {
        marginTop: 8,
        backgroundColor: "#e6edf3",
        borderRadius: 8,
        paddingVertical: 8,
        paddingHorizontal: 16,
        alignItems: "center",
        borderWidth: 1,
        borderColor: "#c8d6e0",
    },
    iconCancelButtonText: {
        color: "#2f4f66",
        fontSize: 13,
        fontWeight: "bold",
    },
});
