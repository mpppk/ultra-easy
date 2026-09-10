# ultra-easy

TanStack StartとCloudflare Workersを使ったアプリケーションです。

## 開発

依存関係をインストールします。

```bash
bun install
```

開発サーバーを起動します。

```bash
bun --bun run dev
```

画面を追加する場合は`src/routes`配下へroute fileを作成します。TanStack Routerにより`src/routeTree.gen.ts`が更新されます。

本番用buildは次のcommandで実行します。

```bash
bun --bun run build
```

## Cloudflare Workersへのデプロイ

このプロジェクトではCloudflare Vite pluginと`wrangler.jsonc`を利用します。

1. Wranglerをインストールする: `npm install -g wrangler`
2. 認証する: `wrangler login`
3. デプロイする: `npx wrangler deploy`

本番用secretは、`.env.example`に記載された各項目について`wrangler secret put MY_VAR`を実行して設定します。secretではない公開設定値は`wrangler.jsonc`の`vars`へ設定します。

KV、D1、R2、Durable Object等のbindingも`wrangler.jsonc`で管理します。詳細はCloudflare WorkersのWrangler設定ドキュメントを参照してください。
