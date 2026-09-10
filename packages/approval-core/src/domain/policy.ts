import type {
  ActionType,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ApprovalRuleKey,
  OrganizationId,
  ResourceType,
} from "./brand.ts";
import type { AlwaysCondition, Condition } from "./condition.ts";
import type { FlowDefinition } from "./flow.ts";

export type ApprovalRuleDefinition = {
  key: ApprovalRuleKey;
  when: Condition | AlwaysCondition;
  flow: FlowDefinition;
};

export type ApprovalPolicyDefinition = {
  schemaVersion: 1;
  key: ApprovalPolicyKey;
  name: string;
  description?: string;
  rules: ApprovalRuleDefinition[];
};

export type ApprovalPolicySelector = {
  actionTypes: ActionType[];
  resourceTypes?: ResourceType[];
  when?: Condition;
};

export type ApprovalPolicyBinding = {
  id: ApprovalPolicyBindingId;
  organizationId: OrganizationId;
  policyKey: ApprovalPolicyKey;
  selector: ApprovalPolicySelector;
  compositionOrder?: number;
  enabled: boolean;
};
