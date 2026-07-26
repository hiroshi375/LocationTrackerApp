import {
    Alert,
    Linking,
    Pressable,
    StyleSheet,
    Text,
    View,
} from "react-native";

const CONTACT_EMAIL = "your-email@example.com";

export default function ContactScreen() {
    const openMailApp = async () => {
        const subject = encodeURIComponent(
            "LocationTrackerAppへのお問い合わせ",
        );

        const body = encodeURIComponent(
            [
                "お問い合わせ内容をご記入ください。",
                "",
                "--------------------------------",
                "アプリ名: LocationTrackerApp",
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
        <View style={styles.container}>
            <Text style={styles.title}>お問い合わせ</Text>

            <Text style={styles.description}>
                アプリに関するご質問、不具合報告、ご要望などは、
                以下のボタンからお問い合わせください。
            </Text>

            <View style={styles.emailBox}>
                <Text style={styles.emailLabel}>お問い合わせ先</Text>
                <Text selectable style={styles.emailText}>
                    {CONTACT_EMAIL}
                </Text>
            </View>

            <Pressable
                style={({ pressed }) => [
                    styles.button,
                    pressed && styles.buttonPressed,
                ]}
                onPress={() => {
                    void openMailApp();
                }}
            >
                <Text style={styles.buttonText}>メールで問い合わせる</Text>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 20,
        backgroundColor: "#f7f7f7",
    },
    title: {
        fontSize: 24,
        fontWeight: "bold",
        color: "#2f4f66",
        marginBottom: 12,
    },
    description: {
        fontSize: 14,
        lineHeight: 22,
        color: "#555",
        marginBottom: 20,
    },
    emailBox: {
        padding: 16,
        borderWidth: 1,
        borderColor: "#d6dfe6",
        borderRadius: 8,
        backgroundColor: "#ffffff",
        marginBottom: 20,
    },
    emailLabel: {
        fontSize: 13,
        color: "#666",
        marginBottom: 6,
    },
    emailText: {
        fontSize: 15,
        fontWeight: "bold",
        color: "#2f4f66",
    },
    button: {
        minHeight: 48,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderRadius: 8,
        backgroundColor: "#4b6f8f",
        alignItems: "center",
        justifyContent: "center",
    },
    buttonPressed: {
        opacity: 0.75,
    },
    buttonText: {
        fontSize: 15,
        fontWeight: "bold",
        color: "#ffffff",
    },
});
