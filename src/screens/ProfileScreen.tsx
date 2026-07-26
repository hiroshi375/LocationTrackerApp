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
    ScrollView,
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
    deleteCurrentAccount,
    type AccountDeletionProgress,
} from "../services/accountDeletionService";
import {
    getCurrentUserProfile,
    updateUserProfileDisplayName,
} from "../services/userProfileService";

type Props = NativeStackScreenProps<RootStackParamList, "Profile">;

export default function ProfileScreen({ navigation }: Props) {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [deletingAccount, setDeletingAccount] = useState(false);
    const [deleteAccountProgress, setDeleteAccountProgress] =
        useState<AccountDeletionProgress | null>(null);

    const [profileId, setProfileId] = useState<string | null>(null);
    const [email, setEmail] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [iconImageUrl, setIconImageUrl] = useState<string | null>(null);
    const [uploadingIcon, setUploadingIcon] = useState(false);
    const [selectedIconUri, setSelectedIconUri] = useState<string | null>(null);
    const isProcessing = saving || uploadingIcon || deletingAccount;

    const loadProfile = useCallback(async () => {
        try {
            setLoading(true);

            const profile = await getCurrentUserProfile();

            setProfileId(profile.id);
            setEmail(profile.email ?? "");
            setDisplayName(profile.displayName ?? "");

            const nextIconImagePath = profile.iconImagePath ?? null;

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

    const handleDeleteAccount = () => {
        if (isProcessing) {
            return;
        }

        Alert.alert(
            "アカウントを削除",
            [
                "アカウントと関連するすべてのデータを完全に削除します。",
                "",
                "削除されるデータ",
                "・プロフィール",
                "・プロフィール画像",
                "・位置履歴",
                "・アクティビティ履歴",
                "・現在地共有情報",
                "・月次集計情報",
                "・端末内の記録状態",
                "",
                "この操作は元に戻せません。",
            ].join("\n"),
            [
                {
                    text: "キャンセル",
                    style: "cancel",
                },
                {
                    text: "削除する",
                    style: "destructive",
                    onPress: confirmDeleteAccount,
                },
            ],
        );
    };

    const confirmDeleteAccount = () => {
        Alert.alert("最終確認", "本当にアカウントを完全に削除しますか？", [
            {
                text: "キャンセル",
                style: "cancel",
            },
            {
                text: "完全に削除",
                style: "destructive",
                onPress: () => {
                    void executeDeleteAccount();
                },
            },
        ]);
    };

    const executeDeleteAccount = async () => {
        try {
            setDeletingAccount(true);
            setDeleteAccountProgress("stoppingRecording");

            await deleteCurrentAccount({
                onProgress: setDeleteAccountProgress,
            });

            /*
             * deleteUser()に成功すると未認証状態になるため、
             * Authenticator側でサインイン画面へ切り替わる。
             */
        } catch (error) {
            console.error("Delete account error:", error);

            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "不明なエラーが発生しました。";

            Alert.alert(
                "アカウント削除エラー",
                [
                    "アカウントを完全に削除できませんでした。",
                    "一部のデータが既に削除されている可能性があります。",
                    "",
                    errorMessage,
                    "",
                    "通信状態を確認して、もう一度実行してください。",
                ].join("\n"),
            );
        } finally {
            setDeletingAccount(false);
            setDeleteAccountProgress(null);
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
            <ScrollView
                contentContainerStyle={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
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
                                isProcessing && styles.disabledButton,
                            ]}
                            onPress={pickProfileIcon}
                            disabled={isProcessing}
                        >
                            <Text style={styles.iconButtonText}>
                                画像を選択
                            </Text>
                        </Pressable>

                        {selectedIconUri && (
                            <>
                                <Pressable
                                    style={[
                                        styles.iconSaveButton,
                                        isProcessing && styles.disabledButton,
                                    ]}
                                    onPress={saveSelectedProfileIcon}
                                    disabled={isProcessing}
                                >
                                    <Text style={styles.iconButtonText}>
                                        {uploadingIcon
                                            ? "アップロード中..."
                                            : "このアイコンを保存"}
                                    </Text>
                                </Pressable>

                                <Pressable
                                    style={[
                                        styles.iconCancelButton,
                                        isProcessing && styles.disabledButton,
                                    ]}
                                    onPress={() => setSelectedIconUri(null)}
                                    disabled={isProcessing}
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
                        editable={!isProcessing}
                    />

                    <Text style={styles.description}>
                        このユーザー名は、共有先ユーザー検索で表示されます。
                    </Text>

                    <Pressable
                        style={[
                            styles.saveButton,
                            isProcessing && styles.disabledButton,
                        ]}
                        onPress={saveProfile}
                        disabled={isProcessing}
                    >
                        <Text style={styles.saveButtonText}>
                            {saving ? "保存中..." : "保存"}
                        </Text>
                    </Pressable>

                    <Pressable
                        style={[
                            styles.backButton,
                            isProcessing && styles.disabledButton,
                        ]}
                        onPress={() => navigation.goBack()}
                        disabled={isProcessing}
                    >
                        <Text style={styles.backButtonText}>戻る</Text>
                    </Pressable>

                    <View style={styles.dangerZone}>
                        <Text style={styles.dangerZoneTitle}>
                            アカウント管理
                        </Text>

                        <Text style={styles.dangerZoneDescription}>
                            アカウントを削除すると、位置履歴、アクティビティ履歴、
                            プロフィール、プロフィール画像、共有情報などが削除されます。
                            この操作は元に戻せません。
                        </Text>

                        <Pressable
                            style={[
                                styles.deleteAccountButton,
                                deletingAccount && styles.disabledButton,
                            ]}
                            onPress={handleDeleteAccount}
                            disabled={isProcessing}
                        >
                            {deletingAccount ? (
                                <View style={styles.deleteAccountProgressRow}>
                                    <ActivityIndicator
                                        size="small"
                                        color="#ffffff"
                                    />

                                    <Text
                                        style={styles.deleteAccountButtonText}
                                    >
                                        {getDeleteAccountProgressText(
                                            deleteAccountProgress,
                                        )}
                                    </Text>
                                </View>
                            ) : (
                                <Text style={styles.deleteAccountButtonText}>
                                    アカウントを削除
                                </Text>
                            )}
                        </Pressable>
                    </View>
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

function getDeleteAccountProgressText(
    progress: AccountDeletionProgress | null,
): string {
    switch (progress) {
        case "stoppingRecording":
            return "自動記録を停止中...";

        case "loadingProfile":
            return "プロフィールを確認中...";

        case "deletingLocationLogs":
            return "位置履歴を削除中...";

        case "deletingRecordingSessions":
            return "アクティビティ履歴を削除中...";

        case "deletingLiveLocations":
            return "現在地共有情報を削除中...";

        case "deletingMonthlySummaries":
            return "月次集計を削除中...";

        case "deletingDebugLogs":
            return "記録ログを削除中...";

        case "deletingProfileImage":
            return "プロフィール画像を削除中...";

        case "deletingProfile":
            return "プロフィールを削除中...";

        case "deletingLocalData":
            return "端末内データを削除中...";

        case "deletingCognitoUser":
            return "アカウントを削除中...";

        default:
            return "削除中...";
    }
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
    scrollContent: {
        paddingBottom: 40,
    },

    dangerZone: {
        marginTop: 28,
        paddingTop: 20,
        borderTopWidth: 1,
        borderTopColor: "#e0b4b4",
    },

    dangerZoneTitle: {
        fontSize: 16,
        fontWeight: "bold",
        color: "#a12622",
        marginBottom: 8,
    },

    dangerZoneDescription: {
        fontSize: 13,
        lineHeight: 20,
        color: "#666",
        marginBottom: 14,
    },

    deleteAccountButton: {
        minHeight: 48,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderRadius: 8,
        backgroundColor: "#c62828",
        alignItems: "center",
        justifyContent: "center",
    },

    deleteAccountProgressRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
    },

    deleteAccountButtonText: {
        color: "#ffffff",
        fontSize: 14,
        fontWeight: "bold",
        textAlign: "center",
    },
});
