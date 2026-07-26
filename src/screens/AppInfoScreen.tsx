import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { RootStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<RootStackParamList, "AppInfo">;

export default function AppInfoScreen({ navigation }: Props) {
    return (
        <View style={styles.container}>
            <Text style={styles.title}>アプリ情報</Text>

            <Text style={styles.description}>
                LocationTrackerAppに関する情報を確認できます。
            </Text>

            <View style={styles.buttonColumn}>
                <Pressable
                    style={({ pressed }) => [
                        styles.button,
                        pressed && styles.buttonPressed,
                    ]}
                    onPress={() => navigation.navigate("PrivacyPolicy")}
                >
                    <Text style={styles.buttonText}>プライバシーポリシー</Text>
                </Pressable>

                <Pressable
                    style={({ pressed }) => [
                        styles.button,
                        pressed && styles.buttonPressed,
                    ]}
                    onPress={() => navigation.navigate("TermsOfService")}
                >
                    <Text style={styles.buttonText}>利用規約</Text>
                </Pressable>

                <Pressable
                    style={({ pressed }) => [
                        styles.button,
                        pressed && styles.buttonPressed,
                    ]}
                    onPress={() => navigation.navigate("Contact")}
                >
                    <Text style={styles.buttonText}>お問い合わせ</Text>
                </Pressable>
            </View>
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
        marginBottom: 10,
    },
    description: {
        fontSize: 14,
        lineHeight: 21,
        color: "#555",
        marginBottom: 24,
    },
    buttonColumn: {
        gap: 12,
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
