import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import { field, gte, literal } from "./builder.ts";
import { PolicyFieldMissingError, evaluateCondition } from "./condition-evaluator.ts";
import type {
  ActionType,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  OrganizationId,
} from "./domain/brand.ts";
import type { ApprovalPolicyBinding } from "./domain/policy.ts";
import type { PolicyEvaluationContext } from "./domain/evaluation.ts";
import { ApprovalPlanPolicyNotFoundError, evaluateApprovalPlan } from "./policy-evaluator.ts";
import { createPurchaseActionRequest, createTicketActionRequest } from "./testing/fixtures.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("org:test");

function purchaseContext(): PolicyEvaluationContext {
  const request = createPurchaseActionRequest();
  return {
    ...request,
    action: {
      ...request.action,
      input: { currency: "JPY" },
    },
    organization: { id: organizationId },
    now: "2026-09-12T00:00:00.000Z",
  };
}

describe("ErrorFactory error contract", () => {
  it("Condition Failureをinstanceof / name / codeで識別できる", () => {
    const result = evaluateCondition(
      gte(field("action.input.amountMinor"), literal(500_000)),
      purchaseContext(),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;

    expect(result.error).toBeInstanceOf(PolicyFieldMissingError);
    expect(result.error.name).toBe("PolicyFieldMissingError");
    expect(result.error.code).toBe("field_missing");
    expect(result.error.path).toBe("action.input.amountMinor");
  });

  it("Approval Plan Failureをcustom error unionとして識別できる", () => {
    const request = createTicketActionRequest();
    const policyKey = branded<ApprovalPolicyKey>("policy:missing");
    const binding: ApprovalPolicyBinding = {
      id: branded<ApprovalPolicyBindingId>("binding:missing"),
      organizationId,
      policyKey,
      selector: {
        actionTypes: [request.action.type as ActionType],
      },
      enabled: true,
    };
    const context: PolicyEvaluationContext = {
      ...request,
      organization: { id: organizationId },
      now: "2026-09-12T00:00:00.000Z",
    };

    const result = evaluateApprovalPlan({ context, bindings: [binding], policies: [] });

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;

    expect(result.error).toBeInstanceOf(ApprovalPlanPolicyNotFoundError);
    expect(result.error.name).toBe("ApprovalPlanPolicyNotFoundError");
    expect(result.error.type).toBe("policy_not_found");

    if (result.error.name === "ApprovalPlanPolicyNotFoundError") {
      expect(result.error.policyKey).toBe(policyKey);
      expect(String(result.error.bindingId)).toBe("binding:missing");
    }
  });
});
