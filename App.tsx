import "react-native-get-random-values";
import "./src/tasks/backgroundLocationTask";

import { Authenticator } from "@aws-amplify/ui-react-native";
import { Amplify } from "aws-amplify";
import { Hub } from "aws-amplify/utils";
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
import { SafeAreaProvider } from "react-native-safe-area-context";

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

Amplify.configure(outputs);

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

function AppContent() {
    return (
        <SafeAreaProvider>
            <SingleDeviceSessionGuard>
                <RootNavigator />
            </SingleDeviceSessionGuard>
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
