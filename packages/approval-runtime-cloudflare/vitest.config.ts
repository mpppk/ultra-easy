import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

const migrationsPath = fileURLToPath(new URL("../approval-d1/migrations", import.meta.url));
const executorAttempts = new Map<string, { count: number; idempotencyKey: string }>();

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
          ACTION_EXECUTOR: async (request: Request) => {
            const body = (await request.json()) as {
              organizationId?: string;
              actionRequestId?: string;
              idempotencyKey?: string;
              action?: { input?: { executorScenario?: string } };
            };
            const actionRequestId = body.actionRequestId ?? "unknown";
            const executionKey = JSON.stringify([
              body.organizationId ?? "unknown",
              actionRequestId,
            ]);
            const idempotencyKey = body.idempotencyKey ?? "";
            const previous = executorAttempts.get(executionKey);
            const attempt = (previous?.count ?? 0) + 1;

            if (previous && previous.idempotencyKey !== idempotencyKey) {
              return Response.json(
                {
                  code: "idempotency_key_changed",
                  retriable: false,
                  detail: "retry間でidempotency keyが変化しました",
                },
                { status: 409 },
              );
            }
            executorAttempts.set(executionKey, { count: attempt, idempotencyKey });

            const scenario = body.action?.input?.executorScenario;
            if (scenario === "retry-once" && attempt === 1) {
              return Response.json(
                {
                  code: "temporary_timeout",
                  retriable: true,
                  detail: "temporary executor failure",
                },
                { status: 503 },
              );
            }
            if (scenario === "non-retriable" && attempt === 1) {
              return Response.json(
                {
                  code: "business_validation_failed",
                  retriable: false,
                  detail: "business validation failed",
                },
                { status: 422 },
              );
            }

            return Response.json({
              status: "succeeded",
              output: { attempt, idempotencyKey },
            });
          },
        },
      },
    })),
  ],
});
