import { Result } from "@praha/byethrow";

import { sha256CanonicalJson } from "@app/approval-core";
import type {
  Action,
  ActionDefinitionResolver,
  ActionType,
  ExecutorKey,
  JsonValue,
  OrganizationId,
  ResourceId,
  ResourceType,
} from "@app/approval-core";

import type { McpJsonSchema, McpToolDefinition } from "./protocol.ts";

export class McpGatewayError extends Error {
  readonly name = "McpGatewayError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

/**
 * ActionType ↔ Gateway上の公開MCP tool ↔ downstream MCP toolの1:1 binding。
 *
 * MCP固有情報はcoreの `ActionDefinition` へ入れず、このadapter側bindingだけが持つ。
 * transport / session / client stateはbindingへ含めない。
 * routing（target / argumentMapping）を変える場合は `version` を上げ、
 * 承認待ちのActionRequestは作成時のroute snapshot（`McpRouteSnapshot`）で実行する。
 */
export type McpToolBinding = {
  id: string;
  version: number;
  organizationId: OrganizationId;
  /** `active` のbindingだけがGatewayへ公開・解決される。 */
  status: "active" | "inactive";
  actionType: ActionType;
  exposedTool: {
    name: string;
    title?: string;
    description?: string;
    inputSchema: McpJsonSchema;
    outputSchema?: McpJsonSchema;
    annotations?: Record<string, unknown>;
  };
  target: {
    mcpServerId: string;
    toolName: string;
  };
  /**
   * MCP arguments → Action(resource + input)の正規化。
   * `resourceIdArgument` の値をresource.idにし、残りのargumentsをAction inputにする。
   * actor / authority / organization等のtrusted identityはargumentsから一切読まない。
   */
  argumentMapping: {
    resourceType: ResourceType;
    resourceIdArgument: string;
  };
};

export type McpToolBindingIssue = {
  bindingId: string;
  code:
    | "invalid_binding_id"
    | "invalid_version"
    | "invalid_tool_name"
    | "invalid_input_schema"
    | "invalid_target"
    | "invalid_argument_mapping"
    | "duplicate_binding_id"
    | "duplicate_tool_name"
    | "duplicate_action_type";
  message: string;
};

export class McpToolBindingValidationError extends Error {
  readonly name = "McpToolBindingValidationError";
  readonly code = "mcp_tool_binding_invalid";

