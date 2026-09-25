import { Result } from "@praha/byethrow";
import { assert, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

import { MemoryTelemetrySink, type OrganizationId } from "@app/approval-core";

import { evaluateRecentOrganizationAlerts, readOperatorAlertThresholds } from "./operations.ts";
import {
  analyticsEngineFgaMetrics,
  detectStuckActionRequests,
  fgaAlertMetricsFromEnv,
} from "./operator-signals.ts";
import type { WorkflowBindingControl, WorkflowInstanceStatus } from "./workflow-cancellation.ts";
import { actionWorkflowInstanceId } from "./workflow.ts";

const testEnv = env as typeof env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const org = "organization:signals-runtime" as OrganizationId;
const now = "2026-09-25T01:00:00.000Z";

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM approval_runtime_projections"),
    testEnv.DB.prepare("DELETE FROM action_results"),
    testEnv.DB.prepare("DELETE FROM operator_alert_states"),
  ]);
});

async function projection(actionRequestId: string, status: string, updatedAt: string) {
  await testEnv.DB.prepare(
    `INSERT INTO approval_runtime_projections
       (organization_id, action_request_id, approval_plan_checksum, status, state_json, updated_at)
     VALUES (?, ?, 'sha256:x', ?, '{}', ?)`,
  )
    .bind(org, actionRequestId, status, updatedAt)
    .run();
}

/** instance ID → 状態。未登録のinstanceはget()がrejectする（存在しないWorkflow）。 */
async function fakeWorkflow(
  statuses: Record<string, WorkflowInstanceStatus>,
): Promise<WorkflowBindingControl> {
  const byInstance = new Map<string, WorkflowInstanceStatus>();
  for (const [actionRequestId, status] of Object.entries(statuses)) {
    byInstance.set(
      await actionWorkflowInstanceId({
        organizationId: org,
        actionRequestId: actionRequestId as never,
      }),
      status,
    );
  }
  return {
    async get(id) {
      const status = byInstance.get(id);
      if (!status) return Promise.reject(new Error("instance.not_found"));
      return {
        status: async () => ({ status }),
        terminate: async () => undefined,
      };
    },
  };
}

describe("#109 detectStuckActionRequests", () => {
  it("Workflowが終わっている / 存在しない非終端ActionRequestだけを滞留と判定する", async () => {
    await projection("action:waiting", "pending", "2026-09-25T00:00:00.000Z");
    await projection("action:errored", "pending", "2026-09-25T00:00:00.000Z");
    await projection("action:missing", "approved", "2026-09-25T00:10:00.000Z");
    await projection("action:fresh", "pending", "2026-09-25T00:55:00.000Z");
    const telemetry = new MemoryTelemetrySink();

    const stuck = await detectStuckActionRequests({
      db: testEnv.DB,
      workflow: await fakeWorkflow({
        "action:waiting": "waiting",
        "action:errored": "errored",
        "action:fresh": "errored",
      }),
      organizationId: org,
      now,
      stuckAfterMinutes: 15,
      telemetry,
    });

    assert(Result.isSuccess(stuck));
    expect(stuck.value.map((item) => [String(item.actionRequestId), item.workflowStatus])).toEqual([
      ["action:errored", "errored"],
      ["action:missing", "unavailable"],
    ]);
    expect(
      telemetry.records
        .filter((record) => record.kind === "log" && record.event === "action.stuck")
        .map((record) => record.correlation?.actionRequestId),
    ).toEqual(["action:errored", "action:missing"]);
  });
});

describe("#109 analyticsEngineFgaMetrics", () => {
  it("SQL APIで組織ごとのFGA error率とCheck p95を読む", async () => {
    const queries: string[] = [];
    const source = analyticsEngineFgaMetrics({
      accountId: "account",
      apiToken: "token",
      dataset: "ultra_easy_telemetry_staging",
      fetch: (async (url: string, init: RequestInit) => {
        expect(url).toBe(
          "https://api.cloudflare.com/client/v4/accounts/account/analytics_engine/sql",
        );
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer token");
        const query = init.body as string;
        queries.push(query);
        return Response.json({
          data: query.includes("quantileExactWeighted")
            ? [{ organizationId: String(org), p95: 1250 }]
            : [{ organizationId: String(org), errors: 3, calls: "100" }],
        });
      }) as typeof globalThis.fetch,
    });
    assert(source);
    const loaded = await source.load();
    assert(Result.isSuccess(loaded));
    expect(loaded.value.get(String(org))).toEqual({ errorRate: 0.03, checkP95Ms: 1250 });
    expect(queries.every((query) => query.includes("FROM ultra_easy_telemetry_staging"))).toBe(
      true,
    );
  });

  it("SQL APIの失敗はResultで返し、不正なdataset名・未設定のenvでは作らない", async () => {
    const failing = analyticsEngineFgaMetrics({
      accountId: "account",
      apiToken: "token",
      dataset: "dataset",
      fetch: (async () => new Response("forbidden", { status: 403 })) as typeof globalThis.fetch,
    });
    assert(failing);
    const loaded = await failing.load();
    assert(Result.isFailure(loaded));
    expect(loaded.error.code).toBe("fga_metrics_unavailable");
    expect(
      analyticsEngineFgaMetrics({ accountId: "a", apiToken: "t", dataset: "x; DROP" }),
    ).toBeNull();
    expect(
      fgaAlertMetricsFromEnv({ ANALYTICS_ENGINE_ACCOUNT_ID: "a", TELEMETRY_DATASET: "d" }),
    ).toBeNull();
  });
});

describe("#109 evaluateRecentOrganizationAlerts", () => {
  it("Workflow異常終了・滞留・FGA error率をcronで評価し、runbookへ誘導できる状態にする", async () => {
    await testEnv.DB.prepare(
      `INSERT INTO action_events (organization_id, action_request_id, event_key, event_type, occurred_at, event_json)
       VALUES (?, 'action:errored', ?, 'workflow.failed', ?, '{}')`,
    )
      .bind(org, `workflow-failed:${crypto.randomUUID()}`, "2026-09-25T00:58:00.000Z")
      .run();
    await projection("action:errored", "pending", "2026-09-25T00:00:00.000Z");
    const telemetry = new MemoryTelemetrySink();

    const evaluated = await evaluateRecentOrganizationAlerts({
      db: testEnv.DB,
      thresholds: readOperatorAlertThresholds({}),
      now,
      telemetry,
      workflow: await fakeWorkflow({ "action:errored": "errored" }),
      fgaMetrics: {
        load: async () =>
          Result.succeed(new Map([[String(org), { errorRate: 0.2, checkP95Ms: 200 }]])),
      },
    });

    assert(Result.isSuccess(evaluated));
    const states = evaluated.value.find((entry) => entry.organizationId === org)?.states ?? [];
    const statusOf = (key: string) => states.find((state) => state.key === key)?.status;
    expect(statusOf("workflow_failures")).toBe("firing");
    expect(statusOf("stuck_action_requests")).toBe("firing");
    expect(statusOf("fga_error_rate")).toBe("breaching");
    expect(statusOf("fga_latency_p95")).toBe("ok");
    expect(
      telemetry.records
        .filter((record) => record.kind === "log" && record.event === "alert.firing")
        .map((record) => (record.kind === "log" ? (record.attributes.alertKey ?? "") : ""))
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(["stuck_action_requests", "workflow_failures"]);
  });
});
