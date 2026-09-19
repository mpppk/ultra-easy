import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import type {
  Action,
  ActionRequestId,
  ActionType,
  OrganizationId,
  ResourceId,
  ResourceType,
  UserId,
} from "@app/approval-core";
import type {
  ActionRequestApplicationService,
  ActionRequestView,
  ApprovalReadRepository,
  TrustedActionRequestContext,
} from "@app/approval-application";

import {
  ApprovalMcpAdapter,
  InMemoryMcpTaskProjectionRepository,
  MCP_MISSING_REQUIRED_CLIENT_CAPABILITY,
  MCP_TASKS_EXTENSION,
} from "./index.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("org:mcp");
const actionRequestId = branded<ActionRequestId>("action-request:mcp");
const alice = branded<UserId>("user:alice");
const action: Action = {
  type: branded<ActionType>("ticket.priority.change"),
  resource: {
    type: branded<ResourceType>("ticket"),
    id: branded<ResourceId>("TICKET-1"),
  },
  input: { priority: "critical" },
};
const trustedContext: TrustedActionRequestContext = {
  actor: { type: "user", id: alice },
  authority: { principal: { type: "user", id: alice } },
  origin: { type: "mcp", caller: { type: "user", id: alice } },
  organization: { id: organizationId },
  now: "2026-09-19T00:00:00.000Z",
};

function view(status: ActionRequestView["status"]): ActionRequestView {
  return {
    id: String(actionRequestId),
    organizationId: String(organizationId),
    actor: trustedContext.actor,
    authorityPrincipal: trustedContext.authority.principal,
    caller: trustedContext.origin.caller,
    action,
    origin: "mcp",
    status,
    approval: { required: status === "pending_approval" },
    checksums: {
      actionFingerprint: "sha256:action",
      evaluationSnapshotChecksum: "sha256:snapshot",
      approvalPlanChecksum: "sha256:plan",
    },
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  };
}

function accepted(status: ActionRequestView["status"]) {
  return {
    type: "accepted" as const,
    actionRequestId,
    request: {
      actor: trustedContext.actor,
      authority: trustedContext.authority,
      origin: trustedContext.origin,
      action,
    },
    plan: {} as never,
    view: view(status),
  };
}

function harness(status: ActionRequestView["status"] = "executed") {
  const submissions: Array<Parameters<ActionRequestApplicationService["submit"]>[0]> = [];
  const mappings: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  let currentView = view(status);

  const applicationService: Pick<ActionRequestApplicationService, "submit"> = {
    submit(input) {
      submissions.push(input);
      return Promise.resolve(Result.succeed(accepted(currentView.status)));
    },
  };
  const actionRequestReader: Pick<ApprovalReadRepository, "getActionRequest"> = {
    getActionRequest() {
      return Promise.resolve(Result.succeed(currentView));
    },
  };
  const taskRepository = new InMemoryMcpTaskProjectionRepository();
  const adapter = new ApprovalMcpAdapter({
    applicationService,
    actionMapper: {
      map(input) {
        mappings.push(input);
        return Promise.resolve(
          Result.succeed({
            ...action,
            input: input.arguments ?? {},
          }),
        );
      },
    },
    trustedContextProvider: {
      resolve() {
        return Promise.resolve(Result.succeed(trustedContext));
      },
    },
    taskRepository,
    actionRequestReader,
    taskIdGenerator: { next: () => "task:mcp:1" },
    clock: { now: () => "2026-09-19T00:00:01.000Z" },
    pollIntervalMs: 5000,
  });

  return {
    adapter,
    submissions,
    mappings,
    setView(next: ActionRequestView) {
      currentView = next;
    },
  };
}

const taskExtensions = { [MCP_TASKS_EXTENSION]: {} };

describe("M6-4 MCP adapter", () => {
  it("AC-M6-007: tools/callをActionRequestへ正規化しtrusted identityをargumentsから受け取らない", async () => {
    const value = harness("executed");

    const result = await value.adapter.callTool({
      organizationId,
      toolCall: {
        name: "ticket_set_priority",
        arguments: {
          priority: "critical",
          actor: { type: "service", id: "spoofed" },
          authority: { principal: { type: "service", id: "spoofed" } },
        },
      },
    });

    expect(result.type).toBe("result");
    if (result.type !== "result") return;
    expect(result.result.resultType).toBe("complete");
    expect(value.mappings).toHaveLength(1);
    expect(value.submissions).toHaveLength(1);
    expect(value.submissions[0]?.trustedContext.actor).toEqual(trustedContext.actor);
    expect(value.submissions[0]?.trustedContext.authority).toEqual(trustedContext.authority);
    expect(value.submissions[0]?.action.input).toMatchObject({ priority: "critical" });
  });

  it("AC-M6-008: pending_approvalをTasks対応clientへdurable MCP Taskとして投影する", async () => {
    const value = harness("pending_approval");

    const created = await value.adapter.callTool({
      organizationId,
      toolCall: { name: "ticket_set_priority", arguments: { priority: "critical" } },
      extensions: taskExtensions,
    });

    expect(created).toEqual({
      type: "result",
      result: {
        resultType: "task",
        taskId: "task:mcp:1",
        status: "working",
        statusMessage: "ActionRequest is waiting for approval",
        createdAt: "2026-09-19T00:00:01.000Z",
        lastUpdatedAt: "2026-09-19T00:00:01.000Z",
        ttlMs: null,
        pollIntervalMs: 5000,
      },
    });

    const polled = await value.adapter.getTask({
      taskId: "task:mcp:1",
      extensions: taskExtensions,
    });
    expect(polled.type).toBe("result");
    if (polled.type !== "result") return;
    expect(polled.result.status).toBe("working");

    value.setView({
      ...view("executed"),
      updatedAt: "2026-09-19T00:05:00.000Z",
    });
    const completed = await value.adapter.getTask({
      taskId: "task:mcp:1",
      extensions: taskExtensions,
    });
    expect(completed.type).toBe("result");
    if (completed.type !== "result") return;
    expect(completed.result.status).toBe("completed");
    expect(completed.result.result?.isError).not.toBe(true);
  });

  it("AC-M6-009: Tasks非対応clientではpending approvalをsilent hang/bypassせず-32021で返す", async () => {
    const value = harness("pending_approval");

    const result = await value.adapter.callTool({
      organizationId,
      toolCall: { name: "ticket_set_priority", arguments: { priority: "critical" } },
    });

    expect(result).toMatchObject({
      type: "error",
      error: {
        code: MCP_MISSING_REQUIRED_CLIENT_CAPABILITY,
        data: {
          requiredCapabilities: {
            extensions: {
              [MCP_TASKS_EXTENSION]: {},
            },
          },
        },
      },
    });
    expect(value.submissions).toHaveLength(1);
  });

  it("AC-M6-009: tasks/get自体もextension未宣言clientには-32021を返す", async () => {
    const value = harness("pending_approval");

    const result = await value.adapter.getTask({ taskId: "task:mcp:1" });

    expect(result).toMatchObject({
      type: "error",
      error: { code: MCP_MISSING_REQUIRED_CLIENT_CAPABILITY },
    });
  });
});
