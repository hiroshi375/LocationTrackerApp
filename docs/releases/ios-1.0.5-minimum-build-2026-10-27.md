# iOS 1.0.5（12）公開後の最低対応ビルド更新

2026-10-27、所有者の依頼により`docs/app-version.json`のiOS設定を更新。

## 公開確認

- App Store Connect：iOS 1.0.5「Ready for Distribution」、紐付くビルド12、承認後自動公開。
- Apple公開Lookup API（日本）：AcLog Fit／trackId 6818737493、version 1.0.5、minimumOsVersion 15.1。
- 公開APIのcurrentVersionReleaseDate：2026-10-26T15:13:10Z（2026-10-27 00:13:10 JST）。公開APIはビルド番号を返さないため12はConnect画面と組み合わせて確認した。
- 参照：https://itunes.apple.com/lookup?id=6818737493&country=jp ／ https://apps.apple.com/jp/app/id6818737493

## 設定変更

|項目|変更前|変更後|
|---|---|---|
|iOS latestVersion|1.0.1|1.0.5|
|iOS latestBuild|6|12|
|iOS minimumSupportedBuild|3|12|
|iOS pendingRelease|古い1.0.4（10）準備中|削除|

更新案内は修正内容と、記録・共有停止後にApp Storeで更新する手順を表示する。ストアURLは維持。Androidの設定は不変。

## 検査と動作上の範囲

- JSON形式・minimum<=latest・差分形式を確認。iOSビルド3/6/10/11は更新あり／必須、12/13は更新なしとなる境界を確認。
- 現行`appVersionService.checkAppVersion`はnativeBuildVersionとJSONのビルド番号を比較。ホームのフォーカス時に取得する。
- 最低未満では更新カードの「あとで」を表示しない。これはアプリ全体の利用停止・強制更新・プッシュ通知ではない。取得失敗時にアプリ本体を停止しない。
- ビルド番号が取得できない端末は更新必須と判定できない。古いバイナリに遠隔設定取得の仕組みがなければ、このJSON変更だけで案内は追加できない。
- OTA IDの必須指定ではない。管理者画面OTAの配信情報は別の出荷記録を参照。
- 地域・端末側ストアの反映やキャッシュで更新ボタンの反映時刻が異なる可能性がある。更新できない場合に削除・データ消去を案内しない。

今回、追加ビルド・EAS Update・端末データ／バックエンドの変更は行わない。既知のiOS数分遅延・静置異常距離は解決済みへ変更せず、合意どおり後続の再現検証とする。
