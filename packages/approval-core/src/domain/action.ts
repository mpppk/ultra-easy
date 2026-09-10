import type { ActionType, AgentRunId, ClientId, ResourceId, ResourceType } from "./brand.ts";
import type { Delegation, PrincipalRef } from "./principal.ts";

export type ResourceRef = {
  type: ResourceType;
  id: ResourceId;
};

export type Action = {
  type: ActionType;
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
  clientId?: ClientId;
  caller?: PrincipalRef;
  agentRunId?: AgentRunId;
};

export type ActionRequest = {
  actor: PrincipalRef;
  authority: ActionAuthority;
  action: Action;
  origin: ActionOrigin;
};
