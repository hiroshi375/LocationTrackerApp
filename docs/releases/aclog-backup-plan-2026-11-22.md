# AcLog Fit 本番バックアップ計画・反映／復旧手順

状態: 2026-11-22 本番反映済み。変更前12件AVAILABLE、PITR10件35日、日次12件35日、初回12件COMPLETED。隔離復元12件とPITR UserProfile復元が成功。SNS購読確認・TESTメール到達は確認済み。2026-11-23 03:00 JSTの定時12件がすべてCOMPLETED・35日保持であることを照合し、導入完了。

## 対象・構成

- アカウント `005466002626`、リージョン `ap-northeast-1`、AppSync `yafsunxnuzb6hf2em4dxawtjfe`。
- `scripts/backup/production.json` が物理名の正本。重要10テーブルはPITR35日。重要10＋月間/週間集計2＝12テーブルを毎日03:00 Asia/Tokyoに開始、開始猶予60分・完了猶予360分、保持35日。
- 初回は12テーブルすべての手動バックアップを取得する。日次は35世代を目安とし、失敗・遅延により実際の世代数は変動する。
- BackgroundLocationDebugLog、LiveLocation、UserDeviceSessionは対象外。診断の重要証跡は別途必要時に取得済み原本を保持。
- 専用CloudFormationスタック `aclog-production-backup`。既存Amplifyスタックのテーブルを取り込んだり再作成したりしない。PITRは生成した10件の明示的CLI入力で設定する。
- AWS BackupのDynamoDB管理は現状有効。リージョン設定を勝手に変更しない。AWS管理暗号化を利用し、新規のカスタマー管理KMSキーは作らない。
- 作るもの: Vault、Plan、Selection、専用バックアップIAMロール、SNS Topic/Policy、通知先Email購読。IAMは明示12テーブルとそのバックアップだけ。テーブル/行の削除・更新権限なし。バックアップ期限処理用DeleteBackupは許可する。
- メールはAlertEmailパラメータで反映前に決定。FAILED/EXPIRED/復元FAILEDを通知。通知メールのSNS確認リンクは所有者が承認する。通知の実配送は本番反映後の確認項目。
- Vault/Topicはスタック削除時もRetain。Vault Lock・他リージョンコピー・アカウント間コピーは今回含めない。PITRは既存テーブルの削除保護とは別。今回DeletionProtectionは変更しない。
- 同一アカウント・東京だけの保護であり、アカウント侵害や東京リージョン全体の災害対策は別工程。

## 費用見積り（2026-11-22準備時）

東京のAWS Price List API確認: PITR USD 0.228/GB-month、AWS Backup DynamoDB標準Warm USD 0.114/GB-month、Warm復元 USD 0.171/GB。
監査時TableSizeBytes合計: PITR10件63,810,535bytes、日次12件63,847,566bytes。統計は更新遅延のある概算。
小さめに見積もらないよう1GB=10^9bytes、日次を毎回フルサイズ35世代として計算:

- PITR: 0.063810535 × 0.228 = USD 0.01455/月。
- 日次: 0.063847566 × 35 × 0.114 = USD 0.25475/月。
- 保管計: 約USD 0.27/月。仮に1USD=150円なら約40円/月（為替の実勢値ではなく換算仮定）。
- インデックス容量も含め全対象112MBをPITR/日次両方に重ねた保守的な計算では約USD 0.47/月（同じ仮定で約71円）。現状の保管料目安はUSD 0.27〜0.48/月とする。
- PITRと日次の対象が各1GBになれば約USD 4.22/月、10GBなら約USD 42.18/月。
- 保管のみの試算。消費税、為替、SNS、復元後テーブル/インデックス、照合用読み取り、既存手動バックアップ、ログ、増加分は別。既存バックアップは自動削除しない。
- 定常35世代の試算であり請求額保証ではない。開始後のCost Explorer確認を必須とする。

## 反映前の準備（読み取り・ローカル生成のみ）

リポジトリのルートで実行する。OUTはタスク専用の絶対パスにする。

```bash
export OUT=/Users/satouhiroshi/Documents/Codex/2026-10-14/new-chat/outputs/aclog-backup-audit-20261122/prepared
python3 scripts/backup/prepare_backup.py --output "$OUT"
aws sts get-caller-identity
aws cloudformation validate-template --region ap-northeast-1 --template-body "file://$OUT/backup-stack.json"
aws backup describe-region-settings --region ap-northeast-1
```

