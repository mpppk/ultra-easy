import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

const migrationsPath = fileURLToPath(new URL("../approval-d1/migrations", import.meta.url));

export default defineConfig({
  test: {
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
  },
  plugins: [
    cloudflareTest(async () => ({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(migrationsPath),
        },
        serviceBindings: {
          ACTION_AUTHORIZER: async (request: Request) => {
            const body = (await request.json()) as {
              evaluatedAt?: string;
              consistency?: string;
            };
            return Response.json({
              type: "allow",
              evidence: {
                provider: "test-authorizer",
                evaluatedAt: body.evaluatedAt,
                consistency: body.consistency,
              },
            });
          },
        },
      },
    })),
  ],
});
