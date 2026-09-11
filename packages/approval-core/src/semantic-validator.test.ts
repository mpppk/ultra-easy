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
  ApprovalStepKey,
  OrganizationId,
  PolicyFieldCatalog,
  ResourceType,
} from "./index.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

function expectIssue(result: ReturnType<typeof validateApprovalPolicySemantics>, code: string): void {
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.issues.map((issue) => issue.code)).toContain(code);
}

function expectBindingIssue(
  result: ReturnType<typeof validateApprovalPolicyBindingSemantics>,
  code: string,
): void {
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.issues.map((issue) => issue.code)).toContain(code);
}

const approver = managerOf(authorityPrincipal());

function approval(key: string, name?: string) {
  return approve({ key, ...(name ? { name } : {}), approver });
}

function policyWithFlow(flow: ReturnType<typeof approve>): ApprovalPolicyDefinition {
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
    it("validなPolicyを受理する", () => {
      expect(validateApprovalPolicySemantics(policyWithFlow(approval("manager")))).toEqual({
        valid: true,
      });
    });

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

      expectIssue(validateApprovalPolicySemantics(policy), "duplicate_rule_key");
    });

    it("同一Flow内のStep key重複を拒否する", () => {
      const duplicate = approval("manager");
      const policy = definePolicy({
        key: "policy:duplicate-step",
        name: "Step重複",
        rules: [rule("default", { when: always(), flow: serial(duplicate, duplicate) })],
      });

      expectIssue(validateApprovalPolicySemantics(policy), "duplicate_step_key");
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

      expectIssue(validateApprovalPolicySemantics(policy), "duplicate_step_key");
    });

    it("異なるStep keyなら同じnameを許可する", () => {
      const policy = definePolicy({
        key: "policy:same-name",
        name: "同名Step",
        rules: [
          rule("default", {
            when: always(),
            flow: serial(approval("manager-1", "上長承認"), approval("manager-2", "上長承認")),
          }),
        ],
      });

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

      expectIssue(validateApprovalPolicySemantics(policy), "unsupported_schema_version");
    });

    it("always Ruleが末尾でないPolicyを拒否する", () => {
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

      expectIssue(validateApprovalPolicySemantics(policy), "always_not_last");
    });

    it("空のserialを拒否する", () => {
      const policy = definePolicy({
        key: "policy:empty-serial",
        name: "空serial",
        rules: [
          rule("default", {
            when: always(),
            flow: { type: "serial", children: [] },
          }),
        ],
      });

      expectIssue(validateApprovalPolicySemantics(policy), "empty_serial");
    });

    it("空のparallelを拒否する", () => {
      const policy = definePolicy({
        key: "policy:empty-parallel",
        name: "空parallel",
        rules: [
          rule("default", {
            when: always(),
            flow: { type: "parallel", strategy: "all", children: [] },
          }),
        ],
      });

      expectIssue(validateApprovalPolicySemantics(policy), "empty_parallel");
    });

    it("quorumが1未満なら拒否する", () => {
      const policy = definePolicy({
        key: "policy:zero-quorum",
        name: "quorum不正",
        rules: [
          rule("default", {
            when: always(),
            flow: {
              type: "parallel",
              strategy: "quorum",
              quorum: 0,
              children: [approval("manager")],
            },
          }),
        ],
      });

      expectIssue(validateApprovalPolicySemantics(policy), "invalid_quorum");
    });

    it("quorumがchildren数を超える場合は拒否する", () => {
      const policy = definePolicy({
        key: "policy:large-quorum",
        name: "quorum不正",
        rules: [
          rule("default", {
            when: always(),
            flow: {
              type: "parallel",
              strategy: "quorum",
              quorum: 2,
              children: [approval("manager")],
            },
          }),
        ],
      });

      expectIssue(validateApprovalPolicySemantics(policy), "invalid_quorum");
    });

    it("quorum以外のstrategyでquorum指定を拒否する", () => {
      const flow = {
        type: "parallel",
        strategy: "all",
        quorum: 1,
        children: [approval("manager")],
      } as unknown as ApprovalPolicyDefinition["rules"][number]["flow"];
      const policy = definePolicy({
        key: "policy:unexpected-quorum",
        name: "余分なquorum",
        rules: [rule("default", { when: always(), flow })],
      });

      expectIssue(validateApprovalPolicySemantics(policy), "unexpected_quorum");
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

      expectIssue(validateApprovalPolicySemantics(policy), "unknown_field_root");
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

      expectIssue(
        validateApprovalPolicySemantics(policy, { fieldCatalog }),
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

      expectIssue(validateApprovalPolicySemantics(policy), "invalid_number");
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

      expectIssue(
        validateApprovalPolicySemantics(policy, { fieldCatalog }),
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

      expectIssue(
        validateApprovalPolicySemantics(policy),
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

      expectIssue(validateApprovalPolicySemantics(policy), "invalid_candidate_completion");
    });

    it("v1で未対応のonUnresolved strategyを拒否する", () => {
      const flow = {
        ...approval("manager"),
        onUnresolved: { type: "skip" },
      } as unknown as ReturnType<typeof approve>;

      expectIssue(
        validateApprovalPolicySemantics(policyWithFlow(flow)),
        "invalid_unresolved_strategy",
      );
    });

    it("fallbackにapproverがなければ拒否する", () => {
      const flow = {
        ...approval("manager"),
        onUnresolved: { type: "fallback" },
      } as unknown as ReturnType<typeof approve>;

      expectIssue(
        validateApprovalPolicySemantics(policyWithFlow(flow)),
        "invalid_unresolved_strategy",
      );
    });

    it("expiresAfterが0なら拒否する", () => {
      const policy = policyWithFlow(
        approve({ key: "manager", approver, expiresAfter: { seconds: 0 } }),
      );

      expectIssue(validateApprovalPolicySemantics(policy), "invalid_expiry");
    });

    it("expiresAfterが最大値を超えたら拒否する", () => {
      const policy = policyWithFlow(
        approve({ key: "manager", approver, expiresAfter: { seconds: 11 } }),
      );

      expectIssue(validateApprovalPolicySemantics(policy, { maxExpirySeconds: 10 }), "invalid_expiry");
    });

    it("requireCommentOnの未知Decisionを拒否する", () => {
      const flow = {
        ...approval("manager"),
        requireCommentOn: ["approve", "skip"],
      } as unknown as ReturnType<typeof approve>;

      expectIssue(
        validateApprovalPolicySemantics(policyWithFlow(flow)),
        "invalid_comment_requirement",
      );
    });
  });
});

