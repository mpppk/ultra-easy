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
    ignorePatterns: ["apps/web/src/routeTree.gen.ts", "apps/knowledge/src/routeTree.gen.ts"],
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
        {
          selector: "CallExpression[callee.name=/^decodeURI(Component)?$/]",
          message:
            "decodeURIComponentはURIErrorを投げます。@app/approval-coreのdecodeUriComponent（Result）を使ってください。",
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
        // #102: branded typeへの`as`は検証を素通りさせる。brand.ts（smart constructor）とtest以外で禁止する。
        files: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts"],
        excludeFiles: [
          "**/*.test.ts",
          "**/*.test.tsx",
          "**/*.type-test.ts",
          "**/testing/**",
          "**/test-support.ts",
          "packages/approval-core/src/domain/brand.ts",
          "packages/approval-core/src/uri.ts",
          "apps/web/src/routeTree.gen.ts",
          "apps/knowledge/src/routeTree.gen.ts",
        ],
        rules: {
          "eslint-js/no-restricted-syntax": [
            "error",
            {
              selector: "ThrowStatement",
              message: "throwは禁止です。失敗は@praha/byethrowのResultで明示的に返してください。",
            },
            {
              selector: "CallExpression[callee.name=/^decodeURI(Component)?$/]",
              message:
                "decodeURIComponentはURIErrorを投げます。@app/approval-coreのdecodeUriComponent（Result）を使ってください。",
            },
            {
              selector:
                "TSAsExpression > TSTypeReference.typeAnnotation[typeName.name=/^(UserId|AgentId|ServiceId|PrincipalId|ActionRequestId|ActionType|ActionDefinitionKey|ExecutorKey|ResourceType|ResourceId|OrganizationId|DelegationGrantId|ClientId|AgentRunId|ApprovalPolicyKey|ApprovalPolicyBindingId|ApprovalRuleKey|ApprovalStepKey|ApprovalTaskId|MaterializedStepId|SnapshotApproverCohortId|Sha256Digest|ActionFingerprint|EvaluationSnapshotChecksum|ApprovalPlanChecksum|ApprovalBindingFingerprint|SchemaKey|RelationName|AuthorizationObjectType|AuthorizationObjectRef)$/]",
              message:
                "branded typeへのasは禁止です。parseBrand / brandLiteral等のsmart constructor（domain/brand.ts）を使ってください。",
            },
          ],
        },
      },
      {
        // #110: production codeのlogはTelemetrySink（JSON契約）へ統一する。consoleへの出口は
        // ConsoleTelemetrySinkだけ（inlineでdisable）。test / testing / 運用scriptは対象外。
        files: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts"],
        excludeFiles: [
          "**/*.test.ts",
          "**/*.test.tsx",
          "**/*.type-test.ts",
          "**/testing/**",
          "**/test-support.ts",
        ],
        rules: {
          "no-console": "error",
        },
      },
      {
        // 例外を投げるdecodeURIComponentをResultで包む唯一の場所。
        files: ["packages/approval-core/src/uri.ts"],
        rules: {
          "eslint-js/no-restricted-syntax": [
            "error",
            {
              selector: "ThrowStatement",
              message: "throwは禁止です。失敗は@praha/byethrowのResultで明示的に返してください。",
            },
          ],
        },
      },
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
                    "!@app/expression-core",
                  ],
                  message:
                    "approval-coreのproduction codeから許可されていない外部packageへ直接依存しないでください。",
                },
              ],
            },
          ],
        },
      },
      {
        // #155: 共有Expression Engineはpure / deterministic。外部I/Oを行うpackageへ依存させない。
        files: ["packages/expression-core/src/**/*.ts"],
        excludeFiles: ["packages/expression-core/src/**/*.test.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["*", "**/*", "!./**", "!@praha/byethrow", "!@praha/error-factory"],
                  message:
                    "expression-coreはpureな評価器です。@praha以外の外部package（I/Oを含む）へ依存しないでください。",
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
