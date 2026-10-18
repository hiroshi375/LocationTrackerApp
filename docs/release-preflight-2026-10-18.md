# ⑨-1 出荷差分・環境・署名とiOS再生成確認

2026-10-18完了。全体8/9、工程⑨1/4。配布用ネイティブビルド・提出は⑨-2以降。

## 今回の変更

- app.jsonのios.appleTeamIdへ、実機ビルドに使った既存チームLMZX3N39USを保存。
- withIosPodDeploymentTarget Config Pluginを登録。pod installのpost_installでPodsの最低値をアプリの既存最低値15.1まで引き上げる。より高い最低値を持つ依存は下げない。
- scripts/verify-ios-prebuild.cjsで署名・Bundle ID・バージョン・runtime・位置記録・地図・Pod設定を照合。
- 未追跡の無関係なローカル画像を.easignoreへ明示し、EASアップロードから除外。画像自体は変更・削除しない。
- アプリの画面・記録処理、GraphQLモデル・Resolver・Lambda・既存端末のネイティブプロジェクトは変更しない。

## 再生成確認

既存ios/を削除せず、作業用の隔離コピーで次を実行。

```bash
npx expo prebuild --platform ios --no-install
# 同じコマンドを再度実行し、生成ブロックの重複がないことも確認
cd ios
pod install --no-repo-update
```

再生成したiosディレクトリに対して、元リポジトリから検証する。

```bash
node scripts/verify-ios-prebuild.cjs /absolute/path/to/regenerated/ios
```

結果：Team一致、Bundle ID維持、最低iOS15.1、Pods306設定すべて最低値以上、生成ブロック1件。fetch/location両モード・位置許可文言・Google Maps初期化・Pod登録・Expo Updates接続先を維持。PodfileのRuby構文検査成功。

既存ローカルiOSはバージョン/runtime 1.0.0だが、追跡中のExpo設定は以前から1.0.1。再生成後は1.0.1で一致する。ストア配布／OTA更新を実施したという意味ではない。現在の端末用ios/はそのまま保持しており、配布ビルドは再生成した設定から作る。

## 環境・署名

- アプリ識別子はAndroid/iOSともcom.hiroshisato.locationtrackerappで維持。
- productionはEAS環境production・channel production、AndroidはAAB、autoIncrement=true、appVersionSource=remote。
- EASの読み取り時点でAndroid versionCode21、iOS buildNumber6。次ビルドはEASの自動増分に従い、手元で予約・変更していない。
- EAS productionにRevenueCatのAndroid本番キー・iOS本番キー・有効化設定があること、キー種別goog_/appl_を確認。値は記録しない。開発用テストキーと本番キーの分岐は既存実装どおり。
- amplify_outputs.jsonを追跡しアプリへ同梱、.easignoreは.env系を除外。接続先は既存の出荷版も使用する共有Sandbox。環境名だけでデータが隔離されているとは扱わない。
- 開発用Probeは__DEV__ガードで配布版には表示されない。環境変数の検証用ログID・ローカルバックアップはコミットしない。

## 保存互換性の確認範囲

旧版createLocationLogと新版ingestLocationLogのAppSync Resolverの存在を確認。旧createRecordingSessionの互換経路もソースで維持。今回の差分に保存API・バックエンド・クライアント保存処理の変更はない。

稼働Lambda SHAはay5o2aqr+dSANy6HWJWsnLl9xRgfv9Sn2hnSI44rRdg=で前回と一致。再デプロイなし。

フロント／バックエンド型チェック、git diff --check、group-access19件とshare-recovery4件が成功。旧版の生成create互換・新版取り込み・遅延キューの権限再付与禁止を含む。

前工程でのAndroid新版とiPhone出荷版の実記録成功は継続して有効。ただし今回再生成したネイティブアプリの新たな実機保存を実施したとは扱わない。これは⑨-2で配布用ビルドを用いて確認する。

## 次に必要な実機操作（⑨-2）

今は追加操作不要。配布用ビルドの作成・導入後、停止状態・未送信0を確認してから短い実記録で時間増加、停止・名前保存、履歴／カレンダーから地図、共有解除と取得拒否を確認する。アプリを先にアンインストールしない。署名・Provisioning Profileはビルド時に最終確認する。
