import { Result } from "@praha/byethrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import {
  canonicalizeJson,
  parseBrand,
  sha256CanonicalJson,
  sha256Text,
  type ActionDefinition,
  type ActionExecutionGuaranteeLevel,
  type JsonObject,
  type JsonValue,
  type OrganizationId,
  type ServicePrincipalRef,
} from "@app/approval-core";
import {
  mcpActionRouteFingerprint,
  mcpCatalogExecutorKey,
  type McpActionRoute,
} from "@app/approval-mcp";
import {
  WORKFLOW_EXECUTOR_KEY,
  WORKFLOW_INPUT_SCHEMA_PREFIX,
  type WorkflowActionBinding,
} from "@app/workflow-application";
import {
  DEFAULT_SANDBOX_LIMITS,
  isJsonSchemaLite,
  parseWorkflowDefinition,
  publishWorkflowVersion,
  validateJsonSchemaLite,
  type JsonSchemaLite,
  type ProgramCapabilityManifest,
  type ProgramNodeVersion,
  type SandboxLimits,
  type WorkflowDefinition,
  type WorkflowGraph,
  type WorkflowNode,
} from "@app/workflow-core";

/**
 * Application Catalog manifest（#198）。
 *
 * 外部アプリ（例: Knowledge）がultra-easyに登録するAction / Workflowの宣言。repositoryで管理し、
 * review済みのcatalog migration（`packages/approval-d1/migrations/*_catalog.sql`）として
 * デプロイ時に適用する（docs/governance-bootstrap.md の「version-controlled migration」経路）。
 * runtimeはこの宣言からcatalogへ書き込まない。読み取り専用のview（server registry、input schema、
 * authorization relation、予約済みaction type、capability）だけを使う。
 */
export type ApplicationCatalog = {
  application: string;
  /** このアプリが所有するaction typeの名前空間（例: `knowledge.`）。Studio等からは公開できない。 */
  actionTypePrefix: string;
  /** 登録先organization（staging / productionのdeployment organization）。 */
  organizations: readonly string[];
  /** catalog migrationのpublishedAt（出力を決定的にするため固定値）。 */
  publishedAt: string;
  servers: readonly CatalogMcpServer[];
  primitives: readonly CatalogPrimitiveAction[];
  programs: readonly CatalogProgram[];
  composites: readonly CatalogCompositeAction[];
};

/** downstream MCP server。endpoint / credentialはdeployment設定だけが持ち、catalogへ保存しない。 */
export type CatalogMcpServer = {
  id: string;
  /**
   * 同じCloudflare account内のWorkerへはService Bindingで接続する（workers.dev間のfetchは
   * 使えない）。bindingがあればこちらを優先する。
   */
  serviceBinding: string;
  /** Service Binding経由で呼ぶpath（例: `/mcp`）。 */
  path: string;
  /** Service Bindingが無いdeploymentで使うendpoint URLのdeployment var名。 */
  endpointVar: string;
  /** Bearer tokenを持つWorker secret名（`wrangler secret put`のみ）。 */
  tokenSecret: string;
  /** downstreamが`dev.ultra-easy/idempotencyKey`でdedupeする（またはread-onlyな）ら`idempotent`。 */
  guaranteeLevel: ActionExecutionGuaranteeLevel;
  timeoutMs?: number;
};

/** MCP toolをbackendに持つprimitive Action。 */
export type CatalogPrimitiveAction = {
  actionType: string;
  version: number;
  resourceType: string;
  /** Authorizationでresourceに対してcheckするrelation。 */
  relation: string;
  tool: { server: string; name: string; resourceIdArgument: string };
  /** Action inputのschema。resource IDはresourceから渡すのでinputには含めない。 */
  input: Extract<JsonSchemaLite, { type: "object" }>;
};

/** Composite Actionが使う手書きProgram（sandboxで実行する。LLM生成ではない）。 */
export type CatalogProgram = {
  programId: string;
  version: number;
  description: string;
  source: string;
  inputSchema: JsonSchemaLite;
  outputSchema: JsonSchemaLite;
  requestedCapabilities: ProgramCapabilityManifest;
  runtimeProfile?: Partial<SandboxLimits>;
};

