import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from "react-native";

import type { RootStackParamList } from "../navigation/RootNavigator";
import { acceptLegalDocuments } from "../services/legalConsentService";

type Props = {
    onAccepted: () => void;
};

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

export default function TermsConsentScreen({ onAccepted }: Props) {
    const navigation = useNavigation<NavigationProp>();

    const [agreed, setAgreed] = useState(false);
    const [saving, setSaving] = useState(false);

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
        <ScrollView
            style={styles.container}
            contentContainerStyle={styles.content}
        >
            <Text style={styles.title}>LocationTrackerAppへようこそ</Text>

            <Text style={styles.description}>
                LocationTrackerAppをご利用いただく前に、
                利用規約とプライバシーポリシーをご確認ください。
            </Text>

            <View style={styles.infoBox}>
                <Text style={styles.infoTitle}>ご利用にあたって</Text>

                <Text style={styles.infoText}>
                    本アプリでは、移動ルートを記録するために
                    位置情報を使用します。
                    {"\n\n"}
                    自動記録中は、アプリを画面に表示していない場合でも
                    位置情報を取得することがあります。
                    {"\n\n"}
                    位置情報の共有は、ユーザー自身が共有先を選択した場合に
                    行われます。
                </Text>
            </View>

            <View style={styles.documentArea}>
                <Pressable
                    style={({ pressed }) => [
                        styles.documentButton,
                        pressed && styles.buttonPressed,
                    ]}
                    onPress={() => {
                        navigation.navigate("TermsOfService");
                    }}
                >
                    <View>
                        <Text style={styles.documentButtonTitle}>利用規約</Text>

                        <Text style={styles.documentButtonDescription}>
                            アプリの利用条件をご確認ください
                        </Text>
                    </View>

                    <Text style={styles.documentButtonArrow}>›</Text>
                </Pressable>

                <Pressable
                    style={({ pressed }) => [
                        styles.documentButton,
                        pressed && styles.buttonPressed,
                    ]}
                    onPress={() => {
                        navigation.navigate("PrivacyPolicy");
                    }}
                >
                    <View>
                        <Text style={styles.documentButtonTitle}>
                            プライバシーポリシー
                        </Text>

                        <Text style={styles.documentButtonDescription}>
                            位置情報などの取扱いをご確認ください
                        </Text>
                    </View>

                    <Text style={styles.documentButtonArrow}>›</Text>
                </Pressable>
            </View>

            <Pressable
                style={({ pressed }) => [
                    styles.agreementRow,
                    pressed && styles.buttonPressed,
                ]}
                onPress={() => {
                    if (!saving) {
                        setAgreed((current) => !current);
                    }
                }}
                disabled={saving}
            >
                <View
                    style={[styles.checkbox, agreed && styles.checkboxChecked]}
                >
                    {agreed && <Text style={styles.checkmark}>✓</Text>}
                </View>

                <Text style={styles.agreementText}>
                    利用規約およびプライバシーポリシーを確認し、
                    内容に同意します。
                </Text>
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

                        <Text style={styles.acceptButtonText}>保存中...</Text>
                    </View>
                ) : (
                    <Text style={styles.acceptButtonText}>
                        同意して利用を開始
                    </Text>
                )}
            </Pressable>

            <Text style={styles.note}>
                一度同意すると、次回以降のログイン時には
                この画面は表示されません。
            </Text>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#ffffff",
    },

    content: {
        flexGrow: 1,
        padding: 20,
        paddingBottom: 48,
    },

    title: {
        marginTop: 12,
        marginBottom: 12,
        fontSize: 24,
        fontWeight: "bold",
        color: "#2f4f66",
        textAlign: "center",
    },

    description: {
        marginBottom: 20,
        fontSize: 15,
        lineHeight: 23,
        color: "#555",
        textAlign: "center",
    },

    infoBox: {
        marginBottom: 20,
        padding: 16,
        borderRadius: 12,
        backgroundColor: "#eef6fb",
    },

    infoTitle: {
        marginBottom: 8,
        fontSize: 16,
        fontWeight: "bold",
        color: "#2f4f66",
    },

    infoText: {
        fontSize: 14,
        lineHeight: 22,
        color: "#455a64",
    },

    documentArea: {
        marginBottom: 24,
        gap: 10,
    },

    documentButton: {
        minHeight: 68,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderWidth: 1,
        borderColor: "#d9e0e6",
        borderRadius: 10,
        backgroundColor: "#ffffff",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
    },

    documentButtonTitle: {
        marginBottom: 3,
        fontSize: 15,
        fontWeight: "bold",
        color: "#333",
    },

    documentButtonDescription: {
        fontSize: 12,
        color: "#777",
    },

    documentButtonArrow: {
        marginLeft: 12,
        fontSize: 30,
        color: "#78909c",
    },

    agreementRow: {
        marginBottom: 20,
        padding: 14,
        borderWidth: 1,
        borderColor: "#c8d0d7",
        borderRadius: 10,
        flexDirection: "row",
        alignItems: "flex-start",
        backgroundColor: "#ffffff",
    },

    checkbox: {
        width: 24,
        height: 24,
        marginRight: 12,
        borderWidth: 2,
        borderColor: "#78909c",
        borderRadius: 5,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#ffffff",
    },

    checkboxChecked: {
        borderColor: "#4b6f8f",
        backgroundColor: "#4b6f8f",
    },

    checkmark: {
        color: "#ffffff",
        fontSize: 16,
        fontWeight: "bold",
        lineHeight: 19,
    },

    agreementText: {
        flex: 1,
        fontSize: 14,
        lineHeight: 21,
        color: "#333",
    },

    acceptButton: {
        minHeight: 50,
        borderRadius: 10,
        backgroundColor: "#4b6f8f",
        alignItems: "center",
        justifyContent: "center",
    },

    acceptButtonDisabled: {
        backgroundColor: "#b0bec5",
    },

    acceptButtonLoading: {
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
    },

    acceptButtonText: {
        fontSize: 16,
        fontWeight: "bold",
        color: "#ffffff",
    },

    buttonPressed: {
        opacity: 0.75,
    },

    note: {
        marginTop: 14,
        fontSize: 12,
        lineHeight: 18,
        color: "#777",
        textAlign: "center",
    },
});
