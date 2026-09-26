import { useLayoutEffect } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const CONTACT_EMAIL = "hi64sa10@yahoo.co.jp";
const LAST_UPDATED = "2026年9月23日";

export default function TermsOfServiceScreen() {
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();

    useLayoutEffect(() => {
        navigation.setOptions({
            headerShown: false,
        });
    }, [navigation]);
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
                    利用規約
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
                            name="file-document-outline"
                            size={24}
                            color="#ffffff"
                        />
                    </View>

                    <View style={styles.introTextArea}>
                        <Text style={styles.introTitle}>利用規約</Text>

                        <Text style={styles.intro}>
                            この利用規約は、AcLog Fit
                            （以下「本アプリ」といいます。）の利用条件を定めるものです。
                            本アプリをご利用いただく前に、内容をご確認ください。
                        </Text>
                    </View>
                </View>

                <Section icon="information-outline" title="1. 本アプリについて">
                    本アプリは、スマートフォン等の位置情報を利用して、
                    移動ルートやアクティビティを記録・確認・共有するためのサービスです。
                    {"\n\n"}
                    本アプリには、FREEプランとPREMIUMプランがあります。
                </Section>

                <Section icon="account-outline" title="2. アカウント">
                    本アプリの利用には、アカウント登録が必要となります。
                    登録情報はメールアドレス、表示名、プロフィール画像などです。
                    {"\n\n"}
                    ユーザーは、登録情報を適切に管理し、
                    自分のアカウントを第三者に不正に利用されないよう管理するものとします。
                </Section>

                <Section
                    icon="crown-outline"
                    title="3. FREEプランとPREMIUMプラン"
                >
                    FREEプランでは、本アプリの基本機能を無料で利用できます。
                    ただし、記録回数、記録時間、位置情報の記録条件、
                    共有グループ数などに一定の制限があります。
                    {"\n\n"}
                    PREMIUMプランでは、FREEプランより細かな位置記録設定や、
                    制限が緩和された機能、
                    アクティビティ区分の変更などを利用できます。
                    {"\n\n"}
                    各プランの具体的な機能および制限は、 アプリ内の「FREE /
                    PREMIUM プラン」画面に表示します。
                </Section>

                <Section icon="credit-card-outline" title="4. PREMIUMの購入">
                    PREMIUMは、現在、買い切り型の商品として提供しています。
                    定期的に料金が発生する自動更新型のサブスクリプションではありません。
                    {"\n\n"}
                    購入価格は、購入時にGoogle Play等のアプリストアに
                    表示される価格をご確認ください。
                    {"\n\n"}
                    購入処理、支払方法、返金等については、
                    購入に利用したアプリストアの規約および
                    適用される法令に従います。
                    {"\n\n"}
                    購入済みのPremium利用権限については、
                    アプリの「購入を復元」機能等により復元できる場合があります。
                </Section>

                <Section
                    icon="map-marker-radius-outline"
                    title="5. 位置情報の取得"
                >
                    本アプリの自動記録機能では、
                    ユーザーが記録を開始している間、
                    バックグラウンドを含めて位置情報を取得する場合があります。
                    {"\n\n"}
                    位置情報の取得には、端末およびOSで
                    必要な位置情報権限が許可されている必要があります。
                </Section>

                <Section icon="crosshairs-gps" title="6. 位置情報の精度">
                    位置情報の取得精度、記録間隔、記録地点、
                    移動距離などは、GPSの状態、端末、OS、
                    通信状況、周辺環境、省電力設定などの影響を受けます。
                    {"\n\n"}
                    そのため、位置がずれる、記録が欠ける、
                    実際とは異なる距離が表示されるなどの事象が
                    発生する場合があります。
                </Section>

                <Section
                    icon="account-group-outline"
                    title="7. 位置情報およびアクティビティの共有"
                >
                    本アプリでは、ユーザー自身の操作によって、
                    他のユーザーに現在地やアクティビティ履歴を
                    共有することができます。
                    {"\n\n"}
                    位置情報はプライバシー性の高い情報です。
                    共有機能を利用する場合は、
                    共有する相手や共有範囲を十分に確認してください。
                </Section>

                <Section icon="podium" title="8. ランキング">
                    ランキングは、本アプリが定める条件を満たす
                    アクティビティをもとに集計します。
                    {"\n\n"}
                    徒歩・ランニング等、
                    ランキング対象として設定されたアクティビティのみが
                    集計される場合があります。
                    {"\n\n"}
                    不正な記録、明らかに異常な記録、
                    集計対象外と判定された記録については、
                    ランキングへ反映されない場合があります。
                </Section>

                <Section
                    icon="map-marker-path"
                    title="9. サンプルアクティビティ"
                >
                    本アプリでは、機能説明やGuidewayによる操作説明のため、
                    サンプルアクティビティを表示する場合があります。
                    {"\n\n"}
                    サンプルアクティビティはユーザー自身の実際の移動記録ではなく、
                    ランキング、月間記録数、その他の活動実績には加算されません。
                </Section>

                <Section icon="alert-circle-outline" title="10. 禁止事項">
                    ユーザーは、本アプリの利用にあたり、
                    次の行為を行ってはなりません。
                    {"\n\n"}
                    ・他のユーザーになりすます行為
                    {"\n"}
                    ・他のユーザーの位置情報を不正に取得または利用する行為
                    {"\n"}
                    ・本人の同意なく位置情報等を第三者へ公開する行為
                    {"\n"}
                    ・ランキング等の結果を不正に操作する行為
                    {"\n"}
                    ・本アプリまたはサーバーへ過度な負荷を与える行為
                    {"\n"}
                    ・本アプリの運営または他のユーザーの利用を妨害する行為
                    {"\n"}
                    ・法令または公序良俗に反する行為
                    {"\n"}
                    ・その他、運営者が不適切と判断する行為
                </Section>

                <Section icon="tools" title="11. サービスの変更・停止">
                    本アプリは、機能改善、メンテナンス、
                    外部サービスの仕様変更その他の事情により、
                    本アプリの全部または一部の機能を変更、追加、
                    一時停止または終了する場合があります。
                    {"\n\n"}
                    FREE / PREMIUMの機能や利用条件についても、
                    必要に応じて変更する場合があります。 重要な変更については、
                    可能な範囲で事前にお知らせするよう努めます。
                </Section>

                <Section icon="shield-alert-outline" title="12. 免責事項">
                    本アプリで表示される位置、距離、時間、
                    アクティビティ区分、ランキング等は参考情報です。
                    その完全性、正確性、継続性を保証するものではありません。
                    {"\n\n"}
                    本アプリは、生命・身体の安全確保、
                    緊急通報、遭難救助、医療判断などを目的とした
                    サービスではありません。
                    {"\n\n"}
                    通信障害、端末故障、OSの制限、
                    GPS精度、外部サービスの障害等によって
                    データが記録・表示・共有されない場合があります。
                </Section>

                <Section
                    icon="delete-outline"
                    title="13. アカウントおよびデータの削除"
                >
                    ユーザーは、本アプリが提供する機能を利用して、
                    アクティビティ履歴等を削除できます。
                    {"\n\n"}
                    アカウントを削除した場合、 アカウントに関連するデータは、
                    法令上または運用上保持が必要な情報を除き、
                    順次削除されます。
                    {"\n\n"}
                    Premium購入に関する取引記録については、 Google
                    Play等のアプリストア側に記録が残る場合があります。
                </Section>

                <Section icon="shield-account-outline" title="14. プライバシー">
                    本アプリにおける位置情報その他のユーザー情報の取扱いは、
                    別途定めるプライバシーポリシーに従います。
                </Section>

                <Section
                    icon="file-document-edit-outline"
                    title="15. 本規約の変更"
                >
                    本規約は、本アプリの機能変更、
                    法令その他の事情に応じて変更する場合があります。
                    {"\n\n"}
                    重要な変更がある場合は、
                    アプリ内その他適切な方法でお知らせします。
                </Section>

                <Section icon="scale-balance" title="16. 準拠法・お問い合わせ">
                    本規約は日本法に準拠します。
                    本アプリに関するお問い合わせは、
                    以下のメールアドレスまでご連絡ください。
                    {"\n\n"}
                    {CONTACT_EMAIL}
                </Section>

                <View style={styles.footer}>
                    <MaterialCommunityIcons
                        name="calendar-check-outline"
                        size={16}
                        color="#819198"
                    />

                    <Text style={styles.footerText}>
                        最終改定日：{LAST_UPDATED}
                    </Text>
                </View>
            </ScrollView>
        </View>
    );
}

