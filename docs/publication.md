# 公開と検証

Sonic Assistant Bridge は [KG-NINJA/sonic-assistant-bridge](https://github.com/KG-NINJA/sonic-assistant-bridge) から配信します。元の SonicForceField リポジトリと `/SonicForceField/` サイトは変更しません。

- 英語：`https://kg-ninja.github.io/sonic-assistant-bridge/`
- 日本語：`https://kg-ninja.github.io/sonic-assistant-bridge/ja/`
- ワークフロー：[Verify and deploy Pages](https://github.com/KG-NINJA/sonic-assistant-bridge/actions/workflows/pages.yml)

新規リポジトリは README の初期コミット `57219e0420e849d183b840489e6f56cd6e7a6663` から始まります。実装はその子孫として反映し、履歴を上書きしません。所有者が Pages の Source を **GitHub Actions** に設定し、標準ドメインの HTTPS 設定を確認しています。

## 配置する内容

`npm run build:pages` の `pages/` だけをアップロードします。HTML/CSS/ブラウザー JavaScript、Three.js、本体と依存ライブラリーのライセンスを含みます。相対パスは `/sonic-assistant-bridge/` と日本語の `/ja/` に対応します。

Node 受信サーバー、MCP バックエンド、購読、秘密、ログは配置しません。Pages 上ではローカル模擬配送を利用できず、外部イベント送信も実装していません。サイトを開くだけではマイクを取得しません。合成デモと、明示的な開始・ブラウザー許可に基づくマイク測定を区別して表示します。停止・非表示・ページ離脱で音声資源を解放し、自動再開しません。

## リリース手順

1. 作業ブランチと PR で変更し、元リポジトリへの書き込みを避けます。
2. `npm ci`、`npm test`、lint、typecheck、構文検査、ローカル／Pages ビルドを実行します。ブラウザー試験は合成デモと偽マイクを使い、物理音響とは区別します。
3. 最新 PR head の必要チェック・レビュー・保護設定を満たしてからマージします。PR イベントでは build のみ実行します。
4. `main` push または手動実行で `pages/` を配置します。実際の新コミットに対応する build と deploy の成功を確認します。
5. 英日ページとそのアセットを HTTPS で取得し、相対パス、ライセンス、合成デモ、明示的なマイク開始停止を確認します。偽マイクの試験は実機性能を証明しません。
6. リポジトリ・コミット・CI/deploy のリンク、実際に確認した範囲、未検証項目を記録します。ローカル成功、CI 成功、配信成功は別々に扱います。

この経路は新しいアカウント、トークン、権限の拡張、課金、独自ドメインを必要としません。既存の権限で実行できない操作は、その対象と原因を確認して停止します。[GitHub Pages の公式手順](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)に従います。

## ライセンスと制限

所有者が権利を持つ元コードと追加コードは [MIT](../LICENSE) です。Three.js 0.186.0 の原文 MIT と著作権表示は、英日両方の `vendor/LICENSE` に変更せず同梱します。[第三者の表示](../THIRD_PARTY_NOTICES.md)も参照してください。

静止した人の在席、人物分類、距離、検知範囲、成功率、音圧安全性、実際の dot 接続は検証していません。生音声は端末内だけで処理します。実測にはユーザー自身の機器での確認が必要です。[ローカル試験の記録](validation.md)は公開後の読み戻し確認と区別しています。
