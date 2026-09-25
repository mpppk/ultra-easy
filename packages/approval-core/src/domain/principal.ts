import type { Condition } from "./condition.ts";
import type {
  ActionType,
  AgentId,
  DelegationGrantId,
  ResourceId,
  ResourceType,
  ServiceId,
  UserId,
} from "./brand.ts";

export type PrincipalType = "user" | "agent" | "service";

export type UserPrincipalRef = {
  type: "user";
  id: UserId;
};

export type AgentPrincipalRef = {
  type: "agent";
  id: AgentId;
};

export type ServicePrincipalRef = {
  type: "service";
  id: ServiceId;
};

export type PrincipalRef = UserPrincipalRef | AgentPrincipalRef | ServicePrincipalRef;

/**
 * 委任で利用可能なActionを狭めるscope。複数hopでは全hopのscopeをANDして評価する。
 * fieldが無い場合、その軸では追加制約を課さない。
 */
export type DelegationScope = {
  actionTypes?: ActionType[];
  resourceTypes?: ResourceType[];
  resourceIds?: ResourceId[];
  notBefore?: string;
  expiresAt?: string;
  /**
   * attribute restriction（#161）。共有Condition言語をdelegation namespace
   * （`action.type` / `action.resource.*` / `action.input.*` / `actor.*` / `origin.*` / `now`）で評価し、
   * 一致しない・評価できない（field欠落・型不一致等）場合は委任を拒否する（fail-closed）。
   */
  condition?: Condition;
};

export type DelegationHop = {
  delegator: PrincipalRef;
  delegatee: PrincipalRef;
  grantId: DelegationGrantId;
  scope?: DelegationScope;
};

export type Delegation = {
  chain: DelegationHop[];
};
