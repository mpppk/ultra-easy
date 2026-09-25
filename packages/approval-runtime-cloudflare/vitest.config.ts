import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

const migrationsPath = fileURLToPath(new URL("../approval-d1/migrations", import.meta.url));

export default defineConfig({
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
