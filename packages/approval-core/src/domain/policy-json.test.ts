import { describe, expect, it } from "vite-plus/test";

import type {
  ApprovalPolicyDefinition,
  ApprovalPolicyKey,
  ApprovalRuleKey,
  ApprovalStepKey,
  AuthorizationObjectRef,
  RelationName,
} from "./index.ts";

describe("Approval PolicyのJSON契約", () => {
  it("AC-M0-002: Policy ASTはJSONへの保存・復元で構造を失わない", () => {
    const policy = {
      schemaVersion: 1,
      key: "ticket-critical-approval" as ApprovalPolicyKey,
      name: "Critical ticket approval",
      rules: [
        {
          key: "critical" as ApprovalRuleKey,
          when: {
            type: "comparison",
            left: { type: "field", path: "action.input.priority" },
            operator: "eq",
            right: { type: "literal", value: "critical" },
          },
          flow: {
            type: "serial",
            children: [
              {
                type: "approval",
                key: "manager" as ApprovalStepKey,
                purpose: "business_approval",
                approver: {
                  type: "principal_relation",
                  principal: { type: "authority_principal" },
                  relation: "manager" as RelationName,
                },
                selfApproval: { mode: "deny" },
              },
              {
                type: "parallel",
                strategy: "any",
                children: [
                  {
                    type: "approval",
                    key: "security" as ApprovalStepKey,
                    purpose: "security_approval",
                    approver: {
                      type: "relation",
                      object: {
                        type: "literal",
                        object: "organization:acme" as AuthorizationObjectRef,
                      },
                      relation: "security_approver" as RelationName,
                    },
                  },
                  {
                    type: "approval",
                    key: "compliance" as ApprovalStepKey,
                    purpose: "compliance_approval",
                    approver: {
                      type: "relation",
                      object: {
                        type: "literal",
                        object: "organization:acme" as AuthorizationObjectRef,
                      },
                      relation: "compliance_approver" as RelationName,
                    },
                  },
                ],
              },
            ],
          },
        },
        {
          key: "otherwise" as ApprovalRuleKey,
          when: { type: "always" },
          flow: { type: "none" },
        },
      ],
    } satisfies ApprovalPolicyDefinition;

    // brandはTypeScript上だけの情報なのでJSON表現には影響しない。
    // Policy ASTはDBへJSONとして保存・復元される前提で、functionやclass instance等の
    // runtime-onlyな情報に依存せず、round-trip後も同じ構造であることを確認する。
    const serialized = JSON.stringify(policy);
    const restored = JSON.parse(serialized) as unknown;

    expect(restored).toEqual(policy);
  });
});
