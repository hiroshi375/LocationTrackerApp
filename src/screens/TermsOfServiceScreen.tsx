import { ScrollView, StyleSheet, Text, View } from "react-native";

export default function TermsOfServiceScreen() {
    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={styles.content}
        >
            <Text style={styles.title}>利用規約</Text>

            <Section title="1. 本アプリについて">
                本アプリは、位置情報を利用して移動履歴や
                アクティビティを記録するサービスです。
            </Section>

            <Section title="2. 利用上の注意">
                位置情報の取得精度や記録間隔は、端末、OS、
                通信状況、省電力設定などにより変化する場合があります。
            </Section>

            <Section title="3. 禁止事項">
                他の利用者への迷惑行為、不正利用、サービス運営を妨げる行為を
                禁止します。
            </Section>

            <Section title="4. 免責事項">
                本アプリで表示される位置情報や距離は参考情報です。
                記録の完全性や正確性を保証するものではありません。
            </Section>

            <Section title="5. 規約の変更">
                本規約は、必要に応じて変更する場合があります。
            </Section>
        </ScrollView>
    );
}

type SectionProps = {
    title: string;
    children: React.ReactNode;
};

function Section({ title, children }: SectionProps) {
    return (
        <View style={styles.section}>
            <Text style={styles.sectionTitle}>{title}</Text>
            <Text style={styles.text}>{children}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#ffffff",
    },
    content: {
        padding: 20,
        paddingBottom: 40,
    },
    title: {
        fontSize: 24,
        fontWeight: "bold",
        color: "#2f4f66",
        marginBottom: 20,
    },
    section: {
        marginBottom: 20,
    },
    sectionTitle: {
        fontSize: 16,
        fontWeight: "bold",
        color: "#333",
        marginBottom: 8,
    },
    text: {
        fontSize: 14,
        lineHeight: 22,
        color: "#444",
    },
});