describe("validateApprovalPolicyBindingSemantics", () => {
  it("actionTypesが空なら拒否する", () => {
    expectBindingIssue(
      validateApprovalPolicyBindingSemantics(binding({ selector: { actionTypes: [] } })),
      "empty_action_selector",
    );
  });

  it("末尾prefix wildcard以外のAction type patternを拒否する", () => {
    expectBindingIssue(
      validateApprovalPolicyBindingSemantics(
        binding({ selector: { actionTypes: [branded<ActionType>("ticket.*.update")] } }),
      ),
      "invalid_action_type_pattern",
    );
  });

  it("resourceTypesを指定して空配列なら拒否する", () => {
    expectBindingIssue(
      validateApprovalPolicyBindingSemantics(
        binding({
          selector: {
            actionTypes: [branded<ActionType>("ticket.update")],
            resourceTypes: [] as ResourceType[],
          },
        }),
      ),
      "empty_resource_selector",
    );
  });

  it("compositionOrderが安全な整数でなければ拒否する", () => {
    expectBindingIssue(
      validateApprovalPolicyBindingSemantics(
        binding({ compositionOrder: Number.MAX_SAFE_INTEGER + 1 }),
      ),
      "invalid_composition_order",
    );
  });

  it("selector.whenでもallowlist外fieldを拒否する", () => {
    expectBindingIssue(
      validateApprovalPolicyBindingSemantics(
        binding({
          selector: {
            actionTypes: [branded<ActionType>("ticket.update")],
            when: eq(field("request.secret"), literal(true)),
          },
        }),
      ),
      "unknown_field_root",
    );
  });
});
