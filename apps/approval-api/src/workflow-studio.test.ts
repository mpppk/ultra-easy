import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import { HttpTrustedContextError } from "@app/approval-application";
import { brandLiteral } from "@app/approval-core";
import type { CapabilityPolicy } from "@app/workflow-application";
import type { WorkflowPlatform } from "@app/workflow-platform";

import { createProductionWorkflowStudioApi } from "./workflow-studio.ts";

const organizationId = brandLiteral("OrganizationId", "organization:staging");
const principal = { type: "user" as const, id: brandLiteral("UserId", "user:alice") };
const request = (method = "GET") =>
  new Request("https://api.example/v1/admin/workflow/definitions", { method });
const host = {
  env: { DB: {} as D1Database },
  platform: {} as WorkflowPlatform,
  capabilityPolicy: {} as CapabilityPolicy,
  llmModel: "test-model",
};

describe("production Workflow Studio authorization", () => {
  it("rejects unauthenticated callers before accessing FGA or D1", async () => {
    let checks = 0;
    const api = createProductionWorkflowStudioApi({
      ...host,
      organizationId,
      identity: {
        resolve: async () =>
          Result.fail(new HttpTrustedContextError(401, "bearer_token_missing", "Bearer required")),
      },
      access: {
        check: async () => {
          checks += 1;
          return Result.succeed(true);
        },
      },
    });
    const response = await api.fetch(request());
    expect(response.status).toBe(401);
    expect(checks).toBe(0);
  });

  it("rejects a caller from another tenant before accessing FGA or D1", async () => {
    let checks = 0;
    const api = createProductionWorkflowStudioApi({
      ...host,
      organizationId,
      identity: {
        resolve: async () =>
          Result.succeed({
            organizationId: brandLiteral("OrganizationId", "organization:other"),
            principal,
          }),
      },
      access: {
        check: async () => {
          checks += 1;
          return Result.succeed(true);
        },
      },
    });
    const response = await api.fetch(request());
    expect(response.status).toBe(403);
    expect(checks).toBe(0);
  });

  it("requires editor permission for definition writes", async () => {
    const permissions: string[] = [];
    const api = createProductionWorkflowStudioApi({
      ...host,
      organizationId,
      identity: { resolve: async () => Result.succeed({ organizationId, principal }) },
      access: {
        check: async ({ permission }) => {
          permissions.push(permission);
          return Result.succeed(false);
        },
      },
    });
    const response = await api.fetch(request("PUT"));
    expect(response.status).toBe(403);
    expect(permissions).toEqual(["editor"]);
  });
});