  constructor(readonly issues: readonly McpToolBindingIssue[]) {
    super(issues.map((issue) => `${issue.bindingId}: ${issue.message}`).join("; "));
  }
}

/** MCP tool name: 1〜128文字、ASCII英数字と `_` `-` `.` のみ。 */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 単一bindingの静的検証。
 *
 * input schemaの整合性方針: Gatewayが公開する `inputSchema` はclient向けのwire contractであり、
 * 実行可否を決める正本はAction Definitionのinput schema（prepareで必ずvalidation）である。
 * binding側では、公開schemaがobjectであり、resource IDを運ぶargumentを必須stringとして
 * 宣言していることだけを保証する。
 */
export function validateMcpToolBinding(binding: McpToolBinding): McpToolBindingIssue[] {
  const issues: McpToolBindingIssue[] = [];
  const issue = (code: McpToolBindingIssue["code"], message: string) =>
    issues.push({ bindingId: binding.id, code, message });

  if (binding.id.length === 0) issue("invalid_binding_id", "binding idが空です");
  if (!Number.isInteger(binding.version) || binding.version < 1) {
    issue("invalid_version", "versionは1以上の整数である必要があります");
  }
  if (!TOOL_NAME_PATTERN.test(binding.exposedTool.name)) {
    issue("invalid_tool_name", `公開tool名が不正です: ${binding.exposedTool.name}`);
  }
  if (!TOOL_NAME_PATTERN.test(binding.target.toolName) || binding.target.mcpServerId.length === 0) {
    issue("invalid_target", "downstream targetのserver ID / tool名が不正です");
  }

  const schema = binding.exposedTool.inputSchema;
  const argument = binding.argumentMapping.resourceIdArgument;
  if (argument.length === 0 || String(binding.argumentMapping.resourceType).length === 0) {
    issue("invalid_argument_mapping", "resourceType / resourceIdArgumentが空です");
  }
  if (!isRecord(schema) || schema.type !== "object") {
    issue("invalid_input_schema", "inputSchemaはtype=objectのJSON Schemaである必要があります");
    return issues;
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const property = properties[argument];
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!isRecord(property) || property.type !== "string" || !required.includes(argument)) {
    issue(
      "invalid_input_schema",
      `inputSchemaはresource ID argument '${argument}' を必須stringとして宣言する必要があります`,
    );
  }
  return issues;
}

/** binding集合のfail-fast検証。active bindingはorganization内でtool名・ActionTypeとも1:1。 */
export function validateMcpToolBindings(
  bindings: readonly McpToolBinding[],
): Result.Result<void, McpToolBindingValidationError> {
  const issues = bindings.flatMap(validateMcpToolBinding);
  const ids = new Set<string>();
  const toolNames = new Map<string, string>();
  const actionTypes = new Map<string, string>();

  for (const binding of bindings) {
    const idKey = JSON.stringify([String(binding.organizationId), binding.id, binding.version]);
    if (ids.has(idKey)) {
      issues.push({
        bindingId: binding.id,
        code: "duplicate_binding_id",
        message: `binding id/versionが重複しています: ${binding.id}@${binding.version}`,
      });
    }
    ids.add(idKey);
    if (binding.status !== "active") continue;

    const toolKey = JSON.stringify([String(binding.organizationId), binding.exposedTool.name]);
    const existingTool = toolNames.get(toolKey);
    if (existingTool !== undefined) {
      issues.push({
        bindingId: binding.id,
        code: "duplicate_tool_name",
        message: `公開tool名 '${binding.exposedTool.name}' が ${existingTool} と重複しています`,
      });
    }
    toolNames.set(toolKey, binding.id);

    const actionKey = JSON.stringify([String(binding.organizationId), String(binding.actionType)]);
    const existingAction = actionTypes.get(actionKey);
    if (existingAction !== undefined) {
      issues.push({
        bindingId: binding.id,
        code: "duplicate_action_type",
        message: `ActionType '${String(binding.actionType)}' が ${existingAction} と重複しています`,
      });
    }
    actionTypes.set(actionKey, binding.id);
  }

  return issues.length === 0
    ? Result.succeed(undefined)
    : Result.fail(new McpToolBindingValidationError(issues));
}

/**
 * bindingが指すActionTypeがpublish済みAction Definitionを持ち、
 * downstream MCP executorで実行されるexecutorKeyであることを確認する。
 */
export async function validateMcpToolBindingsAgainstActionDefinitions(input: {
  bindings: readonly McpToolBinding[];
  resolver: ActionDefinitionResolver;
  mcpExecutorKey: ExecutorKey;
}): Result.ResultAsync<void, McpToolBindingValidationError> {
  const issues: McpToolBindingIssue[] = [];
  for (const binding of input.bindings) {
    if (binding.status !== "active") continue;
    const resolved = await input.resolver.resolve(binding.actionType);
    if (Result.isFailure(resolved) || !resolved.value) {
      issues.push({
        bindingId: binding.id,
        code: "invalid_target",
        message: Result.isFailure(resolved)
          ? `Action Definitionを解決できません: ${resolved.error.message}`
          : `publishされたAction Definitionがありません: ${String(binding.actionType)}`,
      });
      continue;
    }
    if (String(resolved.value.actionType) !== String(binding.actionType)) {
      issues.push({
        bindingId: binding.id,
        code: "invalid_target",
        message: "Action DefinitionのactionTypeがbindingと一致しません",
      });
    }
    if (String(resolved.value.executorKey) !== String(input.mcpExecutorKey)) {
      issues.push({
        bindingId: binding.id,
        code: "invalid_target",
        message: `Action DefinitionのexecutorKeyがMCP executor (${String(input.mcpExecutorKey)}) ではありません`,
      });
    }
  }
  return issues.length === 0
    ? Result.succeed(undefined)
    : Result.fail(new McpToolBindingValidationError(issues));
}

export interface McpToolBindingRegistry {
  /** organizationのactive bindingだけを返す。tenant境界を越えたbindingは返さない。 */
  listActive(input: {
    organizationId: OrganizationId;
  }): Result.ResultAsync<readonly McpToolBinding[], McpGatewayError>;

