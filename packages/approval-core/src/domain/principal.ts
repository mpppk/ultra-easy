export type PrincipalType = "user" | "agent" | "service";

export type PrincipalRef = {
  type: PrincipalType;
  id: string;
};

export type DelegationHop = {
  delegator: PrincipalRef;
  delegatee: PrincipalRef;
  grantId: string;
};

export type Delegation = {
  chain: DelegationHop[];
};
