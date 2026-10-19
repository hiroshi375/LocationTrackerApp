# 1.0.4 SDK情報取扱い追記・再通知の配布準備

2026-10-19。利用者が変更前後の全文を確認し、反映・コミット・push後に各OSのproductionビルドを1回ずつ行うことを承認。

## 対象

- Android 1.0.4（25）、production AAB。
- iOS 1.0.4（10）、production IPA。
- EASの実行前リモート番号はAndroid24、iOS9。production autoIncrement=true。
- production-device-android、追加APK、OTA、ストア一般公開、バックエンドのデプロイは行わない。

## 文書と再通知

PrivacyPolicyScreen.tsxの第1・2・5・6節、TermsOfServiceScreen.tsxの第2節に、承認済み原稿を反映。他節は変更しない。体重、アプリ生成端末ID、バージョン・起動情報、購入情報の関連付けと分析、地図SDKの情報取扱いを説明する。

公開Webのprivacy/・terms/をアプリ本文から同期。account-deletion/にアカウントを維持したアクティビティ履歴の削除方法と問い合わせ方法を追加。

同意識別値を2026-10-19-r2に更新し、先の2026-10-19版へ同意済みでも再通知する。表示上の改定日は2026年10月19日。既存同意レコードの一括消去はしない。新しいアプリ起動時に現在の本文の確認と明示的同意を求める。旧バイナリにOTA配信しない。

app-version.jsonのpendingReleaseのみ更新。公開済みバージョンと最低サポート番号は今回変更しない。iOS1.0.2のReady for Distributionは前ターンに観測済みだが、今回一般公開や公開版通知の切替は行わない。

## SDK残項目

- RevenueCat管理画面のIntegrationsはActive 0。アプリ内に広告識別子収集・メール・体重・位置情報・プロフィール画像を購入者属性へ送信する呼出しは見当たらない。CognitoユーザーIDでlogInするため購入情報は本人に関連付く。購入状態の分析利用は承認済み追記に含む。
- 既存Android24 AAB内BUNDLE-METADATAの依存情報でMaps18.2.0、RevenueCat purchases10.22.1／Hybrid19.2.0を確認。iOS再生成Podfile.lockではGoogleMaps8.4.0／RevenueCat5.90.1／Hybrid19.2.0。
- Google公式の現行説明にあるSDK識別子、IP、端末情報、地図操作、クラッシュ・診断情報は承認済み追記で説明済み。現行説明は最新SDK向けであり、旧SDKでの全実通信を採取した検証ではない。追加の文書修正は不要と判断。ストア申告の共有・診断等の最終回答は提出前の照合事項として残す。
- 参照: https://developers.google.com/maps/documentation/android-sdk/play-data-disclosure
- 参照: https://www.revenuecat.com/docs/platform-resources/google-platform-resources/google-plays-data-safety
- 参照: https://www.revenuecat.com/docs/platform-resources/apple-platform-resources/apple-app-privacy

## 互換性とローカル検証

保存処理、記録キュー、API定義、Amplifyモデル、Lambda、認可、共有処理、依存関係・ロックファイルは変更しない。旧版・新版の記録保存の経路を今回変更しないことを差分で確認。新バイナリの実機スモークテストは完成後に実施するため、今回のローカル確認と区別する。

17件の関連テスト、フロント型チェック、変更したTypeScriptのlint、承認済み本文との一致、他節の不変、公開HTMLとの全文一致を確認。Webアプリのexportは既存react-native-mapsのWeb非対応で失敗したため、配布対象Android/iOSを個別に検証する。公開HTML生成・同期の失敗ではない。

Android・iOS個別のproduction JS exportは双方成功。Expo解決済み設定はversion1.0.4、runtime=appVersion、既存Team・Bundle ID・package・位置情報設定プラグインを維持。