1. アカウントとproduction.jsonの全12物理名を再照合。各テーブルがACTIVEであることを確認。
2. 通知先メールを所有者が決定。現在のPITR設定・AWS Backupプラン一覧・リージョン設定・実行者を保存。
3. 本番設定の変更前に明示承認を得る。2026-11-22にユーザー承認を受け、以下を実行済み。

## 承認後の本番反映（設定変更あり）

1. production.jsonに列挙した12テーブルについて `aws dynamodb create-backup` を実行し、全件のBackupArnを保存。describe-backupで全件AVAILABLEを確認してから続ける。
2. 生成したpitr-enable-requests.jsonの10入力だけに `aws dynamodb update-continuous-backups --region ap-northeast-1 --cli-input-json ...` を実行する。1テーブルずつ結果を保存し、途中失敗時は停止。全体は単一トランザクションではない。
3. 各テーブルの `describe-continuous-backups` でENABLED、RecoveryPeriodInDays=35、復旧可能な最古/最新時刻を保存。有効化以前に遡って保護できるわけではない。
4. 以下で専用スタックを反映する。AlertEmailは承認された実在の通知先に置き換える。新規IAMロール作成を含む。

```bash
aws cloudformation deploy \
  --region ap-northeast-1 \
  --stack-name aclog-production-backup \
  --template-file "$OUT/backup-stack.json" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides AlertEmail=承認された通知先メール
```

5. STACK CREATE/UPDATE_COMPLETE、Planの時刻/保持35日、Selectionの12ARN、Vault通知をAPIで照合。SNS購読がPendingConfirmationでなくなることを確認。
6. 初回の即時バックアップジョブを専用Vault/Roleで開始し、12件すべてCOMPLETED、RecoveryPointが利用可能であることを確認。start-backup-jobのLifecycleはDeleteAfterDays=35を明示。
7. 最初の日次実行後、12テーブルすべてに直近の完了RecoveryPointがあることを確認する。失敗イベント通知だけでは「ジョブ自体が起動しなかった」事象は検出できないため、当初はこの確認を毎日行う。自動未取得監視は必要に応じ別途追加。
8. 初回復元試験とSNS配送テストまで完了して初めて導入完了とする。CloudFormationの構文検査だけでは実行時IAM/通知到達性を保証しない。
9. Amplifyの本番再デプロイ後もPITRと12物理名が維持されていることを再確認。テーブル置換時はこの正本とSelectionも更新する。

## 障害時の復旧手順

目的: 事故直前の状態を隔離テーブルで検証し、原本・保存状態・索引・共有権限を整合させる。自動で本番に上書きしない。

1. 書き込み、バックアップ対象リソースの利用ジョブ、共有ワーカーを含め影響範囲を確認する。必要なら別承認で書き込みを止める。復旧前の現行データもバックアップする。
2. 事故時刻をUTCで確定。重要10テーブルすべてのEarliestRestorableDateTime/LatestRestorableDateTimeの共通範囲内で事故前の共通時点Tを選ぶ。約5分前までという値は保証値ではなく、各APIの実値を使う。
3. PITRでは次のコマンドを対象ごとに実行。新テーブル名は `aclog-restore-YYYYMMDD-論理名`。対象名とTは復旧計画で確定する。

```bash
aws dynamodb restore-table-to-point-in-time \
  --region ap-northeast-1 \
  --source-table-name 対象の物理テーブル名 \
  --target-table-name aclog-restore-YYYYMMDD-論理名 \
  --restore-date-time 事故直前の共通UTC時刻
```

4. 日次RecoveryPointから戻す場合:
   - `aws backup list-recovery-points-by-backup-vault --backup-vault-name aclog-production-daily` から対象ResourceArn/時刻を選択。
   - `aws backup get-recovery-point-restore-metadata --backup-vault-name aclog-production-daily --recovery-point-arn ...` のRestoreMetadataを保存し、targetTableNameを隔離名に設定。
   - 復元専用IAMロールは通常バックアップロールと分離し、隔離先だけへの権限を復旧時に別承認で用意する。通常バックアップロールには復元権限を与えていない。
   - `aws backup start-restore-job --recovery-point-arn ... --metadata file://restore-metadata.json --iam-role-arn 復元専用ロールARN --resource-type DynamoDB`、describe-restore-jobでCOMPLETEDを確認。
   - 日次バックアップは複数テーブルで同一秒の原子的スナップショットではない。各取得時刻の違いを前提に整合検査・操作再開の要否を判断する。
