import type {
  ActionRequest,
  ActionType,
  AgentId,
  AgentRunId,
  ClientId,
  DelegationGrantId,
  ResourceId,
  ResourceType,
  UserId,
} from "../domain/index.ts";

function asBrand<Id extends string>(value: string): Id {
  return value as Id;
}

export const fixtureIds = Object.freeze({
  alice: asBrand<UserId>("user:alice"),
  bob: asBrand<UserId>("user:bob"),
  ticketAssistant: asBrand<AgentId>("agent:ticket-assistant"),
  delegation: asBrand<DelegationGrantId>("delegation:alice-to-ticket-assistant"),
  ticket: asBrand<ResourceId>("TICKET-123"),
  purchase: asBrand<ResourceId>("PURCHASE-001"),
  mcpClient: asBrand<ClientId>("mcp-client:test"),
  agentRun: asBrand<AgentRunId>("run:123"),
});

const ticketType = asBrand<ResourceType>("ticket");
const purchaseType = asBrand<ResourceType>("purchase-request");
const ticketPriorityChange = asBrand<ActionType>("ticket.priority.change");
const purchaseCreate = asBrand<ActionType>("purchase.request.create");

export function createHumanActionRequest(): ActionRequest {
  return {
    actor: { type: "user", id: fixtureIds.alice },
    authority: { principal: { type: "user", id: fixtureIds.alice } },
    action: {
      type: ticketPriorityChange,
      resource: { type: ticketType, id: fixtureIds.ticket },
      input: { priority: "critical" },
    },
    origin: { type: "ui" },
  };
}

export function createAgentActionRequest(): ActionRequest {
  return {
    actor: { type: "agent", id: fixtureIds.ticketAssistant },
    authority: { principal: { type: "agent", id: fixtureIds.ticketAssistant } },
    action: {
      type: ticketPriorityChange,
      resource: { type: ticketType, id: fixtureIds.ticket },
      input: { priority: "critical" },
    },
    origin: {
      type: "mcp",
      caller: { type: "user", id: fixtureIds.alice },
      clientId: fixtureIds.mcpClient,
      agentRunId: fixtureIds.agentRun,
    },
  };
}

export function createDelegatedAgentActionRequest(): ActionRequest {
  return {
    actor: { type: "agent", id: fixtureIds.ticketAssistant },
    authority: {
      principal: { type: "user", id: fixtureIds.alice },
      delegation: {
        chain: [
          {
            delegator: { type: "user", id: fixtureIds.alice },
            delegatee: { type: "agent", id: fixtureIds.ticketAssistant },
            grantId: fixtureIds.delegation,
          },
        ],
      },
    },
    action: {
      type: ticketPriorityChange,
      resource: { type: ticketType, id: fixtureIds.ticket },
      input: { priority: "critical" },
    },
    origin: {
      type: "mcp",
      caller: { type: "user", id: fixtureIds.alice },
      clientId: fixtureIds.mcpClient,
      agentRunId: fixtureIds.agentRun,
    },
  };
}

export function createTicketActionRequest(): ActionRequest {
  return createHumanActionRequest();
}

export function createPurchaseActionRequest(): ActionRequest {
  return {
    actor: { type: "user", id: fixtureIds.alice },
    authority: { principal: { type: "user", id: fixtureIds.alice } },
    action: {
      type: purchaseCreate,
      resource: { type: purchaseType, id: fixtureIds.purchase },
      input: { amountMinor: 500_000, currency: "JPY" },
    },
    origin: { type: "api" },
  };
}
