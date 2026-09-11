import { defineConfig, lazyPlugins } from "vite-plus";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  // Workspace root is itself the app; keep bare `vp dev`/`vp build` pointed here.
  defaultPackage: ".",
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    // TanStack Routerが`vp dev`/`vp test`のたびに独自formatで再生成するため、
    // oxfmtの対象から外して差分が出ないようにする。
    ignorePatterns: ["src/routeTree.gen.ts"],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    overrides: [
      {
        files: ["packages/approval-core/src/**/*.ts"],
        excludeFiles: [
          "packages/approval-core/src/**/*.test.ts",
          "packages/approval-core/src/**/*.type-test.ts",
        ],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [
                {
                  name: "@standard-schema/spec",
                  allowTypeImports: true,
                  message: "approval-coreでは@standard-schema/specを型としてのみ利用してください。",
                },
              ],
              patterns: [
                {
                  group: ["*", "**/*", "!./**", "!../**", "!@standard-schema/spec"],
                  message:
                    "approval-coreのproduction codeから外部packageへ直接依存しないでください。",
                },
              ],
            },
          ],
        },
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
  resolve: { tsconfigPaths: true },
  plugins: lazyPlugins(() => [
    // Cloudflare Vite plugin is incompatible with Vitest (sets resolve.external in ssr env).
    // Skip it during `vp test` / Vitest runs.
    ...(process.env.VITEST ? [] : [cloudflare({ viteEnvironment: { name: "ssr" } })]),

    tanstackStart(),
    viteReact(),
  ]),
});