  resolveByToolName(input: {
    organizationId: OrganizationId;
    toolName: string;
  }): Result.ResultAsync<McpToolBinding | null, McpGatewayError>;

  resolveByActionType(input: {
    organizationId: OrganizationId;
    actionType: ActionType;
  }): Result.ResultAsync<McpToolBinding | null, McpGatewayError>;
}

/** 設定値（GitOps / IaC）から構築するimmutable registry。構築時にfail-fast検証する。 */
export class StaticMcpToolBindingRegistry implements McpToolBindingRegistry {
  private constructor(private readonly bindings: readonly McpToolBinding[]) {}

  static create(
    bindings: readonly McpToolBinding[],
  ): Result.Result<StaticMcpToolBindingRegistry, McpToolBindingValidationError> {
    const validated = validateMcpToolBindings(bindings);
    if (Result.isFailure(validated)) return validated;
    return Result.succeed(new StaticMcpToolBindingRegistry(structuredClone([...bindings])));
  }

  private active(organizationId: OrganizationId): McpToolBinding[] {
    return this.bindings
      .filter(
        (binding) =>
          binding.status === "active" && String(binding.organizationId) === String(organizationId),
      )
      .map((binding) => structuredClone(binding));
  }

  listActive(input: { organizationId: OrganizationId }) {
    return Promise.resolve(Result.succeed(this.active(input.organizationId)));
  }

  resolveByToolName(input: { organizationId: OrganizationId; toolName: string }) {
    return Promise.resolve(
      Result.succeed(
        this.active(input.organizationId).find(
          (binding) => binding.exposedTool.name === input.toolName,
        ) ?? null,
      ),
    );
  }

  resolveByActionType(input: { organizationId: OrganizationId; actionType: ActionType }) {
    return Promise.resolve(
      Result.succeed(
        this.active(input.organizationId).find(
          (binding) => String(binding.actionType) === String(input.actionType),
        ) ?? null,
      ),
    );
  }
}

export function mcpToolDefinition(binding: McpToolBinding): McpToolDefinition {
  const tool = binding.exposedTool;
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: structuredClone(tool.inputSchema),
    ...(tool.outputSchema !== undefined
      ? { outputSchema: structuredClone(tool.outputSchema) }
      : {}),
    ...(tool.annotations !== undefined ? { annotations: structuredClone(tool.annotations) } : {}),
  };
}

/** routingとtool contractを識別するfingerprint（statusは含めない）。 */
export async function mcpToolBindingFingerprint(
  binding: McpToolBinding,
): Result.ResultAsync<string, McpGatewayError> {
  const digest = await sha256CanonicalJson({
    id: binding.id,
    version: binding.version,
    organizationId: String(binding.organizationId),
    actionType: String(binding.actionType),
    exposedTool: binding.exposedTool,
    target: binding.target,
    argumentMapping: binding.argumentMapping,
  } as unknown as JsonValue);
  if (Result.isFailure(digest)) {
    return Result.fail(
      new McpGatewayError("binding_fingerprint_failed", false, digest.error.message),
    );
  }
  return Result.succeed(String(digest.value));
}

export type McpArgumentMappingError = {
  message: string;
  path?: string;
};

/** MCP arguments → Action。trusted identityはここで一切扱わない。 */
export function mapMcpToolArguments(
  binding: McpToolBinding,
  args: Record<string, unknown> | undefined,
): Result.Result<Action, McpArgumentMappingError> {
  const values = args ?? {};
  const argument = binding.argumentMapping.resourceIdArgument;
  const resourceId = values[argument];
  if (typeof resourceId !== "string" || resourceId.length === 0) {
    return Result.fail({
      message: `argument '${argument}' must be a non-empty string`,
      path: argument,
    });
  }
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key !== argument) input[key] = value;
  }
  return Result.succeed({
    type: binding.actionType,
    resource: {
      type: binding.argumentMapping.resourceType,
      id: resourceId as ResourceId,
    },
    input,
  });
}
