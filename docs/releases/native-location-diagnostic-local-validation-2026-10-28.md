# Native測位診断・ローカル検証準備

2026-10-28。追加EASビルド・OTA配信・本番設定の変更は行わない。通常版を保持し、既存の別パッケージ検証104をローカルAPKで更新する準備。

## Native追加項目

`patches/expo-location+19.0.8.patch` に診断専用AcLogNativeLocationEvidenceを追加した。通常のLocation座標・timestamp・speed等は変更せず、診断用の任意文字列aclogNativeEvidenceを併記する。パッケージ名が `com.hiroshisato.locationtrackerapp.incident104` と完全一致する時だけ有効で、通常版では無効。SQLiteスキーマ・DBバージョンは変更しない。

|項目|記録箇所・解釈|
|---|---|
|元latitude／longitude／fixTimeMs|Native Locationから直接コピーし、JSの点と完全一致するかを比較|
|fixElapsedRealtimeNanos|壁時計とは別の、測位時の単調時刻|
|receivedElapsedRealtimeNanos／receivedWallTimeMs|前面のLocation callback・背景のdeferLocations入口で観測。機器OSが推定した時刻とアプリに届いた時刻を分離|
|capturedElapsedRealtimeNanos／capturedWallTimeMs|LocationResponseへ変換した時刻。受信と変換の時間差を区別|
|bootCount|取得可能な場合のみ。単調時刻を再起動をまたいで比較しない|
|hasSpeed／speedMetersPerSecond|速度が本当に付いているかを保存。未測定の0を静止としない|
|hasSpeedAccuracy／speedAccuracyMetersPerSecond|API26以降の速度精度。未取得はnull|
|hasAccuracy／accuracyMeters|位置精度の有無と値|
|provider／mocked|測位プロバイダー名と模擬位置の状態。fusedだけでGNSS／Wi-Fiの内訳を断定しない|

ナノ秒は文字列で保持し、JSの整数精度損失を避ける。受信時刻の対応は最大128点の弱参照メモリーだけで、測位データ自体を変更しない。対応が失われた場合は受信時刻nullとして扱う。新しいセンサー・GNSSリスナー・通信は登録しない。診断例外は通常Location変換へ伝播させない。

JS診断はNative値を許可リストで取り込み、Native元点とJS点の一致、速度の存在／欠測を明示する。Native元点→受信箱のJS受渡し→採否→Cloud結果をcorrelationKeyで照合する。未知のメタデータは既存キュー保存・APIペイロードへ混ぜない。

## 通常版と検証版の隔離

- 通常版：`com.hiroshisato.locationtrackerapp`、1.0.5（27）。更新前APKを保存し、作業後もインストール済みAPKのSHA-256が変わらないことを確認。
- 検証版：`com.hiroshisato.locationtrackerapp.incident104`、表示名「AcLog Fit 検証104」。既存検証APKと同じ署名で上書き可能。アンインストールやデータ消去はしない。
- 隔離Cognito・AppSyncへ接続。APKのJSバンドルに隔離先が存在し、本番Cognito／APIが存在しないことを検査。
- OTAは検証用Manifestで無効。
- 通常ソースのJS診断フラグはOFF。`.amplify/known-issues-20261027/native-local/` 内の専用Metro構成でだけONへ差し替える。
- 同じ専用Metro構成でだけ「Native採否診断を出力（検証専用）」ボタンを追加。専用アカウントのroleや本番の管理者権限は変更しない。
- APKだけでなくソースマップも調べ、診断ONと検証専用出力ボタンが実際に組み込まれたことを確認。検証構成を指定したつもりでも実際のバンドルがOFFだった中間成果物は採用していない。

## ローカルビルドと検査

Android GradleによるローカルassembleReleaseを実施。EASコマンドは実行していない。

- 最新採用APK SHA-256：`fbcc963cefb3c390571a854bdf5fa788aaa796152e5b0779b92f57ba1ac25e27`
- パッケージ：`com.hiroshisato.locationtrackerapp.incident104`
- 最新版表示：`1.0.5-incident104-native`、検証用versionCode 10428（通常版の1.0.5（27）とは別）。中身は今回の作業ツリーを使用。
- 署名：既存の検証104と同一の開発署名。
- NativeコンパイルとAPK作成：合格。
- JS／Native診断取込・精度保持・速度欠測・対応キー集計・既存受渡し／基準のテスト32件：合格。
- Native受信箱SQLテスト3件、TypeScript型検査、元npmパッケージへのpatch適用確認、git diff --check：合格。

隔離バックエンドの更新前基準は30記録／3157地点、記録・共有停止。これはクラウドの基準であり、端末内未送信行の内容一致を検証済みという意味ではない。通常版の未送信領域にはアクセス・変更しない。

