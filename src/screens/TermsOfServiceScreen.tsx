import { useLayoutEffect } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const CONTACT_EMAIL = "hi64sa10@yahoo.co.jp";
const LAST_UPDATED = "2026年10月19日"; // 公開時に実際の改定日を設定

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
                    {"本アプリの利用には、アカウント登録が必要となります。 登録情報はメールアドレス、表示名、プロフィール画像などです。\n消費カロリーの目安の算出に使用する体重は任意で登録できます。\n\nユーザーは、登録情報を適切に管理し、 自分のアカウントを第三者に不正に利用されないよう管理するものとします。\n\n本アプリは、端末セッションの管理のために生成した端末識別子と、アプリのバージョン、ビルド番号、OS種別、最終起動日時を取り扱います。これらの情報および外部サービスによる情報の取扱いの詳細は、プライバシーポリシーをご確認ください。"}
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
                    購入価格は、購入時に各アプリストアに表示される
                    価格をご確認ください。
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
                    {"\n\n"}本アプリの自動記録機能では、ユーザーが記録を開始している間、バックグラウンドを含めて位置情報を取得する場合があります。{"\n\n"}位置情報を利用する機能には、端末およびOSで必要な位置情報権限が許可されている必要があります。権限は端末の設定から変更できますが、権限を許可しない場合や取り消した場合は、位置記録や位置共有などの機能の一部または全部を利用できなくなる場合があります。
                </Section>

                <Section icon="crosshairs-gps" title="6. 位置情報の精度">
                    {"\n\n"}位置情報の取得精度、記録間隔、記録地点、移動距離などは、GPSの状態、端末、OS、通信状況、周辺環境、省電力設定などの影響を受けます。{"\n\n"}このため、位置がずれる、記録が欠ける、実際とは異なる距離が表示される、情報の更新や共有に遅れが生じるといった事象が発生する場合があります。
                </Section>

                <Section
                    icon="account-group-outline"
                    title="7. 位置情報およびアクティビティの共有"
                >
                    {"【リアルタイム位置情報の共有】\nユーザーの操作および位置共有設定に応じて、選択した相手と現在地を共有できます。アクティビティ履歴の共有とは別の設定です。\n\n【アクティビティ履歴の共有】\nグループへの参加だけで、過去のアクティビティ履歴が共有されることはありません。記録の所有者が、アクティビティ履歴ごとに共有相手と共有に使用するグループを指定します。共有されたアクティビティ履歴およびその地図・位置記録は、所有者と有効な共有権限を持つ相手が閲覧できます。アクティビティカレンダーには、ログイン中のユーザー本人が所有するアクティビティ履歴だけが表示されます。他のユーザーから共有されたアクティビティ履歴は、アクティビティカレンダーには表示されません。\n\n共有解除、脱退、除外、グループの無効化・削除などによって対象の共有権限が失効すると、その相手は対象アクティビティ履歴や位置記録をサーバーから新たに取得できなくなります。ただし、別のグループを通じた有効な共有が残っている場合は、引き続き閲覧できます。グループへの再参加だけでは失効した共有は復活せず、所有者による再共有が必要です。記録の所有者本人の閲覧権限は、グループからの脱退・除外やグループ削除によって失われません。\n\n【共有に伴う注意・禁止事項】\n位置情報や移動履歴は個人の生活行動を推測できる情報です。共有先と共有範囲を確認してください。他のユーザーから共有された情報を、本人の同意なく第三者に公開すること、嫌がらせ、監視、追跡その他の不適切な目的に利用することを禁止します。\n\n共有停止後も、端末へ取得済みの情報や相手が保存した画像・コピーの完全な削除は保証されません。共有情報はGPS精度、通信環境、OSの制限等により不正確になったり、更新が遅延・停止したりする場合があります。緊急時の安全確認、救命、遭難救助等を保証するものではありません。"}
                </Section>

                <Section icon="podium" title="8. アクティビティランキング">
                    アクティビティランキングは、本アプリが定める条件を満たす
                    アクティビティをもとに集計します。
                    {"\n\n"}
                    徒歩・ランニング等、
                    アクティビティランキング対象として設定されたアクティビティのみが
                    集計されます。
                    {"\n\n"}
                    不正な記録、明らかに異常な記録、
                    集計対象外と判定された記録については、
                    アクティビティランキングへ反映されない場合があります。
                </Section>

                <Section
                    icon="map-marker-path"
                    title="9. サンプルアクティビティ"
                >
                    本アプリでは、機能説明やGuidewayによる操作説明のため、
                    サンプルアクティビティを表示する場合があります。
                    {"\n\n"}
                    サンプルアクティビティはユーザー自身の実際の移動記録ではなく、
                    アクティビティランキング、月間記録数、その他の活動実績には加算されません。
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
                    ・アクティビティランキング等の結果を不正に操作する行為
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
                    {"\n\n"}本アプリで表示される位置、距離、時間、アクティビティ区分、アクティビティランキング等は参考情報です。完全性、正確性、継続性を保証するものではありません。{"\n\n"}本アプリは、生命・身体の安全確保、緊急通報、遭難救助、医療判断などを目的としたサービスではありません。位置共有が有効な場合でも、相手の現在地を常に正確かつリアルタイムに確認できるとは限りません。{"\n\n"}通信障害、端末故障、OSの制限、GPS精度、外部サービスの障害等によってデータが記録・表示・共有されない場合があります。
                </Section>

                <Section
                    icon="delete-outline"
                    title="13. アカウントおよびデータの削除"
                >
                    {"ユーザーは、本アプリの「アクティビティ履歴」画面の「削除」機能およびアカウント削除機能を利用できます。\n\nアカウント削除機能では、共有権限を失効させたうえで、位置記録、アクティビティ履歴、現在地情報、共有Grant、関連する共有操作情報、索引、月間・週次集計、記録診断情報、端末セッション、プロフィール画像、プロフィールおよび認証アカウントを順に削除します。ユーザーが所有する共有グループは削除し、他のグループからは脱退します。他のユーザーが所有するアクティビティ履歴は削除せず、対象となる共有権限を解除します。\n\nこの端末に保存された削除対象ユーザーの未送信記録も削除します。他のアカウントの未送信記録は削除しません。別の端末に保存された情報や共有相手が既に保存した画像・コピーまで、遠隔で消去できるとは限りません。\n\n処理に時間がかかる場合は小分けにして進めます。通信断やアプリ終了などで中断した場合は、アカウント削除を再実行して続きから再開してください。エラーが表示された場合は、削除が完了したと判断せず、再実行するかお問い合わせください。\n\n再開と重複実行防止のため、必要最小限の削除進捗情報を保持します。サーバー上の関連データの削除処理が完了した後、この進捗情報は7日を目安として自動削除処理の対象になります。\n\n共用のサーバー運用ログは通常のアカウント削除の対象外であり、現行の設定では保存期間の上限を設けていません。詳細はプライバシーポリシー「9. 情報の保存期間と削除」をご確認ください。\n\n端末の位置情報権限を取り消しても、保存済みアクティビティ履歴は自動的には削除されません。情報の保存・削除については、プライバシーポリシー「9. 情報の保存期間と削除」もご確認ください。\n\nPremium購入に関する取引記録は、各アプリストアなど購入処理を行う事業者側に残る場合があります。アカウント削除と購入の返金は別の手続きです。購入情報の管理・返金等は、各アプリストアの規約および適用される法令に従います。"}
                </Section>

                <Section icon="shield-account-outline" title="14. プライバシー">
                    本アプリにおける位置情報その他のユーザー情報の取扱いは、
                    別途定めるプライバシーポリシーに従います。
                </Section>

                <Section
                    icon="file-document-edit-outline"
                    title="15. 本規約の変更"
                >
                    {"本規約は、本アプリの機能変更、法令その他の事情に応じて変更する場合があります。変更にあたっては、適用される法令に従い、重要な変更の内容と適用時期をアプリ内その他適切な方法でお知らせします。\n\n同意の再確認が必要な改定では、以前に同意したユーザーにも改定後の利用規約とプライバシーポリシーを案内し、再度確認・同意を求めます。既に取得した情報の利用目的や共有範囲を変更する場合の扱いは、プライバシーポリシーに従います。"}
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
