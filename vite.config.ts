import { defineConfig } from "vite-plus";

// Workspace root: shared tooling config only.
// App/runtime config lives in each package (see apps/web/vite.config.ts).
export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    // TanStack Routerが`vp dev`/`vp test`のたびに独自formatで再生成するため、
    // oxfmtの対象から外して差分が出ないようにする。
    ignorePatterns: ["apps/web/src/routeTree.gen.ts"],
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
});