type SectionProps = {
    icon: keyof typeof MaterialCommunityIcons.glyphMap;
    title: string;
    children: React.ReactNode;
};

function Section({ icon, title, children }: SectionProps) {
    return (
        <View style={styles.section}>
            <View style={styles.sectionHeader}>
                <View style={styles.sectionIconCircle}>
                    <MaterialCommunityIcons
                        name={icon}
                        size={19}
                        color="#0e9384"
                    />
                </View>

                <Text style={styles.sectionTitle}>{title}</Text>
            </View>

            <Text style={styles.text}>{children}</Text>
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
        paddingBottom: 36,
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

    intro: {
        color: "#71838c",

        fontSize: 12,
        lineHeight: 18,
    },

    section: {
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

    sectionHeader: {
        marginBottom: 10,

        flexDirection: "row",
        alignItems: "center",

        gap: 8,
    },

    sectionIconCircle: {
        width: 34,
        height: 34,

        borderRadius: 17,

        alignItems: "center",
        justifyContent: "center",

        backgroundColor: "#e7f6f3",
    },

    sectionTitle: {
        flex: 1,

        color: "#203f4f",

        fontSize: 15,
        fontWeight: "700",
    },

    text: {
        color: "#4d626d",

        fontSize: 13,
        lineHeight: 21,
    },

    footer: {
        marginTop: 2,

        paddingTop: 14,
        paddingBottom: 4,

        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",

        gap: 5,

        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: "#dce5e9",
    },

    footerText: {
        color: "#819198",

        fontSize: 12,
    },
});
