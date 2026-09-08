---
allowed-agents: claude-code
description: Build a CLI + Web UI tool distributed as a single self-contained binary using Bun. Covers project structure, entry point pattern, oRPC API layer, SQLite/Drizzle DB, React+Tailwind frontend, cross-platform build, and GitHub Actions CI/CD.
metadata:
  github-path: bun-cli-webui
  github-ref: refs/heads/main
  github-repo: https://github.com/mpppk/skills
  github-tree-sha: d90a402833761b4a2b8ac909afa64ae3f205585a
name: bun-cli-webui
---

# bun-cli-webui

Skill for building a tool that works both as a CLI and as a local Web UI, compiled into a single binary with Bun. Reference implementation: [mpppk/roadmap-tool](https://github.com/mpppk/roadmap-tool).

## When to use

Use this skill when asked to:

- Create a new CLI tool that also has a local Web UI
- Add a Web UI to an existing Bun CLI
- Set up the build pipeline for a Bun single-binary project
- Configure CI/CD for cross-platform binary releases

## Architecture Overview

```
src/
  binary.ts       ← compiled entrypoint: dispatches to CLI or server
  cli.ts          ← CLI command handler (node:util parseArgs)
  server.ts       ← Bun.serve() with oRPC + SSE + HTML serving
  router.ts       ← oRPC router shared by CLI and server
  frontend.tsx    ← React app entrypoint (referenced in index.html)
  index.html      ← SPA shell (Bun serves .tsx directly)
  index.ts        ← dev-only entrypoint (bun --hot)
  runtime-config.ts ← PORT, base URL helpers
  update.ts       ← self-update from GitHub Releases
  db/
    index.ts      ← SQLite + Drizzle setup, auto-migration
    path.ts       ← XDG-compliant DB path resolution
    schema.ts     ← Drizzle schema
    migrate.ts    ← custom migration runner
build-binary.ts   ← Bun.build({ compile: true })
build.ts          ← browser bundle (dist/)
bunfig.toml       ← static serving config with tailwind plugin
```

## Entry Point Pattern (binary.ts)

```typescript
#!/usr/bin/env bun

const args = process.argv.slice(2);

if (args.length > 0) {
  const { handleCliError, runCli } = await import("./cli");
  await runCli(args, "my-tool").catch(handleCliError);
} else {
  const { startServer } = await import("./server");
  const server = await startServer();
  await openBrowser(server.url.href);
}
```

- Args present → CLI mode (dynamic import keeps server deps out of CLI path)
- No args → start local server, open browser automatically

## Server (server.ts)

Use `Bun.serve()` with route-based handlers:

```typescript
import index from "./index.html"; // Bun imports HTML natively

serve({
  port,
  routes: {
    "/events/data-changes": (req, server) => {
      server.timeout(req, 0);
      return createSSEResponse(req); // SSE for real-time sync
    },
    "/orpc/*": async (req) => {
      const result = await rpcHandler.handle(req, { prefix: "/orpc", context: { db } });
      return result.matched ? result.response : new Response("Not found", { status: 404 });
    },
    "/*": index, // serve React SPA for all other routes
  },
  development: process.env.NODE_ENV !== "production" ? { hmr: true } : false,
});
```

Check port availability before binding — fail fast with a clear error if the port is in use.

## API Layer (oRPC)

Use `@orpc/server` for a type-safe RPC layer shared between server and CLI:

```typescript
// router.ts
import { os } from "@orpc/server";
import * as z from "zod";

type Context = { db: typeof db };
const o = os.$context<Context>();

export const router = {
  items: {
    list: o.handler(async ({ context }) => {
      /* ... */
    }),
    create: o.input(z.object({ name: z.string() })).handler(async ({ input, context }) => {
      /* ... */
    }),
  },
};
```

CLI calls the router directly without HTTP:

```typescript
// cli.ts
import { createRouterClient } from "@orpc/server";
const orpc = createRouterClient(router, { context: { db } });
const items = await orpc.items.list({});
```

Frontend calls via HTTP (`/orpc/*` route).

## CLI (cli.ts)

Use Node's built-in `parseArgs` — no external arg parsing library needed:

```typescript
import { parseArgs } from "node:util";

export async function runCli(argv: string[], commandName: string) {
  const [resource, command, ...args] = argv;

  if (resource === "--version" || resource === "-v") {
    console.log(version);
    return;
  }
  if (!resource || resource === "--help") {
    console.log(helpText);
    return;
  }

  const { values, positionals } = parseArgs({
    args,
    options: { "some-flag": { type: "string" } },
    strict: true,
    allowPositionals: true,
  });
  // dispatch to orpc calls
}

export function handleCliError(err: unknown): never {
  if (err instanceof CliExit) process.exit(err.code);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
```

## Frontend (React + Tailwind)

`index.html` references the `.tsx` directly — Bun handles transpilation:

```html
<script type="module" src="./frontend.tsx" async></script>
```

`frontend.tsx` uses Bun's HMR pattern:

```typescript
// biome-ignore lint/suspicious/noAssignInExpressions: Bun HMR pattern
(import.meta.hot.data.root ??= createRoot(elem)).render(app);
```

Stack: React 19, Tailwind v4 (`bun-plugin-tailwind`), shadcn/ui (Radix UI + CVA).

`bunfig.toml` enables the Tailwind plugin for static serving:

```toml
[serve.static]
plugins = ["bun-plugin-tailwind"]
env = "BUN_PUBLIC_*"
```

## Database (SQLite + Drizzle)

```typescript
// db/index.ts
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

const sqlite = new Database(resolveDbPath());
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");
runMigrations(sqlite); // auto-migrate on startup

export const db = drizzle(sqlite, { schema });
```

DB path resolution follows the XDG Base Directory Specification:

```typescript
// db/path.ts
export function resolveDbPath(): string {
  if (process.env.MY_TOOL_DB) return process.env.MY_TOOL_DB;
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, "my-tool", "db.sqlite");
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.join(home, ".local", "share", "my-tool", "db.sqlite");
}
```

Manage migrations with a custom `__migrations` table instead of drizzle-kit at runtime (drizzle-kit is dev-only for generating SQL files). Embed SQL files with `import sql from "./migration.sql" with { type: "text" }`.

## Build

`build-binary.ts` — produces a self-contained executable:

```typescript
import tailwind from "bun-plugin-tailwind";

const target = (Bun.env.BUN_TARGET ?? "bun") as Parameters<typeof Bun.build>[0]["target"];

await Bun.build({
  entrypoints: ["./src/binary.ts"],
  target,
  compile: { outfile: "./my-tool" },
  plugins: [tailwind],
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
```

Cross-compile by setting `BUN_TARGET` (e.g. `bun-linux-arm64`, `bun-darwin-arm64`, `bun-windows-x64`).

`package.json` scripts:

```json
{
  "scripts": {
    "dev": "portless run bun --hot src/index.ts",
    "build": "bun run build.ts",
    "build:binary": "bun run build-binary.ts",
    "typecheck": "bun install --frozen-lockfile && tsc --noEmit",
    "lint": "biome lint ./src",
    "format": "biome format --write ./src",
    "check": "biome check ./src",
    "test": "bun test"
  }
}
```

## CI/CD

Two workflows:

- **`release.yml`** (manual dispatch): bump version in `package.json`, commit, tag, push branch, open PR
- **`cd.yml`** (triggered on `v*` tag push or called from release): quality checks → cross-platform build matrix → GitHub Release

Build matrix targets: `linux-x64`, `linux-arm64`, `darwin-arm64`, `windows-x64`.

```yaml
# cd.yml build step (per matrix entry)
- name: Build binary
  env:
    BUN_TARGET: ${{ matrix.bun_target }}
  run: bun run build:binary

- name: Package (Unix)
  if: runner.os != 'Windows'
  run: tar czf ${{ matrix.archive }} my-tool
```

Publish a `checksums.txt` (sha256sum) alongside the binaries in the GitHub Release.

## Self-Update (update.ts)

Pattern for `my-tool update` command:

1. Fetch latest release from GitHub API
2. Compare semver against embedded `version` from `package.json`
3. Detect platform/arch → select correct asset name
4. Download archive + `checksums.txt`, verify SHA256 with `Bun.CryptoHasher`
5. Extract to tmp dir, move new binary over `process.execPath`
6. Guard against running from source: `if (execPath.endsWith("/bun")) throw`

## Key Dependencies

| Package                        | Purpose                                    |
| ------------------------------ | ------------------------------------------ |
| `@orpc/server`, `@orpc/client` | Type-safe RPC layer                        |
| `drizzle-orm`, `bun:sqlite`    | SQLite ORM                                 |
| `drizzle-kit` (dev)            | Schema migration file generation           |
| `bun-plugin-tailwind`          | Tailwind CSS in Bun build/serve            |
| `react`, `react-dom`           | Frontend UI                                |
| `zod`                          | Schema validation for oRPC                 |
| `portless`                     | Auto port selection in dev                 |
| `@biomejs/biome` (dev)         | Lint + format (replaces ESLint + Prettier) |
| `sonner`                       | Toast notifications                        |

shadcn/ui component deps: `@radix-ui/*`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`

## Checklist for a New Project

- [ ] `bun init` then configure `tsconfig.json` (target: `ESNext`, moduleResolution: `bundler`)
- [ ] Set `"type": "module"` and `"bin"` in `package.json`
- [ ] Create `bunfig.toml` with tailwind static plugin
- [ ] Implement `binary.ts` → `cli.ts` → `server.ts` → `router.ts` flow
- [ ] Set up `src/db/path.ts` with XDG-compliant path (use tool-specific env var)
- [ ] Write `build-binary.ts` using `Bun.build({ compile: true })`
- [ ] Add `release.yml` + `cd.yml` workflows for cross-platform binary distribution
- [ ] Add `agent-skills` topic to the repo after publishing