/** Workflow-backed Composite Action。 */
export type CatalogCompositeAction = {
  actionType: string;
  actionDefinitionVersion: number;
  workflowId: string;
  workflowVersion: number;
  resourceType: string;
  relation: string;
  /**
   * Workflow DefinitionのJSON（`parseWorkflowDefinition`で検証してから使う）。
   * Program Nodeの`sourceDigest`はcatalogのProgramから埋める（手で書かない）。
   */
  workflow: JsonObject;
};

export class CatalogManifestError extends Error {
  override readonly name = "CatalogManifestError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** catalog migrationの1単位（1 version）。digestが変わる再登録はimmutability違反として拒否する。 */
export type CatalogEntry = { id: string; digest: string; statements: string[] };

const CATALOG_SCHEMA_PREFIX = "catalog:";

function invalid(code: string, message: string): Result.Result<never, CatalogManifestError> {
  return Result.fail(new CatalogManifestError(code, message));
}

export function catalogActor(
  catalog: ApplicationCatalog,
): Result.Result<ServicePrincipalRef, CatalogManifestError> {
  const id = parseBrand("ServiceId", `service:catalog-${catalog.application}`);
  return Result.isSuccess(id)
    ? Result.succeed({ type: "service", id: id.value })
    : invalid("catalog_application_invalid", "application名が不正です");
}

function catalogSource(catalog: ApplicationCatalog): string {
  return `catalog:${catalog.application}`;
}

function actionDefinition(input: {
  key: string;
  version: number;
  actionType: string;
  schemaKey: string;
  schemaVersion: number;
  executorKey: string;
}): Result.Result<ActionDefinition, CatalogManifestError> {
  const key = parseBrand("ActionDefinitionKey", input.key);
  const actionType = parseBrand("ActionType", input.actionType);
  const schemaKey = parseBrand("SchemaKey", input.schemaKey);
  const executorKey = parseBrand("ExecutorKey", input.executorKey);
  if (
    Result.isFailure(key) ||
    Result.isFailure(actionType) ||
    Result.isFailure(schemaKey) ||
    Result.isFailure(executorKey)
  ) {
    return invalid("catalog_action_invalid", `${input.actionType}: Action Definitionが不正です`);
  }
  return Result.succeed({
    key: key.value,
    version: input.version,
    actionType: actionType.value,
    inputSchema: { key: schemaKey.value, version: input.schemaVersion },
    executorKey: executorKey.value,
  });
}

export function primitiveDefinition(
  primitive: CatalogPrimitiveAction,
): Result.Result<ActionDefinition, CatalogManifestError> {
  const key = `${CATALOG_SCHEMA_PREFIX}${primitive.actionType}`;
  return actionDefinition({
    key,
    version: primitive.version,
    actionType: primitive.actionType,
    schemaKey: key,
    schemaVersion: primitive.version,
    executorKey: mcpCatalogExecutorKey(primitive.tool.server),
  });
}

function compositeDefinition(
  composite: CatalogCompositeAction,
): Result.Result<ActionDefinition, CatalogManifestError> {
  return actionDefinition({
    key: `workflow:${composite.workflowId}`,
    version: composite.actionDefinitionVersion,
    actionType: composite.actionType,
    schemaKey: `${WORKFLOW_INPUT_SCHEMA_PREFIX}${composite.workflowId}`,
    schemaVersion: composite.workflowVersion,
    executorKey: String(WORKFLOW_EXECUTOR_KEY),
  });
}

function allNodes(graph: WorkflowGraph): WorkflowNode[] {
  return graph.nodes.flatMap((node) =>
    node.type === "for_each" || node.type === "while" ? [node, ...allNodes(node.body)] : [node],
  );
}

/** Program Nodeの参照（programId@version）へ、catalogのProgramのsource digestを埋める。 */
function withProgramDigests(value: JsonValue, digests: ReadonlyMap<string, string>): JsonValue {
  if (Array.isArray(value)) return value.map((item) => withProgramDigests(item, digests));
  if (typeof value !== "object" || value === null) return value;
  const mapped: JsonObject = {};
  for (const [key, child] of Object.entries(value))
    mapped[key] = withProgramDigests(child, digests);
  const program = mapped["program"];
  if (
    mapped["type"] === "program" &&
    typeof program === "object" &&
    program !== null &&
    !Array.isArray(program)
  ) {
    const programId = program["programId"];
    const version = program["version"];
    const digest =
      typeof programId === "string" && typeof version === "number"
        ? digests.get(`${programId}@${version}`)
        : undefined;
    if (digest) mapped["program"] = { ...program, sourceDigest: digest };
  }
  return mapped;
}

function parseWorkflow(
  composite: CatalogCompositeAction,
  digests: ReadonlyMap<string, string> = new Map(),
): Result.Result<WorkflowDefinition, CatalogManifestError> {
  const parsed = parseWorkflowDefinition(withProgramDigests(composite.workflow, digests));
  if (Result.isFailure(parsed)) {
    return invalid(
      "catalog_workflow_invalid",
      `${composite.actionType}: ${parsed.error.map((issue) => `${issue.location}: ${issue.message}`).join("; ")}`,
    );
  }
  if (String(parsed.value.id) !== composite.workflowId) {
    return invalid(
      "catalog_workflow_invalid",
      `${composite.actionType}: workflow idが一致しません`,
    );
  }
  return Result.succeed(parsed.value);
}

function ownedBy(catalog: ApplicationCatalog, actionType: string): boolean {
  return (
    actionType.startsWith(catalog.actionTypePrefix) &&
    actionType.length > catalog.actionTypePrefix.length
  );
}

/** 宣言の静的検証（重複・名前空間・参照整合性・schema）。 */
export function validateCatalog(catalog: ApplicationCatalog): CatalogManifestError[] {
  const issues: CatalogManifestError[] = [];
  const issue = (code: string, message: string) =>
    issues.push(new CatalogManifestError(code, message));
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(catalog.application)) {
    issue("catalog_application_invalid", "application名が不正です");
  }
  if (!catalog.actionTypePrefix.endsWith(".") || catalog.actionTypePrefix.length < 2) {
    issue("catalog_prefix_invalid", "actionTypePrefixは`<name>.`である必要があります");
  }
  if (catalog.organizations.length === 0)
    issue("catalog_organizations_empty", "organizationが必要です");
  const servers = new Set(catalog.servers.map((server) => server.id));
  if (servers.size !== catalog.servers.length)
    issue("catalog_server_duplicate", "server IDが重複しています");

