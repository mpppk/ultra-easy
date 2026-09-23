# ultra-easy

TanStack StartとCloudflare Workersを使ったアプリケーションです。

## 構成

bun workspaceのmonorepoです。workspace rootには実装を置かず、アプリは`apps/`、ライブラリは`packages/`で管理します。

```text
apps/web/                 TanStack Start + Cloudflare Workers アプリ
packages/approval-core/   承認ワークフローのdomain core (@app/approval-core)
tests/                    milestone横断のacceptance suite
```

## 開発

依存関係をインストールします。

```bash
bun install
```

開発サーバーを起動します。

```bash
bun --bun run dev
```

画面を追加する場合は`apps/web/src/routes`配下へroute fileを作成します。TanStack Routerにより`apps/web/src/routeTree.gen.ts`が更新されます（生成ファイルなので手で整形せず、そのままcommitします）。

本番用buildは次のcommandで実行します。

```bash
bun --bun run build
```

## Web UI components

`apps/web` uses Tailwind CSS v4 and shadcn/ui. Add shared primitives from the
repository root with the shadcn CLI:

```bash
bunx shadcn@latest add button -c apps/web
```

Generated primitives belong in `apps/web/src/components/ui`; feature-specific
components belong in `src/components/<feature>`. Use the `#components`,
`#lib`, and `#hooks` package imports configured in `apps/web/package.json`.
Keep colors on the semantic CSS variables in `src/styles.css` so light and
dark themes stay consistent.

## Cloudflare Workersへのデプロイ

このプロジェクトではCloudflare Vite pluginと`apps/web/wrangler.jsonc`を利用します。

1. Wranglerをインストールする: `npm install -g wrangler`
2. 認証する: `wrangler login`
3. デプロイする: `npx wrangler deploy`

本番用secretは、`.env.example`に記載された各項目について`wrangler secret put MY_VAR`を実行して設定します。secretではない公開設定値は`apps/web/wrangler.jsonc`の`vars`へ設定します。

KV、D1、R2、Durable Object等のbindingも`apps/web/wrangler.jsonc`で管理します。詳細はCloudflare WorkersのWrangler設定ドキュメントを参照してください。
