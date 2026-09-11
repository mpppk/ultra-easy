import { describe, expect, it } from "vite-plus/test";

import {
  createAgentActionRequest,
  createDelegatedAgentActionRequest,
  createHumanActionRequest,
  createPurchaseActionRequest,
  createTicketActionRequest,
  fixtureIds,
} from "@app/approval-core/testing";

describe("M0 representative fixtures", () => {
  it("Human / Agent / Delegated Agentのauthority semanticsを固定する", () => {
    const human = createHumanActionRequest();
    const agent = createAgentActionRequest();
    const delegated = createDelegatedAgentActionRequest();

    expect(human.actor).toEqual(human.authority.principal);
    expect(agent.actor).toEqual(agent.authority.principal);

    expect(delegated.actor).toEqual({
      type: "agent",
      id: fixtureIds.ticketAssistant,
    });
    expect(delegated.authority.principal).toEqual({
      type: "user",
      id: fixtureIds.alice,
    });
    expect(delegated.authority.delegation?.chain).toEqual([
      {
        delegator: { type: "user", id: fixtureIds.alice },
        delegatee: { type: "agent", id: fixtureIds.ticketAssistant },
        grantId: fixtureIds.delegation,
      },
    ]);
  });

  it("Ticket / Purchaseの代表Actionを固定する", () => {
    const ticket = createTicketActionRequest();
    const purchase = createPurchaseActionRequest();

    expect(ticket.action.input).toEqual({ priority: "critical" });
    expect(purchase.action.input).toEqual({
      amountMinor: 500_000,
      currency: "JPY",
    });
  });

  it("factoryごとに独立したActionRequestを返す", () => {
    const first = createHumanActionRequest();
    const second = createHumanActionRequest();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.action).not.toBe(second.action);
  });
});
