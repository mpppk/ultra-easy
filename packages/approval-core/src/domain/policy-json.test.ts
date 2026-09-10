import { describe, expect, it } from "vite-plus/test";

import type { ApprovalPolicyDefinition } from "./index.ts";

describe("Approval PolicyのJSON契約", () => {
  it("AC-M0-002: Policy ASTはJSONへの保存・復元で構造を失わない", () => {
    const policy = {
      schemaVersion: 1,
      key: "ticket-critical-approval",
      name: "Critical ticket approval",
      rules: [
        {
          key: "critical",
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
                key: "manager",
                purpose: "business_approval",
                approver: {
                  type: "principal_relation",
                  principal: { type: "authority_principal" },
                  relation: "manager",
                },
                selfApproval: { mode: "deny" },
              },
              {
                type: "parallel",
                strategy: "any",
                children: [
                  {
                    type: "approval",
                    key: "security",
                    purpose: "security_approval",
                    approver: {
                      type: "relation",
                      object: { type: "literal", object: "organization:acme" },
                      relation: "security_approver",
                    },
                  },
                  {
                    type: "approval",
                    key: "compliance",
                    purpose: "compliance_approval",
                    approver: {
                      type: "relation",
                      object: { type: "literal", object: "organization:acme" },
                      relation: "compliance_approver",
                    },
                  },
                ],
              },
            ],
          },
        },
        {
          key: "otherwise",
          when: { type: "always" },
          flow: { type: "none" },
        },
      ],
    } satisfies ApprovalPolicyDefinition;

    // Policy ASTはDBへJSONとして保存・復元される前提なので、
    // functionやclass instance等のruntime-onlyな情報に依存せず、
    // JSON round-trip後も同じ構造であることをsmoke testする。
    const serialized = JSON.stringify(policy);
    const restored = JSON.parse(serialized) as unknown;

    expect(restored).toEqual(policy);
  });
});
