import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type { ClientId } from "@app/approval-core";

import {
  AllOfMcpToolExposureAuthorizer,
  checkMcpToolExposure,
  McpExposureProviderError,
  StaticMcpToolExposurePolicy,
  type McpToolExposureAuthorizer,
  type McpToolExposureRequest,
} from "./exposure.ts";
import { OpenFgaMcpToolExposureAuthorizer } from "./exposure-openfga.ts";
import {
  agent,
  alice,
  branded,
  clientId,
  closeActionType,
  mallory,
  org,
  otherOrg,
  priorityActionType,
} from "./test-support.ts";

function request(overrides: Partial<McpToolExposureRequest> = {}): McpToolExposureRequest {
  return {
    organizationId: org,
    actor: { type: "agent", id: agent },
    authority: { principal: { type: "user", id: alice } },
    origin: { type: "mcp", clientId },
    actionType: priorityActionType,
    toolName: "ticket_set_priority",
    ...overrides,
  };
}

async function decide(authorizer: McpToolExposureAuthorizer, input = request()) {
  const decided = await checkMcpToolExposure(authorizer, input);
  assert(Result.isSuccess(decided));
  return decided.value.type;
}

describe("MCP Gateway 2: Tool Exposure authorizers", () => {
  it("static policyはorganization / ActionType / authority / actor / clientの全条件一致でallow", async () => {
    const policy = new StaticMcpToolExposurePolicy([
      {
        organizationIds: [org],
        actionTypes: [priorityActionType],
        authorityPrincipals: [{ type: "user", id: alice }],
        actors: [{ type: "agent", id: agent }],
        clientIds: [clientId],
      },
    ]);

    expect(await decide(policy)).toBe("allow");
    expect(await decide(policy, request({ organizationId: otherOrg }))).toBe("deny");
    expect(await decide(policy, request({ actionType: closeActionType }))).toBe("deny");
    expect(
      await decide(policy, request({ authority: { principal: { type: "user", id: mallory } } })),
    ).toBe("deny");
    expect(await decide(policy, request({ origin: { type: "mcp" } }))).toBe("deny");
    expect(
      await decide(
        policy,
        request({ origin: { type: "mcp", clientId: branded<ClientId>("client:other") } }),
      ),
    ).toBe("deny");
  });

  it("ruleが無ければdefault deny、AllOfは1つでもdenyならdeny", async () => {
    const allowAll = new StaticMcpToolExposurePolicy([{}]);
    const denyAll = new StaticMcpToolExposurePolicy([]);

    expect(await decide(denyAll)).toBe("deny");
    expect(await decide(new AllOfMcpToolExposureAuthorizer([allowAll, allowAll]))).toBe("allow");
    expect(await decide(new AllOfMcpToolExposureAuthorizer([allowAll, denyAll]))).toBe("deny");
    expect(await decide(new AllOfMcpToolExposureAuthorizer([]))).toBe("deny");
  });

  it("provider errorはerrorとして返しallowへ倒さない（throwもfail-closed）", async () => {
    const failing: McpToolExposureAuthorizer = {
      check: () =>
        Promise.resolve(Result.fail(new McpExposureProviderError("down", true, "unavailable"))),
    };
    const throwing: McpToolExposureAuthorizer = {
      check: () => Promise.reject(new Error("boom")),
    };

    expect(Result.isFailure(await checkMcpToolExposure(failing, request()))).toBe(true);
    expect(Result.isFailure(await checkMcpToolExposure(throwing, request()))).toBe(true);
    expect(
      Result.isFailure(
        await checkMcpToolExposure(new AllOfMcpToolExposureAuthorizer([failing]), request()),
      ),
    ).toBe(true);
  });

  it("OpenFGA mcp_tool#can_useをauthority principalでcheckする", async () => {
    const checks: unknown[] = [];
    let allowed = true;
    const authorizer = new OpenFgaMcpToolExposureAuthorizer({
      check(input) {
        checks.push(input);
        return Promise.resolve(Result.succeed(allowed));
      },
    });

    expect(await decide(authorizer)).toBe("allow");
    allowed = false;
    expect(await decide(authorizer)).toBe("deny");
    expect(checks[0]).toEqual({
      user: "user:alice",
      relation: "can_use",
      object: "mcp_tool:ticket.priority.change",
      consistency: "minimize_latency",
    });
    expect(
      await decide(authorizer, request({ authority: { principal: { type: "agent", id: agent } } })),
    ).toBe("deny");
  });

  it("OpenFGA provider errorはretriable情報を保ってfail-closed", async () => {
    const authorizer = new OpenFgaMcpToolExposureAuthorizer({
      check: () =>
        Promise.resolve(
          Result.fail({ code: "network_error", retriable: true, message: "unreachable" }),
        ),
    });

    const decided = await checkMcpToolExposure(authorizer, request());

    assert(Result.isFailure(decided));
    expect(decided.error).toMatchObject({ code: "network_error", retriable: true });
  });
});
