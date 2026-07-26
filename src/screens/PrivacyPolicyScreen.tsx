import { ScrollView, StyleSheet, Text, View } from "react-native";

export default function PrivacyPolicyScreen() {
    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={styles.content}
        >
            <Text style={styles.title}>プライバシーポリシー</Text>

            <Section title="1. 取得する情報">
                本アプリは、移動履歴を記録するため、位置情報、
                ユーザーID、メールアドレス、表示名などの情報を取得します。
            </Section>

            <Section title="2. 位置情報の利用">
                自動記録中は、アプリを使用していない間やバックグラウンドでも
                位置情報を取得する場合があります。取得した位置情報は、
                移動ルートやアクティビティ履歴の作成に使用します。
            </Section>

            <Section title="3. 情報の保存">
                取得した情報は、AWSのクラウドサービスを利用して保存します。
            </Section>

            <Section title="4. 情報の共有">
                ユーザーが明示的に共有操作を行った場合に限り、
                選択したユーザーへ位置情報またはアクティビティ履歴を共有します。
            </Section>

            <Section title="5. 情報の削除">
                ユーザーは、アプリ内から位置履歴やアカウント情報の
                削除を依頼できます。
            </Section>

            <Section title="6. お問い合わせ">
                本ポリシーに関するお問い合わせは、
                アプリ内のお問い合わせ画面からご連絡ください。
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
