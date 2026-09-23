import "react-native-get-random-values";
import "./src/tasks/backgroundLocationTask";

import { Authenticator } from "@aws-amplify/ui-react-native";
import { Amplify } from "aws-amplify";
import { Hub, I18n } from "aws-amplify/utils";
import { getCurrentUser, signOut } from "aws-amplify/auth";
import { StatusBar } from "expo-status-bar";
import {
    ActivityIndicator,
    Alert,
    AppState,
    type AppStateStatus,
    View,
} from "react-native";
import {
    type ReactNode,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";
import {
    SafeAreaProvider,
    useSafeAreaInsets,
} from "react-native-safe-area-context";
import { TourProvider, type TourDefinition } from "guideway";

import outputs from "./amplify_outputs.json";
import RootNavigator from "./src/navigation/RootNavigator";
import {
    configureRevenueCat,
    identifyRevenueCatUser,
    logoutRevenueCatUser,
} from "./src/services/revenueCatService";
import {
    checkCurrentDeviceSession,
    clearLocalDeviceSessionRegistration,
    initializeCurrentDeviceSession,
} from "./src/services/singleDeviceSessionService";
import AsyncStorage from "@react-native-async-storage/async-storage";

Amplify.configure(outputs);

const appTours: TourDefinition[] = [
    {
        id: "home-tutorial",
        //showOnce: true,
        steps: [
            {
                id: "home-auto-recording",
                title: "自動記録",
                body: "「自動記録開始」を押すと、移動中の位置情報を自動で記録します。記録頻度や記録する移動距離も設定できます。",
                placement: "auto",
            },
            {
                id: "home-recording-map",
                title: "地図表示",
                body: "「地図で見る」から、記録中の現在地や移動ルートを地図上で確認できます。",
                placement: "auto",
            },
            {
                id: "home-activity-history",
                title: "アクティビティ履歴",
                body: "過去に記録したアクティビティを確認できます。記録したルートや移動距離なども確認できます。",
                placement: "auto",
            },
            {
                id: "home-sharing",
                title: "リアルタイム共有",
                body: "現在地を共有するユーザーを選択できます。自動記録中でなくても現在地をリアルタイムで共有できます。",
                placement: "auto",
            },
        ],
    },

    {
        id: "activity-history-tutorial",
        //showOnce: true,
        steps: [
            {
                id: "activity-history-search",
                title: "アクティビティ検索",
                body: "アクティビティ名を入力すると、保存済みの履歴を絞り込んで検索できます。",
                placement: "auto",
            },
            {
                id: "activity-history-list",
                title: "アクティビティ履歴",
                body: "記録したアクティビティが新しい順に表示されます。期間、距離、記録ポイント数などを確認できます。",
                placement: "auto",
            },
            {
                id: "activity-history-card",
                title: "アクティビティの詳細",
                body: "アクティビティを選ぶと、記録条件や移動情報、アクティビティ区分などを確認できます。",
                placement: "auto",
            },
            {
                id: "activity-history-actions",
                title: "アクティビティの操作",
                body: "地図表示、タイトル変更、共有、削除などの操作を行えます。このガイドが終了したら、サンプルアクティビティの「地図で表示」を押して、地図の使い方を確認してみましょう。",
                placement: "auto",
            },
        ],
    },

    {
        id: "activity-map-tutorial",
        //showOnce: true,
        steps: [
            {
                id: "activity-map-layer",
                title: "地図の種類",
                body: "標準、航空写真、レトロ風など、地図の表示方法を切り替えられます。ドット絵風マップは現在準備中です。",
                placement: "auto",
            },
            {
                id: "activity-map-points",
                title: "記録ポイントを表示",
                body: "「ポイント表示」をONにすると、位置情報を記録した地点を地図上に表示できます。もう一度押すと非表示にできます。",
                placement: "auto",
            },
            {
                id: "activity-map-route",
                title: "ルート全体表示",
                body: "過去のアクティビティでは、移動ルート全体が画面内に収まるように表示されます。",
                placement: "auto",
            },
            {
                id: "activity-map-log-list",
                title: "記録ポイント一覧",
                body: "記録した地点を一覧で確認できます。各ポイントの時刻、foreground・background、位置精度などを確認できます。",
                placement: "auto",
            },
        ],
    },
];
/*
 * Amplify Authenticatorを日本語表示にする。
 */
I18n.putVocabulariesForLanguage("ja", {
    // ログイン画面
    "Sign In": "ログイン",
    "Sign in": "ログイン",
    "Sign in to your account": "ログイン",
    "Signing in": "ログイン中...",
    "Sign In with Amazon": "Amazonでログイン",
    "Sign In with Apple": "Appleでログイン",
    "Sign In with Facebook": "Facebookでログイン",
    "Sign In with Google": "Googleでログイン",

    Username: "ユーザー名",
    "Enter your Username": "ユーザー名を入力",
    "Enter your username": "ユーザー名を入力",

    Password: "パスワード",
    "Enter your Password": "パスワードを入力",
    "Enter your password": "パスワードを入力",

    "Forgot your password?": "パスワードをお忘れですか？",
    "Forgot Password?": "パスワードをお忘れですか？",

    "No account?": "アカウントをお持ちでないですか？",
    "Create Account": "アカウント作成",
    "Create account": "アカウント作成",

    // アカウント作成画面
    "Create a new account": "新しいアカウントを作成",
    "Creating Account": "アカウントを作成中...",
    "Creating account": "アカウントを作成中...",

    Email: "メールアドレス",
    "Enter your Email": "メールアドレスを入力",
    "Enter your email": "メールアドレスを入力",

    "Phone Number": "電話番号",

    "Confirm Password": "パスワード確認",
    "Please confirm your Password": "パスワードを再入力",
    "Confirm your password": "パスワードを再入力",

    "Already have an account?": "すでにアカウントをお持ちですか？",

    // 確認コード
    "Confirmation Code": "確認コード",
    "Confirmation code": "確認コード",
    "Enter your Confirmation Code": "確認コードを入力",
    "Enter your confirmation code": "確認コードを入力",

    Confirm: "確認",
    Confirming: "確認中...",

    "Resend Code": "確認コードを再送信",
    "Resend code": "確認コードを再送信",
    "Resending Code": "確認コードを再送信中...",

    "We Emailed You": "確認コードをメールで送信しました",
    "Your code is on the way. To log in, enter the code we emailed to":
        "ログインするには、メールで送信された確認コードを入力してください。",

    // パスワードリセット
    "Reset Password": "パスワードをリセット",
    "Reset password": "パスワードをリセット",
    "Reset your password": "パスワードをリセット",

    "Send Code": "確認コードを送信",
    "Send code": "確認コードを送信",
    Sending: "送信中...",

    "New Password": "新しいパスワード",
    "Enter your new password": "新しいパスワードを入力",

    "Back to Sign In": "ログイン画面に戻る",
    "Back to Sign in": "ログイン画面に戻る",

    Submit: "送信",

    // パスワード変更
    "Change Password": "パスワードを変更",
    "Change password": "パスワードを変更",

    // 一般
    Skip: "スキップ",
    Cancel: "キャンセル",
    Continue: "続ける",

    // 主なエラーメッセージ
    "Incorrect username or password.":
        "メールアドレスまたはパスワードが正しくありません。",

    "User does not exist.": "ユーザーが見つかりません。",

    "User already exists": "このユーザーはすでに登録されています。",

    "An account with the given email already exists.":
        "このメールアドレスはすでに登録されています。",

    "Invalid verification code provided, please try again.":
        "確認コードが正しくありません。もう一度入力してください。",

    "Invalid code provided, please request a code again.":
        "確認コードが正しくありません。確認コードを再送信してください。",

    "Attempt limit exceeded, please try after some time.":
        "試行回数の上限を超えました。しばらくしてからもう一度お試しください。",

    "Password attempts exceeded":
        "パスワードの試行回数を超えました。しばらくしてからもう一度お試しください。",

    "Network error": "ネットワークエラーが発生しました。",

    "Password did not conform with policy":
        "パスワードが必要な条件を満たしていません。",

    "Password must have at least 8 characters":
        "パスワードは8文字以上で入力してください。",

    "Passwords must match": "パスワードが一致していません。",
});

/*
 * 表示言語を日本語に固定する。
 */
I18n.setLanguage("ja");

function SingleDeviceSessionGuard({ children }: { children: ReactNode }) {
    const [checking, setChecking] = useState(true);

    const forceSigningOutRef = useRef(false);

    /*
     * 別端末ログインを検出した場合の強制ログアウト。
     */
    const forceSignOut = useCallback(async () => {
        if (forceSigningOutRef.current) {
            return;
        }

        forceSigningOutRef.current = true;

        try {
            /*
             * 次回ログイン時には、
             * この端末を再び有効端末として登録できるようにする。
             */
            await clearLocalDeviceSessionRegistration();

            Alert.alert(
                "ログアウトしました",
                [
                    "このアカウントは別の端末でログインされました。",
                    "",
                    "再度この端末でログインすると、",
                    "こちらの端末が有効になります。",
                ].join("\n"),
            );

            await signOut();
        } catch (error) {
            console.error("[SingleDeviceSession] Force sign out error:", error);
        } finally {
            forceSigningOutRef.current = false;
        }
    }, []);

    /*
     * 初回表示時。
     */
    useEffect(() => {
        let cancelled = false;

        const initialize = async () => {
            try {
                setChecking(true);

                /*
                 * RevenueCat SDKはアプリライフサイクル中に
                 * 1回だけconfigureする。
                 */
                configureRevenueCat();

                /*
                 * Cognitoの認証済みユーザーを取得する。
                 *
                 * userIdをRevenueCat App User IDとして利用する。
                 */
                try {
                    const currentUser = await getCurrentUser();

                    await identifyRevenueCatUser(currentUser.userId);

                    console.log(
                        "[RevenueCat] Cognito user linked:",
                        currentUser.userId,
                    );
                } catch (error) {
                    /*
                     * RevenueCat側の障害だけで
                     * LocationTrackerAppへのログインを失敗させない。
                     */
                    console.error("[RevenueCat] Initialize user error:", error);
                }

                /*
                 * 既存の1アカウント1端末制御。
                 */
                const isActive = await initializeCurrentDeviceSession();

                if (cancelled) {
                    return;
                }

                if (!isActive) {
                    await forceSignOut();

                    return;
                }
            } catch (error) {
                /*
                 * SingleDeviceSession確認失敗時は
                 * これまでどおりfail-open。
                 */
                console.error("[SingleDeviceSession] Initialize error:", error);
            } finally {
                if (!cancelled) {
                    setChecking(false);
                }
            }
        };

        void initialize();

        return () => {
            cancelled = true;
        };
    }, [forceSignOut]);

    /*
     * background → foregroundへ戻ったとき、
     * この端末がまだ有効か確認する。
     */
    useEffect(() => {
        let previousState = AppState.currentState;

        const subscription = AppState.addEventListener(
            "change",
            (nextState: AppStateStatus) => {
                const wasBackground =
                    previousState === "background" ||
                    previousState === "inactive";

                previousState = nextState;

                if (!wasBackground || nextState !== "active") {
                    return;
                }

                void (async () => {
                    try {
                        const isActive = await checkCurrentDeviceSession();

                        if (!isActive) {
                            await forceSignOut();
                        }
                    } catch (error) {
                        /*
                         * 一時的なネットワークエラーでは
                         * ログアウトしない。
                         */
                        console.error(
                            "[SingleDeviceSession] Foreground check error:",
                            error,
                        );
                    }
                })();
            },
        );

        return () => {
            subscription.remove();
        };
    }, [forceSignOut]);

    /*
     * 通常signOut時にもローカルの登録状態をクリアする。
     *
     * これにより同じ端末から再ログインした場合、
     * 新しい有効端末として登録される。
     */
    useEffect(() => {
        const unsubscribe = Hub.listen("auth", ({ payload }) => {
            if (payload.event !== "signedOut") {
                return;
            }

            void clearLocalDeviceSessionRegistration();

            /*
             * Cognitoログアウト時はRevenueCat側もログアウトする。
             *
             * RevenueCatのlogOut()後は匿名ユーザーに戻る。
             * 次回ログイン時にidentifyRevenueCatUser()で
             * Cognito userIdへ再度紐付ける。
             */
            void logoutRevenueCatUser();
        });

        return unsubscribe;
    }, []);

    if (checking) {
        return (
            <View
                style={{
                    flex: 1,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: "#ffffff",
                }}
            >
                <ActivityIndicator />
            </View>
        );
    }

    return <>{children}</>;
}

function AppTourProvider({ children }: { children: ReactNode }) {
    const insets = useSafeAreaInsets();

    return (
        <TourProvider
            tours={appTours}
            insets={insets}
            storage={AsyncStorage}
            colorScheme="light"
            overlayTapBehavior="skip"
            theme={{
                labels: {
                    next: "次へ",
                    back: "戻る",
                    skip: "スキップ",
                    done: "完了",
                },
            }}
        >
            {children}
        </TourProvider>
    );
}

function AppContent() {
    return (
        <SafeAreaProvider>
            <AppTourProvider>
                <SingleDeviceSessionGuard>
                    <RootNavigator />
                </SingleDeviceSessionGuard>
            </AppTourProvider>
        </SafeAreaProvider>
    );
}

export default function App() {
    return (
        <Authenticator.Provider>
            <StatusBar
                style="dark"
                hidden={false}
                backgroundColor="#ffffff"
                translucent={false}
            />

            <Authenticator>
                <AppContent />
            </Authenticator>
        </Authenticator.Provider>
    );
}