5. 各隔離テーブルがACTIVEになった後、全行の件数・キー・原本内容のハッシュ、LocationLog/RecordingSession/SessionLogIndexの対応、SAVED/DISCARDED保護、ShareGroup/Member/Grant/操作状態を照合。メタデータのItemCountだけで合格にしない。
6. T以降のアカウント削除・共有解除を照合して再適用する。期限切れのAccountDeletion行がTTLで消えている場合もあるため、バックアップだけを削除履歴の正本としない。削除申請記録・関係者確認・現行データ等で確認不能なら本番復旧を止める。削除済みユーザーや共有権限を復活させない。
7. Cognitoユーザー・S3画像・RevenueCat購入状態は今回のバックアップ外。UserProfileだけから認証ユーザーや購入権限を再作成しない。
8. 復旧後テーブルのTTL/Streams/PITR/IAM/タグ/アラームを再設定する必要がある。復元直後にStreamsワーカーを接続して古い共有操作を自動再実行させない。
9. 合格後に別承認を得て「元テーブルへの限定修復」または「接続先切替」を計画する。AppSync/Lambdaには物理名参照があるため、復元しただけではアプリは切り替わらない。
10. 元テーブル・バックアップ・隔離テーブルは検証完了前に削除しない。復旧所要時間は実測して運用目標を決める。日次のみでは最大約1日以上の欠落余地、PITRでも復旧可能時点と検証時間の制約がある。

## 反映中止・ロールバック

- 反映前なら生成物を破棄するだけでAWS変更なし。
- 反映後に日次を止める場合は新規ジョブだけ停止する計画変更を別承認。既存RecoveryPoint・Vaultは残す。スタック全削除を停止手段にしない。
- PITRは即時無効化しない。無効化や保持短縮は保護範囲を減らすため別承認し、変更前バックアップを取る。
- 失敗時は部分的に有効化済みのテーブルを記録し、再実行で不足だけ補う。既存バックアップや本番テーブルを削除してやり直さない。
- ローカル正本をGitで管理する。2026-11-22にCloudFormation作成・PITR更新・SNS購読要求を実施。設定コード・テスト・本手順書を専用コミットで管理する（IDはGit履歴を参照）。

## 検査コマンド

```bash
PYTHONDONTWRITEBYTECODE=1 python3 tests/test_backup_plan.py -v
```

対象限定、PITR10/日次12、35日、03:00JST、バックアップロールに行変更/テーブル削除権限がないこと、Vault保持、誤設定の拒否を検査する。

## 2026-11-22 本番反映・復元試験の記録

- 証跡: /Users/satouhiroshi/Documents/Codex/2026-10-14/new-chat/outputs/aclog-backup-audit-20261122/ 。deployment-report.json、initial-backup-completed.json、restore-status.json、restore-comparison.jsonを参照。
- スタック: aclog-production-backup / CREATE_COMPLETE。Vault aclog-production-daily。Plan 3277033c-bed3-4393-9e4a-b3417cac84ae。明示12ARNと03:00 JST/35日をAPIで照合。
- 12件を aclog-restore-20261122-* へ隔離復元し、すべてCOMPLETED。PITRは aclog-restore-20261122-pitr-UserProfile へ復元しACTIVE/17件ハッシュ一致。隔離先はアプリに接続していない。
- 初回参照とのハッシュ照合は日次11/12一致。GroupAccessOperationTableは73件中1行のハッシュ差異があったため再取得し、現行本番73件と復元73件の全内容一致を確認（group-access-second-comparison.json）。初回差異の原因は未確定で、原本を変更して合わせる操作は行っていない。
- 通知先 hi64sa10@yahoo.co.jp。2026-11-22にSNS購読確認をAWS側で照合。09:53:18 JSTにTEST通知を送信（MessageId cba1363f-d3cd-5e8e-8ee3-5543ecf33f9a）、ユーザーから本文一致・受信済みの回答を得た。SNSトピック→メールの配送確認は完了。AWS Backupの実際の失敗イベントは意図的に発生させておらず、サービス起点の失敗通知を実配送で確認したものではない。
- 日次の最初の定時実行は次の03:00 JST。今回の即時12件成功と区別し、定時実行の完了12件を後日確認する。
- 復元試験テーブル13件と復元専用IAMロール AcLogFitRestoreValidation20261122 は、2026-11-22に明示承認を受け削除済み。全13件の不存在とロールの不存在、本番15テーブルACTIVE、初回12復元ポイントCOMPLETED、変更前12バックアップAVAILABLEを照合（cleanup-audit.json）。元テーブルの行・アプリ接続先は変更していない。

