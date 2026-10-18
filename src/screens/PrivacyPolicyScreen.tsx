import { useLayoutEffect } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const CONTACT_EMAIL = "hi64sa10@yahoo.co.jp";
const LAST_UPDATED = "2026年10月19日"; // 公開時に実際の改定日を設定

export default function PrivacyPolicyScreen() {
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

            {/* ヘッダ */}
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
                    プライバシーポリシー
                </Text>

                <View style={styles.headerRightSpace} />
            </View>

            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
            >
                {/* 冒頭説明 */}
                <View style={styles.introCard}>
                    <View style={styles.introIconCircle}>
                        <MaterialCommunityIcons
                            name="shield-account-outline"
                            size={24}
                            color="#ffffff"
                        />
                    </View>

                    <View style={styles.introTextArea}>
                        <Text style={styles.introTitle}>
                            プライバシーポリシー
                        </Text>

                        <Text style={styles.intro}>
                            AcLog Fit（以下「本アプリ」といいます。）では、
                            ユーザーの移動履歴を記録・表示・共有するために、
                            位置情報などの情報を取り扱います。
                            本ポリシーでは、取得する情報とその利用方法について説明します。
                        </Text>
                    </View>
                </View>

                <Section icon="database-outline" title="1. 取得する情報">
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
                    ・アクティビティランキングや利用状況を算出するための集計情報
                    {"\n"}
                    ・FREE / PREMIUMの利用状態および購入状態
                    {"\n"}
                    ・アプリの動作状況、エラー、処理結果などの診断情報
                </Section>

                <Section icon="target-account" title="2. 情報の利用目的">
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
                    ・アクティビティランキングおよび活動実績の集計
                    {"\n"}
                    ・FREE / PREMIUMの機能制御
                    {"\n"}
                    ・購入済みPremium機能の確認および復元
                    {"\n"}
                    ・不具合調査、サービス改善、安定運用
                    {"\n"}
                    ・不正利用やサービスの不適切な利用の防止
                </Section>

                <Section
                    icon="map-marker-radius-outline"
                    title="3. バックグラウンドでの位置情報取得"
                >
                    {"\n\n"}本アプリでは、自動記録機能を提供するため、ユーザーが記録を開始している間、アプリが画面に表示されていない場合や使用していない間にも位置情報を取得する場合があります。取得した情報は、移動ルートおよびアクティビティ履歴の継続記録に利用します。{"\n\n"}位置情報の取得には、端末の設定で必要な権限を許可する必要があります。権限はiOS・Androidの端末設定から変更または取り消すことができます。権限を取り消すと、位置情報を使用する機能の一部または全部が利用できなくなる場合があります。{"\n\n"}位置情報の取得権限の変更は、すでに保存したアクティビティ履歴の削除とは異なります。保存済みデータについては「9. 情報の保存期間と削除」をご確認ください。
                </Section>

                <Section icon="cloud-outline" title="4. 情報の保存">
                    {"\n\n"}取得した位置情報、アクティビティ履歴、プロフィール情報などは、サービス提供のため、AWS（Amazon Web Services）のクラウドサービス等を利用して保存します。{"\n\n"}一部の設定情報、未送信の位置記録データなどは、アプリがインストールされた端末内に保存される場合があります。通信状態によってはクラウドへの反映が遅れる場合があります。{"\n\n"}情報の保存期間と削除方法については「9. 情報の保存期間と削除」をご確認ください。
                </Section>

                <Section icon="link-variant" title="5. 外部サービスの利用">
                    {"\n\n"}本アプリでは、サービス提供のために次の外部サービスを利用しています。{"\n\n"}・AWS：ユーザー認証、データ保存、API等
・RevenueCat：Premiumの購入状態および利用権限の確認
・Apple App Store / Google Play：Premium商品の購入処理
・Google Maps / Appleマップ：地図表示{"\n\n"}これらのサービスでは、サービス提供に必要な情報が各事業者によって処理される場合があります。情報の取扱いには各事業者のプライバシーポリシー等が適用される場合があります。また、サービスのシステムやデータセンターの所在地により、情報が日本国外で処理または保存される場合があります。
                </Section>

                <Section
                    icon="crown-outline"
                    title="6. Premium購入に関する情報"
                >
                    Premium商品の購入処理はApple App Store / Google Playを通じて行われます。
                    本アプリがクレジットカード番号などの決済情報を直接取得することはありません。
                    {"\n\n"}
                    本アプリでは、Premium機能を提供するため、
                    RevenueCatを通じて購入状態やPremium利用権限を確認します。
                </Section>

                <Section
                    icon="account-group-outline"
                    title="7. ユーザー間での情報共有"
                >
                    {"【リアルタイム位置情報の共有】\nユーザーが位置共有の相手を選択し、共有を有効にした場合、現在地、取得・更新時刻などが共有相手に表示されます。アクティビティ履歴の共有とは別に、位置共有の設定を確認してください。\n\n【アクティビティ履歴の共有】\nグループへの参加だけで、過去のアクティビティ履歴が共有されることはありません。記録の所有者が、アクティビティ履歴ごとに共有相手と共有に使用するグループを指定します。共有されたアクティビティ履歴およびその地図・位置記録は、所有者と有効な共有権限を持つ相手が閲覧できます。アクティビティカレンダーには、ログイン中のユーザー本人が所有するアクティビティ履歴だけが表示されます。他のユーザーから共有されたアクティビティ履歴は、アクティビティカレンダーには表示されません。\n\n共有解除、脱退、除外、グループの無効化・削除などによって対象の共有権限が失効すると、その相手は対象アクティビティ履歴や位置記録をサーバーから新たに取得できなくなります。ただし、別のグループを通じた有効な共有が残っている場合は、引き続き閲覧できます。グループへの再参加だけでは失効した共有は復活せず、所有者による再共有が必要です。記録の所有者本人の閲覧権限は、グループからの脱退・除外やグループ削除によって失われません。\n\n【共有に伴う表示と注意】\n「履歴の共有管理」画面や「共有グループ管理」画面などでは、相手を識別するために表示名、メールアドレス、プロフィール画像などを表示する場合があります。アクティビティランキングで表示される情報については「8. アクティビティランキング」をご確認ください。共有終了前に端末へ取得された情報や、共有相手が保存した画像・コピーまで消去できるとは限りません。\n\n位置情報や移動履歴から自宅、勤務先、生活時間帯などが推測される場合があります。信頼できる相手と共有してください。他のユーザーから共有された情報を本人の同意なく第三者に公開しないでください。"}
                </Section>

                <Section icon="podium" title="8. アクティビティランキング">
                    {"\n\n"}アクティビティランキング機能では、表示名、プロフィール画像、対象となるアクティビティの移動距離、移動時間など、アクティビティランキング表示に必要な情報が、アクティビティランキングを閲覧できる他のユーザーに表示される場合があります。{"\n\n"}アクティビティランキングには、本アプリが定める集計条件を満たすアクティビティのみが反映されます。操作説明用のサンプルアクティビティは集計対象になりません。
                </Section>

                <Section
                    icon="delete-clock-outline"
                    title="9. 情報の保存期間と削除"
                >
                    {"ユーザー情報およびアクティビティ履歴は、原則としてアカウントまたは対象データが存在する間保存されます。\n\n位置情報の取得権限は端末設定から変更・取り消しができます。これは今後の取得を制御する操作であり、保存済みアクティビティ履歴の削除とは異なります。記録の停止、共有の解除、保存済み情報の削除は、それぞれ対応する機能で行ってください。保存済みのアクティビティ履歴は、本アプリの「アクティビティ履歴」画面の「削除」機能から削除できます。\n\nアカウント削除機能では、共有権限を失効させたうえで、位置記録、アクティビティ履歴、現在地情報、共有Grant、関連する共有操作情報、索引、月間・週次集計、記録診断情報、端末セッション、プロフィール画像、プロフィールおよび認証アカウントを順に削除します。ユーザーが所有する共有グループは削除し、他のグループからは脱退します。他のユーザーが所有するアクティビティ履歴は削除せず、対象となる共有権限を解除します。\n\nこの端末に保存された削除対象ユーザーの未送信記録も削除します。他のアカウントの未送信記録は削除しません。別の端末に保存された情報や共有相手が既に保存した画像・コピーまで、遠隔で消去できるとは限りません。\n\n処理に時間がかかる場合は小分けにして進めます。通信断やアプリ終了などで中断した場合は、アカウント削除を再実行して続きから再開してください。エラーが表示された場合は、削除が完了したと判断せず、再実行するかお問い合わせください。\n\n再開と重複実行防止のため、必要最小限の削除進捗情報を保持します。サーバー上の関連データの削除処理が完了した後、この進捗情報は7日を目安として自動削除処理の対象になります。\n\n上記の記録診断情報とは別に、共有管理サーバーの共用運用ログには、処理時刻、ユーザー識別子、エラーなどが記録される場合があります。この共用運用ログは通常のアカウント削除の対象外です。現行の設定では保存期間の上限を設けていません。\n\n法令により保持が必要な情報がある場合は、その目的に必要な範囲と期間に限って保持します。削除対象・方法・処理状況については「13. お問い合わせ」からご連絡ください。"}
                </Section>

                <Section icon="shield-check-outline" title="10. 安全管理">
                    本アプリでは、取得した情報への不正アクセス、
                    紛失、漏えい、改ざん等を防止するため、
                    利用するクラウドサービスのセキュリティ機能などを活用し、
                    合理的な安全管理措置を講じるよう努めます。
                </Section>

                <Section
                    icon="account-child-outline"
                    title="11. 未成年者の利用"
                >
                    未成年の方が本アプリを利用する場合は、
                    必要に応じて保護者等の同意を得たうえで利用してください。
                    特に位置情報の共有機能を利用する場合は、
                    共有する相手や共有範囲を十分に確認してください。
                </Section>

                <Section
                    icon="file-document-edit-outline"
                    title="12. プライバシーポリシーの変更"
                >
                    {"本アプリの機能変更、法令の変更その他の事情により、本ポリシーを変更する場合があります。重要な変更については、変更内容と適用時期をアプリ内その他適切な方法でお知らせします。\n\n既に取得した情報の利用目的や共有範囲を拡大・変更する場合は、その内容を説明し、変更後の利用を開始する前に必要な同意を取得します。適用される法令およびプラットフォームの要件に従います。\n\n同意の再確認が必要な改定では、以前に同意したユーザーにも改定後の文書を案内し、再度確認・同意を求めます。"}
                </Section>

                <Section icon="email-outline" title="13. お問い合わせ">
                    本ポリシーおよび個人情報の取扱いに関するお問い合わせは、
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
