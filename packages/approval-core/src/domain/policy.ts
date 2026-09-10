import type { AlwaysCondition, Condition } from "./condition.ts";
import type { FlowDefinition } from "./flow.ts";

export type ApprovalRuleDefinition = {
  key: string;
  when: Condition | AlwaysCondition;
  flow: FlowDefinition;
};

export type ApprovalPolicyDefinition = {
  schemaVersion: 1;
  key: string;
  name: string;
  description?: string;
  rules: ApprovalRuleDefinition[];
};

export type ApprovalPolicySelector = {
  actionTypes: string[];
  resourceTypes?: string[];
  when?: Condition;
};

export type ApprovalPolicyBinding = {
  id: string;
  organizationId: string;
  policyKey: string;
  selector: ApprovalPolicySelector;
  compositionOrder?: number;
  enabled: boolean;
};
