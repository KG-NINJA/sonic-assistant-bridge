# dot 接続の準備状況

現時点では **dot 未接続**です。公開 Pages の「04」は、ページ内プレビューとローカル模擬受信の操作でした。GitHub Pages には認証サーバーがなく、送信先を選べるようにするだけでは dot へ届けられません。

今回のコードは、非公開の認証済み測定画面から同じオリジンの受信 API へメタデータを渡し、サーバーで MCP Events を扱うための準備です。所有者の承認後、専用の非公開 Site を登録しましたが、まだ未公開です。プラグイン接続・実購読・callback 署名秘密・外部配送は未設定です。公開 Pages と元の SonicForceField は維持します。

## 想定する経路

```text
公開 Pages（プレビュー）
  └─ 承認・配備後に追加する非公開 Site への通常のリンク
      └─ ChatGPT のトップレベル画面でサインイン
          └─ 明示開始したマイク → ブラウザ内解析
              └─ 同じ Site の /api/bridge/events（音声を含まない JSON）
                  └─ 認証・検証・抑制 → 購読 callback へサーバー署名付き配送
                      └─ 実際の会話で受信を確認するまで dot 到達未確認
```

公開 Pages から非公開 Site へのクロスオリジン POST や、ブラウザへの service bypass token 配布は行いません。サインインは通常のトップレベル遷移を使い、戻り先は Site 内の相対パスです。測定も送信も初期無効です。非表示・ページ離脱で停止し、自動再開・バックグラウンド配送はありません。

## 用意したコードの境界

| コード | 役割 |
| --- | --- |
| `src/bridge-ui.js` | 公開画面の未接続理由、非公開画面の明示的な接続確認・送信有効化・送信停止・購読解除。 |
| `bridge/private-handler.js` | HTTPS の固定オリジン、認証された利用者、同一 Origin の POST、8 KiB の非圧縮 JSON を検証する HTTP 境界。 |
| `bridge/d1-store.js` / `migrations/0001_bridge_state.sql` | 暗号化した所有者別の購読・抑制・配送予約を CAS で保存する D1 アダプターと schema-only SQL。実 D1 への適用は未実施。 |
| `bridge/sites-receiver.js` | Sites Dispatch 用の組み立て口。D1 を受け取るが、外部配送処理は組み込まず拒否を維持。 |
| `bridge/service.js` | MCP Events の購読・署名付き challenge・所有者分離・期限・イベント抑制・解除。未設定の本番依存があれば配送を拒否。 |
| `bridge/https-callback.js` | Node 専用の HTTPS 配送。DNS の全応答を検証し、検証済み IPv4 に接続しつつ元ホストの TLS 検証を維持。転送を追跡しない。 |

HTTP 境界の一般形は、サーバー側で認証を検証する関数を受け取ります。認証関数なしでは常に拒否します。Sites 専用の形は Sites Dispatch が検証して渡す `oai-authenticated-user-id` を使います。**これを一般公開の Node サーバーへそのまま接続するとヘッダーを偽造できるため、Sites Dispatch 以外でそのアダプターを使ってはいけません。** Site ID とオリジンは、実際に承認・作成された値をサーバー設定で固定します。

`npm start` は従来のループバック版のままです。新しい HTTP 境界はまだ公開サーバーのルートへ取り付けていません。`pages/` と `dist/` に認証サーバー・Node 配送コードを混ぜていません。非公開画面のマーカーは承認されたホストの HTML にのみ設定するもので、認証を代行するものではありません。

イベントは共通の厳格な形式に限定します。音声、FFT、自由文、ユーザーが指定する宛先は受け付けません。購読は原則として `motion.detected` の実測だけを対象にし、合成イベントは明示した試験用設定で区別します。callback の受理を示す表示は、dot の応答を示す表示ではありません。

## 実接続を止めている条件

