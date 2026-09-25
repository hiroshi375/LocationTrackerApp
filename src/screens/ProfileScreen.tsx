import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useLayoutEffect, useState } from "react";
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
import { useSubscription } from "../hooks/useSubscription";
import { client } from "../lib/client";
import type { RootStackParamList } from "../navigation/RootNavigator";
import {
    deleteCurrentAccount,
    type AccountDeletionProgress,
} from "../services/accountDeletionService";
import {
    getCurrentUserProfile,
    updateUserProfileDisplayName,
    updateUserProfileWeightKg,
} from "../services/userProfileService";
import {
    getPremiumPackage,
    getRevenueCatCustomerInfo,
    hasPremiumEntitlement,
    purchasePremium,
    restorePremiumPurchases,
} from "../services/revenueCatService";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type Props = NativeStackScreenProps<RootStackParamList, "Profile">;

export default function ProfileScreen({ navigation }: Props) {
    const insets = useSafeAreaInsets();

    useLayoutEffect(() => {
        navigation.setOptions({
            headerShown: false,
        });
    }, [navigation]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [deletingAccount, setDeletingAccount] = useState(false);
    const [deleteAccountProgress, setDeleteAccountProgress] =
        useState<AccountDeletionProgress | null>(null);

    const [profileId, setProfileId] = useState<string | null>(null);
    const [email, setEmail] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [weightKg, setWeightKg] = useState("");
    const [profileRole, setProfileRole] = useState<string | null>(null);
    const [iconImageUrl, setIconImageUrl] = useState<string | null>(null);
    const [uploadingIcon, setUploadingIcon] = useState(false);
    const [selectedIconUri, setSelectedIconUri] = useState<string | null>(null);
    const [premiumPurchased, setPremiumPurchased] = useState(false);
    const [premiumPriceText, setPremiumPriceText] = useState("");
    const [purchasingPremium, setPurchasingPremium] = useState(false);
    const [restoringPremium, setRestoringPremium] = useState(false);
    const {
        tier: subscriptionTier,
        loading: subscriptionLoading,
        refresh: refreshSubscription,
    } = useSubscription();

    const isProcessing =
        saving ||
        uploadingIcon ||
        deletingAccount ||
        purchasingPremium ||
        restoringPremium;

    const isAdmin = profileRole === "admin";

    const isPremiumPlan =
        subscriptionTier === "PREMIUM" || premiumPurchased || isAdmin;

    const currentPlanText = isAdmin
        ? "Premium（管理者）"
        : isPremiumPlan
          ? "Premium"
          : "FREE";

    const loadProfile = useCallback(async () => {
        try {
            setLoading(true);

            const profile = await getCurrentUserProfile();

            setProfileId(profile.id);
            setEmail(profile.email ?? "");
            setDisplayName(profile.displayName ?? "");
            setWeightKg(
                typeof profile.weightKg === "number"
                    ? String(profile.weightKg)
                    : "",
            );
            setProfileRole(profile.role ?? null);

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

    const loadPremiumPurchaseStatus = useCallback(async (): Promise<void> => {
        try {
            const [customerInfo, premiumPackage] = await Promise.all([
                getRevenueCatCustomerInfo(),
                getPremiumPackage(),
            ]);

            const purchased = hasPremiumEntitlement(customerInfo);

            setPremiumPurchased(purchased);

            setPremiumPriceText(premiumPackage?.product.priceString ?? "");

            console.log("[Profile] Premium status:", {
                purchased,
                price: premiumPackage?.product.priceString ?? null,
            });
        } catch (error) {
            console.error("[Profile] Premium status load error:", error);

            setPremiumPurchased(false);
            setPremiumPriceText("");
        }
    }, []);

    const handlePurchasePremium = async (): Promise<void> => {
        if (purchasingPremium) {
            return;
        }

        if (isPremiumPlan) {
            Alert.alert(
                "Premium利用中",
                isAdmin
                    ? "管理者ユーザーはPremium機能を利用できます。"
                    : "すでにPremiumプランをご利用いただいています。",
            );
            return;
        }

        try {
            setPurchasingPremium(true);

            const result = await purchasePremium();

            if (result.status === "CANCELLED") {
                return;
            }

            setPremiumPurchased(true);

            await refreshSubscription();

            Alert.alert("購入完了", "Premium機能が利用可能になりました。");
        } catch (error) {
            console.error("[Profile] Premium purchase error:", error);

            Alert.alert("購入エラー", "Premiumの購入に失敗しました。");
        } finally {
            setPurchasingPremium(false);
        }
    };

    const handleRestorePremium = async (): Promise<void> => {
        if (restoringPremium) {
            return;
        }

        try {
            setRestoringPremium(true);

            const customerInfo = await restorePremiumPurchases();

            const purchased = hasPremiumEntitlement(customerInfo);

            setPremiumPurchased(purchased);

            await refreshSubscription();

            Alert.alert(
                purchased ? "復元完了" : "購入情報なし",
                purchased
                    ? "Premium購入情報を復元しました。"
                    : "復元できるPremium購入情報はありませんでした。",
            );
        } catch (error) {
            console.error("[Profile] Premium restore error:", error);

            Alert.alert("復元エラー", "購入情報の復元に失敗しました。");
        } finally {
            setRestoringPremium(false);
        }
    };

    const saveProfile = async () => {
        const trimmedDisplayName = displayName.trim();
        const trimmedWeightKg = weightKg.trim();

        let parsedWeightKg: number | null = null;

        if (trimmedWeightKg) {
            parsedWeightKg = Number(trimmedWeightKg);

            if (
                !Number.isFinite(parsedWeightKg) ||
                parsedWeightKg <= 0 ||
                parsedWeightKg > 300
            ) {
                Alert.alert(
                    "入力エラー",
                    "体重は0より大きく300kg以下の数値で入力してください。",
                );
                return;
            }
        }
        if (!trimmedDisplayName) {
            Alert.alert("入力エラー", "ユーザー名を入力してください。");
            return;
        }

        if (!profileId) {
            Alert.alert(
                "プロフィール未読込",
                "プロフィール情報を読み込んでから再度お試しください。",
            );
            return;
        }

        try {
            setSaving(true);

            let nextIconImagePath: string | null = null;

            /*
             * 新しい画像が選択されている場合だけ、
             * S3へアップロードする。
             */
            if (selectedIconUri) {
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

                nextIconImagePath = uploadResult.path;
            }

            /*
             * displayNameは既存serviceで更新する。
             */
            await updateUserProfileDisplayName(trimmedDisplayName);
            await updateUserProfileWeightKg(parsedWeightKg);
            /*
             * 新しいアイコンが選択されていた場合だけ、
             * 同じUserProfileへiconImagePathを保存する。
             */
            if (nextIconImagePath) {
                const updateResult = await client.models.UserProfile.update({
                    id: profileId,
                    iconImagePath: nextIconImagePath,
                });

                if (updateResult.errors) {
                    console.error(
                        "UserProfile icon update errors:",
                        updateResult.errors,
                    );

                    throw new Error("アイコン情報を保存できませんでした。");
                }

                const urlResult = await getUrl({
                    path: nextIconImagePath,
                    options: {
                        expiresIn: 3600,
                    },
                });

                setIconImageUrl(urlResult.url.toString());
                setSelectedIconUri(null);
            }

            setDisplayName(trimmedDisplayName);

            Alert.alert("保存完了", "プロフィールを保存しました。");
            navigation.goBack();
        } catch (error) {
            console.error("Save profile error:", error);

            Alert.alert("保存エラー", "プロフィールの保存に失敗しました。");
        } finally {
            setSaving(false);
            setUploadingIcon(false);
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
            void loadPremiumPurchaseStatus();
        }, [loadProfile, loadPremiumPurchaseStatus]),
    );

    return (
        <View style={styles.screen}>
            <StatusBar
                style="light"
                backgroundColor="#06395f"
                translucent={false}
            />

            {/* ヘッダ */}
            <View
                style={[
                    styles.appHeader,
                    {
                        paddingTop: Math.max(insets.top, 8),
                    },
                ]}
            >
                <Pressable
                    style={styles.headerBackButton}
                    onPress={() => navigation.goBack()}
                    disabled={isProcessing}
                >
                    <Text style={styles.headerBackText}>‹</Text>
                </Pressable>

                <Text style={styles.headerTitle} numberOfLines={1}>
                    プロフィール
                </Text>

                <View style={styles.headerRightSpace} />
            </View>

            {loading ? (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="small" color="#0e9384" />

                    <Text style={styles.loadingText}>
                        プロフィールを読み込み中...
                    </Text>
                </View>
            ) : (
                <KeyboardAvoidingView
                    style={styles.keyboardAvoidingView}
                    behavior={Platform.OS === "ios" ? "padding" : undefined}
                >
                    <ScrollView
                        style={styles.scrollView}
                        contentContainerStyle={styles.scrollContent}
                        keyboardShouldPersistTaps="handled"
                        showsVerticalScrollIndicator={false}
                    >
                        {/* プロフィール画像 */}
                        <View style={styles.profileTopSection}>
                            <View style={styles.profileImageWrapper}>
                                {selectedIconUri || iconImageUrl ? (
                                    <Image
                                        source={{
                                            uri:
                                                selectedIconUri ??
                                                iconImageUrl ??
                                                "",
                                        }}
                                        style={styles.profileIcon}
                                    />
                                ) : (
                                    <View style={styles.profileIconPlaceholder}>
                                        <MaterialCommunityIcons
                                            name="account"
                                            size={56}
                                            color="#78909c"
                                        />
                                    </View>
                                )}

                                <Pressable
                                    style={({ pressed }) => [
                                        styles.profileImageEditButton,
                                        pressed && styles.buttonPressed,
                                        isProcessing && styles.disabledButton,
                                    ]}
                                    onPress={pickProfileIcon}
                                    disabled={isProcessing}
                                >
                                    <MaterialCommunityIcons
                                        name="camera"
                                        size={17}
                                        color="#ffffff"
                                    />
                                </Pressable>
                            </View>

                            <Text
                                style={styles.profileDisplayName}
                                numberOfLines={1}
                            >
                                {displayName.trim() || "ユーザー"}
                            </Text>

                            <Text style={styles.profileEmail} numberOfLines={1}>
                                {email}
                            </Text>

                            <Pressable
                                style={({ pressed }) => [
                                    styles.changeImageButton,
                                    pressed && styles.buttonPressed,
                                    isProcessing && styles.disabledButton,
                                ]}
                                onPress={pickProfileIcon}
                                disabled={isProcessing}
                            >
                                <MaterialCommunityIcons
                                    name="image-edit-outline"
                                    size={16}
                                    color="#0e7185"
                                />

                                <Text style={styles.changeImageButtonText}>
                                    アイコンを変更
                                </Text>
                            </Pressable>

                            {selectedIconUri && (
                                <Pressable
                                    style={styles.cancelImageButton}
                                    onPress={() => setSelectedIconUri(null)}
                                    disabled={isProcessing}
                                >
                                    <Text style={styles.cancelImageButtonText}>
                                        選択を取り消す
                                    </Text>
                                </Pressable>
                            )}
                        </View>

                        {/* 基本情報 */}
                        <View style={styles.sectionCard}>
                            <View style={styles.sectionHeader}>
                                <MaterialCommunityIcons
                                    name="account-outline"
                                    size={21}
                                    color="#0e9384"
                                />

                                <Text style={styles.sectionTitle}>
                                    基本情報
                                </Text>
                            </View>

                            <View style={styles.formItem}>
                                <View style={styles.formLabelRow}>
                                    <MaterialCommunityIcons
                                        name="email-outline"
                                        size={19}
                                        color="#71838c"
                                    />

                                    <Text style={styles.formLabel}>
                                        メールアドレス
                                    </Text>
                                </View>

                                <TextInput
                                    style={[styles.input, styles.readOnlyInput]}
                                    value={email}
                                    editable={false}
                                />
                            </View>

                            <View style={styles.formDivider} />

                            <View style={styles.formItem}>
                                <View style={styles.formLabelRow}>
                                    <MaterialCommunityIcons
                                        name="account-edit-outline"
                                        size={19}
                                        color="#71838c"
                                    />

                                    <Text style={styles.formLabel}>表示名</Text>
                                </View>

                                <TextInput
                                    style={styles.input}
                                    value={displayName}
                                    onChangeText={setDisplayName}
                                    placeholder="例：佐藤"
                                    editable={!isProcessing}
                                />

                                <Text style={styles.helperText}>
                                    ランキングや共有先ユーザー検索で
                                    表示されます。
                                </Text>
                            </View>

                            <View style={styles.formDivider} />

                            <View style={styles.formItem}>
                                <View style={styles.formLabelRow}>
                                    <MaterialCommunityIcons
                                        name="weight-kilogram"
                                        size={19}
                                        color="#71838c"
                                    />

                                    <Text style={styles.formLabel}>体重</Text>
                                </View>

                                <View style={styles.weightInputRow}>
                                    <TextInput
                                        style={[
                                            styles.input,
                                            styles.weightInput,
                                        ]}
                                        value={weightKg}
                                        onChangeText={setWeightKg}
                                        placeholder="例：65.0"
                                        keyboardType="decimal-pad"
                                        editable={!isProcessing}
                                        maxLength={6}
                                    />

                                    <Text style={styles.weightUnit}>kg</Text>
                                </View>

                                <Text style={styles.helperText}>
                                    消費カロリーの推定計算に使用します。
                                </Text>
                            </View>

                            <Pressable
                                style={({ pressed }) => [
                                    styles.saveButton,
                                    pressed &&
                                        !isProcessing &&
                                        styles.buttonPressed,
                                    isProcessing && styles.disabledButton,
                                ]}
                                onPress={saveProfile}
                                disabled={isProcessing}
                            >
                                {saving || uploadingIcon ? (
                                    <View style={styles.buttonLoadingRow}>
                                        <ActivityIndicator
                                            size="small"
                                            color="#ffffff"
                                        />

                                        <Text style={styles.saveButtonText}>
                                            保存中...
                                        </Text>
                                    </View>
                                ) : (
                                    <Text style={styles.saveButtonText}>
                                        変更を保存
                                    </Text>
                                )}
                            </Pressable>
                        </View>

                        {/* プラン */}
                        <View style={styles.sectionCard}>
                            <View style={styles.sectionHeader}>
                                <MaterialCommunityIcons
                                    name={
                                        isPremiumPlan
                                            ? "crown-outline"
                                            : "shield-outline"
                                    }
                                    size={21}
                                    color={
                                        isPremiumPlan ? "#d49a16" : "#0e9384"
                                    }
                                />

                                <Text style={styles.sectionTitle}>
                                    サブスクリプション
                                </Text>
                            </View>

                            <View style={styles.planCurrentRow}>
                                <View>
                                    <Text style={styles.planLabel}>
                                        現在のプラン
                                    </Text>

                                    <Text
                                        style={[
                                            styles.planValue,
                                            isPremiumPlan &&
                                                styles.planPremiumValue,
                                        ]}
                                    >
                                        {subscriptionLoading
                                            ? "確認中..."
                                            : currentPlanText}
                                    </Text>
                                </View>

                                <View
                                    style={[
                                        styles.planBadge,
                                        isPremiumPlan
                                            ? styles.premiumBadge
                                            : styles.freeBadge,
                                    ]}
                                >
                                    <MaterialCommunityIcons
                                        name={
                                            isPremiumPlan
                                                ? "crown"
                                                : "check-circle-outline"
                                        }
                                        size={16}
                                        color={
                                            isPremiumPlan
                                                ? "#9b6a00"
                                                : "#56727e"
                                        }
                                    />

                                    <Text
                                        style={[
                                            styles.planBadgeText,
                                            isPremiumPlan &&
                                                styles.premiumBadgeText,
                                        ]}
                                    >
                                        {isPremiumPlan ? "Premium" : "Free"}
                                    </Text>
                                </View>
                            </View>

                            {isAdmin ? (
                                <Text style={styles.planDescription}>
                                    管理者ユーザーのため、
                                    Premium機能を利用できます。
                                </Text>
                            ) : premiumPurchased ? (
                                <Text style={styles.premiumActiveText}>
                                    Premium購入済み
                                </Text>
                            ) : isPremiumPlan ? (
                                <Text style={styles.premiumActiveText}>
                                    Premium利用中
                                </Text>
                            ) : (
                                <>
                                    <Text style={styles.planDescription}>
                                        Premiumでは、
                                        すべての機能をご利用いただけます。
                                    </Text>

                                    <Pressable
                                        style={({ pressed }) => [
                                            styles.premiumPurchaseButton,
                                            pressed &&
                                                !isProcessing &&
                                                styles.buttonPressed,
                                            isProcessing &&
                                                styles.disabledButton,
                                        ]}
                                        disabled={
                                            isProcessing || subscriptionLoading
                                        }
                                        onPress={() => {
                                            void handlePurchasePremium();
                                        }}
                                    >
                                        <MaterialCommunityIcons
                                            name="crown"
                                            size={19}
                                            color="#ffffff"
                                        />

                                        <Text
                                            style={
                                                styles.premiumPurchaseButtonText
                                            }
                                        >
                                            {purchasingPremium
                                                ? "購入処理中..."
                                                : premiumPriceText
                                                  ? `Premiumを購入  ${premiumPriceText}`
                                                  : "Premiumを購入"}
                                        </Text>
                                    </Pressable>
                                </>
                            )}

                            <Pressable
                                style={({ pressed }) => [
                                    styles.restoreButton,
                                    pressed && styles.buttonPressed,
                                ]}
                                disabled={isProcessing}
                                onPress={() => {
                                    void handleRestorePremium();
                                }}
                            >
                                <MaterialCommunityIcons
                                    name="restore"
                                    size={17}
                                    color="#557480"
                                />

                                <Text style={styles.restoreButtonText}>
                                    {restoringPremium
                                        ? "復元中..."
                                        : "購入を復元"}
                                </Text>
                            </Pressable>
                        </View>

                        {/* アカウント管理 */}
                        <View
                            style={[styles.sectionCard, styles.accountSection]}
                        >
                            <View style={styles.sectionHeader}>
                                <MaterialCommunityIcons
                                    name="account-cog-outline"
                                    size={21}
                                    color="#71838c"
                                />

                                <Text style={styles.sectionTitle}>
                                    アカウント管理
                                </Text>
                            </View>

                            <Text style={styles.accountDescription}>
                                アカウントを削除すると、位置履歴、
                                アクティビティ履歴、プロフィール、
                                共有情報などがすべて削除されます。
                            </Text>

                            <Pressable
                                style={({ pressed }) => [
                                    styles.deleteAccountButton,
                                    pressed &&
                                        !isProcessing &&
                                        styles.deleteAccountButtonPressed,
                                    deletingAccount && styles.disabledButton,
                                ]}
                                onPress={handleDeleteAccount}
                                disabled={isProcessing}
                            >
                                {deletingAccount ? (
                                    <View style={styles.buttonLoadingRow}>
                                        <ActivityIndicator
                                            size="small"
                                            color="#c0392b"
                                        />

                                        <Text
                                            style={
                                                styles.deleteAccountButtonText
                                            }
                                        >
                                            {getDeleteAccountProgressText(
                                                deleteAccountProgress,
                                            )}
                                        </Text>
                                    </View>
                                ) : (
                                    <>
                                        <MaterialCommunityIcons
                                            name="delete-outline"
                                            size={19}
                                            color="#c0392b"
                                        />

                                        <Text
                                            style={
                                                styles.deleteAccountButtonText
                                            }
                                        >
                                            アカウントを削除
                                        </Text>
                                    </>
                                )}
                            </Pressable>
                        </View>
                    </ScrollView>
                </KeyboardAvoidingView>
            )}
        </View>
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
    screen: {
        flex: 1,
        backgroundColor: "#f3f7f9",
    },

    appHeader: {
        minHeight: 58,

        paddingHorizontal: 10,
        paddingBottom: 8,

        flexDirection: "row",
        alignItems: "flex-end",

        backgroundColor: "#06395f",

        elevation: 6,

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.16,
        shadowRadius: 4,
    },

    headerBackButton: {
        width: 46,
        height: 44,

        alignItems: "center",
        justifyContent: "center",
    },

    headerBackText: {
        color: "#ffffff",

        fontSize: 42,
        lineHeight: 42,
        fontWeight: "300",
    },

    headerTitle: {
        flex: 1,

        paddingBottom: 9,

        textAlign: "center",

        color: "#ffffff",

        fontSize: 18,
        fontWeight: "700",
    },

    headerRightSpace: {
        width: 46,
        height: 44,
    },

    keyboardAvoidingView: {
        flex: 1,
    },

    scrollView: {
        flex: 1,
    },

    scrollContent: {
        paddingHorizontal: 14,
        paddingTop: 12,
        paddingBottom: 36,
    },

    loadingContainer: {
        flex: 1,

        alignItems: "center",
        justifyContent: "center",

        gap: 8,
    },

    loadingText: {
        color: "#71838c",

        fontSize: 13,
    },

    profileTopSection: {
        alignItems: "center",

        marginBottom: 14,
    },

    profileImageWrapper: {
        position: "relative",
    },

    profileIcon: {
        width: 92,
        height: 92,

        borderRadius: 46,

        borderWidth: 3,
        borderColor: "#ffffff",

        backgroundColor: "#dce7eb",

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.12,
        shadowRadius: 5,

        elevation: 3,
    },

    profileIconPlaceholder: {
        width: 92,
        height: 92,

        borderRadius: 46,

        alignItems: "center",
        justifyContent: "center",

        borderWidth: 3,
        borderColor: "#ffffff",

        backgroundColor: "#dfe9ed",
    },

    profileImageEditButton: {
        position: "absolute",

        right: -1,
        bottom: 0,

        width: 31,
        height: 31,

        borderRadius: 16,

        alignItems: "center",
        justifyContent: "center",

        borderWidth: 2,
        borderColor: "#ffffff",

        backgroundColor: "#0e9384",
    },

    profileDisplayName: {
        marginTop: 7,

        color: "#183b50",

        fontSize: 20,
        fontWeight: "700",
    },

    profileEmail: {
        marginTop: 1,

        color: "#7a8b93",

        fontSize: 12,
    },

    changeImageButton: {
        marginTop: 8,

        minHeight: 32,

        paddingHorizontal: 12,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 5,

        borderRadius: 16,

        borderWidth: 1,
        borderColor: "#bfd8df",

        backgroundColor: "#ffffff",
    },
    changeImageButtonText: {
        color: "#0e7185",

        fontSize: 12,
        fontWeight: "700",
    },

    cancelImageButton: {
        marginTop: 5,
    },

    cancelImageButtonText: {
        color: "#87969d",

        fontSize: 11,
        textDecorationLine: "underline",
    },

    sectionCard: {
        marginBottom: 12,

        padding: 14,

        borderRadius: 14,

        borderWidth: 1,
        borderColor: "#dfe7ea",

        backgroundColor: "#ffffff",

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.05,
        shadowRadius: 4,

        elevation: 1,
    },

    sectionHeader: {
        marginBottom: 15,

        flexDirection: "row",
        alignItems: "center",

        gap: 8,
    },

    sectionTitle: {
        color: "#203f4f",

        fontSize: 16,
        fontWeight: "700",
    },

    formItem: {
        paddingVertical: 2,
    },

    formLabelRow: {
        marginBottom: 7,

        flexDirection: "row",
        alignItems: "center",

        gap: 7,
    },

    formLabel: {
        color: "#49606b",

        fontSize: 13,
        fontWeight: "700",
    },

    input: {
        height: 42,

        paddingHorizontal: 12,

        borderWidth: 1,
        borderColor: "#d3dfe4",
        borderRadius: 9,

        backgroundColor: "#ffffff",

        color: "#213f4d",

        fontSize: 15,
    },

    readOnlyInput: {
        backgroundColor: "#f3f6f7",

        color: "#7a8b93",
    },

    formDivider: {
        height: StyleSheet.hairlineWidth,

        marginVertical: 11,

        backgroundColor: "#e0e7ea",
    },

    helperText: {
        marginTop: 6,

        color: "#819198",

        fontSize: 11,
        lineHeight: 16,
    },

    weightInputRow: {
        flexDirection: "row",
        alignItems: "center",

        gap: 10,
    },

    weightInput: {
        flex: 1,
    },

    weightUnit: {
        minWidth: 24,

        color: "#607780",

        fontSize: 14,
        fontWeight: "700",
    },

    saveButton: {
        minHeight: 44,

        marginTop: 16,

        alignItems: "center",
        justifyContent: "center",

        borderRadius: 10,

        backgroundColor: "#0e9384",
    },

    saveButtonText: {
        color: "#ffffff",

        fontSize: 14,
        fontWeight: "700",
    },

    buttonLoadingRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 8,
    },

    buttonPressed: {
        opacity: 0.7,
    },

    disabledButton: {
        opacity: 0.5,
    },

    planCurrentRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",

        padding: 12,

        borderRadius: 10,

        backgroundColor: "#f7fafb",
    },

    planLabel: {
        color: "#7a8b93",

        fontSize: 11,
        fontWeight: "600",
    },

    planValue: {
        marginTop: 2,

        color: "#365565",

        fontSize: 16,
        fontWeight: "700",
    },

    planPremiumValue: {
        color: "#a36c00",
    },

    planBadge: {
        minHeight: 30,

        paddingHorizontal: 10,

        flexDirection: "row",
        alignItems: "center",

        gap: 4,

        borderRadius: 15,
    },

    freeBadge: {
        backgroundColor: "#e8eef1",
    },

    premiumBadge: {
        backgroundColor: "#fff1c7",
    },

    planBadgeText: {
        color: "#56727e",

        fontSize: 11,
        fontWeight: "700",
    },

    premiumBadgeText: {
        color: "#9b6a00",
    },

    planDescription: {
        marginTop: 12,

        color: "#71838c",

        fontSize: 12,
        lineHeight: 18,
    },

    premiumActiveText: {
        marginTop: 12,

        color: "#0e9384",

        fontSize: 13,
        fontWeight: "700",
    },

    premiumPurchaseButton: {
        minHeight: 46,

        marginTop: 14,

        paddingHorizontal: 14,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 7,

        borderRadius: 10,

        backgroundColor: "#d6a022",
    },

    premiumPurchaseButtonText: {
        color: "#ffffff",

        fontSize: 14,
        fontWeight: "700",
    },

    restoreButton: {
        minHeight: 40,

        marginTop: 7,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 5,
    },

    restoreButtonText: {
        color: "#557480",

        fontSize: 12,
        fontWeight: "700",
    },

    accountSection: {
        marginBottom: 0,
    },

    accountDescription: {
        marginBottom: 14,

        color: "#71838c",

        fontSize: 12,
        lineHeight: 18,
    },

    deleteAccountButton: {
        minHeight: 44,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 6,

        borderWidth: 1,
        borderColor: "#e4b9b5",

        borderRadius: 10,

        backgroundColor: "#fff7f6",
    },

    deleteAccountButtonPressed: {
        backgroundColor: "#fdeceb",
    },

    deleteAccountButtonText: {
        color: "#c0392b",

        fontSize: 13,
        fontWeight: "700",

        textAlign: "center",
    },
});
