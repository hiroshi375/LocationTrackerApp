import { ScrollView, StyleSheet, Text, View } from "react-native";

const CONTACT_EMAIL = "hi64sa10@yahoo.co.jp";
const LAST_UPDATED = "2026年9月23日";

export default function PrivacyPolicyScreen() {
    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={styles.content}
        >
            <Text style={styles.title}>プライバシーポリシー</Text>

            <Text style={styles.intro}>
                LocationTrackerApp（以下「本アプリ」といいます。）では、
                ユーザーの移動履歴を記録・表示・共有するために、
                位置情報などの情報を取り扱います。
                本ポリシーでは、取得する情報とその利用方法について説明します。
            </Text>

            <Section title="1. 取得する情報">
                本アプリでは、サービスの提供に必要な範囲で、次の情報を取得または保存する場合があります。
                {"\n\n"}
                ・位置情報（緯度、経度、取得時刻、位置精度など）
                {"\n"}
                ・位置情報の取得元（foreground / background）
                {"\n"}
                ・移動距離、移動時間、アクティビティ区分などの記録情報
                {"\n"}
                ・バッテリー残量、バッテリー状態、省電力モードなど、位置記録の状況確認に必要な情報
                {"\n"}
                ・ユーザーID、メールアドレス、表示名
                {"\n"}
                ・ユーザーが登録したプロフィール画像
                {"\n"}
                ・共有グループ、共有先ユーザーなどの共有設定
                {"\n"}
                ・ランキングや利用状況を算出するための集計情報
                {"\n"}
                ・FREE / PREMIUMの利用状態および購入状態
                {"\n"}
                ・アプリの動作状況、エラー、処理結果などの診断情報
            </Section>

            <Section title="2. 情報の利用目的">
                取得した情報は、主に次の目的で利用します。
                {"\n\n"}
                ・移動ルートおよびアクティビティ履歴の記録・表示
                {"\n"}
                ・移動距離、移動時間などの算出
                {"\n"}
                ・アクティビティ区分の判定
                {"\n"}
                ・リアルタイム位置情報およびアクティビティ履歴の共有
                {"\n"}
                ・ランキングおよび活動実績の集計
                {"\n"}
                ・FREE / PREMIUMの機能制御
                {"\n"}
                ・購入済みPremium機能の確認および復元
                {"\n"}
                ・不具合調査、サービス改善、安定運用
                {"\n"}
                ・不正利用やサービスの不適切な利用の防止
            </Section>

            <Section title="3. バックグラウンドでの位置情報取得">
                本アプリでは、自動記録機能を提供するため、
                ユーザーが自動記録を開始している間は、
                アプリが画面に表示されていない場合や、
                アプリを使用していない間でも位置情報を取得する場合があります。
                {"\n\n"}
                バックグラウンド位置情報は、
                移動ルートやアクティビティ履歴を継続して記録するために利用します。
                ユーザーが自動記録を開始していない状態で、
                アクティビティ記録を目的として継続的に位置情報を保存することはありません。
            </Section>

            <Section title="4. 情報の保存">
                取得した位置情報、アクティビティ履歴、
                プロフィール情報などは、サービス提供のため、 AWS（Amazon Web
                Services）のクラウドサービス等を利用して保存します。
                {"\n\n"}
                また、一部の設定や未送信データなどは、
                アプリがインストールされている端末内に保存される場合があります。
            </Section>

            <Section title="5. 外部サービスの利用">
                本アプリでは、サービス提供のために外部サービスを利用しています。
                {"\n\n"}
                ・AWS：ユーザー認証、データ保存、API等
                {"\n"}
                ・RevenueCat：Premiumの購入状態および利用権限の確認
                {"\n"}
                ・Google Play：Premium商品の購入処理
                {"\n"}
                ・Google Maps等：地図表示
                {"\n\n"}
                これらのサービスでは、それぞれの事業者の
                プライバシーポリシーに基づいて情報が取り扱われる場合があります。
                また、利用するサービスのシステムやデータセンターの所在地により、
                情報が日本国外で処理または保存される場合があります。
            </Section>

            <Section title="6. Premium購入に関する情報">
                Premium商品の購入処理はGoogle
                Play等のアプリストアを通じて行われます。
                本アプリがクレジットカード番号などの決済情報を直接取得することはありません。
                {"\n\n"}
                本アプリでは、Premium機能を提供するため、
                RevenueCatを通じて購入状態やPremium利用権限を確認します。
            </Section>

            <Section title="7. ユーザー間での情報共有">
                ユーザーが明示的に共有操作を行った場合、
                選択したユーザーや共有グループのメンバーに対して、
                現在地、移動ルート、アクティビティ履歴などが表示される場合があります。
                {"\n\n"}
                共有先を選択する際は、
                信頼できる相手であることを確認したうえでご利用ください。
            </Section>

            <Section title="8. ランキング">
                ランキング機能では、表示名、プロフィール画像、
                移動距離、移動時間など、
                ランキング表示に必要な情報が他のユーザーに表示される場合があります。
                {"\n\n"}
                ランキングには、本アプリが定める集計条件を満たす
                アクティビティのみが反映されます。
                操作説明用のサンプルアクティビティは集計対象にはなりません。
            </Section>

            <Section title="9. 情報の保存期間と削除">
                ユーザー情報およびアクティビティ履歴は、
                原則としてアカウントまたは対象データが存在する間保存されます。
                {"\n\n"}
                ユーザーは、本アプリで提供される削除機能を利用して、
                アクティビティ履歴などを削除できます。
                また、アカウント削除機能またはお問い合わせを通じて、
                アカウントに関連する情報の削除を依頼できます。
                {"\n\n"}
                ただし、法令への対応、不正利用防止、
                障害調査その他正当な理由により、
                必要最小限の情報を一定期間保持する場合があります。
            </Section>

            <Section title="10. 安全管理">
                本アプリでは、取得した情報への不正アクセス、
                紛失、漏えい、改ざん等を防止するため、
                利用するクラウドサービスのセキュリティ機能などを活用し、
                合理的な安全管理措置を講じるよう努めます。
            </Section>

            <Section title="11. 未成年者の利用">
                未成年の方が本アプリを利用する場合は、
                必要に応じて保護者等の同意を得たうえで利用してください。
                特に位置情報の共有機能を利用する場合は、
                共有する相手や共有範囲を十分に確認してください。
            </Section>

            <Section title="12. プライバシーポリシーの変更">
                本アプリの機能変更、法令の変更その他必要に応じて、
                本ポリシーを変更する場合があります。 重要な変更がある場合は、
                アプリ内その他適切な方法でお知らせします。
            </Section>

            <Section title="13. お問い合わせ">
                本ポリシーおよび個人情報の取扱いに関するお問い合わせは、
                以下のメールアドレスまでご連絡ください。
                {"\n\n"}
                {CONTACT_EMAIL}
            </Section>

            <View style={styles.footer}>
                <Text style={styles.footerText}>
                    最終改定日：{LAST_UPDATED}
                </Text>
            </View>
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
        paddingBottom: 48,
    },

    title: {
        fontSize: 24,
        fontWeight: "bold",
        color: "#2f4f66",
        marginBottom: 16,
    },

    intro: {
        fontSize: 14,
        lineHeight: 22,
        color: "#444",
        marginBottom: 24,
    },

    section: {
        marginBottom: 24,
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

    footer: {
        paddingTop: 8,
        borderTopWidth: 1,
        borderTopColor: "#e5e5e5",
    },

    footerText: {
        fontSize: 13,
        color: "#777",
    },
});
