# ⑨-2 productionビルドと実機確認（進行中）

## 版番号訂正と再ビルド

1.0.2（8）のiOSビルドFINISHEDを確認し、submission 028e1cfb-00ac-4c39-bc6b-28008e760649として再提出受付済み。TestFlight側の処理完了は別途確認する。Android1.0.2（23）はビルド中。

### Android 1.0.1（22）の実記録結果

利用者が屋外移動し、通常画面で停止・Phase9AndroidTestの名前保存・保存完了を確認。セッションsession-1792298880948-jezmxh12、A所有、共有先なし。22ログ（F21/B1）、98.719854m、13:48〜13:51 JST、表示時間00:03:48。

履歴一覧・詳細・保存後のPolyline、カレンダー10/18から同じ地図への遷移を確認。索引22件・pointCount22・全ログの所有者と共有先なしが一致。月5期間・週18期間・プロフィール累計・利用件数の集計照合成功。release APKはrun-asでSQLiteを直接読めないため、保存後の端末キュー0を直接確認したとは扱わない。1.0.2（23）更新後のスモークとiOS TestFlight版の検証は引き続き残る。

Expo画面の提出ログでAppleエラー90062・90186を確認。CFBundleShortVersionString=1.0.1は承認済み1.0.1より大きくなく、1.0.1のPre-Release Trainは閉鎖済みだった。初回ビルド前の公開済み表示バージョン照合が不足していた。バージョンを両OSとも1.0.2へ訂正し、以下を再受付。

| 対象 | バージョン | 内部番号 | ビルドID |
|---|---|---|---|
| Android production AAB | 1.0.2 | 23 | 6660b0db-c515-4b23-b645-a24ddbe267d9 |
| iOS production IPA | 1.0.2 | 8 | 15690fc9-4498-4e1a-9fef-b9215c29eb3c |
| Android検証APK | 1.0.2 | 23 | fd050169-829e-4280-901f-db3ef82ab22b |

アプリ表示版とappVersion方式のruntimeが1.0.2になる。保存ロジック・API・AWSバックエンドは変更しない。iOS完成後にTestFlightへ再提出する。Androidの導入済み1.0.1（22）では、位置情報を利用者が常に許可・正確へ変更し、10秒・10m、現在地共有なしで実記録を開始、時間増加を確認。移動完了待ち。23への更新後も起動・設定・保存のスモーク確認が必要。

## ビルド結果と導入状況

更新：Android開発版の入れ替えを利用者が許可。未送信0とSQLite61行の新しいバックアップを確認後、開発版アンインストール・配布APK導入成功。端末でもversionName1.0.1/versionCode22を確認し、Aログイン済み。初期化後の位置情報権限が未設定のため、利用者へ「常に許可・正確な位置情報」を依頼中。残留Background現在地共有は通常停止操作で解除済み。実記録はまだ始めていない。

iOS submission ad89811a-8595-477b-b583-ee24141f17e8はERROREDで終了。CLIにはエラー詳細・ログURLが返らず、Expoの提出画面へのログインを利用者へ依頼。ASC読み取りでは公開済み1.0.1（6）、TestFlightも6までで7は未登録。したがってTestFlightへのアップロード成功とは扱わない。原因を確定してから再送する。

3件ともEAS FINISHED。Android AAB/APKとも1.0.1（22）、iOS IPAは1.0.1（7）。Android検証APKのpackage/versionを実ファイルでも確認。

iOSは利用者許可により、既存ASC App ID6818737493へEAS Submit受付済み。submission ad89811a-8595-477b-b583-ee24141f17e8。内部TestFlight用で、一般公開・App Store審査は行っていない。初回のwhat-to-test指定はEASプラン制限で受付されず、当該オプションを外して正常受付された。

Androidはadb install -rがINSTALL_FAILED_UPDATE_INCOMPATIBLE。開発署名と配布署名が異なるためで、上書きは実行されていない。端末の記録停止・未送信0・元SQLite61行のバックアップを再確認し、アンインストール／配布版への入れ替えについて利用者回答待ち。

開始：2026-10-18。バックエンドは既存出荷版と共通で、今回のビルド操作ではデプロイしない。

## ビルド受付済み

| 対象 | バージョン | 内部番号 | 形式・用途 | ビルドID |
|---|---|---|---|---|
| Android production | 1.0.1 | 22 | AAB、ストア用 | 48be0cb9-b7e5-44b6-a5cf-2c964322d3c6 |
| iOS production | 1.0.1 | 7 | ストア用IPA、TestFlight確認 | f55b92fa-7a78-463f-b6c7-eef003b8b3b9 |
| Android production-device-android | 1.0.1 | 22 | APK、直接導入用 | a0d27441-a186-4357-919c-5c74cd7c6927 |

実行コマンド：

```bash
eas build --platform all --profile production --non-interactive --no-wait --json
eas build --platform android --profile production-device-android --non-interactive --no-wait --json
```

リモートの21/6をproductionのautoIncrementで22/7へ更新済み。検証APKはproductionを継承し、内部配布APK・autoIncrement=falseのみ上書き。同じコード・production環境・channel・署名を使うが、ストア提出AABそのもののインストール試験ではない。

ビルド時のGit基点はf302132、⑨-1の未コミットConfig Plugin／署名設定もアップロードに含む。ビルド記録のコミットSHAだけでアップロード内容がコミット済みと誤認しない。SDK／アプリ版は変えていない。

