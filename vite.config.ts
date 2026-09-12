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
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "byethrow", specifier: "@praha/byethrow-oxlint" },
      { name: "eslint-js", specifier: "oxlint-plugin-eslint" },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "eslint-js/no-restricted-syntax": [
        "error",
        {
          selector: "ThrowStatement",
          message: "throwは禁止です。失敗は@praha/byethrowのResultで明示的に返してください。",
        },
      ],
      "byethrow/consistent-namespace": "error",
      "byethrow/no-ambiguous-error-type": "error",
      "byethrow/no-ambiguous-success-type": "error",
      "byethrow/no-negated-type-guards": "error",
      "byethrow/no-throw-in-callback": "error",
      "byethrow/no-try-catch-in-callback": "error",
      "byethrow/prefer-result-async": "error",
      "byethrow/prefer-result-maybe-async": "error",
    },
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
                  group: [
                    "*",
                    "**/*",
                    "!./**",
                    "!../**",
                    "!@standard-schema/spec",
                    "!@praha/byethrow",
                    "!@praha/error-factory",
                  ],
                  message:
                    "approval-coreのproduction codeから許可されていない外部packageへ直接依存しないでください。",
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
