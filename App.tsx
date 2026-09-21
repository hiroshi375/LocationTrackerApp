import "react-native-get-random-values";
import "./src/tasks/backgroundLocationTask";

import { Authenticator } from "@aws-amplify/ui-react-native";
import { Amplify } from "aws-amplify";
import { Hub } from "aws-amplify/utils";
import { signOut } from "aws-amplify/auth";
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
                 * 通信障害だけでユーザーをログアウトさせない。
                 *
                 * セッション確認失敗時はfail-openとする。
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
            if (payload.event === "signedOut") {
                void clearLocalDeviceSessionRegistration();
            }
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