1. **承認と登録の状態**：所有者限定の Site・canonical plugin・指定された会話への動きメタデータ通知は承認済みです。専用 Site の登録と所有者限定の確認まで完了し、公開・プラグイン作成・購読は未完了です。料金契約や公開範囲の変更は含みません。別の利用者の構築を承認するものでもありません。
2. **Sites で Events を認識することの確認**：Sites は MCP ツールと自動作成される private plugin を文書化しています。一般の MCP Events は dots に対応しますが、この Site/plugin の Events カタログ発見・購読が動くことはまだ実証していません。
3. **接続時の宛先保護**：公式 MCP Events は、接続のたびの DNS 検証と非公開アドレスへの接続防止を要求します。Sites の Worker は HTTP 接続だけで raw TCP が使えません。Worker の `fetch` と事前 DNS 検査だけでは、検証した IP へ実際に接続することを確認できません。`resolveOverride` は外部の任意 callback 用の IP 固定ではありません。現在の Workers `node:http` は `lookup` / `createConnection` が非対応で、`node:https` も `fetch` のラッパーです。元ホスト名の `servername` / socket 制御を使う Node コードの移植では解決しません。そのため **Sites 上の実送信は無効のまま**です。Node 専用配送コードの合成試験は、この制約を解消した証拠ではありません。
4. **本番の状態管理**：暗号化 D1 アダプター、所有者別の原子的な更新、複数 Worker の配送予約・解除を実装しました。実 SQLite を使った模擬 D1 で、再起動・競合・結果不明・遅延応答を試験済みです。実 D1 バインディング、公式移行と実行時暗号鍵の設定、Worker 上での検証はまだです。解除は新規配送を拒否しますが、開始済み処理が残る間は 202／「停止確認待ち」とします。期限だけで予約を消さず、受理済み callback を取り消せるとも表示しません。[構成・移行・停止の意味](durable-state.ja.md)を参照してください。
5. **配備ツールの利用不能**：この実行環境のインストール済みプラグインキャッシュに Sites の公式 `project-setup.mjs` / `site-workflow.mjs` がありません。親環境で確認された `sites/1.1.2/scripts` もこちらでは ENOENT でした。クラウド参照文書の取得をヘルパーの配置手順として扱いません。既に登録した同じ Site を、公式ヘルパーが存在する環境で再開する必要があります。認証や配備処理の独自代替は行いません。

Worker の候補フラグ `global_fetch_strictly_public` は同一 zone への公開経路を規定しますが、実際の Sites ビルド・ホストでの反映と、MCP の接続時アドレス保護を満たすことは確認できていません。未対応と断定もせず、配送を無効に保ちます。Workers では `redirect: 'manual'` と全 3xx 拒否を使い、`redirect: 'error'` は TypeError になるため使えません。

必要な次の判断は、Sites が提供する適切な送信保護を確認するか、接続時 IP 固定を提供できる別の認証済み受信・配送ホストを選ぶことです。新しいホストや料金、ネットワーク設定を勝手に追加しません。承認だけでは技術的な接続保護の未確認を解消できません。

## 配備・実配送の前に必要な検証

- 実際に返された Site ID・HTTPS URL と private audience を確認し、固定設定へ反映する。
- Site が作成するプラグインを使い、接続済みイベントソースと `events/list` に `sonic.motion` が出ることを確認する。
- 認証済み `events/subscribe` が渡した callback URL と秘密だけを使う。推測した dot URL やブラウザに貼り付けた秘密を使わない。
- サーバー側で宛先保護、署名付き challenge、永続化、所有者確認を完了して初めて購読を有効化する。
- 明示した合成イベントを一件送り、callback 受理だけでなく、対応するイベント ID がこの会話で受信されたことを確認する。通知内容が模擬であると表示する。
- 送信無効化、購読解除、期限切れ、再起動、重複・連発、別所有者の要求、認証失効を確認する。
- 最後にユーザーが明示開始した実測イベントで確認する。物理音響の検知精度は別途未検証とする。

試験で使う固定のサンプル署名データ・メモリー購読・模擬 HTTP 応答は合成データです。実サービスの鍵やアクセス権を作ったものではありません。

参照（2026-11-02 確認）：[OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)、[Cloudflare Request / redirect と resolveOverride](https://developers.cloudflare.com/workers/runtime-apis/request/)、[Workers HTTP](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/)、[Workers HTTPS](https://developers.cloudflare.com/workers/runtime-apis/nodejs/https/)、[global_fetch_strictly_public](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)。Sites の認証・MCP・実行環境の境界は利用可能な Sites スキルの `identity-and-secrets.md`、`site-mcp-server.md`、`SKILL.md` で確認しました。