成果物と検査JSON、更新前APKはGit対象外の `.amplify/known-issues-20261027/native-local/` に保全。

## 実機手順と現在位置

検証104は完全再起動後にログイン成功と利用者が確認。最初のNative診断APKはインストール成功・SHA一致、通常版APK不変、隔離30記録／3157地点保持を確認した。その後、検証用versionCode 1のままでは本番の最低ビルド判定による更新案内が出ると分かったため、検証用variant出力だけを10428／1.0.5-incident104-nativeへ変更した。通常版の番号・本番app-version.jsonは変更していない。最新版APKの署名・接続先・診断ON・出力ボタンを再検査し、現在は最新版のPlayプロテクト確認待ち。新規記録はまだ開始していない。最初のAPK検査JSONはartifact-verification-initial.jsonに保持。

1. Androidで検証104だけを開き、ログイン名と記録／共有停止を確認。動作中なら上書きせず状態を確認する。通常版は操作しない。
2. 停止確認後、検証104だけへadb install -rで更新。必要ならPlayプロテクトの端末操作を案内する。データ削除やアンインストールによる回避は行わない。
3. インストール済みAPK一致・通常版APK不変・隔離接続・既存検証記録保持を確認後、専用「検証104 記録側」で共有先なし、既存設定30秒／50mのまま前面90秒の静置記録を案内する。
4. 「HF104Native前面確認」で停止保存し、表示時間・距離・経路線を確認。検証専用の診断出力ボタンから出力する。
5. 最初のログでNative項目・受信／変換時刻・対応キー・実基準・Cloud結果・欠測数を確認し、不足や負荷があれば背景試験へ進まない。
6. 問題なければ別セッションでロック背景90秒の静置を案内する。移動・低速歩行・周回はまだ要求しない。試験終了後に両方の停止と保存保持を照合する。

この短時間試験はまず証拠が揃うかの確認であり、飛び値が出なければ「解決した」とは判定しない。環境要因／測位エンジンまで断定するには、必要に応じて別条件の比較を後続で設計する。

## 検証104のログインエラー切り分け

端末でIncorrect username or passwordとの申告を受け、インストール済み検証APKを読み取り検査した。想定する隔離CognitoのプールID・アプリクライアントIDが存在し、本番プールIDは含まれない。device-login.txtの認証情報が専用fixtureと一致し、Cognitoユーザーも有効・CONFIRMEDだった。

同じ隔離先・同じアプリクライアントに対し、ファイル内の専用認証情報でNodeの独立プロセスから1回認証し、isSignedIn=true／DONEを確認後、その独立セッションのみサインアウトした。端末の保存領域・パスワード・ユーザー状態・roleは変更していない。

想定と違うCognitoを見ている、専用アカウントが無効、ファイルのパスワードが失効した、という説明を裏付ける結果ではなかった。端末で通常版のアカウントを入力したか、入力補完／入力欄の状態等が影響したかはまだ未確認。専用アカウントでの1回の制御した再試行を案内し、繰り返し失敗するなら診断を継続する。通常版の認証情報を隔離版へ流用せず、データ消去・再インストール・パスワード再設定は行わない。

### 再失敗後のsandbox点検

- 端末の認証失敗ログはNotAuthorizedException／authentication分類で、ストレージ例外ではなかった。
- インストール済みバンドルから検出されるCognitoプール候補は想定隔離先1件だけ。設定文字列の存在に加え、CloudTrailでも直近の試行は同じアプリクライアントのUSER_SRP_AUTH→PASSWORD_VERIFIERへ到達し、端末側の試行に認証拒否を確認。InitiateAuth成功だけをログイン成功と誤認しない。
- 同じクライアント・専用情報での独立したMacプロセスのPASSWORD_VERIFIERは成功。隔離AppSyncのgetUserProfileもHTTP200・GraphQLエラー0で専用所有者のプロフィールを取得できた。
- Cognito Lambda認証トリガーなし、MFA OFF、デバイス記憶設定なし、アプリクライアントSecretなし。端末に表示されたユーザー名も期待値と一致した。パスワード本文は記録していない。
- CloudTrailのユーザー名／認証応答は秘匿されており、端末が送信した入力内容の完全一致やSRP計算の正常性までは未確定。sandbox全体の停止・接続先違いを示す証拠はなく、端末側の入力／認証実行経路を継続調査する。
- 記録・共有停止を再確認し、検証104だけをam force-stop→明示Activity起動で完全再起動した。スワイプ終了と異なり常駐プロセスも終了する条件を確認するため。通常版・保存領域は変更しない。データ消去、再インストール、パスワード変更、sandbox再作成はしていない。
