# Native受信・シリアライズ間と測位要求の診断（2026-11-01）

## 対象と実施状態
Android「AcLog Fit 検証104」用。ソース追加・関連テスト23件・Expo Locationのrelease Kotlinコンパイル・npm原本へのパッチ再適用dry-runを完了。端末APKの更新、EASビルド、OTA配信は未実施。通常版・比較アプリのインストール済みバイナリと端末データは変更していない。採否・距離計算・キュー状態・DBスキーマを変更しない。

## ファイル
- patches/expo-location+19.0.8.patch: 以下のNative差分を再現可能に保持。
  - records/AcLogNativeLocationEvidence.kt: Location受信時のimmutable JSON写し、receiptId、受信経路、requestId。シリアライズ時の従来フィールドと併記。
  - taskConsumers/LocationTaskConsumer.kt: background-resultとlastLocation fallbackを区別。背景要求のregister/remove呼び出しと非同期成功/失敗。
  - LocationModule.kt: 前面watchのregister/remove/resume呼び出しと非同期結果、watch IDとの関連付け。
- src/services/locationDecisionDiagnosticCore.ts: 新規項目のallowlist、受信時とシリアライズ時の座標/時刻/elapsed一致判定。旧ログの欠落はnull。
- src/services/headlessDiagnosticExportService.ts: 検証104のみaclog-location-requests.jsonlをcompact出力にも追記。
- tests/nativeLocationDecisionEvidence.test.ts: 座標変化検出、旧ログ互換、秘密情報allowlist除外。

## 取得と保持
受信時: 緯度経度・fixTime・elapsed・速度/精度/速度精度と有効フラグ・provider/mock、receiptId、受信時刻、受信経路。従来のシリアライズ時情報と同じ診断行で比較する。受信したLocation自体を書き換えない。毎fixの追加ディスクI/Oは行わず既存の診断archive経路を使用。
要求: processId、sequence、requestId、stage、wall/elapsed、LocationRequest.toStringの1024文字上限。座標や認証情報を要求履歴に含めない。専用単一writerで非同期保存、直近256イベントのみ。ファイル上限512KiB、出力も上限検査。無制限の過去履歴としない。API完了listenerは結果観測のみ、既存の制御フローは変更しない。

## 証拠の限界
- background PendingIntentは再利用される。受信時requestIdはその時点の最新登録IDで、以前の要求から遅着したbroadcastの帰属を保証しない。時系列とremove/register完了を併読する。
- resumeは同じ前面watch IDを使用。processIdを併用しプロセス間のID再利用を区別する。
- 256イベント以前の履歴は切れる。全履歴があると誤認しない。出力ヘッダに明示。
- 診断I/O例外は測位へ伝播させない。missing/read-error/oversizedは出力に明示するが、非同期writerの終了直前のイベントは未永続化の可能性がある。停止後数秒置いて出力する。
- 実機でのフィールド到達・停止イベントの永続化は未確認。コンパイル/JSテストを実機確認完了と扱わない。

## 次の実機確認（ローカル検証版更新後）
1. 記録/共有停止・検証104専用ログインと既存記録の保持を確認。
2. 共有なし30秒/50mで前面30秒→画面ロック90秒→停止・専用名で保存。
3. 停止後5秒以上待ち診断出力。receiptId、受信/serialized一致、登録成功・停止解除成功を確認。
4. 診断の到達と欠落を確認してから長時間条件を決定。新たな110分試験はまだ依頼しない。

## 10432短時間実機結果 2026-11-01 19:52
原本: HeadlessDiagnostic_20261101_195233.txt（Mac/Dropbox原本を変更しない）。212,357 bytes。ユーザー報告「HF104受信対照短時間確認」00:02:55、4m、経路線あり。

- cloud confirmed-created 7地点。175.267秒、アプリ実装で再計算4.054631239m。表示と一致。
- 採否117行、1runtime、sequence欠落0、永続化/読取り/書込み失敗0。メモリーevicted22はarchiveから回収済み。archive全体512ファイル上限到達は明示し、過去記録の全保持と混同しない。
- Native証拠56行中、受信写し54行・37receipt。54行すべて座標/時刻/elapsed一致。unique receiptについて速度/精度/速度精度/有効フラグ/provider/mockも相違0。
- 2行（開始・終了付近のforeground receipt）は写しなし。欠損を一致扱いしない。単発getCurrentPosition系は今回のwatch/background受信フック対象外である可能性があるが、厳密な経路識別は未確認。
- 背景通常結果4receipt、lastLocation代替経路23receipt、前面結果10receipt。複数採否経路への複製行を実受信数と混同しない。
- 要求12イベント。背景要求1件と前面watch2件の登録成功、各解除成功を出力。19:48:44に前面/背景登録、19:51:25に前面watch解除/再登録、19:51:28に前面解除、19:51:32に背景解除。未完了登録/解除は当該出力にない。
- 短時間の追加診断到達は合格。ただし大きな位置飛びは今回再現せず、根本原因の確定ではない。

次の焦点: LocationResultなしのbroadcastがlastLocationへ進む理由と、前面/背景要求の併存・ロック中継続の仕様。まず既存コードを読んでintent生成元/受信actionを特定し、必要なら最小診断を設計する。推測で代替経路を無効化したり採否/距離計算を変更しない。
