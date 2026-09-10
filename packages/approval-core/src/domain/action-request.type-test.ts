import type {
  ActionRequest,
  ActionType,
  AgentId,
  AgentRunId,
  ApprovalPolicyBinding,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ClientId,
  DelegationGrantId,
  OrganizationId,
  ResourceId,
  ResourceType,
  UserId,
} from "./index.ts";

// AC-M0-001
//
// これはruntimeの振る舞いを検証するテストではない。
// `vp check`によるTypeScriptの型チェックで、実際に操作するactorと
// 権限の根拠となるauthority principalを別Principalとして表現でき、
// その間のdelegation chainも同時に保持できることを保証する。
const aliceId = "user:alice" as UserId;
const ticketAssistantId = "agent:ticket-assistant" as AgentId;
const delegationGrantId = "delegation:alice-to-ticket-assistant" as DelegationGrantId;
const ticketPriorityChange = "ticket.priority.change" as ActionType;
const ticketType = "ticket" as ResourceType;
const ticketId = "TICKET-123" as ResourceId;
const mcpClientId = "mcp-client:test" as ClientId;
const agentRunId = "run:123" as AgentRunId;

export const delegatedAgentActionRequest = {
  actor: { type: "agent", id: ticketAssistantId },
  authority: {
    principal: { type: "user", id: aliceId },
    delegation: {
      chain: [
        {
          delegator: { type: "user", id: aliceId },
          delegatee: { type: "agent", id: ticketAssistantId },
          grantId: delegationGrantId,
        },
      ],
    },
  },
  action: {
    type: ticketPriorityChange,
    resource: { type: ticketType, id: ticketId },
    input: { priority: "critical" },
  },
  origin: {
    type: "mcp",
    caller: { type: "user", id: aliceId },
    clientId: mcpClientId,
    agentRunId,
  },
} satisfies ActionRequest;

// Branded typeによって、実行時には同じstringでも意味の異なる識別子を
// 相互に代入できないことをcompile-time contractとして固定する。
// @ts-expect-error AgentIdをUserIdとして扱うことはできない
export const invalidUserId: UserId = ticketAssistantId;

// @ts-expect-error UserIdをResourceIdとして扱うことはできない
export const invalidResourceId: ResourceId = aliceId;

const policyKey = "ticket-policy" as ApprovalPolicyKey;
const bindingId = "binding:ticket-policy" as ApprovalPolicyBindingId;
const organizationId = "organization:acme" as OrganizationId;

export const validPolicyBinding = {
  id: bindingId,
  organizationId,
  policyKey,
  selector: { actionTypes: [ticketPriorityChange] },
  enabled: true,
} satisfies ApprovalPolicyBinding;

// @ts-expect-error ApprovalPolicyKeyをApprovalPolicyBindingIdとして扱うことはできない
export const invalidPolicyBindingId: ApprovalPolicyBindingId = policyKey;
