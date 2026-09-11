<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# ultra-easy

Cloudflare Workers + TanStack Start (React) project. Package manager is **bun** (not npm). `packageManager` is `bun@1.4.0`.

## Workspace Layout

bun workspace (`workspaces: ["apps/*", "packages/*", "tests"]`), following the layout Vite+ scaffolds in `node_modules/vite-plus/templates/monorepo`. **The workspace root holds no implementation** — apps go in `apps/`, libraries in `packages/`, and the cross-package test suite is its own package in `tests/`.

```text
apps/web/                 @app/web — TanStack Start + Cloudflare Workers app
packages/approval-core/   @app/approval-core — approval workflow domain core
tests/                    @app/tests — milestone-spanning acceptance suite (see docs/implementation-plan.md)
```

- Import across packages by package name (`@app/approval-core`, `@app/approval-core/testing`), never by relative path into `packages/` or `apps/`.
- Root `vite.config.ts` carries shared tooling config only (`fmt`, `lint`, `staged`). App/runtime config belongs in the package — see `apps/web/vite.config.ts`.
- Root `package.json` carries only workspace tooling deps. App deps (react, tanstack, wrangler) belong in `apps/web/package.json`; adding them at the root lets any package import them undeclared via hoisting.
- `vp dev` / `vp build` / `vp preview` / `vp pack` refuse to run at the workspace root. Target a package with `vp -C apps/web <command>`, or use the root delegating scripts (`bun run dev` → `vp run @app/web#dev`).
- `vp check` does run at the root and sweeps every package — that is what CI uses for static checks.
- `vp test` at the root is **not** a workspace sweep: it is a single Vitest run rooted at the workspace root, so it globs every package's test files but applies the root `vite.config.ts` to all of them. Always run tests per package (`bun run test` → `vp run -r test`), so `apps/web` gets its own TanStack Start + React config.
- `vp run -r <script>` runs a script in every package in dependency order; `vp run @app/web#<script>` targets one.

## Commands

- Use `bun` for package operations (`bun install`, `bun add`, `bun run <script>`).
- `vp run <script>` runs `package.json` scripts; `vp check` / `vp test` run the built-ins.
- Validate from the root with `vp check` and `bun run test` (`vp run -r test`, each package runs `vp test` under its own config). Test one package with `vp -C apps/web test`.
- Build everything with `bun run build` (`vp run -r build`); build just the app with `vp -C apps/web build`.
- Dev server: `bun run dev` (`vp run @app/web#dev`, port 3000). Deploy: `bun run deploy` (`vp build && wrangler deploy` inside `apps/web`).

## エラー処理

- `throw`文は禁止する。失敗可能な処理は原則として`@praha/byethrow`の`Result` / `ResultAsync`で表現する。
- Promiseや外部SDKなど例外を投げうる境界は`Result.fn`等で捕捉し、型付きerrorへ変換する。
- `vp check`で`ThrowStatement`を検出し、CIで再発を防止する。

## Notes

- `apps/web/vite.config.ts` applies `@cloudflare/vite-plugin` (ssr environment) + TanStack Start + React. The Cloudflare plugin is skipped when `VITEST=true` because it is incompatible with Vitest (`resolve.external` in ssr env).
- Wrangler config is `apps/web/wrangler.jsonc` (worker name `ultra-easy`, `nodejs_compat`, observability enabled). Cloudflare Workers Builds must have its root directory set to `apps/web`.
- A single root `tsconfig.json` covers every package, so the type-aware lint in `vp check` sees the whole workspace as one TS project.
- CI (`.github/workflows/check.yml`) runs `vp install`, `vp check`, `vp run -r test` with bun.
- Secrets live in the 1Password Environment named `ultra-easy` (`GYAZO_API_TOKEN`, `CLOUDFLARE_API_TOKEN`). Do not commit plaintext secrets.
- `apps/web/src/routeTree.gen.ts` is generated by TanStack Router (regenerated on every `vp dev` / `vp build` / `vp test`) and is excluded from oxfmt via `fmt.ignorePatterns` in the root `vite.config.ts`. Commit it exactly as the generator emits it (single quotes, no semicolons) — do not hand-format it, or every run will dirty the working tree. Regenerate with `vp run @app/web#generate-routes`.
- Project skills are installed at project scope in `.agents/skills` (mpppk/skills, helpfeel/cosense-cli, mattpocock/skills grilling + domain-modeling).
