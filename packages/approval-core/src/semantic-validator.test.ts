import { describe, expect, it } from "vite-plus/test";

import {
  always,
  and,
  approve,
  authorityPrincipal,
  definePolicy,
  eq,
  field,
  gte,
  literal,
  managerOf,
  rule,
  serial,
  validateApprovalPolicyBindingSemantics,
  validateApprovalPolicySemantics,
} from "./index.ts";
import type {
  ActionType,
  ApprovalPolicyBinding,
  ApprovalPolicyBindingId,
  ApprovalPolicyDefinition,
  ApprovalPolicyKey,
  ApprovalRuleKey,
  OrganizationId,
  PolicyFieldCatalog,
  ResourceType,
} from "./index.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

function issueCodes(result: ReturnType<typeof validateApprovalPolicySemantics>): string[] {
  expect(result.valid).toBe(false);
  if (result.valid) return [];
  return result.issues.map((issue) => issue.code);
}

function bindingIssueCodes(
  result: ReturnType<typeof validateApprovalPolicyBindingSemantics>,
): string[] {
  expect(result.valid).toBe(false);
  if (result.valid) return [];
  return result.issues.map((issue) => issue.code);
}

const approver = managerOf(authorityPrincipal());

type Flow = ApprovalPolicyDefinition["rules"][number]["flow"];

function approval(key: string, name?: string) {
  return approve({ key, ...(name ? { name } : {}), approver });
}

function policyWithFlow(flow: Flow) {
  return definePolicy({
    key: "policy:test",
    name: "テストPolicy",
    rules: [rule("default", { when: always(), flow })],
  });
}

function binding(overrides: Partial<ApprovalPolicyBinding> = {}): ApprovalPolicyBinding {
  return {
    id: branded<ApprovalPolicyBindingId>("binding:test"),
    organizationId: branded<OrganizationId>("org:test"),
    policyKey: branded<ApprovalPolicyKey>("policy:test"),
    selector: { actionTypes: [branded<ActionType>("ticket.update")] },
    enabled: true,
    ...overrides,
  };
}

