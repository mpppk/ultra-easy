import { describe, expect, it } from "vitest";

import type { ActionRequest } from "./index.ts";

describe("ActionRequest", () => {
  it("AC-M0-001 represents actor and delegated authority independently", () => {
    const request = {
      actor: { type: "agent", id: "agent:ticket-assistant" },
      authority: {
        principal: { type: "user", id: "user:alice" },
        delegation: {
          chain: [
            {
              delegator: { type: "user", id: "user:alice" },
              delegatee: { type: "agent", id: "agent:ticket-assistant" },
              grantId: "delegation:alice-to-ticket-assistant",
            },
          ],
        },
      },
      action: {
        type: "ticket.priority.change",
        resource: { type: "ticket", id: "TICKET-123" },
        input: { priority: "critical" },
      },
      origin: {
        type: "mcp",
        caller: { type: "user", id: "user:alice" },
        clientId: "mcp-client:test",
        agentRunId: "run:123",
      },
    } satisfies ActionRequest;

    expect(request.actor).toEqual({
      type: "agent",
      id: "agent:ticket-assistant",
    });
    expect(request.authority.principal).toEqual({
      type: "user",
      id: "user:alice",
    });
    expect(request.authority.delegation.chain).toEqual([
      {
        delegator: { type: "user", id: "user:alice" },
        delegatee: { type: "agent", id: "agent:ticket-assistant" },
        grantId: "delegation:alice-to-ticket-assistant",
      },
    ]);
  });
});
