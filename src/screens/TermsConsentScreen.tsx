import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import { useLayoutEffect, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { RootStackParamList } from "../navigation/RootNavigator";
import { acceptLegalDocuments } from "../services/legalConsentService";

type Props = {
    onAccepted: () => void;
};

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

export default function TermsConsentScreen({ onAccepted }: Props) {
    const navigation = useNavigation<NavigationProp>();
    const insets = useSafeAreaInsets();

    const [agreed, setAgreed] = useState(false);
    const [saving, setSaving] = useState(false);

    useLayoutEffect(() => {
        navigation.setOptions({
            headerShown: false,
        });
    }, [navigation]);

    const handleAccept = async () => {
        if (!agreed || saving) {
            return;
        }

        try {
            setSaving(true);

            await acceptLegalDocuments();

            /*
             * DBへの保存が成功した場合だけ、
             * RootNavigatorを通常モードへ切り替える。
             */
            onAccepted();
        } catch (error) {
            console.error("[TermsConsentScreen] Accept error:", error);

            Alert.alert(
                "保存できませんでした",
                error instanceof Error
                    ? error.message
                    : "利用規約への同意情報を保存できませんでした。",
            );
        } finally {
            setSaving(false);
        }
    };

    return (
        <View style={styles.screen}>
            <StatusBar
                style="light"
                backgroundColor="#06395f"
                translucent={false}
            />

            <View
                style={[
                    styles.appHeader,
                    {
                        paddingTop: Math.max(insets.top, 8),
                    },
                ]}
            >
                <View style={styles.headerSideSpace} />

                <Text style={styles.headerTitle} numberOfLines={1}>
                    利用開始の確認
                </Text>

                <View style={styles.headerSideSpace} />
            </View>

            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
            >
                <View style={styles.welcomeCard}>
                    <View style={styles.welcomeIconCircle}>
                        <MaterialCommunityIcons
                            name="shield-check-outline"
                            size={30}
                            color="#ffffff"
                        />
                    </View>

                    <Text style={styles.welcomeTitle}>AcLog Fitへようこそ</Text>

                    <Text style={styles.welcomeDescription}>
                        AcLog Fitをご利用いただく前に、
                        利用規約とプライバシーポリシーをご確認ください。
                    </Text>
                </View>

                <View style={styles.infoCard}>
                    <View style={styles.cardHeaderRow}>
                        <View style={styles.cardIconCircle}>
                            <MaterialCommunityIcons
                                name="map-marker-radius-outline"
                                size={20}
                                color="#0e9384"
                            />
                        </View>

                        <Text style={styles.cardTitle}>ご利用にあたって</Text>
                    </View>

                    <View style={styles.infoItem}>
                        <MaterialCommunityIcons
                            name="map-marker-outline"
                            size={18}
                            color="#557480"
                        />

                        <Text style={styles.infoText}>
                            本アプリでは、移動ルートを記録するために
                            位置情報を使用します。
                        </Text>
                    </View>

                    <View style={styles.infoItem}>
                        <MaterialCommunityIcons
                            name="cellphone-marker"
                            size={18}
                            color="#557480"
                        />

                        <Text style={styles.infoText}>
                            自動記録中は、アプリを画面に表示していない場合でも
                            位置情報を取得することがあります。
                        </Text>
                    </View>

                    <View style={styles.infoItem}>
                        <MaterialCommunityIcons
                            name="account-group-outline"
                            size={18}
                            color="#557480"
                        />

                        <Text style={styles.infoText}>
                            位置情報の共有は、ユーザー自身が共有先を
                            選択した場合に行われます。
                        </Text>
                    </View>
                </View>

                <View style={styles.documentCard}>
                    <View
                        style={[
                            styles.cardHeaderRow,
                            styles.documentCardHeader,
                        ]}
                    >
                        <View style={styles.cardIconCircle}>
                            <MaterialCommunityIcons
                                name="file-document-outline"
                                size={20}
                                color="#0e9384"
                            />
                        </View>

                        <Text style={styles.cardTitle}>ご確認ください</Text>
                    </View>

                    <Pressable
                        style={({ pressed }) => [
                            styles.documentButton,
                            pressed && styles.buttonPressed,
                        ]}
                        onPress={() => {
                            navigation.navigate("TermsOfService");
                        }}
                    >
                        <View style={styles.documentLeft}>
                            <View style={styles.documentIconCircle}>
                                <MaterialCommunityIcons
                                    name="file-document-outline"
                                    size={20}
                                    color="#0e9384"
                                />
                            </View>

                            <View style={styles.documentTextArea}>
                                <Text style={styles.documentButtonTitle}>
                                    利用規約
                                </Text>

                                <Text style={styles.documentButtonDescription}>
                                    アプリの利用条件をご確認ください
                                </Text>
                            </View>
                        </View>

                        <MaterialCommunityIcons
                            name="chevron-right"
                            size={25}
                            color="#91a0a7"
                        />
                    </Pressable>

                    <View style={styles.documentDivider} />

                    <Pressable
                        style={({ pressed }) => [
                            styles.documentButton,
                            pressed && styles.buttonPressed,
                        ]}
                        onPress={() => {
                            navigation.navigate("PrivacyPolicy");
                        }}
                    >
                        <View style={styles.documentLeft}>
                            <View style={styles.documentIconCircle}>
                                <MaterialCommunityIcons
                                    name="shield-account-outline"
                                    size={20}
                                    color="#0e9384"
                                />
                            </View>

                            <View style={styles.documentTextArea}>
                                <Text style={styles.documentButtonTitle}>
                                    プライバシーポリシー
                                </Text>

                                <Text style={styles.documentButtonDescription}>
                                    位置情報などの取扱いをご確認ください
                                </Text>
                            </View>
                        </View>

                        <MaterialCommunityIcons
                            name="chevron-right"
                            size={25}
                            color="#91a0a7"
                        />
                    </Pressable>
                </View>

                <Pressable
                    style={({ pressed }) => [
                        styles.agreementCard,
                        agreed && styles.agreementCardChecked,
                        pressed && !saving && styles.buttonPressed,
                    ]}
                    onPress={() => {
                        if (!saving) {
                            setAgreed((current) => !current);
                        }
                    }}
                    disabled={saving}
                >
                    <View
                        style={[
                            styles.checkbox,
                            agreed && styles.checkboxChecked,
                        ]}
                    >
                        {agreed && (
                            <MaterialCommunityIcons
                                name="check"
                                size={18}
                                color="#ffffff"
                            />
                        )}
                    </View>

                    <View style={styles.agreementTextArea}>
                        <Text style={styles.agreementTitle}>
                            内容を確認し、同意します
                        </Text>

                        <Text style={styles.agreementText}>
                            利用規約およびプライバシーポリシーを確認し、
                            内容に同意します。
                        </Text>
                    </View>
                </Pressable>

                <Pressable
                    style={({ pressed }) => [
                        styles.acceptButton,
                        pressed && agreed && !saving && styles.buttonPressed,
                        (!agreed || saving) && styles.acceptButtonDisabled,
                    ]}
                    onPress={() => {
                        void handleAccept();
                    }}
                    disabled={!agreed || saving}
                >
                    {saving ? (
                        <View style={styles.acceptButtonLoading}>
                            <ActivityIndicator size="small" color="#ffffff" />

                            <Text style={styles.acceptButtonText}>
                                保存中...
                            </Text>
                        </View>
                    ) : (
                        <>
                            <MaterialCommunityIcons
                                name="check-circle-outline"
                                size={20}
                                color="#ffffff"
                            />

                            <Text style={styles.acceptButtonText}>
                                同意して利用を開始
                            </Text>
                        </>
                    )}
                </Pressable>

                <View style={styles.noteRow}>
                    <MaterialCommunityIcons
                        name="information-outline"
                        size={16}
                        color="#819198"
                    />

                    <Text style={styles.note}>
                        一度同意すると、次回以降のログイン時には
                        この画面は表示されません。
                    </Text>
                </View>
            </ScrollView>
        </View>
    );
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

    headerSideSpace: {
        width: 46,
        height: 44,
    },

    headerTitle: {
        flex: 1,

        paddingBottom: 9,

        textAlign: "center",

        color: "#ffffff",

        fontSize: 18,
        fontWeight: "700",
    },

    scrollView: {
        flex: 1,
    },

    content: {
        paddingHorizontal: 14,
        paddingTop: 14,
        paddingBottom: 34,
    },

    welcomeCard: {
        marginBottom: 12,

        paddingHorizontal: 18,
        paddingVertical: 20,

        alignItems: "center",

        borderWidth: 1,
        borderColor: "#dfe7ea",
        borderRadius: 16,

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

    welcomeIconCircle: {
        width: 58,
        height: 58,

        marginBottom: 11,

        borderRadius: 29,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#0e9384",
    },

    welcomeTitle: {
        marginBottom: 7,

        textAlign: "center",

        color: "#203f4f",

        fontSize: 20,
        fontWeight: "800",
    },

    welcomeDescription: {
        maxWidth: 310,

        textAlign: "center",

        color: "#71838c",

        fontSize: 13,
        lineHeight: 19,
    },

    infoCard: {
        marginBottom: 12,

        padding: 15,

        borderWidth: 1,
        borderColor: "#dfe7ea",
        borderRadius: 14,

        backgroundColor: "#ffffff",

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.04,
        shadowRadius: 4,

        elevation: 1,
    },

    documentCard: {
        marginBottom: 12,

        paddingTop: 15,

        borderWidth: 1,
        borderColor: "#dfe7ea",
        borderRadius: 14,

        backgroundColor: "#ffffff",

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.04,
        shadowRadius: 4,

        elevation: 1,

        overflow: "hidden",
    },

    cardHeaderRow: {
        marginBottom: 12,
        paddingHorizontal: 1,

        flexDirection: "row",
        alignItems: "center",

        gap: 8,
    },

    cardIconCircle: {
        width: 34,
        height: 34,

        borderRadius: 17,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#e7f6f3",
    },

    cardTitle: {
        color: "#203f4f",

        fontSize: 15,
        fontWeight: "700",
    },

    infoItem: {
        flexDirection: "row",
        alignItems: "flex-start",

        gap: 9,

        paddingVertical: 7,
    },

    infoText: {
        flex: 1,

        color: "#526772",

        fontSize: 13,
        lineHeight: 20,
    },

    documentButton: {
        minHeight: 70,

        paddingHorizontal: 15,
        paddingVertical: 11,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",

        backgroundColor: "#ffffff",
    },

    documentLeft: {
        flex: 1,

        flexDirection: "row",
        alignItems: "center",

        marginRight: 10,
    },

    documentIconCircle: {
        width: 38,
        height: 38,

        marginRight: 11,

        borderRadius: 19,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#eaf7f5",
    },

    documentTextArea: {
        flex: 1,
    },

    documentButtonTitle: {
        marginBottom: 3,

        color: "#20303a",

        fontSize: 14,
        fontWeight: "700",
    },

    documentButtonDescription: {
        color: "#71838c",

        fontSize: 12,
        lineHeight: 17,
    },

    documentDivider: {
        height: StyleSheet.hairlineWidth,

        marginLeft: 64,

        backgroundColor: "#e2e8ec",
    },

    agreementCard: {
        marginBottom: 12,

        padding: 14,

        flexDirection: "row",
        alignItems: "flex-start",

        borderWidth: 1,
        borderColor: "#ccd9de",
        borderRadius: 14,

        backgroundColor: "#ffffff",
    },

    agreementCardChecked: {
        borderColor: "#0e9384",

        backgroundColor: "#f1fbf8",
    },

    checkbox: {
        width: 25,
        height: 25,

        marginTop: 1,
        marginRight: 12,

        borderWidth: 2,
        borderColor: "#91a1a8",
        borderRadius: 6,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#ffffff",
    },

    checkboxChecked: {
        borderColor: "#0e9384",
        backgroundColor: "#0e9384",
    },

    agreementTextArea: {
        flex: 1,
    },

    agreementTitle: {
        marginBottom: 3,

        color: "#20303a",

        fontSize: 14,
        fontWeight: "700",
    },

    agreementText: {
        color: "#667982",

        fontSize: 12,
        lineHeight: 18,
    },

    acceptButton: {
        minHeight: 50,

        paddingHorizontal: 16,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 7,

        borderRadius: 12,

        backgroundColor: "#0e9384",

        shadowColor: "#000000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.08,
        shadowRadius: 3,

        elevation: 1,
    },

    acceptButtonDisabled: {
        backgroundColor: "#afbdc2",
    },

    acceptButtonLoading: {
        flexDirection: "row",
        alignItems: "center",

        gap: 8,
    },

    acceptButtonText: {
        color: "#ffffff",

        fontSize: 15,
        fontWeight: "700",
    },

    buttonPressed: {
        opacity: 0.76,
    },

    noteRow: {
        marginTop: 13,
        paddingHorizontal: 8,

        flexDirection: "row",
        alignItems: "flex-start",
        justifyContent: "center",

        gap: 5,
    },

    note: {
        flexShrink: 1,

        textAlign: "center",

        color: "#819198",

        fontSize: 11,
        lineHeight: 17,
    },

    documentCardHeader: {
        paddingHorizontal: 15,
    },
});
