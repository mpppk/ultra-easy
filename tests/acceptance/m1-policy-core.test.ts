import { describe, expect, it } from "vite-plus/test";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import {
  always,
  and,
  approve,
  authorityPrincipal,
  definePolicy,
  eq,
  evaluateApprovalPlan,
  evaluateCondition,
  evaluatePolicy,
  field,
  gte,
  literal,
  managerOf,
  none,
  resolvePolicyBindings,
  rule,
  serial,
  validateActionInput,
  validateApprovalPolicyBindingSemantics,
  validateApprovalPolicySemantics,
} from "@app/approval-core";
import type {
  ActionType,
  ApprovalPolicyBinding,
  ApprovalPolicyBindingId,
  ApprovalPolicyDefinition,
  ApprovalPolicyKey,
  ApprovalRuleKey,
  ApprovalStepKey,
  OrganizationId,
  PolicyEvaluationContext,
  PolicyFieldCatalog,
  ResourceType,
} from "@app/approval-core";
import { createPurchaseActionRequest, createTicketActionRequest } from "@app/approval-core/testing";

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("org:test");

function ticketContext(
  input: Record<string, unknown> = { priority: "critical" },
): PolicyEvaluationContext {
  const request = createTicketActionRequest();
  return {
    ...request,
    action: { ...request.action, input },
    organization: { id: organizationId },
    now: "2026-09-11T00:00:00.000Z",
  };
}

function purchaseContext(input: Record<string, unknown>): PolicyEvaluationContext {
  const request = createPurchaseActionRequest();
  return {
    ...request,
    action: { ...request.action, input },
    organization: { id: organizationId },
    now: "2026-09-11T00:00:00.000Z",
  };
}

function createBinding(input: {
  id: string;
  policyKey: ApprovalPolicyKey;
  compositionOrder?: number;
  actionTypes?: ActionType[];
  resourceTypes?: ResourceType[];
  enabled?: boolean;
  when?: ApprovalPolicyBinding["selector"]["when"];
}): ApprovalPolicyBinding {
  return {
    id: branded<ApprovalPolicyBindingId>(input.id),
    organizationId,
    policyKey: input.policyKey,
    selector: {
      actionTypes: input.actionTypes ?? [createTicketActionRequest().action.type],
      ...(input.resourceTypes ? { resourceTypes: input.resourceTypes } : {}),
      ...(input.when ? { when: input.when } : {}),
    },
    ...(input.compositionOrder !== undefined ? { compositionOrder: input.compositionOrder } : {}),
    enabled: input.enabled ?? true,
  };
}

const managerFlow = approve({
  key: "manager",
  approver: managerOf(authorityPrincipal()),
});
const securityFlow = approve({
  key: "security",
  approver: managerOf(authorityPrincipal()),
  purpose: "security_approval",
});