describe("validateApprovalPolicySemantics", () => {
  describe("Policy / Step identity", () => {
    it("同一Policy内のRule key重複を拒否する", () => {
      const policy = {
        schemaVersion: 1,
        key: branded<ApprovalPolicyKey>("policy:duplicate-rule"),
        name: "Rule重複",
        rules: [
          {
            key: branded<ApprovalRuleKey>("same"),
            when: eq(field("action.input.priority"), literal("critical")),
            flow: approval("manager"),
          },
          {
            key: branded<ApprovalRuleKey>("same"),
            when: always(),
            flow: approval("security"),
          },
        ],
      } satisfies ApprovalPolicyDefinition;

      expect(issueCodes(validateApprovalPolicySemantics(policy))).toContain("duplicate_rule_key");
    });

    it("同一Flow内のStep key重複を拒否する", () => {
      const duplicate = approval("manager");
      const policy = policyWithFlow(serial(duplicate, duplicate));

      expect(issueCodes(validateApprovalPolicySemantics(policy))).toContain("duplicate_step_key");
    });

    it("別Rule間でもStep key重複を拒否する", () => {
      const policy = definePolicy({
        key: "policy:cross-rule-duplicate-step",
        name: "Ruleを跨ぐStep重複",
        rules: [
          rule("critical", {
            when: eq(field("action.input.priority"), literal("critical")),
            flow: approval("manager"),
          }),
          rule("default", { when: always(), flow: approval("manager") }),
        ],
      });

      expect(issueCodes(validateApprovalPolicySemantics(policy))).toContain("duplicate_step_key");
    });

    it("異なるStep keyなら同じnameを許可する", () => {
      const policy = policyWithFlow(
        serial(approval("manager-1", "上長承認"), approval("manager-2", "上長承認")),
      );

      expect(validateApprovalPolicySemantics(policy)).toEqual({ valid: true });
    });

    it("異なるPolicyでは同じStep keyを許可する", () => {
      const first = definePolicy({
        key: "policy:first",
        name: "First",
        rules: [rule("default", { when: always(), flow: approval("manager") })],
      });
      const second = definePolicy({
        key: "policy:second",
        name: "Second",
        rules: [rule("default", { when: always(), flow: approval("manager") })],
      });

      expect(validateApprovalPolicySemantics(first)).toEqual({ valid: true });
      expect(validateApprovalPolicySemantics(second)).toEqual({ valid: true });
    });
  });

  describe("Rule / Flow structure", () => {
    it("未対応schemaVersionを拒否する", () => {
      const policy = {
        ...policyWithFlow(approval("manager")),
        schemaVersion: 2,
      } as unknown as ApprovalPolicyDefinition;

      expect(issueCodes(validateApprovalPolicySemantics(policy))).toContain(
        "unsupported_schema_version",
      );
    });

    it("always Ruleが末尾でなければ拒否する", () => {
      const policy = definePolicy({
        key: "policy:always-not-last",
        name: "always位置不正",
        rules: [
          rule("always", { when: always(), flow: approval("manager") }),
          rule("second", {
            when: eq(field("action.input.priority"), literal("critical")),
            flow: approval("security"),
          }),
        ],
      });

      expect(issueCodes(validateApprovalPolicySemantics(policy))).toContain("always_not_last");
    });

    it("空のserialを拒否する", () => {
      expect(
        issueCodes(
          validateApprovalPolicySemantics(policyWithFlow({ type: "serial", children: [] })),
        ),
      ).toContain("empty_serial");
    });

    it("空のparallelを拒否する", () => {
      expect(
        issueCodes(
          validateApprovalPolicySemantics(
            policyWithFlow({ type: "parallel", strategy: "all", children: [] }),
          ),
        ),
      ).toContain("empty_parallel");
    });

    it("quorumが1未満なら拒否する", () => {
      const flow: Flow = {
        type: "parallel",
        strategy: "quorum",
        quorum: 0,
        children: [approval("manager")],
      };

      expect(issueCodes(validateApprovalPolicySemantics(policyWithFlow(flow)))).toContain(
        "invalid_quorum",
      );
    });

    it("quorumがchildren数を超える場合は拒否する", () => {
      const flow: Flow = {
        type: "parallel",
        strategy: "quorum",
        quorum: 2,
        children: [approval("manager")],
      };

      expect(issueCodes(validateApprovalPolicySemantics(policyWithFlow(flow)))).toContain(
        "invalid_quorum",
      );
    });

    it("quorum以外のstrategyでquorum指定を拒否する", () => {
      const flow = {
        type: "parallel",
        strategy: "all",
        quorum: 1,
        children: [approval("manager")],
      } as unknown as Flow;

      expect(issueCodes(validateApprovalPolicySemantics(policyWithFlow(flow)))).toContain(
        "unexpected_quorum",
      );
    });
  });

  describe("Condition semantics", () => {
    it("allowlist外のfield rootを拒否する", () => {
      const policy = definePolicy({
        key: "policy:unknown-field",
        name: "未知field",
        rules: [
          rule("default", {
            when: eq(field("request.secret"), literal(true)),
            flow: approval("manager"),
          }),
        ],
      });

      expect(issueCodes(validateApprovalPolicySemantics(policy))).toContain("unknown_field_root");
    });

    it("Field Catalog上で型互換性のない順序比較を拒否する", () => {
      const policy = definePolicy({
        key: "policy:type-mismatch",
        name: "型不一致",
        rules: [
          rule("default", {
            when: gte(field("action.input.priority"), literal(1)),
            flow: approval("manager"),
          }),
        ],
      });
      const fieldCatalog: PolicyFieldCatalog = [
        { path: "action.input.priority", type: "string" },
      ];

      expect(issueCodes(validateApprovalPolicySemantics(policy, { fieldCatalog }))).toContain(
        "unsupported_type_comparison",
      );
    });

    it("unsafe integer literalを拒否する", () => {
      const policy = definePolicy({
        key: "policy:unsafe-number",
        name: "unsafe number",
        rules: [
          rule("default", {
            when: eq(field("action.input.amount"), literal(Number.MAX_SAFE_INTEGER + 1)),
            flow: approval("manager"),
          }),
        ],
      });

      expect(issueCodes(validateApprovalPolicySemantics(policy))).toContain("invalid_number");
    });

    it("money_minorとliteralの比較にcurrency guardがなければ拒否する", () => {
      const policy = definePolicy({
        key: "policy:money-without-currency",
        name: "通貨guardなし",
        rules: [
          rule("default", {
            when: gte(field("action.input.amountMinor"), literal(500_000)),
            flow: approval("manager"),
          }),
        ],
      });
      const fieldCatalog: PolicyFieldCatalog = [
        {
          path: "action.input.amountMinor",
          type: "money_minor",
          currencyPath: "action.input.currency",
        },
        { path: "action.input.currency", type: "string" },
      ];

      expect(issueCodes(validateApprovalPolicySemantics(policy, { fieldCatalog }))).toContain(
        "money_currency_guard_required",
      );
    });

    it("money_minorとliteralの比較にcurrency guardがあれば受理する", () => {
      const policy = definePolicy({
        key: "policy:money-with-currency",
        name: "通貨guardあり",
        rules: [
          rule("default", {
            when: and(
              eq(field("action.input.currency"), literal("JPY")),
              gte(field("action.input.amountMinor"), literal(500_000)),
            ),
            flow: approval("manager"),
          }),
        ],
      });
      const fieldCatalog: PolicyFieldCatalog = [
        {
          path: "action.input.amountMinor",
          type: "money_minor",
          currencyPath: "action.input.currency",
        },
        { path: "action.input.currency", type: "string" },
      ];

      expect(validateApprovalPolicySemantics(policy, { fieldCatalog })).toEqual({ valid: true });
    });
  });

  describe("Approval Step semantics", () => {
    it("candidateCompletion=allでsnapshot以外を拒否する", () => {
      const policy = policyWithFlow(
        approve({
          key: "manager",
          approver,
          resolution: "dynamic",
          candidateCompletion: "all",
        }),
      );

      expect(issueCodes(validateApprovalPolicySemantics(policy))).toContain(
        "candidate_completion_requires_snapshot",
      );
    });

    it("candidateCompletion.quorumが1未満なら拒否する", () => {
      const policy = policyWithFlow(
        approve({
          key: "manager",
          approver,
          resolution: "snapshot",
          candidateCompletion: { type: "quorum", count: 0 },
        }),
      );

      expect(issueCodes(validateApprovalPolicySemantics(policy))).toContain(
        "invalid_candidate_completion",
      );
    });

    it("v1で未対応のonUnresolved strategyを拒否する", () => {
      const flow = {
        ...approval("manager"),
        onUnresolved: { type: "skip" },
      } as unknown as ReturnType<typeof approve>;

      expect(issueCodes(validateApprovalPolicySemantics(policyWithFlow(flow)))).toContain(
        "invalid_unresolved_strategy",
      );
    });

    it("fallbackにapproverがなければ拒否する", () => {
      const flow = {
        ...approval("manager"),
        onUnresolved: { type: "fallback" },
      } as unknown as ReturnType<typeof approve>;

      expect(issueCodes(validateApprovalPolicySemantics(policyWithFlow(flow)))).toContain(
        "invalid_unresolved_strategy",
      );
    });

    it("expiresAfterが0なら拒否する", () => {
      const policy = policyWithFlow(
        approve({ key: "manager", approver, expiresAfter: { seconds: 0 } }),
      );

      expect(issueCodes(validateApprovalPolicySemantics(policy))).toContain("invalid_expiry");
    });

    it("expiresAfterが最大値を超えたら拒否する", () => {
      const policy = policyWithFlow(
        approve({ key: "manager", approver, expiresAfter: { seconds: 11 } }),
      );

      expect(
        issueCodes(validateApprovalPolicySemantics(policy, { maxExpirySeconds: 10 })),
      ).toContain("invalid_expiry");
    });

    it("requireCommentOnの未知Decisionを拒否する", () => {
      const flow = {
        ...approval("manager"),
        requireCommentOn: ["approve", "skip"],
      } as unknown as ReturnType<typeof approve>;

      expect(issueCodes(validateApprovalPolicySemantics(policyWithFlow(flow)))).toContain(
        "invalid_comment_requirement",
      );
    });
  });
});

