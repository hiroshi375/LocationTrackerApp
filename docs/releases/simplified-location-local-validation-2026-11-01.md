# 検証104だけの測位経路単純化（10433）

## 変更と隔離
本番既定 `src/config/locationValidation.ts` は false。既存の隔離Metro構成だけで true の専用ファイルへ差し替える。JSはAndroidかつ完全一致のincident104 IDも必要。Native側は同IDと明示オプションaclogSimplifiedLocation=trueの両条件を要求する。通常版のインストール済みAPK、OTA、EAS、本番設定は変更しない。

1. `useForegroundLocationRecorder.ts`: 記録中の前面watchを開始/再登録しない。共有用前面watchも記録中は抑止。背景側の最新受信キャッシュを1秒間隔で読み前面の開始位置からの距離表示に利用する（測位要求・保存・inbox ACKは行わない）。受信更新時のみUI診断を記録。
2. `nativeRecordingInboxService.ts`: 検証用設定時だけNative taskへaclogSimplifiedLocationを渡す。
3. `simplifiedLocationValidationCore.ts` / Service: owner/session一致、30秒以内、未来1秒以内、座標範囲を検査。Nativeキャッシュはプロセス内のみ、キューや保存データと独立。
4. expo-location patch: LocationTaskOptionsでフラグを保持。LocationResultなしではavailability-only/unknownを記録して戻り、無条件lastLocationを呼ばない。座標結果の既存受渡し/採否/保存は変更しない。
5. `AcLogSimplifiedLocation.kt`: 背景受信の最新点をscope付きで公開。追加センサー/測位要求/DB変更なし。

開始前の単発の開始位置取得は従来どおり（背景記録要求開始前）。停止時は新規getCurrentPositionを要求せず、同owner/sessionの新鮮な背景キャッシュを最終地点として使用。キャッシュが取れなければ既存catchで最終地点追加をスキップし、停止/flushは続行する。開始/停止境界の保存タイムスタンプが以前と変わり得ることを実機で確認する。採否条件・距離計算を変更したものではない。

## ローカル検査
- TypeScript noEmit合格。
- 変更後の関連回帰18件合格（診断・Native inbox・停止後復旧等）。Native inbox SQLite 3件合格。
- release APK assemble成功。10433、SHA256 bb898c77b82cf87308f65c807a2b44582cde4cbacdf86f76bcc17437a6396b68。
- 隔離Cognito/APIあり・本番Cognito/APIなし、既存検証版と同署名、OTA無効。
- source mapの設定ファイルは専用trueだけ。通常ソースのfalseを維持。
- Native/JS双方の新機能組込みをAPK検査。

## 実機試験（ユーザー操作待ち）
既存地図保持→共有なし30秒/50mで前面30秒→USB接続のままロック90秒→停止「HF104単一路短時間確認」で保存→5秒待ち診断出力。返答待ちで長時間継続しない。

判定: simplified-mode-enabled、背景要求登録1件、前面watch登録0件、UIキャッシュ受信、Native→JS一致、無条件キャッシュ経路なし、停止解除成功、欠落/失敗0、時間/距離一致。背景受信が得られない場合も試験を延長せず停止して調査。

短時間合格を数km異常距離解決と扱わない。その後低速歩行/周回の確認、110分静置で効果を判断する。

要求ログは直近256イベント。availability-onlyログが多い場合は開始イベントが切れる可能性を含めて判定する。既存原本/保存/未送信データを削除しない。

## 10433 短時間実機結果（20:42開始、20:45診断出力）
原本 HeadlessDiagnostic_20261101_204518.txt、169,833 bytes。ユーザー報告00:02:08、7m、経路線あり、既存記録表示OK。

- 今回のprocess/時刻範囲でsimplified-mode-enabledと背景要求register-success 1件。前面watch登録0件。過去10432の要求履歴もファイルに残っているので、現在の要求と混同しない。
- availability-only-no-cache 38件。unknown-intent-no-cacheなし。受信観察のsourceはbackground-resultのみ（42行）、background-last-location-fallback 0行。
- Native受信21receipt/21fix。受信→シリアライズ一致42行、不一致0。写しのない開始時単発位置1行は一致扱いしない。
- UI background cacheの更新6回。UIからの追加保存なし（停止時の最終地点確認は従来のforce-saveと同じ処理）。
- cloud created6件、existing1件。同一点の確認を除いたunique保存点6地点。期間128.775秒、既存distance実装で6.706371957m、表示00:02:08/7mと一致。大きな飛びなし、Native隣接最大約6.970m、最大測位間隔7.923秒。
- 85観察行、1runtime、sequence欠落0、読書き失敗0、archive flush成功。過去archive全体の512上限は到達しているが今回の行欠落はない。
- 背景要求remove成功20:44:29.416を確認。

判定: 2対策が実機で有効化され、前面/ロック/停止/保存の短時間動作は合格。静置7mは残っており静置距離ゼロの対策ではない。数km異常が解消したと断定しない。次は低速歩行と周回で取りこぼしがないことを短時間確認後、同じ条件の110分静置で改善効果を判定する。新たなビルド/配信や既存データの書換えは行わない。