## 最初の定時実行の確認（2026-11-23）

- 03:00 JSTがスケジュール時刻。開始猶予60分のため開始は03:00〜04:00を想定し、03:00直後に完了していなくても失敗とはしない。完了猶予は実際の開始から360分。04:10頃に12対象のジョブ作成/開始を確認し、最終は10:10頃を目安に再照合する。期限内でも全件完了すれば確認できる。
- AWS Backupの「バックアップジョブ」で、Vault=aclog-production-daily、対象日、CreatedBy.BackupPlanId=3277033c-bed3-4393-9e4a-b3417cac84ae、同プランのRuleIdを照合する。手動で作成した初回12件を定時成功と取り違えない。
- production.jsonの12 ResourceArnそれぞれについてCOMPLETEDを1件以上確認。同一テーブルの重複で12件と数えず、異なる12対象がすべて揃うこと。FAILED/ABORTED/EXPIRED/PARTIALなどがあれば原因を調査し、未取得対象だけ再実行する。ジョブなしも失敗通知とは別に調査する。
- 各RecoveryPointのStatus=COMPLETED、Source ResourceArn、Vault、CreationDate、Lifecycle.DeleteAfterDays=35、CalculatedLifecycle.DeleteAtを照合し、一覧を証跡へ保存する。35世代が初日から存在するわけではない。
- PITR重要10件はENABLED/RecoveryPeriodInDays=35と復旧可能時刻が前進していることを確認。導入前まで35日遡れるという意味ではない。
- VaultのFAILED/EXPIRED/RESTORE_FAILED通知設定、SNS購読確認済みが維持されていることを確認。成功メールが届かないのは正常（失敗のみ通知）。メールが来ないことだけでバックアップ成功と判断しない。
- 定時12件成功まで確認したら導入の最終工程を完了と記録。以後も直近の完了バックアップが各対象にあるか点検し、数日後に費用、約35日後に保持期限による世代削除を確認する。

## 残る整理作業

- 隔離復元13テーブルと試験用IAMロールの後片付けは2026-11-22完了。本番テーブル・RecoveryPoint・変更前バックアップは保持。
- 設定コード・テスト・本手順書は無関係な未コミット変更と分離し、専用ブランチで版管理する。
- 定時確認を実施した事実がない段階で完了扱いにしない。チャットからの自動実行予約は今回作成していない。

## 本番15テーブルの取得時点統計

2026-11-22 10:11 JSTに全15テーブルをConsistentRead/COUNTで全件走査し、全件ACTIVEを確認。複数テーブルの同一瞬間のスナップショットではない。容量はDescribeTableの遅延統計値（TableSizeBytes・各IndexSizeBytes）。詳細は証跡ディレクトリのproduction-table-counts-current.json/.csv。

## 2026-11-23 定時実行の最終確認・導入完了

- 03:00 JST作成の異なる12対象すべてをPlanId 3277033c-bed3-4393-9e4a-b3417cac84ae、RuleId f089aea6-a06d-485e-84a3-84005241142bで照合。手動取得分ではなくDaily0300JSTによる取得と確認。
- 12ジョブすべてCOMPLETED。各RecoveryPointもCOMPLETED、ResourceArn一致、Lifecycle.DeleteAfterDays=35、CalculatedLifecycle.DeleteAt設定済み。
- 完了時刻は03:14:44〜03:24:45 JST。PITR重要10件のENABLED/35日と復旧可能時刻、SNS購読確認済みも再確認。
- 証跡: scheduled-verification-20261123.json（既存証跡ディレクトリ）。全導入工程を完了とする。今後は日次欠落確認、費用確認、保持期限到達後の世代削除確認を通常運用として継続する。
