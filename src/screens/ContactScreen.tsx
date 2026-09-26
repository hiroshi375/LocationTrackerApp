import { useLayoutEffect } from "react";
import {
    Alert,
    Linking,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const CONTACT_EMAIL = "hi64sa10@yahoo.co.jp";

export default function ContactScreen() {
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();

    useLayoutEffect(() => {
        navigation.setOptions({
            headerShown: false,
        });
    }, [navigation]);
    const openMailApp = async () => {
        const subject = encodeURIComponent(
            "AcLog Fitへのお問い合わせ",
        );

        const body = encodeURIComponent(
            [
                "お問い合わせ内容をご記入ください。",
                "",
                "--------------------------------",
                "アプリ名: AcLog Fit",
                "--------------------------------",
            ].join("\n"),
        );

        const mailUrl =
            `mailto:${CONTACT_EMAIL}` + `?subject=${subject}` + `&body=${body}`;

        try {
            const canOpen = await Linking.canOpenURL(mailUrl);

            if (!canOpen) {
                Alert.alert(
                    "メールアプリを開けません",
                    `お手数ですが、${CONTACT_EMAIL}まで直接ご連絡ください。`,
                );
                return;
            }

            await Linking.openURL(mailUrl);
        } catch (error) {
            console.error("Open contact mail error:", error);

            Alert.alert(
                "メールアプリを開けません",
                `お手数ですが、${CONTACT_EMAIL}まで直接ご連絡ください。`,
            );
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
                <Pressable
                    style={styles.headerBackButton}
                    onPress={() => navigation.goBack()}
                >
                    <Text style={styles.headerBackText}>‹</Text>
                </Pressable>

                <Text style={styles.headerTitle} numberOfLines={1}>
                    お問い合わせ
                </Text>

                <View style={styles.headerRightSpace} />
            </View>

            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
            >
                <View style={styles.introCard}>
                    <View style={styles.introIconCircle}>
                        <MaterialCommunityIcons
                            name="email-outline"
                            size={24}
                            color="#ffffff"
                        />
                    </View>

                    <View style={styles.introTextArea}>
                        <Text style={styles.introTitle}>お問い合わせ</Text>

                        <Text style={styles.description}>
                            アプリに関するご質問、不具合報告、ご要望などは、
                            メールでお問い合わせください。
                        </Text>
                    </View>
                </View>

                <View style={styles.contactCard}>
                    <View style={styles.cardHeaderRow}>
                        <MaterialCommunityIcons
                            name="email-edit-outline"
                            size={21}
                            color="#0e9384"
                        />

                        <Text style={styles.cardTitle}>お問い合わせ先</Text>
                    </View>

                    <View style={styles.emailBox}>
                        <Text style={styles.emailLabel}>メールアドレス</Text>

                        <Text selectable style={styles.emailText}>
                            {CONTACT_EMAIL}
                        </Text>
                    </View>

                    <Text style={styles.helperText}>
                        ボタンを押すと、端末のメールアプリを開きます。
                    </Text>

                    <Pressable
                        style={({ pressed }) => [
                            styles.primaryButton,
                            pressed && styles.buttonPressed,
                        ]}
                        onPress={() => {
                            void openMailApp();
                        }}
                    >
                        <MaterialCommunityIcons
                            name="email-fast-outline"
                            size={19}
                            color="#ffffff"
                        />

                        <Text style={styles.primaryButtonText}>
                            メールで問い合わせる
                        </Text>
                    </Pressable>
                </View>

                <View style={styles.noteCard}>
                    <View style={styles.noteHeaderRow}>
                        <MaterialCommunityIcons
                            name="information-outline"
                            size={19}
                            color="#557480"
                        />

                        <Text style={styles.noteTitle}>お問い合わせの前に</Text>
                    </View>

                    <Text style={styles.noteText}>
                        不具合についてお問い合わせいただく場合は、
                        発生した操作や状況、端末情報などをできるだけ詳しく
                        ご記載いただくと、確認がスムーズになります。
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

    scrollView: {
        flex: 1,
    },

    content: {
        paddingHorizontal: 14,
        paddingTop: 14,
        paddingBottom: 32,
    },

    introCard: {
        marginBottom: 12,

        padding: 15,

        flexDirection: "row",
        alignItems: "flex-start",

        borderWidth: 1,
        borderColor: "#dfe7ea",
        borderRadius: 14,

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

    introIconCircle: {
        width: 42,
        height: 42,

        marginRight: 11,

        borderRadius: 21,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#0e9384",
    },

    introTextArea: {
        flex: 1,
    },

    introTitle: {
        marginBottom: 4,

        color: "#203f4f",

        fontSize: 16,
        fontWeight: "700",
    },

    description: {
        color: "#71838c",

        fontSize: 12,
        lineHeight: 18,
    },

    contactCard: {
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
        shadowOpacity: 0.05,
        shadowRadius: 4,

        elevation: 1,
    },

    cardHeaderRow: {
        marginBottom: 12,

        flexDirection: "row",
        alignItems: "center",

        gap: 8,
    },

    cardTitle: {
        color: "#203f4f",

        fontSize: 16,
        fontWeight: "700",
    },

    emailBox: {
        padding: 13,

        borderWidth: 1,
        borderColor: "#d5e0e5",
        borderRadius: 10,

        backgroundColor: "#f7fafb",
    },

    emailLabel: {
        marginBottom: 4,

        color: "#74858d",

        fontSize: 11,
        fontWeight: "700",
    },

    emailText: {
        color: "#203f4f",

        fontSize: 15,
        fontWeight: "700",
    },

    helperText: {
        marginTop: 8,

        color: "#819198",

        fontSize: 11,
        lineHeight: 16,
    },

    primaryButton: {
        minHeight: 46,

        marginTop: 14,
        paddingHorizontal: 14,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 7,

        borderRadius: 10,

        backgroundColor: "#0e9384",
    },

    primaryButtonText: {
        color: "#ffffff",

        fontSize: 14,
        fontWeight: "700",
    },

    buttonPressed: {
        opacity: 0.75,
    },

    noteCard: {
        padding: 14,

        borderWidth: 1,
        borderColor: "#dbe6ea",
        borderRadius: 14,

        backgroundColor: "#f6fafb",
    },

    noteHeaderRow: {
        marginBottom: 7,

        flexDirection: "row",
        alignItems: "center",

        gap: 6,
    },

    noteTitle: {
        color: "#405d69",

        fontSize: 14,
        fontWeight: "700",
    },

    noteText: {
        color: "#71838c",

        fontSize: 12,
        lineHeight: 18,
    },
});
