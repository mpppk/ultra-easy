import { describe, expect, it } from "vite-plus/test";

import { validateEffectiveAuthority } from "./authorization.ts";
import type {
  ActionType,
  AgentId,
  DelegationGrantId,
  ResourceId,
  ResourceType,
  UserId,
} from "./domain/brand.ts";
import type { Condition } from "./domain/condition.ts";
import type { ActionRequest } from "./domain/action.ts";

const alice = { type: "user" as const, id: "user:alice" as UserId };
const agent = { type: "agent" as const, id: "agent:payer" as AgentId };
const NOW = "2026-09-25T00:00:00.000Z";

const withinLimit: Condition = {
  type: "and",
  conditions: [
    {
      type: "comparison",
      left: { type: "field", path: "action.input.amount" },
      operator: "lte",
      right: { type: "literal", value: 10_000 },
    },
    {
      type: "comparison",
      left: { type: "field", path: "action.input.currency" },
      operator: "eq",
      right: { type: "literal", value: "JPY" },
    },
  ],
};

function request(
  input: Record<string, unknown>,
  condition: Condition = withinLimit,
): ActionRequest {
  return {
    actor: agent,
    authority: {
      principal: alice,
      delegation: {
        chain: [
          {
            delegator: alice,
            delegatee: agent,
            grantId: "grant:payments" as DelegationGrantId,
            scope: { actionTypes: ["payment.execute" as ActionType], condition },
          },
        ],
      },
    },
    action: {
      type: "payment.execute" as ActionType,
      resource: { type: "invoice" as ResourceType, id: "INV-1" as ResourceId },
      input,
    },
    origin: { type: "api" },
  };
}

describe("attribute-based delegation scope (#161)", () => {
  it("allows only actions whose attributes satisfy the shared Condition", () => {
    expect(
      validateEffectiveAuthority(request({ amount: 9000, currency: "JPY" }), NOW),
    ).toMatchObject({
      type: "valid",
      mode: "delegated",
    });
    expect(
      validateEffectiveAuthority(request({ amount: 50_000, currency: "JPY" }), NOW),
    ).toMatchObject({
      type: "deny",
      code: "delegation_scope_denied",
    });
    expect(
      validateEffectiveAuthority(request({ amount: 100, currency: "USD" }), NOW),
    ).toMatchObject({
      type: "deny",
      code: "delegation_scope_denied",
    });
  });

  it("fails closed on missing fields, type mismatches, and out-of-namespace references", () => {
    expect(validateEffectiveAuthority(request({ currency: "JPY" }), NOW)).toMatchObject({
      type: "deny",
      code: "delegation_scope_invalid",
    });
    expect(
      validateEffectiveAuthority(request({ amount: "9000", currency: "JPY" }), NOW),
    ).toMatchObject({
      type: "deny",
      code: "delegation_scope_invalid",
    });
    const outOfNamespace: Condition = {
      type: "comparison",
      left: { type: "field", path: "organization.settings.limit" },
      operator: "gt",
      right: { type: "literal", value: 0 },
    };
    expect(
      validateEffectiveAuthority(request({ amount: 1, currency: "JPY" }, outOfNamespace), NOW),
    ).toMatchObject({
      type: "deny",
      code: "delegation_scope_invalid",
    });
  });

  it("adding hops never widens the scope (all conditions are ANDed)", () => {
    const base = request({ amount: 9000, currency: "JPY" });
    const sub = { type: "agent" as const, id: "agent:sub" as AgentId };
    const extended: ActionRequest = {
      ...base,
      actor: sub,
      authority: {
        ...base.authority,
        delegation: {
          chain: [
            ...(base.authority.delegation?.chain ?? []),
            {
              delegator: agent,
              delegatee: sub,
              grantId: "grant:sub" as DelegationGrantId,
              // 後続hopがより広い条件を持っても、前のhopの条件は外れない。
              scope: {
                condition: {
                  type: "comparison",
                  left: { type: "literal", value: 1 },
                  operator: "eq",
                  right: { type: "literal", value: 1 },
                },
              },
            },
          ],
        },
      },
    };
    expect(validateEffectiveAuthority(extended, NOW)).toMatchObject({ type: "valid" });
    const tooLarge: ActionRequest = {
      ...extended,
      action: { ...extended.action, input: { amount: 20_000, currency: "JPY" } },
    };
    expect(validateEffectiveAuthority(tooLarge, NOW)).toMatchObject({
      type: "deny",
      code: "delegation_scope_denied",
    });
  });
});
