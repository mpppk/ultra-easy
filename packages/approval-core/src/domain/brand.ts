declare const brand: unique symbol;

/**
 * 実行時表現を変えず、TypeScript上だけで値の意味を区別するためのブランド型。
 *
 * 外部入力を直接castするためのものではない。API / DB / JSON等の境界では
 * validation後に対応するブランド型へ変換する。
 */
export type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};

export type UserId = Brand<string, "UserId">;
export type AgentId = Brand<string, "AgentId">;
export type ServiceId = Brand<string, "ServiceId">;
export type PrincipalId = UserId | AgentId | ServiceId;

export type ActionType = Brand<string, "ActionType">;
export type ActionDefinitionKey = Brand<string, "ActionDefinitionKey">;
export type ExecutorKey = Brand<string, "ExecutorKey">;
export type ResourceType = Brand<string, "ResourceType">;
export type ResourceId = Brand<string, "ResourceId">;

export type OrganizationId = Brand<string, "OrganizationId">;
export type DelegationGrantId = Brand<string, "DelegationGrantId">;
export type ClientId = Brand<string, "ClientId">;
export type AgentRunId = Brand<string, "AgentRunId">;

export type ApprovalPolicyKey = Brand<string, "ApprovalPolicyKey">;
export type ApprovalPolicyBindingId = Brand<string, "ApprovalPolicyBindingId">;
export type ApprovalRuleKey = Brand<string, "ApprovalRuleKey">;
export type ApprovalStepKey = Brand<string, "ApprovalStepKey">;

export type SchemaKey = Brand<string, "SchemaKey">;

export type RelationName = Brand<string, "RelationName">;
export type AuthorizationObjectType = Brand<string, "AuthorizationObjectType">;
export type AuthorizationObjectRef = Brand<string, "AuthorizationObjectRef">;
