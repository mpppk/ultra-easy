import type { AgentId, DelegationGrantId, ServiceId, UserId } from "./brand.ts";

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

export type DelegationHop = {
  delegator: PrincipalRef;
  delegatee: PrincipalRef;
  grantId: DelegationGrantId;
};

export type Delegation = {
  chain: DelegationHop[];
};