describe("validateApprovalPolicyBindingSemantics", () => {
  it("actionTypesが空なら拒否する", () => {
    expect(
      bindingIssueCodes(
        validateApprovalPolicyBindingSemantics(binding({ selector: { actionTypes: [] } })),
      ),
    ).toContain("empty_action_selector");
  });

  it("末尾prefix wildcard以外のAction type patternを拒否する", () => {
    const selector = { actionTypes: [branded<ActionType>("ticket.*.update")] };

    expect(
      bindingIssueCodes(validateApprovalPolicyBindingSemantics(binding({ selector }))),
    ).toContain("invalid_action_type_pattern");
  });

  it("resourceTypesを指定して空配列なら拒否する", () => {
    const selector = {
      actionTypes: [branded<ActionType>("ticket.update")],
      resourceTypes: [] as ResourceType[],
    };

    expect(
      bindingIssueCodes(validateApprovalPolicyBindingSemantics(binding({ selector }))),
    ).toContain("empty_resource_selector");
  });

  it("compositionOrderが安全な整数でなければ拒否する", () => {
    const result = validateApprovalPolicyBindingSemantics(
      binding({ compositionOrder: Number.MAX_SAFE_INTEGER + 1 }),
    );

    expect(bindingIssueCodes(result)).toContain("invalid_composition_order");
  });

  it("selector.whenでもallowlist外fieldを拒否する", () => {
    const selector = {
      actionTypes: [branded<ActionType>("ticket.update")],
      when: eq(field("request.secret"), literal(true)),
    };

    expect(
      bindingIssueCodes(validateApprovalPolicyBindingSemantics(binding({ selector }))),
    ).toContain("unknown_field_root");
  });
});