  const actionTypes = new Set<string>();
  const versioned = new Set<string>();
  for (const primitive of catalog.primitives) {
    const id = `${primitive.actionType}@${primitive.version}`;
    if (versioned.has(id)) issue("catalog_action_duplicate", `${id}が重複しています`);
    versioned.add(id);
    actionTypes.add(primitive.actionType);
    if (!ownedBy(catalog, primitive.actionType)) {
      issue("catalog_action_outside_namespace", `${primitive.actionType}はnamespace外です`);
    }
    if (!Number.isInteger(primitive.version) || primitive.version < 1) {
      issue("catalog_version_invalid", `${id}: versionは1以上の整数です`);
    }
    if (!servers.has(primitive.tool.server)) {
      issue("catalog_server_unknown", `${id}: server ${primitive.tool.server}が未定義です`);
    }
    if (!isJsonSchemaLite(primitive.input) || primitive.input.type !== "object") {
      issue("catalog_input_schema_invalid", `${id}: inputはobject schemaである必要があります`);
    } else if (Object.hasOwn(primitive.input.properties ?? {}, primitive.tool.resourceIdArgument)) {
      issue(
        "catalog_input_schema_invalid",
        `${id}: resource ID argumentはinputではなくresourceから渡します`,
      );
    }
  }

  const programs = new Map<string, CatalogProgram>();
  for (const program of catalog.programs) {
    const id = `${program.programId}@${program.version}`;
    if (programs.has(id)) issue("catalog_program_duplicate", `${id}が重複しています`);
    programs.set(id, program);
    for (const action of program.requestedCapabilities.actions ?? []) {
      if (!ownedBy(catalog, action.actionType)) {
        issue("catalog_action_outside_namespace", `${id}: ${action.actionType}はnamespace外です`);
      }
    }
  }

