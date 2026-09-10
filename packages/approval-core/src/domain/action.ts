import type { Delegation, PrincipalRef } from "./principal.ts";

export type ResourceRef = {
  type: string;
  id: string;
};

export type Action = {
  type: string;
  resource: ResourceRef;
  input: Record<string, unknown>;
};

export type ActionAuthority = {
  principal: PrincipalRef;
  delegation?: Delegation;
};

export type ActionOriginType = "ui" | "api" | "mcp" | "system";

export type ActionOrigin = {
  type: ActionOriginType;
  clientId?: string;
  caller?: PrincipalRef;
  agentRunId?: string;
};

export type ActionRequest = {
  actor: PrincipalRef;
  authority: ActionAuthority;
  action: Action;
  origin: ActionOrigin;
};