利用者から、iOSはTestFlight内部テストへのアップロードを許可。一般公開・App Store審査への提出は行わない。

## 実機確認手順

1. ビルド結果と実際の版番号、署名を確認する。Androidの導入前に記録停止・SQLiteバックアップ・未送信0を確認し、データ削除を伴う場合は先に案内する。
2. Androidの検証APKを導入。起動、ログイン、開発用ボタン非表示、production課金設定の読み込みを確認。課金購入はしない。
3. ユーザーが安全な屋外で短く移動。時間増加・位置保存・停止・名前保存・履歴とカレンダーからの地図・未送信0・クラウドと索引／集計を確認。
4. iOSのビルド7をTestFlightへアップロード。利用者が導入し、上記の短い実記録と共有管理の表示・解除・再共有を確認。別ユーザー認証で認可を照合する。
5. ビルド前後で旧保存API・新版APIと稼働バックエンドの版を照合。直前のiPhone出荷版実記録を旧版側の基準とし、新版配布ビルドの結果と区別して記録する。

productionビルドの受付・完了、TestFlightアップロード・Apple側処理、実機確認はそれぞれ別の状態。全ての必要項目が済むまで⑨-2を完了としない。

## 最終候補1.0.2の確認（2026-10-18）

2026-10-19追加：Google Play実配布版1.0.2（23）でもAの新規記録Phase9PlayTestを保存、13点・181m・4分46秒。全ログ・索引・集計一致、共有先なし。履歴およびカレンダー10/18の最下段から同記録の地図・Polylineを開けた。Playインストール元とPlay配布署名も実APKで確認済み。Play経由導入未実施という以前の経過記載は解消。

最終再共有確認：Android Aで共有一覧を開き直し、Phase9iPhoneTestが復旧。地図・Polyline・203m・1分34秒を確認。Test3のGrant1件が有効、revokedAt解除済み、RecordingSessionと全17ログの共有先はAのみ。最終監査で共有操作203件COMPLETED、グループ操作24件COMPLETED・1件CANCELLED、未完了・残存ロック・実行参照0。⑨-2の配布候補スモークテスト4/4を完了とする。

検証範囲：Androidはproduction設定を継承する直接配布APK、iOSはproduction IPAのTestFlight。PlayがAABから生成する配布物の導入、一般公開・公開後監視は⑨-3以降。配布版からのSQLite未送信件数の直接確認と、今回の解除時の個別get Unauthorized採取は未実施であり、⑦の直接認可回帰結果と今回の画面再取得・権限投影確認を区別する。今回の実機検証でバックエンド変更・OTA配信は実施していない。

iOS BによるPhase9iPhoneTest共有解除後：利用者が共有0人・B本人の地図維持を確認。Android Aで履歴画面を開き直し、共有一覧はPhase8WalkTestの1件のみとなり、対象が非表示であることを確認。Grant1件はisActive=false・revokedAt設定済み。RecordingSessionと全17ログからAが除去され、索引17件と一致。これは画面再取得とDynamoDB投影の確認であり、個別getへの直接Unauthorized応答を採取した検証とは区別する。

Android最終候補23の屋外追加記録「Phase9UpdateTest」は停止・名前保存成功。20点（F17/B3）、159m、3分8秒、Polyline表示、カレンダー10/18の記録表示を確認。全20ログと索引・pointCount一致、共有先なし、月5期間・週18期間・プロフィール合計・利用回数すべて整合。記録は停止済み。配布版はrun-as不可のため、SQLite未送信件数の直接確認は未実施。残る最終候補の共有解除・再共有確認と区別する。

利用者によるiOS最終候補の新規記録「Phase9iPhoneTest」：保存・経路線・Test3経由のAのみへの共有が成功。Android最終候補のAで共有一覧・17点（F13/B4）・203m・1分34秒の地図とPolylineを確認。DynamoDBのRecordingSessionと索引17件・全17ログで共有先がAのみで一致。Android最終候補の追加記録は10秒・10m・リアルタイム共有なしで開始し、時間増加を確認、利用者の屋外移動待ち。

追加確認：Android APKもFINISHED。aaptで1.0.2／23を確認し、adb install -rでSuccess。A（ひろし）のログインと10秒・10m設定を維持し、自分の履歴213件、Phase9AndroidTestの22点・99mを表示できた。更新後の新規保存試験は別途必要。

旧候補iOS 1.0.1（7）は承認済みバージョンのためAppleに拒否された。最終候補をAndroid 1.0.2（23）、iOS 1.0.2（8）へ変更した。上記のビルド7向け手順は最終候補8へ読み替える。

- Android AAB：6660b0db-c515-4b23-b645-a24ddbe267d9はFINISHED（2026-10-18T05:10:49.951Z）。
- Android直接導入用APK：fd050169-829e-4280-901f-db3ef82ab22bはIN_PROGRESS。端末はAログイン・USB接続、インストール済みは1.0.1（22）。APK完成まで上書き更新は保留。
- iOS 1.0.2（8）：Apple処理VALID、内部テストREADY_FOR_BETA_TESTING。
- 利用者がTestFlightからiOSを更新し、アプリ情報で1.0.2（8）を確認。Bでログインし、既存の履歴・カレンダーから地図を開けることを確認済み。最終候補での新規記録・保存と共有操作の確認は別途必要。