  const workflows = new Set<string>();
  for (const composite of catalog.composites) {
    const id = `${composite.actionType}@${composite.actionDefinitionVersion}`;
    if (versioned.has(id)) issue("catalog_action_duplicate", `${id}が重複しています`);
    versioned.add(id);
    actionTypes.add(composite.actionType);
    if (!ownedBy(catalog, composite.actionType)) {
      issue("catalog_action_outside_namespace", `${composite.actionType}はnamespace外です`);
    }
    const workflowId = `${composite.workflowId}@${composite.workflowVersion}`;
    if (workflows.has(workflowId))
      issue("catalog_workflow_duplicate", `${workflowId}が重複しています`);
    workflows.add(workflowId);
    const workflow = parseWorkflow(composite);
    if (Result.isFailure(workflow)) {
      issue(workflow.error.code, workflow.error.message);
      continue;
    }
    for (const node of allNodes(workflow.value.graph)) {
      if (node.type === "action" && !ownedBy(catalog, String(node.actionType))) {
        issue(
          "catalog_action_outside_namespace",
          `${id}: ${String(node.actionType)}はnamespace外です`,
        );
      }
      if (node.type === "program") {
        const reference = `${String(node.program.programId)}@${node.program.version}`;
        if (!programs.has(reference)) {
          issue("catalog_program_unknown", `${id}: Program ${reference}が未定義です`);
        }
      }
      if (node.type === "llm") {
        issue("catalog_llm_not_supported", `${id}: LLM Nodeはcatalog経由では未対応です（#201）`);
      }
    }
  }
  for (const node of catalog.composites.flatMap((composite) => {
    const workflow = parseWorkflow(composite);
    return Result.isSuccess(workflow) ? allNodes(workflow.value.graph) : [];
  })) {
    if (node.type === "action" && !actionTypes.has(String(node.actionType))) {
      issue("catalog_action_unknown", `${String(node.actionType)}がcatalogに未定義です`);
    }
  }
  return issues;
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlValue(value: string | number): string {
  return typeof value === "number" ? String(value) : sqlQuote(value);
}

function json(value: unknown): Result.Result<string, CatalogManifestError> {
  const canonical = canonicalizeJson(value as JsonValue);
  return Result.isSuccess(canonical)
    ? canonical
    : invalid("catalog_json_invalid", canonical.error.message);
}

function insert(table: string, row: Record<string, string | number>): string {
  const columns = Object.keys(row);
  return `INSERT INTO ${table} (${columns.join(", ")})\nVALUES (${columns
    .map((column) => sqlValue(row[column] as string | number))
    .join(", ")});`;
}

async function entry(
  id: string,
  statements: string[],
): Result.ResultAsync<CatalogEntry, CatalogManifestError> {
  const digest = await sha256CanonicalJson({ id, statements });
  if (Result.isFailure(digest)) return invalid("catalog_digest_failed", digest.error.message);
  return Result.succeed({ id, digest: String(digest.value), statements });
}

async function programVersion(
  catalog: ApplicationCatalog,
  program: CatalogProgram,
): Result.ResultAsync<ProgramNodeVersion, CatalogManifestError> {
  const digest = await sha256Text(program.source);
  if (Result.isFailure(digest)) return invalid("catalog_digest_failed", digest.error.message);
  const actor = catalogActor(catalog);
  if (Result.isFailure(actor)) return actor;
  return Result.succeed({
    programId: program.programId,
    version: program.version,
    language: "javascript",
    source: program.source,
    sourceDigest: String(digest.value),
    inputSchema: program.inputSchema,
    outputSchema: program.outputSchema,
    requestedCapabilities: program.requestedCapabilities,
    runtimeProfile: { ...DEFAULT_SANDBOX_LIMITS, ...program.runtimeProfile },
    generator: { kind: "manual", generatedAt: catalog.publishedAt },
    description: program.description,
    publishedAt: catalog.publishedAt,
    publishedBy: String(actor.value.id),
  });
}

/** catalogのProgramから、Program Nodeの`sourceDigest`を埋めたWorkflow Definitionを返す。 */
export async function resolvedWorkflow(
  catalog: ApplicationCatalog,
  composite: CatalogCompositeAction,
): Result.ResultAsync<WorkflowDefinition, CatalogManifestError> {
  const digests = new Map<string, string>();
  for (const program of catalog.programs) {
    const version = await programVersion(catalog, program);
    if (Result.isFailure(version)) return version;
    digests.set(`${program.programId}@${program.version}`, version.value.sourceDigest);
  }
  return parseWorkflow(composite, digests);
}

/**
 * catalogをcatalog migrationのentryへ描画する（organizationごとのplain INSERT）。
 * plain INSERTなので、同じkey / versionが既に別内容で存在するとmigrationごと失敗する（fail-closed）。
 */
export async function renderCatalogEntries(
  catalog: ApplicationCatalog,
): Result.ResultAsync<CatalogEntry[], CatalogManifestError> {
  const issues = validateCatalog(catalog);
  if (issues.length > 0) {
    return invalid(
      "catalog_invalid",
      issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"),
    );
  }
  const actor = catalogActor(catalog);
  if (Result.isFailure(actor)) return actor;
  const actorJson = json(actor.value);
  if (Result.isFailure(actorJson)) return actorJson;
  const source = catalogSource(catalog);
  const organizations: OrganizationId[] = [];
  for (const organization of catalog.organizations) {
    const parsed = parseBrand("OrganizationId", organization);
    if (Result.isFailure(parsed)) return invalid("catalog_organization_invalid", organization);
    organizations.push(parsed.value);
  }
  const entries: CatalogEntry[] = [];

  for (const primitive of catalog.primitives) {
    const defined = primitiveDefinition(primitive);
    if (Result.isFailure(defined)) return defined;
    const definition = defined.value;
    const resourceType = parseBrand("ResourceType", primitive.resourceType);
    if (Result.isFailure(resourceType)) {
      return invalid("catalog_action_invalid", `${primitive.actionType}: resourceTypeが不正です`);
    }
    const definitionJson = json(definition);
    if (Result.isFailure(definitionJson)) return definitionJson;
    const statements: string[] = [];
    for (const organization of organizations) {
      const route: McpActionRoute = {
        organizationId: organization,
        actionDefinitionKey: definition.key,
        actionDefinitionVersion: definition.version,
        actionType: definition.actionType,
        target: { mcpServerId: primitive.tool.server, toolName: primitive.tool.name },
        argumentMapping: {
          resourceType: resourceType.value,
          resourceIdArgument: primitive.tool.resourceIdArgument,
        },
      };
      const fingerprint = await mcpActionRouteFingerprint(route);
      if (Result.isFailure(fingerprint))
        return invalid("catalog_digest_failed", fingerprint.error.message);
      const routeJson = json(route);
      if (Result.isFailure(routeJson)) return routeJson;
      statements.push(
        insert("published_action_definitions", {
          organization_id: organization,
          definition_key: String(definition.key),
          version: definition.version,
          action_type: String(definition.actionType),
          definition_json: definitionJson.value,
          actor_json: actorJson.value,
          source_action_request_id: source,
          published_at: catalog.publishedAt,
        }),
        insert("mcp_action_routes", {
          organization_id: organization,
          action_definition_key: String(definition.key),
          action_definition_version: definition.version,
          action_type: String(definition.actionType),
          route_json: routeJson.value,
          route_fingerprint: fingerprint.value,
          source,
          registered_at: catalog.publishedAt,
        }),
      );
    }
    const rendered = await entry(`action:${primitive.actionType}@${primitive.version}`, statements);
    if (Result.isFailure(rendered)) return rendered;
    entries.push(rendered.value);
  }

  for (const program of catalog.programs) {
    const version = await programVersion(catalog, program);
    if (Result.isFailure(version)) return version;
    const versionJson = json(version.value);
    if (Result.isFailure(versionJson)) return versionJson;
    const rendered = await entry(
      `program:${program.programId}@${program.version}`,
      organizations.map((organization) =>
        insert("workflow_programs", {
          organization_id: organization,
          program_id: program.programId,
          version: program.version,
          source_digest: version.value.sourceDigest,
          version_json: versionJson.value,
          published_at: catalog.publishedAt,
        }),
      ),
    );
    if (Result.isFailure(rendered)) return rendered;
    entries.push(rendered.value);
  }

  for (const composite of catalog.composites) {
    const workflow = await resolvedWorkflow(catalog, composite);
    if (Result.isFailure(workflow)) return workflow;
    const published = await publishWorkflowVersion({
      definition: workflow.value,
      latestVersion: composite.workflowVersion - 1,
      publishedAt: catalog.publishedAt,
      publishedBy: actor.value,
    });
    if (Result.isFailure(published)) {
      return invalid(
        "catalog_workflow_invalid",
        `${composite.actionType}: ${published.error.message} ${JSON.stringify(published.error.issues ?? [])}`,
      );
    }
    const version = published.value;
    const defined = compositeDefinition(composite);
    if (Result.isFailure(defined)) return defined;
    const definition = defined.value;
    const versionJson = json(version);
    const definitionJson = json(definition);
    if (Result.isFailure(versionJson)) return versionJson;
    if (Result.isFailure(definitionJson)) return definitionJson;
    const statements: string[] = [];
    for (const organization of organizations) {
      const binding: WorkflowActionBinding = {
        organizationId: organization,
        actionDefinitionKey: definition.key,
        actionDefinitionVersion: definition.version,
        actionType: definition.actionType,
        workflowDefinitionId: version.definitionId,
        workflowVersion: version.version,
        workflowChecksum: version.checksum,
        createdAt: catalog.publishedAt,
      };
      statements.push(
        insert("workflow_versions", {
          organization_id: organization,
          definition_id: String(version.definitionId),
          version: version.version,
          checksum: String(version.checksum),
          version_json: versionJson.value,
          published_at: catalog.publishedAt,
        }),
        insert("workflow_action_bindings", {
          organization_id: organization,
          action_definition_key: String(binding.actionDefinitionKey),
          action_definition_version: binding.actionDefinitionVersion,
          action_type: String(binding.actionType),
          workflow_definition_id: String(binding.workflowDefinitionId),
          workflow_version: binding.workflowVersion,
          workflow_checksum: String(binding.workflowChecksum),
          created_at: binding.createdAt,
        }),
        insert("published_action_definitions", {
          organization_id: organization,
          definition_key: String(definition.key),
          version: definition.version,
          action_type: String(definition.actionType),
          definition_json: definitionJson.value,
          actor_json: actorJson.value,
          source_action_request_id: source,
          published_at: catalog.publishedAt,
        }),
      );
    }
    const rendered = await entry(
      `composite:${composite.actionType}@${composite.actionDefinitionVersion}`,
      statements,
    );
    if (Result.isFailure(rendered)) return rendered;
    entries.push(rendered.value);
  }
  return Result.succeed(entries);
}

const MARKER = /^-- catalog-entry: (\S+) (sha256:[0-9a-f]{64})$/gm;

/** 既存catalog migrationに記録されたentry（id → digest）。 */
export function parseCatalogMarkers(sql: string): Map<string, string> {
  const markers = new Map<string, string>();
  for (const match of sql.matchAll(MARKER)) markers.set(match[1] as string, match[2] as string);
  return markers;
}

/**
 * 既存migrationに無いentryだけを新しいmigrationにする。同じidが別digestで記録済みなら
 * 登録済みversionの書き換え（immutability違反）として拒否する。
 */
export function planCatalogMigration(input: {
  application: string;
  entries: readonly CatalogEntry[];
  existing: ReadonlyMap<string, string>;
}): Result.Result<{ entries: CatalogEntry[]; sql: string | null }, CatalogManifestError> {
  const conflicts = input.entries.filter(
    (entry) => input.existing.has(entry.id) && input.existing.get(entry.id) !== entry.digest,
  );
  if (conflicts.length > 0) {
    return invalid(
      "catalog_entry_immutable",
      `登録済みversionの内容が変わっています（新しいversionを追加してください）: ${conflicts
        .map((entry) => entry.id)
        .join(", ")}`,
    );
  }
  const pending = input.entries.filter((entry) => !input.existing.has(entry.id));
  if (pending.length === 0) return Result.succeed({ entries: [], sql: null });
  const lines = [
    `-- Generated by apps/approval-api/scripts/generate-catalog-migration.ts from the`,
    `-- ${input.application} Application Catalog (apps/approval-api/src/catalog). Do not edit by hand:`,
    `-- registered versions are immutable; add a new version to the catalog and regenerate.`,
    `-- Plain INSERTs: an existing row with the same key fails the migration (fail-closed).`,
  ];
  for (const entry of pending) {
    lines.push("", `-- catalog-entry: ${entry.id} ${entry.digest}`, ...entry.statements);
  }
  return Result.succeed({ entries: pending, sql: `${lines.join("\n")}\n` });
}

/** runtime view: catalogの全primitive / composite action type。 */
function catalogActionTypes(catalog: ApplicationCatalog): string[] {
  return [
    ...catalog.primitives.map((primitive) => primitive.actionType),
    ...catalog.composites.map((composite) => composite.actionType),
  ];
}

/** runtime view: アプリが所有するaction typeか（Studio等の別経路からのpublishを拒否する）。 */
export function reservedActionTypeOwner(
  catalogs: readonly ApplicationCatalog[],
  actionType: string,
): string | null {
  return (
    catalogs.find(
      (catalog) => ownedBy(catalog, actionType) || catalogActionTypes(catalog).includes(actionType),
    )?.application ?? null
  );
}

/** runtime view: catalogが所有するWorkflow Definition / Programか（Studioから版を追加させない）。 */
export function catalogOwnsWorkflowArtifact(
  catalogs: readonly ApplicationCatalog[],
  artifact: { workflowDefinitionId?: string; programId?: string },
): boolean {
  return catalogs.some(
    (catalog) =>
      catalog.composites.some(
        (composite) => composite.workflowId === artifact.workflowDefinitionId,
      ) || catalog.programs.some((program) => program.programId === artifact.programId),
  );
}

/** runtime view: Authorizationでcheckするrelation（未登録はnull = fail-closed）。 */
export function catalogActionRelation(
  catalogs: readonly ApplicationCatalog[],
  action: { type: string; resourceType: string },
): string | null {
  for (const catalog of catalogs) {
    const declared = [...catalog.primitives, ...catalog.composites].find(
      (candidate) =>
        candidate.actionType === action.type && candidate.resourceType === action.resourceType,
    );
    if (declared) return declared.relation;
  }
  return null;
}

/** runtime view: `catalog:<actionType>` input schemaの解決（version一致だけ）。 */
export function catalogInputSchema(
  catalogs: readonly ApplicationCatalog[],
  reference: { key: string; version: number },
): StandardSchemaV1 | null {
  if (!reference.key.startsWith(CATALOG_SCHEMA_PREFIX)) return null;
  const actionType = reference.key.slice(CATALOG_SCHEMA_PREFIX.length);
  const primitive = catalogs
    .flatMap((catalog) => catalog.primitives)
    .find(
      (candidate) => candidate.actionType === actionType && candidate.version === reference.version,
    );
  if (!primitive) return null;
  const schema = primitive.input;
  return {
    "~standard": {
      version: 1,
      vendor: "ultra-easy-catalog",
      validate(value: unknown) {
        const issues = validateJsonSchemaLite(schema, value);
        return issues.length > 0
          ? {
              issues: issues.map((issue) => ({
                message: `${issue.path}: ${issue.message}`,
              })),
            }
          : { value };
      },
    },
  };
}

/** runtime view: catalogのProgramが要求するAction capability（組織CapabilityPolicyへ加える）。 */
export function catalogCapabilityActions(
  catalogs: readonly ApplicationCatalog[],
): { actionType: string; resourceType?: string }[] {
  return catalogs.flatMap((catalog) =>
    catalog.programs.flatMap((program) => program.requestedCapabilities.actions ?? []),
  );
}
