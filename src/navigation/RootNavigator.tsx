import {
    NavigationContainer,
    createNavigationContainerRef,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import {
    ActivityIndicator,
    Pressable,
    StyleSheet,
    Text,
    View,
} from "react-native";
import ActivityCalendarScreen from "../screens/ActivityCalendarScreen";
import ActivityRankingScreen from "../screens/ActivityRankingScreen";
import AdminLocationLogImportScreen from "../screens/AdminLocationLogImportScreen";
import AppInfoScreen from "../screens/AppInfoScreen";
import ContactScreen from "../screens/ContactScreen";
import LiveLocationMapScreen from "../screens/LiveLocationMapScreen";
import LocationHomeScreen from "../screens/LocationHomeScreen";
import LocationLogScreen from "../screens/LocationLogScreen";
import LocationMapScreen from "../screens/LocationMapScreen";
import PrivacyPolicyScreen from "../screens/PrivacyPolicyScreen";
import ProfileScreen from "../screens/ProfileScreen";
import ShareGroupManagementScreen from "../screens/ShareGroupManagementScreen";
import TermsOfServiceScreen from "../screens/TermsOfServiceScreen";
import SubscriptionPlanScreen from "../screens/SubscriptionPlanScreen";
import TermsConsentScreen from "../screens/TermsConsentScreen";

import { getLegalConsentStatus } from "../services/legalConsentService";

export type RootStackParamList = {
    LocationHome:
        | {
              startTutorial?: boolean;
          }
        | undefined;
    LocationLog:
        | {
              startTutorial?: boolean;
          }
        | undefined;
    AdminLocationLogImport: undefined;
    ActivityCalendar: undefined;
    LocationMap: {
        recordingSessionId?: string | null;
        startMapTutorial?: boolean;
        recordingIntervalMs?: number | null;
        recordingDistanceMeters?: number | null;
        sharedLiveUserId?: string | null;
        sharedLiveLocationId?: string | null;

        /**
         * true: 共有中の現在地と記録ルートを表示
         * false: 共有中の現在地のみ表示
         */
        sharedLiveIsRecording?: boolean;
        /*
         * true:
         * 「共有された履歴」から開いた過去アクティビティ
         */
        isSharedActivityHistory?: boolean;
        selectedLocation?: {
            id: string;
            latitude: number;
            longitude: number;
            accuracy?: number | null;
            recordedAt: string;
            memo?: string | null;
            recordingSessionId?: string | null;
            recordingSessionName?: string | null;
            sharedOwners?: string[] | null;
            source?: string | null;
        };
    };
    Profile: undefined;
    LiveLocationMap: undefined;
    ActivityRanking: undefined;
    AppInfo: undefined;
    PrivacyPolicy: undefined;
    TermsOfService: undefined;
    Contact: undefined;
    ShareGroupManagement: undefined;
    SubscriptionPlan: undefined;
    TermsConsent: undefined;
};
/*
 * GuidewayなどNavigationコンポーネント外から
 * 画面遷移を行うためのNavigation Ref。
 */
export const rootNavigationRef =
    createNavigationContainerRef<RootStackParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

export default function RootNavigator() {
    // ============================================================
    // ★追加④
    // 利用規約・プライバシーポリシーへの同意状態
    // ============================================================

    const [checkingConsent, setCheckingConsent] = useState(true);

    const [hasAcceptedLegalDocuments, setHasAcceptedLegalDocuments] =
        useState(false);

    const [consentLoadError, setConsentLoadError] = useState<string | null>(
        null,
    );

    /*
     * UserProfileから同意状態を取得する。
     *
     * termsAcceptedAt と privacyPolicyAcceptedAt の両方が
     * 保存されていれば同意済みと判断する。
     */
    const loadConsentStatus = useCallback(async () => {
        try {
            setCheckingConsent(true);
            setConsentLoadError(null);

            const status = await getLegalConsentStatus();

            setHasAcceptedLegalDocuments(status.hasAccepted);
        } catch (error) {
            console.error("[RootNavigator] Legal consent check error:", error);

            setConsentLoadError(
                error instanceof Error
                    ? error.message
                    : "利用規約の同意状態を確認できませんでした。",
            );
        } finally {
            setCheckingConsent(false);
        }
    }, []);

    /*
     * ログイン後、RootNavigatorが表示されたタイミングで
     * 同意状態を確認する。
     */
    useEffect(() => {
        void loadConsentStatus();
    }, [loadConsentStatus]);

    // ============================================================
    // ★追加⑤
    // 同意状態を取得している間
    // ============================================================

    if (checkingConsent) {
        return (
            <View style={styles.centerContainer}>
                <ActivityIndicator />

                <Text style={styles.statusText}>
                    利用情報を確認しています...
                </Text>
            </View>
        );
    }

    // ============================================================
    // ★追加⑥
    // AWS等への接続エラーで同意状態を確認できなかった場合
    //
    // この場合、未確認のままホーム画面へ進ませず、
    // 再試行できるようにする。
    // ============================================================

    if (consentLoadError) {
        return (
            <View style={styles.centerContainer}>
                <Text style={styles.errorTitle}>
                    利用情報を確認できませんでした
                </Text>

                <Text style={styles.errorText}>{consentLoadError}</Text>

                <Pressable
                    style={({ pressed }) => [
                        styles.retryButton,
                        pressed && styles.retryButtonPressed,
                    ]}
                    onPress={() => {
                        void loadConsentStatus();
                    }}
                >
                    <Text style={styles.retryButtonText}>再試行</Text>
                </Pressable>
            </View>
        );
    }

    return (
        <NavigationContainer ref={rootNavigationRef}>
            {/*
             * ★変更⑦
             *
             * 同意前と同意後でNavigatorの中身を完全に分離する。
             *
             * 同意前：
             *   TermsConsent
             *   TermsOfService
             *   PrivacyPolicy
             *
             * の3画面しか利用できない。
             *
             * 同意後：
             *   これまでのLocationTrackerAppの画面を利用できる。
             *
             * keyを切り替えることで、同意完了時に
             * Navigation Stackを作り直し、
             * LocationHomeを最初の画面として表示する。
             */}
            <Stack.Navigator
                key={
                    hasAcceptedLegalDocuments
                        ? "main-navigation"
                        : "consent-navigation"
                }
            >
                {!hasAcceptedLegalDocuments ? (
                    <>
                        {/*
                         * ===================================================
                         * ★追加⑧ 未同意ユーザー用画面
                         * ===================================================
                         */}

                        <Stack.Screen
                            name="TermsConsent"
                            options={{
                                title: "ご利用にあたって",
                                headerBackVisible: false,
                                gestureEnabled: false,
                            }}
                        >
                            {() => (
                                <TermsConsentScreen
                                    onAccepted={() => {
                                        /*
                                         * acceptLegalDocuments()による
                                         * UserProfile更新成功後に呼ばれる。
                                         *
                                         * trueになるとNavigatorが
                                         * main-navigationへ切り替わる。
                                         */
                                        setHasAcceptedLegalDocuments(true);
                                    }}
                                />
                            )}
                        </Stack.Screen>

                        {/*
                         * 同意画面から利用規約を確認できるようにする。
                         */}
                        <Stack.Screen
                            name="TermsOfService"
                            component={TermsOfServiceScreen}
                            options={{
                                title: "利用規約",
                            }}
                        />

                        {/*
                         * 同意画面からプライバシーポリシーを
                         * 確認できるようにする。
                         */}
                        <Stack.Screen
                            name="PrivacyPolicy"
                            component={PrivacyPolicyScreen}
                            options={{
                                title: "プライバシーポリシー",
                            }}
                        />
                    </>
                ) : (
                    <>
                        {/*
                         * ===================================================
                         * ★既存⑨
                         * 同意済みユーザー用画面
                         *
                         * ここから下は、現在のRootNavigatorに
                         * 登録されていた画面をすべて残しています。
                         * ===================================================
                         */}
                        <Stack.Screen
                            name="LocationHome"
                            component={LocationHomeScreen}
                            options={{ title: "" }}
                        />
                        <Stack.Screen
                            name="LocationLog"
                            component={LocationLogScreen}
                            options={{ title: "アクティビティ履歴" }}
                        />
                        <Stack.Screen
                            name="AdminLocationLogImport"
                            component={AdminLocationLogImportScreen}
                            options={{ title: "LocationLog CSVインポート" }}
                        />
                        <Stack.Screen
                            name="ActivityCalendar"
                            component={ActivityCalendarScreen}
                            options={{ title: "アクティビティカレンダー" }}
                        />
                        <Stack.Screen
                            name="LocationMap"
                            component={LocationMapScreen}
                            options={{
                                headerShown: false,
                            }}
                        />
                        <Stack.Screen
                            name="Profile"
                            component={ProfileScreen}
                            options={{ title: "プロフィール" }}
                        />
                        <Stack.Screen
                            name="ActivityRanking"
                            component={ActivityRankingScreen}
                            options={{ title: "アクティビティランキング" }}
                        />
                        <Stack.Screen
                            name="LiveLocationMap"
                            component={LiveLocationMapScreen}
                            options={{ title: "共有中の現在地" }}
                        />
                        <Stack.Screen
                            name="AppInfo"
                            component={AppInfoScreen}
                            options={{ title: "アプリ情報" }}
                        />

                        <Stack.Screen
                            name="PrivacyPolicy"
                            component={PrivacyPolicyScreen}
                            options={{ title: "プライバシーポリシー" }}
                        />

                        <Stack.Screen
                            name="TermsOfService"
                            component={TermsOfServiceScreen}
                            options={{ title: "利用規約" }}
                        />

                        <Stack.Screen
                            name="Contact"
                            component={ContactScreen}
                            options={{ title: "お問い合わせ" }}
                        />

                        <Stack.Screen
                            name="ShareGroupManagement"
                            component={ShareGroupManagementScreen}
                            options={{ title: "共有グループ管理" }}
                        />

                        <Stack.Screen
                            name="SubscriptionPlan"
                            component={SubscriptionPlanScreen}
                            options={{
                                title: "FREE / PREMIUM プラン",
                            }}
                        />
                    </>
                )}
            </Stack.Navigator>
        </NavigationContainer>
    );
}

// ============================================================
// ★追加⑩
// 同意状態確認中・エラー画面用スタイル
// ============================================================

const styles = StyleSheet.create({
    centerContainer: {
        flex: 1,
        paddingHorizontal: 24,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#ffffff",
    },

    statusText: {
        marginTop: 12,
        fontSize: 14,
        color: "#666",
    },

    errorTitle: {
        marginBottom: 10,
        fontSize: 18,
        fontWeight: "bold",
        color: "#333",
        textAlign: "center",
    },

    errorText: {
        marginBottom: 20,
        fontSize: 14,
        lineHeight: 21,
        color: "#666",
        textAlign: "center",
    },

    retryButton: {
        minWidth: 140,
        paddingVertical: 11,
        paddingHorizontal: 20,
        borderRadius: 8,
        backgroundColor: "#4b6f8f",
        alignItems: "center",
    },

    retryButtonPressed: {
        opacity: 0.75,
    },

    retryButtonText: {
        fontSize: 15,
        fontWeight: "bold",
        color: "#ffffff",
    },
});
