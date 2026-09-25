import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import {
  APPROVAL_FIELD_NAMESPACES,
  evaluateCondition as evaluateShared,
} from "@app/expression-core";

import { field, gte, literal } from "./builder.ts";
import {
  PolicyFieldNotAllowedError,
  approvalFieldResolver,
  evaluateCondition,
  isAllowedPolicyFieldPath,
} from "./condition-evaluator.ts";
import type { OrganizationId } from "./domain/brand.ts";
import type { PolicyEvaluationContext } from "./domain/evaluation.ts";
import { createPurchaseActionRequest } from "./testing/fixtures.ts";

function context(): PolicyEvaluationContext {
  return {
    ...createPurchaseActionRequest(),
    organization: { id: "org:test" as OrganizationId, settings: { limit: 100 } },
    now: "2026-09-25T00:00:00.000Z",
  };
}

describe("Approval Condition on the shared Expression Engine (#155)", () => {
  it("Approval resolverはApproval namespaceだけを許可する", () => {
    expect(isAllowedPolicyFieldPath("action.input.amountMinor")).toBe(true);
    expect(isAllowedPolicyFieldPath("workflow.input.amount")).toBe(false);
    expect(isAllowedPolicyFieldPath("nodes.a.output")).toBe(false);

    const result = evaluateCondition(gte(field("workflow.input.amount"), literal(1)), context());
    expect(Result.isFailure(result) && result.error).toBeInstanceOf(PolicyFieldNotAllowedError);
  });

  it("Approval wrapperと共有評価器は同じ判定を返す", () => {
    const condition = gte(field("organization.settings.limit"), literal(100));
    const approval = evaluateCondition(condition, context());
    const shared = evaluateShared(condition, approvalFieldResolver(context()));
    expect(approval).toEqual(Result.succeed({ type: "matched" }));
    expect(shared).toEqual(approval);
    expect(APPROVAL_FIELD_NAMESPACES.context).toBe("approval");
  });
});
