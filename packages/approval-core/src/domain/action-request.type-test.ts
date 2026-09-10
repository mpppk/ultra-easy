import type { ActionRequest } from "./index.ts";

// AC-M0-001
//
// これはruntimeの振る舞いを検証するテストではない。
// `vp check`によるTypeScriptの型チェックで、実際に操作するactorと
// 権限の根拠となるauthority principalを別Principalとして表現でき、
// その間のdelegation chainも同時に保持できることを保証する。
export const delegatedAgentActionRequest = {
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
