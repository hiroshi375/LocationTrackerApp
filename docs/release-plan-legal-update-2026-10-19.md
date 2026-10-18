# 改訂文書・アカウント削除対応の更新配布計画

2026年10月19日。コミット67a55cdをorigin/mainへpush済み。EAS Buildは本確認では実行していない。

## 確定した次バージョン

表示バージョンはAndroid・iOSとも1.0.3とする。app.jsonを1.0.3へ更新済み。EASのリモート番号はAndroid versionCode=23、iOS buildNumber=8を読み取り確認した。productionのautoIncrement=trueにより、次回はAndroid24、iOS9になる見込み。他のビルドで番号を消費した場合は再確認する。

既存の1.0.2（23/8）の成果物には今回の改訂文書・再同意・新版削除処理は含まれない。既存成果物を再提出しても今回の変更の配布にはならない。

## 最小限のビルド

- Android：production AABを1回。Google Play内部テストから導入して、その同じAABを後続のテスト・製品版へ昇格する。
- iOS：production IPAを1回。TestFlightで確認し、その同じビルドをApp Store審査へ提出する。
- production-device-androidは直接導入用のAPKを作る補助プロファイル。今回使用しない。当該プロファイルはeas.jsonから削除済み。
- クラウドビルド前にローカル型チェック、関連テスト、production JS書き出し、iOS設定再生成の検証を済ませる。ビルド後の問題で作り直しが必要になった場合だけ、追加ビルドを検討する。

## 残る未コミット変更

- app.json：前回の1.0.2への更新、Apple Team、iOS Pods設定プラグイン登録。今回の配布向けに表示バージョンを1.0.3へ更新済み。
- plugins/withIosPodDeploymentTarget.js：iOS再生成後もPodsの最低OS設定を再現する。app.jsonと一緒に確定する。
- scripts/verify-ios-prebuild.cjs：再生成したiOSの署名・Bundle ID・位置情報設定・地図・Pods設定を検証する。
- eas.json：前回の直接導入APK用プロファイルとApp Store Connect提出先ID。提出先IDは維持し、APK用プロファイルは削除済み。
- .easignore：無関係なローカル画像をEASアップロードから除外する。
- docs/sharing-roadmap.md、production-build-verification.md、release-preflight-2026-10-18.md、store-submission-1.0.2.md：前回の配布・検証記録。途中段階の記載は最終結果と区別して整理する。
- src/screens/0303_paella_04.jpg：今回の機能と無関係な画像。コミット・配布対象に含めない。

## 配布までの順序

1. 上記の配布設定・バージョンを確定し、ローカル確認後に追加コミット・pushする。検証専用applicationIdSuffixは.amplify内のGradle初期化スクリプトだけにあり、productionへ適用しない。
2. productionの接続先、API定義、署名、アップロード対象を確認する。ネイティブ生成フォルダーはEASへ送らず、設定プラグインから再生成する。
3. Android・iOS各1回のproductionビルドを作成する。自動一般公開はしない。
4. Google Play内部テスト・TestFlightへ提出し、表示バージョン、新規記録・保存・地図、既存履歴、アクティビティカレンダーの本人限定表示、改訂通知・全文表示・明示的な再同意を確認する。既存の同意情報は一括削除しない。
5. 現在のApp Store 1.0.2の審査・公開状態を再確認し、1.0.3の提出経路を確定する。審査中の旧ビルドを今回の更新版と混同しない。Apple契約は利用者本人が同意済み。
6. ストアの公開条件、プライバシーURL、データセーフティ等の申告、アカウント削除案内、リリースノートを実装と照合する。一般公開前に対象と操作内容を提示する。
7. 承認後、検証した同一成果物を公開し、公開後の保存・共有・失効・再同意を確認する。

文書差し替え・再通知はソースで有効だが、現在配布済みの旧バイナリへはまだ届いていない。本確認ではOTA配信、EAS Submit、ストア操作、Apple契約同意は行っていない。

## 公開文書・更新通知の反映

アプリはPrivacyPolicyScreen.tsxとTermsOfServiceScreen.tsxを参照する。重複v2画面は削除し、公開Webのprivacy/・terms/・account-deletion/を同じ本文から生成した。GitHub Pagesはmainの/docsを配信する。

app-version.jsonのlatestVersion/latestBuildはストアから取得可能な公開版の案内なので、未公開1.0.3へ先行して切り替えない。配布予定はpendingReleaseにAndroid1.0.3（24）・iOS1.0.3（9）を記録し、公開後にプラットフォーム別にlatestへ切り替える。minimumSupportedBuildはAndroid19・iOS3を維持し、旧版に不意の強制更新を要求しない。

ローカル検証：関連16テストPASS、フロント・バックエンド型チェック、公開文書全文の一致、iOS隔離再生成・pod install・最低OS設定・署名Team・Bundle ID・位置情報・地図・runtime1.0.3の照合。production JSはAndroid/iOSそれぞれ書き出す（Web版は今回の対象外）。保存API・共有バックエンドの追加デプロイは行わない。

2026-10-19ローカル検証結果：公開文書・再同意・削除の16件PASS。production JS書き出しはAndroid/iOSとも成功。隔離prebuildとpod installが成功し、署名・識別子・runtime1.0.3・最低iOS15.1・地図・バックグラウンド位置情報とPods306設定が一致した。EAS送信対象から生成ネイティブ、docs、tests、ローカル環境・認証テスト出力・エディタ設定・旧サンプルルートを除外した。

## ビルド受付・公開Web反映の記録

ソースコミット2bf6e3fをorigin/mainへpush後、productionを各OS1回のみ起動した（追加APKなし）。

| OS | バージョン | EASビルドID |
|---|---|---|
| Android | 1.0.3（24） | 1fd14aab-eb52-4f11-a5e8-120ee81779a8 |
| iOS | 1.0.3（9） | a4367138-5404-475e-98a1-0bbd111329b9 |

GitHub Pagesのmain/docsデプロイが2bf6e3fで成功し、privacy/index.html、terms/index.html、account-deletion/index.html、app-version.jsonのHTTP取得内容がローカルのコミット内容と完全一致した。公開最新版通知の切替は各ストアで実際に取得可能になってから行う。

Apple側は1.0.2（8）がWaiting for Review、手動公開設定。旧版の審査取り下げ・一般公開はこの時点では行っていない。新IPA完成後にTestFlight確認を進め、審査提出前に1.0.2の扱いを確定する。
