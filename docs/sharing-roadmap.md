# AcLog Fit 共有機能：工程と現在地点

更新日：2026-10-19。目標は、共有を許可した相手だけがアクティビティ履歴・地図情報を取得でき、アクティビティカレンダーは本人の記録だけを表示し、旧版・新版の記録保存を維持すること。

全体の分母は9工程。Phase⑦内の8項目は全体工程の分母に加えない。過去の「5/9据え置き」は取り消し、下表の完了根拠で集計する。

| 全体工程 | 内容 | 状態 |
|---|---|---|
| ① | 検証モデルでの認可テスト | 完了 |
| ② | main復帰・実装ブランチの準備 | 完了 |
| ③ | 共有管理Lambdaの基本実装 | 完了 |
| ④ | RecordingSessionの所有者確認 | 完了 |
| ⑤ | HistoricalShareGrantの正本管理 | 完了 |
| ⑥ | 実レコードへの権限反映・認可検証 | 完了 |
| ⑦ | 共有管理・権限失効 | 完了：8/8項目 |
| ⑧ | 実モデルの認可強化 | 完了：⑦と並行して実装・実認証検証済み |
| ⑨ | リリース対象の確定・配布・公開後確認 | 未完了 |

現在は8/9完了（88.9%）。⑦開始時は①〜⑥完了で6/9、⑦完了時は7/9、⑧の先行完了分を含めて8/9と数える。⑨の総合回帰部分は⑦-8で実施済みであり、同じテストを理由なく繰り返さない。

## Phase⑦の完了内容

⑦-1 共有先API、⑦-2 共有管理画面、⑦-3 解除、⑦-4 取得拒否、⑦-5 複数人・複数グループ、⑦-6 脱退・除外・削除、⑦-7 障害復旧・競合、⑦-8 Android/iOS回帰の8項目を完了。詳細はphase7-verification-2026-10-18.md。

## 次に進める工程⑨（2/4）

1. 出荷差分を確定：完了。開発用UIのガード、EAS productionの環境、署名Team、隔離再生成とpod installを確認。詳細はrelease-preflight-2026-10-18.md。
2. リリースビルドを作成：完了。Android 1.0.2（23）の製品版APKとiOS 1.0.2（8）のTestFlightで実記録・保存・履歴・カレンダー・地図を確認。iOSからAへの共有・解除・再共有をAndroid Aの表示とGrant・全17ログで照合。Android AABのPlay経由での導入とPhase9PlayTestの保存・アクティビティカレンダーからの地図表示も完了。詳細はproduction-build-verification.md。
3. 配布・公開：配布先、リリースノート、ストア提出と公開方法を確定し、ユーザー指示の範囲で配布する。
4. 公開後確認：旧版と新版の保存、共有・失効、失敗操作・キュー・ログを確認。異常時の戻し方を用意する。

実データと出荷版が同じSandboxバックエンドを使用しているため、環境名だけで未公開と判断しない。コードpushは端末への配布やバックエンドデプロイではない。

## ローカルiOS設定の再現

ios/はGit管理外。既存のDeployment Target=15.1を維持し、Podsだけの古い最低値をpost_install内、react_native_post_installの後で揃えた。

```ruby
minimum_target = Gem::Version.new(podfile_properties['ios.deploymentTarget'] || '15.1')
installer.pods_project.targets.each do |pod_target|
  pod_target.build_configurations.each do |build_configuration|
    current_target = build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
    if current_target && current_target.match?(/\A\d+(\.\d+)*\z/) && Gem::Version.new(current_target) < minimum_target
      build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = minimum_target.to_s
    end
  end
end
```

初回の手動設定は上記の経過。⑨-1でwithIosPodDeploymentTarget Config Pluginへ永続化し、Teamもapp.jsonへ保存した。現在はprebuildで再現される。隔離再生成・pod install・306設定の確認も成功。手動でPodfileへ重ねて追加する必要はない。

開発用の直接ログ取得テストだけが使うEXPO_PUBLIC_PHASE8_PROBE_LOG_IDは、Git対象外の.env.localに保持する検証用ログID。認証情報ではないが位置情報を含み得るため、値をコミット・報告書へ記載しない。

## 1.0.3の文書改訂配布（2026-10-19）

アカウント削除・改訂文書・再同意は67a55cdで保存済み。オリジナルの画面ファイルを正式な参照先とし、重複したv2画面ファイルを削除。公開Web文書も同じ本文から生成する。Android1.0.3（24）とiOS1.0.3（9）向けにproductionを各1回ビルドする。直接導入用APKプロファイルは削除した。最新の配布状態はrelease-plan-legal-update-2026-10-19.mdを参照。