describe("M1 Policy Core", () => {
  it("AC-M1-001: 同一Policyでは最初に一致したRuleだけを採用する", () => {
    const policy = definePolicy({
      key: "ticket-priority",
      name: "チケット優先度",
      rules: [
        rule("critical", {
          when: eq(field("action.input.priority"), literal("critical")),
          flow: managerFlow,
        }),
        rule("fallback", { when: always(), flow: securityFlow }),
      ],
    });

    const result = evaluatePolicy(policy, ticketContext());

    expect(result.type).toBe("matched");
    if (result.type !== "matched") return;
    expect(String(result.ruleKey)).toBe("critical");
    expect(result.flow).toEqual(managerFlow);
  });

  it("AC-M1-002: Binding順で複数Policyを決定的にserial合成する", () => {
    const managerPolicy = definePolicy({
      key: "manager-policy",
      name: "管理者承認",
      rules: [rule("always", { when: always(), flow: managerFlow })],
    });
    const securityPolicy = definePolicy({
      key: "security-policy",
      name: "セキュリティ承認",
      rules: [rule("always", { when: always(), flow: securityFlow })],
    });
    const managerBinding = createBinding({
      id: "binding:b",
      policyKey: managerPolicy.key,
      compositionOrder: 100,
    });
    const securityBinding = createBinding({
      id: "binding:a",
      policyKey: securityPolicy.key,
      compositionOrder: 200,
    });
    const context = ticketContext();
    context.organization.defaultFlowConstraints = { distinctApprovers: true };

    const first = evaluateApprovalPlan({
      context,
      bindings: [securityBinding, managerBinding],
      policies: [securityPolicy, managerPolicy],
    });
    const second = evaluateApprovalPlan({
      context,
      bindings: [managerBinding, securityBinding],
      policies: [managerPolicy, securityPolicy],
    });

    expect(first).toEqual(second);
    expect(first.type).toBe("compiled");
    if (first.type !== "compiled") return;
    expect(first.flow).toEqual({
      type: "serial",
      children: [managerFlow, securityFlow],
      constraints: { distinctApprovers: true },
    });
  });

  it("AC-M1-003: noneは他Policyの承認を打ち消さず、全てnoneならnoneになる", () => {
    const noApprovalPolicy = definePolicy({
      key: "no-approval",
      name: "追加承認なし",
      rules: [rule("always", { when: always(), flow: none() })],
    });
    const managerPolicy = definePolicy({
      key: "manager-policy",
      name: "管理者承認",
      rules: [rule("always", { when: always(), flow: managerFlow })],
    });
    const noApprovalBinding = createBinding({
      id: "binding:none",
      policyKey: noApprovalPolicy.key,
    });
    const managerBinding = createBinding({ id: "binding:manager", policyKey: managerPolicy.key });

    const mixed = evaluateApprovalPlan({
      context: ticketContext(),
      bindings: [noApprovalBinding, managerBinding],
      policies: [noApprovalPolicy, managerPolicy],
    });
    expect(mixed.type === "compiled" ? mixed.flow : mixed).toEqual(managerFlow);

    const onlyNone = evaluateApprovalPlan({
      context: ticketContext(),
      bindings: [noApprovalBinding],
      policies: [noApprovalPolicy],
    });
    expect(onlyNone.type === "compiled" ? onlyNone.flow : onlyNone).toEqual({ type: "none" });
  });

  it("AC-M1-004: missing field・型不一致・unsafe integerはfail closedする", () => {
    const condition = gte(field("action.input.amountMinor"), literal(500_000));

    expect(evaluateCondition(condition, purchaseContext({ currency: "JPY" }))).toMatchObject({
      type: "error",
      code: "field_missing",
    });
    expect(
      evaluateCondition(condition, purchaseContext({ amountMinor: "500000", currency: "JPY" })),
    ).toMatchObject({ type: "error", code: "type_mismatch" });
    expect(
      evaluateCondition(
        condition,
        purchaseContext({ amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: "JPY" }),
      ),
    ).toMatchObject({ type: "error", code: "invalid_number" });
  });

  it("AC-M1-005: minor-unit金額の境界とcurrency条件を正確に評価する", () => {
    const condition = and(
      eq(field("action.input.currency"), literal("JPY")),
      gte(field("action.input.amountMinor"), literal(500_000)),
    );

    expect(
      evaluateCondition(condition, purchaseContext({ amountMinor: 499_999, currency: "JPY" })).type,
    ).toBe("not_matched");
    expect(
      evaluateCondition(condition, purchaseContext({ amountMinor: 500_000, currency: "JPY" })).type,
    ).toBe("matched");
    expect(
      evaluateCondition(condition, purchaseContext({ amountMinor: 500_001, currency: "JPY" })).type,
    ).toBe("matched");
    expect(
      evaluateCondition(condition, purchaseContext({ amountMinor: 500_001, currency: "USD" })).type,
    ).toBe("not_matched");

    const fieldCatalog: PolicyFieldCatalog = [
      {
        path: "action.input.amountMinor",
        type: "money_minor",
        currencyPath: "action.input.currency",
      },
      { path: "action.input.currency", type: "string" },
    ];
    const validPolicy = definePolicy({
      key: "purchase",
      name: "購入承認",
      rules: [rule("large-jpy", { when: condition, flow: managerFlow })],
    });
    expect(validateApprovalPolicySemantics(validPolicy, { fieldCatalog })).toEqual({ valid: true });

    const unsafePolicy = definePolicy({
      key: "unsafe-purchase",
      name: "通貨条件なし購入承認",
      rules: [
        rule("large", {
          when: gte(field("action.input.amountMinor"), literal(500_000)),
          flow: managerFlow,
        }),
      ],
    });
    const unsafeResult = validateApprovalPolicySemantics(unsafePolicy, { fieldCatalog });
    expect(unsafeResult.valid).toBe(false);
    if (unsafeResult.valid) return;
    expect(unsafeResult.issues.map((issue) => issue.code)).toContain(
      "money_currency_guard_required",
    );
  });

  it("AC-M1-006: enabledかつaction/resource/conditionに一致するBindingだけを選ぶ", () => {
    const policyKey = branded<ApprovalPolicyKey>("policy:test");
    const context = ticketContext();
    const exact = createBinding({ id: "binding:exact", policyKey });
    const prefix = createBinding({
      id: "binding:prefix",
      policyKey,
      actionTypes: [branded<ActionType>("ticket.*")],
    });
    const disabled = createBinding({ id: "binding:disabled", policyKey, enabled: false });
    const wrongResource = createBinding({
      id: "binding:resource",
      policyKey,
      resourceTypes: [branded<ResourceType>("purchase-request")],
    });
    const conditionMismatch = createBinding({
      id: "binding:condition",
      policyKey,
      when: eq(field("action.input.priority"), literal("normal")),
    });

    const result = resolvePolicyBindings(
      [conditionMismatch, wrongResource, disabled, prefix, exact],
      context,
    );

    expect(result.type).toBe("resolved");
    if (result.type !== "resolved") return;
    expect(result.bindings.map((binding) => String(binding.id))).toEqual([
      "binding:exact",
      "binding:prefix",
    ]);
  });

  it("AC-M1-007: semantic validationで危険なPolicy/Bindingをpublish前に拒否する", () => {
    const duplicatedApproval = {
      type: "approval",
      key: branded<ApprovalStepKey>("duplicate"),
      approver: managerOf(authorityPrincipal()),
    } as const;
    const invalidPolicy = {
      schemaVersion: 1,
      key: branded<ApprovalPolicyKey>("invalid"),
      name: "不正Policy",
      rules: [
        {
          key: branded<ApprovalRuleKey>("first"),
          when: { type: "always" },
          flow: {
            type: "serial",
            children: [
              duplicatedApproval,
              duplicatedApproval,
              {
                type: "parallel",
                strategy: "quorum",
                quorum: 2,
                children: [
                  {
                    type: "approval",
                    key: branded<ApprovalStepKey>("only-one"),
                    approver: managerOf(authorityPrincipal()),
                  },
                ],
              },
            ],
          },
        },
        {
          key: branded<ApprovalRuleKey>("second"),
          when: {
            type: "and",
            conditions: [
              {
                type: "comparison",
                left: { type: "field", path: "request.secret" },
                operator: "eq",
                right: { type: "literal", value: true },
              },
              {
                type: "comparison",
                left: { type: "field", path: "action.input.priority" },
                operator: "gt",
                right: { type: "literal", value: 1 },
              },
            ],
          },
          flow: {
            type: "approval",
            key: branded<ApprovalStepKey>("unsafe-step"),
            approver: managerOf(authorityPrincipal()),
            resolution: "dynamic",
            candidateCompletion: "all",
            onUnresolved: { type: "skip" },
            expiresAfter: { seconds: 0 },
          },
        },
      ],
    } as unknown as ApprovalPolicyDefinition;

    const result = validateApprovalPolicySemantics(invalidPolicy, {
      fieldCatalog: [{ path: "action.input.priority", type: "string" }],
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(new Set(result.issues.map((issue) => issue.code))).toEqual(
      new Set([
        "always_not_last",
        "duplicate_step_key",
        "invalid_quorum",
        "unknown_field_root",
        "unsupported_type_comparison",
        "candidate_completion_requires_snapshot",
        "invalid_unresolved_strategy",
        "invalid_expiry",
      ]),
    );

    const invalidBinding = createBinding({
      id: "binding:invalid",
      policyKey: branded<ApprovalPolicyKey>("policy:test"),
      actionTypes: [branded<ActionType>("ticket.*.invalid")],
    });
    const bindingResult = validateApprovalPolicyBindingSemantics(invalidBinding);
    expect(bindingResult.valid).toBe(false);
    if (bindingResult.valid) return;
    expect(bindingResult.issues.map((issue) => issue.code)).toContain(
      "invalid_action_type_pattern",
    );
  });

  it("AC-M1-008: Builderで生成したPolicyは直接記述したJSON ASTと同値になる", () => {
    const built = definePolicy({
      key: "ticket-critical",
      name: "Critical ticket",
      rules: [
        rule("critical", {
          when: eq(field("action.input.priority"), literal("critical")),
          flow: serial(managerFlow, securityFlow),
        }),
        rule("default", { when: always(), flow: none() }),
      ],
    });

    const direct: ApprovalPolicyDefinition = {
      schemaVersion: 1,
      key: branded<ApprovalPolicyKey>("ticket-critical"),
      name: "Critical ticket",
      rules: [
        {
          key: branded<ApprovalRuleKey>("critical"),
          when: {
            type: "comparison",
            left: { type: "field", path: "action.input.priority" },
            operator: "eq",
            right: { type: "literal", value: "critical" },
          },
          flow: { type: "serial", children: [managerFlow, securityFlow] },
        },
        {
          key: branded<ApprovalRuleKey>("default"),
          when: { type: "always" },
          flow: { type: "none" },
        },
      ],
    };

    expect(built).toEqual(direct);
    expect(JSON.parse(JSON.stringify(built))).toEqual(direct);
  });

  it("field namespaceとしてorganization.settingsとderived attributesを参照できる", () => {
    const context = ticketContext();
    context.organization.settings = { threshold: 10 };
    context.attributes = { riskScore: 12 };

    expect(
      evaluateCondition(
        and(
          gte(field("attributes.riskScore"), field("organization.settings.threshold")),
          eq(field("actor.type"), literal("user")),
        ),
        context,
      ).type,
    ).toBe("matched");
  });

  it("Standard Schema validationはvendor固有APIを使わず成功/失敗を正規化する", async () => {
    const schema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(value: unknown) {
          if (
            typeof value === "object" &&
            value !== null &&
            "priority" in value &&
            (value as { priority?: unknown }).priority === "critical"
          ) {
            return { value: { priority: "critical" as const } };
          }
          return { issues: [{ message: "priority must be critical", path: ["priority"] }] };
        },
      },
    } satisfies StandardSchemaV1<unknown, { priority: "critical" }>;

    await expect(validateActionInput(schema, { priority: "critical" })).resolves.toEqual({
      type: "valid",
      value: { priority: "critical" },
    });
    await expect(validateActionInput(schema, { priority: "normal" })).resolves.toMatchObject({
      type: "invalid",
      issues: [{ message: "priority must be critical" }],
    });
  });

  it("ticket demo: priority=criticalならpure evaluationだけでmanager承認になる", () => {
    const policy = definePolicy({
      key: "ticket-priority",
      name: "チケット優先度Policy",
      rules: [
        rule("critical", {
          when: eq(field("action.input.priority"), literal("critical")),
          flow: managerFlow,
        }),
        rule("normal", { when: always(), flow: none() }),
      ],
    });
    const binding = createBinding({ id: "binding:ticket", policyKey: policy.key });

    const critical = evaluateApprovalPlan({
      context: ticketContext({ priority: "critical" }),
      bindings: [binding],
      policies: [policy],
    });
    const normal = evaluateApprovalPlan({
      context: ticketContext({ priority: "normal" }),
      bindings: [binding],
      policies: [policy],
    });

    expect(critical.type === "compiled" ? critical.flow : critical).toEqual(managerFlow);
    expect(normal.type === "compiled" ? normal.flow : normal).toEqual({ type: "none" });
  });
});
