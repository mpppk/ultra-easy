import { Result } from "@praha/byethrow";

import type { ActionDefinition } from "./action-definition.ts";
import { sha256CanonicalJson } from "./canonical-json.ts";
import type { CanonicalJsonError } from "./canonical-json.ts";
import { isAllowedPolicyFieldPath } from "./condition-evaluator.ts";
import type {
  ActionFingerprint,
  ActionRequestId,
  ApprovalBindingFingerprint,
  ApprovalPlanChecksum,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ApprovalRuleKey,
  ApprovalStepKey,
  AuthorizationObjectRef,
  EvaluationSnapshotChecksum,
  MaterializedStepId,
  OrganizationId,
  RelationName,
  Sha256Digest,
  SnapshotApproverCohortId,
  UserId,
} from "./domain/brand.ts";
import type { ValueExpression } from "./domain/condition.ts";
import type { PolicyEvaluationContext } from "./domain/evaluation.ts";
import type {
  ApprovalPurpose,
  ApprovalStepDefinition,
  CandidateCompletion,
  FlowConstraints,
  FlowDefinition,
  PrincipalExpression,
} from "./domain/flow.ts";
import type { JsonObject, JsonValue } from "./domain/json.ts";
import type {
  ApprovalPolicyBinding,
  ApprovalPolicyDefinition,
  ApprovalPolicySelector,
} from "./domain/policy.ts";
import type { PrincipalRef } from "./domain/principal.ts";
import { evaluatePolicy, resolvePolicyBindings } from "./policy-evaluator.ts";

export const INTERPRETER_SEMANTICS_VERSION = 1;

export type VersionedApprovalPolicyBinding = {
  binding: ApprovalPolicyBinding;
  policyVersion: number;
  policy: ApprovalPolicyDefinition;
};

export type ActionDefinitionSnapshot = {
  key: ActionDefinition["key"];
  version: number;
  actionType: ActionDefinition["actionType"];
  inputSchema: ActionDefinition["inputSchema"];
  executorKey: ActionDefinition["executorKey"];
  normalizationVersion?: number;
  derivedAttributeCatalog?: ActionDefinition["derivedAttributeCatalog"];
};

export type MaterializedActionSnapshot = {
  definition: ActionDefinitionSnapshot;
  type: PolicyEvaluationContext["action"]["type"];
  resource: PolicyEvaluationContext["action"]["resource"];
  input: JsonObject;
};

export type EvaluationSnapshot = {
  actor: PolicyEvaluationContext["actor"];
  authority: PolicyEvaluationContext["authority"];
  origin: PolicyEvaluationContext["origin"];
  organization: PolicyEvaluationContext["organization"];
  attributes?: PolicyEvaluationContext["attributes"];
  evaluatedAt: string;
};

export type PolicyBindingSnapshotOutcome =
  | { type: "not_matched" }
  | { type: "matched"; ruleKey: ApprovalRuleKey; flowType: FlowDefinition["type"] };

export type PolicyBindingSnapshot = {
  bindingId: ApprovalPolicyBindingId;
  policyKey: ApprovalPolicyKey;
  policyVersion: number;
  policyDefinitionChecksum: Sha256Digest;
  selector: ApprovalPolicySelector;
  compositionOrder?: number;
  enabled: boolean;
  outcome: PolicyBindingSnapshotOutcome;
};

export type ResolvedApproverTarget =
  | {
      type: "relation";
      object: AuthorizationObjectRef;
      relation: RelationName;
      sourceKind: "relation" | "principal_relation";
    }
  | {
      type: "user";
      userId: UserId;
      sourceKind: "principal" | "user";
    };

export type MaterializedStepSource = {
  policyBindingId: ApprovalPolicyBindingId;
  policyKey: ApprovalPolicyKey;
  policyVersion: number;
  flowPath: string;
};

export type MaterializedSelfApproval = {
  mode: "allow" | "deny";
  subject?: PrincipalRef;
};

export type MaterializedUnresolvedApproverBehavior =
  | { type: "deny" }
  | { type: "fallback"; target: ResolvedApproverTarget };

export type MaterializedApprovalStep = {
  type: "approval";
  materializedStepId: MaterializedStepId;
  stepKey: ApprovalStepKey;
  source: MaterializedStepSource;
  target: ResolvedApproverTarget;
  name?: string;
  purpose?: ApprovalPurpose;
  resolution?: "dynamic" | "snapshot";
  candidateCompletion?: CandidateCompletion;
  onUnresolved?: MaterializedUnresolvedApproverBehavior;
  expiresAfter?: { seconds: number };
  requireCommentOn?: ("approve" | "reject")[];
  selfApproval?: MaterializedSelfApproval;
};

export type MaterializedFlow =
  | { type: "none" }
  | MaterializedApprovalStep
  | { type: "serial"; children: MaterializedFlow[]; constraints?: FlowConstraints }
  | {
      type: "parallel";
      strategy: "all" | "any";
      children: MaterializedFlow[];
      constraints?: FlowConstraints;
    }
  | {
      type: "parallel";
      strategy: "quorum";
      quorum: number;
      children: MaterializedFlow[];
      constraints?: FlowConstraints;
    };

export type MaterializedApprovalPlan = {
  schemaVersion: 1;
  actionRequestId: ActionRequestId;
  organizationId: OrganizationId;
  action: MaterializedActionSnapshot;
  evaluationSnapshot: EvaluationSnapshot;
  policyBindingSnapshots: PolicyBindingSnapshot[];
  flow: MaterializedFlow;
  interpreterSemanticsVersion: number;
  actionFingerprint: ActionFingerprint;
  evaluationSnapshotChecksum: EvaluationSnapshotChecksum;
  approvalPlanChecksum: ApprovalPlanChecksum;
  approvalBindingFingerprint: ApprovalBindingFingerprint;
};

export type SnapshotApproverCohort = {
  id: SnapshotApproverCohortId;
  materializedStepId: MaterializedStepId;
  candidateUserIds: UserId[];
  resolvedAt: string;
  sourceRevision?: string;
};

export type MaterializationErrorCode =
  | "invalid_json_value"
  | "checksum_failed"
  | "invalid_action_definition"
  | "binding_resolution_error"
  | "policy_binding_source_missing"
  | "policy_binding_source_duplicate"
  | "policy_key_mismatch"
  | "invalid_policy_version"
  | "policy_evaluation_error"
  | "field_not_allowed"
  | "field_missing"
  | "invalid_expression_value"
  | "principal_unresolved"
  | "approver_must_be_user";

export type MaterializationResult =
  | { type: "materialized"; plan: MaterializedApprovalPlan }
  | { type: "error"; code: MaterializationErrorCode; message: string; path?: string };

export type SnapshotCohortResult =
  | { type: "materialized"; cohort: SnapshotApproverCohort }
  | {
      type: "error";
      code:
        | "snapshot_resolution_required"
        | "incomplete_candidate_set"
        | "empty_candidate_set"
        | "candidate_quorum_unreachable"
        | "snapshot_checksum_failed";
      message: string;
    };

export type MaterializedPlanVerificationResult =
  | { type: "valid" }
  | {
      type: "invalid";
      code:
        | "action_fingerprint_mismatch"
        | "evaluation_snapshot_checksum_mismatch"
        | "approval_plan_checksum_mismatch"
        | "approval_binding_fingerprint_mismatch"
        | "materialized_step_id_mismatch"
        | "materialized_step_source_mismatch"
        | "organization_mismatch"
        | "invalid_plan";
      message: string;
    };

export class MaterializationFailure extends Error {
  readonly name = "MaterializationFailure";

  constructor(
    readonly code: MaterializationErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

class MaterializedPlanVerificationFailure extends Error {
  readonly name = "MaterializedPlanVerificationFailure";
}

function failure<T>(
  code: MaterializationErrorCode,
  message: string,
  path?: string,
): Result.Result<T, MaterializationFailure> {
  return Result.fail(new MaterializationFailure(code, message, path));
}

function canonicalFailure<T>(
  error: CanonicalJsonError,
  path?: string,
): Result.Result<T, MaterializationFailure> {
  return Result.fail(
    new MaterializationFailure(
      error.code === "sha256_failed" ? "checksum_failed" : "invalid_json_value",
      error.message,
      path,
    ),
  );
}

function asMaterializationError(error: MaterializationFailure): MaterializationResult {
  return {
    type: "error",
    code: error.code,
    message: error.message,
    ...(error.path ? { path: error.path } : {}),
  };
}

function toJsonValue(
  value: unknown,
  path = "$",
  seen = new Set<object>(),
): Result.Result<JsonValue, MaterializationFailure> {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return Result.succeed(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return failure("invalid_json_value", `有限でない数値です: ${path}`, path);
    }
    return Result.succeed(value);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return failure("invalid_json_value", `循環参照があります: ${path}`, path);
    }
    seen.add(value);
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const converted = toJsonValue(value[index], `${path}[${index}]`, seen);
      if (Result.isFailure(converted)) {
        seen.delete(value);
        return converted;
      }
      result.push(converted.value);
    }
    seen.delete(value);
    return Result.succeed(result);
  }

  if (typeof value !== "object" || value === null) {
    return failure("invalid_json_value", `JSON値ではありません: ${path}`, path);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return failure("invalid_json_value", `plain object以外はsnapshotできません: ${path}`, path);
  }
  if (seen.has(value)) {
    return failure("invalid_json_value", `循環参照があります: ${path}`, path);
  }

  seen.add(value);
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const converted = toJsonValue(item, `${path}.${key}`, seen);
    if (Result.isFailure(converted)) {
      seen.delete(value);
      return converted;
    }
    result[key] = converted.value;
  }
  seen.delete(value);
  return Result.succeed(result);
}

function cloneDomain<T>(value: T, path = "$"): Result.Result<Awaited<T>, MaterializationFailure> {
  const cloned = toJsonValue(value, path);
  if (Result.isFailure(cloned)) return cloned;
  return { type: "Success", value: cloned.value as Awaited<T> };
}

function requireJsonObject(
  value: unknown,
  path: string,
): Result.Result<JsonObject, MaterializationFailure> {
  const json = toJsonValue(value, path);
  if (Result.isFailure(json)) return json;
  if (json.value === null || Array.isArray(json.value) || typeof json.value !== "object") {
    return failure("invalid_json_value", `objectが必要です: ${path}`, path);
  }
  return Result.succeed(json.value);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function resolveField(
  path: string,
  context: PolicyEvaluationContext,
): Result.Result<JsonValue, MaterializationFailure> {
  if (!isAllowedPolicyFieldPath(path)) {
    return failure(
      "field_not_allowed",
      `Materializationから参照できないfield pathです: ${path}`,
      path,
    );
  }
  if (path === "now") return Result.succeed(context.now);

  const segments = path.split(".");
  let current: unknown = context;
  for (const segment of segments) {
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") {
      return failure("field_not_allowed", `安全でないfield pathです: ${path}`, path);
    }
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
      return failure("field_missing", `fieldが存在しません: ${path}`, path);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return toJsonValue(current, path);
}

function resolveValueExpression(
  expression: ValueExpression,
  context: PolicyEvaluationContext,
): Result.Result<JsonValue, MaterializationFailure> {
  return expression.type === "field"
    ? resolveField(expression.path, context)
    : toJsonValue(expression.value);
}

function resolvePrincipalExpression(
  expression: PrincipalExpression,
  context: PolicyEvaluationContext,
): Result.Result<PrincipalRef, MaterializationFailure> {
  if (expression.type === "actor") return Result.succeed(context.actor);
  if (expression.type === "authority_principal") return Result.succeed(context.authority.principal);
  if (expression.type === "caller") {
    if (!context.origin.caller) {
      return failure("principal_unresolved", "origin.callerが存在しません");
    }
    return Result.succeed(context.origin.caller);
  }

  const chain = context.authority.delegation?.chain;
  if (!chain || chain.length === 0) {
    return failure("principal_unresolved", "delegatorを解決できません");
  }
  if (expression.depth === "root") return Result.succeed(chain[0]!.delegator);

  const depth = expression.depth ?? 0;
  if (!Number.isSafeInteger(depth) || depth < 0 || depth >= chain.length) {
    return failure("principal_unresolved", `delegator depthを解決できません: ${String(depth)}`);
  }
  return Result.succeed(chain[chain.length - 1 - depth]!.delegator);
}

function asAuthorizationObjectRef(type: string, id: string): AuthorizationObjectRef {
  const prefix = `${type}:`;
  return (id.startsWith(prefix) ? id : `${prefix}${id}`) as AuthorizationObjectRef;
}

function principalObjectRef(principal: PrincipalRef): AuthorizationObjectRef {
  return asAuthorizationObjectRef(principal.type, String(principal.id));
}

function resolveApproverTarget(
  approver: ApprovalStepDefinition["approver"],
  context: PolicyEvaluationContext,
): Result.Result<ResolvedApproverTarget, MaterializationFailure> {
  if (approver.type === "principal") {
    const resolved = resolvePrincipalExpression(approver.principal, context);
    if (Result.isFailure(resolved)) return resolved;
    if (resolved.value.type !== "user") {
      return failure(
        "approver_must_be_user",
        `直接承認者はuserである必要があります: ${resolved.value.type}`,
      );
    }
    return Result.succeed({
      type: "user",
      userId: resolved.value.id,
      sourceKind: "principal",
    });
  }

  if (approver.type === "user") {
    const userId = resolveValueExpression(approver.userId, context);
    if (Result.isFailure(userId)) return userId;
    if (typeof userId.value !== "string") {
      return failure(
        "invalid_expression_value",
        "user approverのuserIdはstringである必要があります",
      );
    }
    return Result.succeed({
      type: "user",
      userId: userId.value as UserId,
      sourceKind: "user",
    });
  }

  if (approver.type === "principal_relation") {
    const principal = resolvePrincipalExpression(approver.principal, context);
    if (Result.isFailure(principal)) return principal;
    return Result.succeed({
      type: "relation",
      object: principalObjectRef(principal.value),
      relation: approver.relation,
      sourceKind: "principal_relation",
    });
  }

  const object = approver.object;
  if (object.type === "literal") {
    return Result.succeed({
      type: "relation",
      object: object.object,
      relation: approver.relation,
      sourceKind: "relation",
    });
  }

  const objectId = resolveValueExpression(object.id, context);
  if (Result.isFailure(objectId)) return objectId;
  if (typeof objectId.value !== "string" && typeof objectId.value !== "number") {
    return failure(
      "invalid_expression_value",
      "relation object idはstringまたはnumberである必要があります",
    );
  }
  return Result.succeed({
    type: "relation",
    object: asAuthorizationObjectRef(String(object.objectType), String(objectId.value)),
    relation: approver.relation,
    sourceKind: "relation",
  });
}

async function hashValue(
  value: unknown,
  path = "$",
): Result.ResultAsync<Sha256Digest, MaterializationFailure> {
  const json = toJsonValue(value, path);
  if (Result.isFailure(json)) return json;
  const digest = await sha256CanonicalJson(json.value);
  if (Result.isFailure(digest)) return canonicalFailure(digest.error, path);
  return Result.succeed(digest.value);
}

/**
 * MaterializedStepIdはPolicy-localなflowPathをBinding/versionへbindするidentity。
 * policyKeyはBinding snapshotとの整合性検証対象であり、ID入力には意図的に含めない。
 */
export async function createMaterializedStepId(
  source: MaterializedStepSource,
): Result.ResultAsync<MaterializedStepId, MaterializationFailure> {
  const digest = await hashValue({
    policyBindingId: source.policyBindingId,
    policyVersion: source.policyVersion,
    flowPath: source.flowPath,
  });
  if (Result.isFailure(digest)) return digest;
  return Result.succeed(
    `mstep:${String(digest.value).slice("sha256:".length)}` as MaterializedStepId,
  );
}

async function materializeFlow(
  flow: FlowDefinition,
  source: Omit<MaterializedStepSource, "flowPath">,
  context: PolicyEvaluationContext,
  flowPath: string,
): Result.ResultAsync<MaterializedFlow, MaterializationFailure> {
  if (flow.type === "none") return Result.succeed({ type: "none" });

  if (flow.type === "approval") {
    const stepSource: MaterializedStepSource = { ...source, flowPath };
    const target = resolveApproverTarget(flow.approver, context);
    if (Result.isFailure(target)) return target;

    let onUnresolved: MaterializedUnresolvedApproverBehavior | undefined;
    if (flow.onUnresolved?.type === "fallback") {
      const fallback = resolveApproverTarget(flow.onUnresolved.approver, context);
      if (Result.isFailure(fallback)) return fallback;
      onUnresolved = { type: "fallback", target: fallback.value };
    } else if (flow.onUnresolved) {
      onUnresolved = { type: "deny" };
    }

    let selfApproval: MaterializedSelfApproval | undefined;
    if (flow.selfApproval) {
      if (flow.selfApproval.subject) {
        const subject = resolvePrincipalExpression(flow.selfApproval.subject, context);
        if (Result.isFailure(subject)) return subject;
        selfApproval = { mode: flow.selfApproval.mode, subject: { ...subject.value } };
      } else {
        selfApproval = { mode: flow.selfApproval.mode };
      }
    }

    const materializedStepId = await createMaterializedStepId(stepSource);
    if (Result.isFailure(materializedStepId)) return materializedStepId;

    return Result.succeed({
      type: "approval",
      materializedStepId: materializedStepId.value,
      stepKey: flow.key,
      source: stepSource,
      target: target.value,
      ...(flow.name !== undefined ? { name: flow.name } : {}),
      ...(flow.purpose !== undefined ? { purpose: flow.purpose } : {}),
      ...(flow.resolution !== undefined ? { resolution: flow.resolution } : {}),
      ...(flow.candidateCompletion !== undefined
        ? {
            candidateCompletion:
              typeof flow.candidateCompletion === "object"
                ? { ...flow.candidateCompletion }
                : flow.candidateCompletion,
          }
        : {}),
      ...(onUnresolved ? { onUnresolved } : {}),
      ...(flow.expiresAfter ? { expiresAfter: { ...flow.expiresAfter } } : {}),
      ...(flow.requireCommentOn ? { requireCommentOn: [...flow.requireCommentOn] } : {}),
      ...(selfApproval ? { selfApproval } : {}),
    });
  }

  const children: MaterializedFlow[] = [];
  for (let index = 0; index < flow.children.length; index += 1) {
    const child = await materializeFlow(
      flow.children[index]!,
      source,
      context,
      `${flowPath}.children[${index}]`,
    );
    if (Result.isFailure(child)) return child;
    children.push(child.value);
  }
  const constraints = flow.constraints ? { ...flow.constraints } : undefined;

  if (flow.type === "serial") {
    return Result.succeed({
      type: "serial",
      children,
      ...(constraints ? { constraints } : {}),
    });
  }
  if (flow.strategy === "quorum") {
    return Result.succeed({
      type: "parallel",
      strategy: "quorum",
      quorum: flow.quorum,
      children,
      ...(constraints ? { constraints } : {}),
    });
  }
  return Result.succeed({
    type: "parallel",
    strategy: flow.strategy,
    children,
    ...(constraints ? { constraints } : {}),
  });
}

function actionDefinitionSnapshot(
  definition: ActionDefinition,
): Result.Result<ActionDefinitionSnapshot, MaterializationFailure> {
  const inputSchema = cloneDomain(definition.inputSchema, "actionDefinition.inputSchema");
  if (Result.isFailure(inputSchema)) return inputSchema;

  let derivedAttributeCatalog: ActionDefinitionSnapshot["derivedAttributeCatalog"];
  if (definition.derivedAttributeCatalog) {
    const cloned = cloneDomain(
      definition.derivedAttributeCatalog,
      "actionDefinition.derivedAttributeCatalog",
    );
    if (Result.isFailure(cloned)) return cloned;
    derivedAttributeCatalog = cloned.value;
  }

  return Result.succeed({
    key: definition.key,
    version: definition.version,
    actionType: definition.actionType,
    inputSchema: inputSchema.value,
    executorKey: definition.executorKey,
    ...(definition.normalizationVersion !== undefined
      ? { normalizationVersion: definition.normalizationVersion }
      : {}),
    ...(derivedAttributeCatalog ? { derivedAttributeCatalog } : {}),
  });
}

function createActionSnapshot(
  context: PolicyEvaluationContext,
  definition: ActionDefinition,
): Result.Result<MaterializedActionSnapshot, MaterializationFailure> {
  const definitionSnapshot = actionDefinitionSnapshot(definition);
  if (Result.isFailure(definitionSnapshot)) return definitionSnapshot;
  const resource = cloneDomain(context.action.resource, "action.resource");
  if (Result.isFailure(resource)) return resource;
  const input = requireJsonObject(context.action.input, "action.input");
  if (Result.isFailure(input)) return input;

  return Result.succeed({
    definition: definitionSnapshot.value,
    type: context.action.type,
    resource: resource.value,
    input: input.value,
  });
}

function createEvaluationSnapshot(
  context: PolicyEvaluationContext,
): Result.Result<EvaluationSnapshot, MaterializationFailure> {
  const actor = cloneDomain(context.actor, "actor");
  if (Result.isFailure(actor)) return actor;
  const authority = cloneDomain(context.authority, "authority");
  if (Result.isFailure(authority)) return authority;
  const origin = cloneDomain(context.origin, "origin");
  if (Result.isFailure(origin)) return origin;
  const organization = cloneDomain(context.organization, "organization");
  if (Result.isFailure(organization)) return organization;

  let attributes: PolicyEvaluationContext["attributes"];
  if (context.attributes) {
    const cloned = cloneDomain(context.attributes, "attributes");
    if (Result.isFailure(cloned)) return cloned;
    attributes = cloned.value;
  }

  return Result.succeed({
    actor: actor.value,
    authority: authority.value,
    origin: origin.value,
    organization: organization.value,
    ...(attributes ? { attributes } : {}),
    evaluatedAt: context.now,
  });
}

export async function computeActionFingerprint(
  action: MaterializedActionSnapshot,
): Result.ResultAsync<ActionFingerprint, MaterializationFailure> {
  const digest = await hashValue({
    definition: { key: action.definition.key, version: action.definition.version },
    type: action.type,
    resource: action.resource,
    input: action.input,
  });
  if (Result.isFailure(digest)) return digest;
  return Result.succeed(digest.value as unknown as ActionFingerprint);
}

export async function computeEvaluationSnapshotChecksum(
  snapshot: EvaluationSnapshot,
): Result.ResultAsync<EvaluationSnapshotChecksum, MaterializationFailure> {
  const digest = await hashValue(snapshot);
  if (Result.isFailure(digest)) return digest;
  return Result.succeed(digest.value as unknown as EvaluationSnapshotChecksum);
}

export async function computeApprovalPlanChecksum(input: {
  policyBindingSnapshots: readonly PolicyBindingSnapshot[];
  flow: MaterializedFlow;
  interpreterSemanticsVersion: number;
}): Result.ResultAsync<ApprovalPlanChecksum, MaterializationFailure> {
  const digest = await hashValue(input);
  if (Result.isFailure(digest)) return digest;
  return Result.succeed(digest.value as unknown as ApprovalPlanChecksum);
}

export async function computeApprovalBindingFingerprint(input: {
  actionFingerprint: ActionFingerprint;
  evaluationSnapshotChecksum: EvaluationSnapshotChecksum;
  approvalPlanChecksum: ApprovalPlanChecksum;
}): Result.ResultAsync<ApprovalBindingFingerprint, MaterializationFailure> {
  const digest = await hashValue(input);
  if (Result.isFailure(digest)) return digest;
  return Result.succeed(digest.value as unknown as ApprovalBindingFingerprint);
}

export async function materializeApprovalPlan(input: {
  actionRequestId: ActionRequestId;
  context: PolicyEvaluationContext;
  actionDefinition: ActionDefinition;
  policyBindings: readonly VersionedApprovalPolicyBinding[];
  interpreterSemanticsVersion?: number;
}): Promise<MaterializationResult> {
  if (
    !Number.isSafeInteger(input.actionDefinition.version) ||
    input.actionDefinition.version < 1 ||
    String(input.actionDefinition.actionType) !== String(input.context.action.type)
  ) {
    return asMaterializationError(
      new MaterializationFailure(
        "invalid_action_definition",
        "Action Definition version/actionTypeがActionRequestと整合しません",
      ),
    );
  }

  const byBindingId = new Map<string, VersionedApprovalPolicyBinding>();
  for (const source of input.policyBindings) {
    const id = String(source.binding.id);
    if (byBindingId.has(id)) {
      return asMaterializationError(
        new MaterializationFailure(
          "policy_binding_source_duplicate",
          `Policy Binding sourceが重複しています: ${id}`,
        ),
      );
    }
    if (!Number.isSafeInteger(source.policyVersion) || source.policyVersion < 1) {
      return asMaterializationError(
        new MaterializationFailure(
          "invalid_policy_version",
          `Policy Versionが不正です: ${source.policyVersion}`,
        ),
      );
    }
    if (String(source.binding.policyKey) !== String(source.policy.key)) {
      return asMaterializationError(
        new MaterializationFailure(
          "policy_key_mismatch",
          `BindingとPolicyのkeyが一致しません: ${id}`,
        ),
      );
    }
    byBindingId.set(id, source);
  }

  const bindingResolution = resolvePolicyBindings(
    input.policyBindings.map((source) => source.binding),
    input.context,
  );
  if (bindingResolution.type === "error") {
    return asMaterializationError(
      new MaterializationFailure(
        "binding_resolution_error",
        bindingResolution.error.message,
        bindingResolution.error.path,
      ),
    );
  }

  const policyBindingSnapshots: PolicyBindingSnapshot[] = [];
  const materializedFlows: MaterializedFlow[] = [];

  for (const binding of bindingResolution.bindings) {
    const source = byBindingId.get(String(binding.id));
    if (!source) {
      return asMaterializationError(
        new MaterializationFailure(
          "policy_binding_source_missing",
          `適用Bindingの固定Policy Versionがありません: ${String(binding.id)}`,
        ),
      );
    }

    const evaluation = evaluatePolicy(source.policy, input.context);
    if (evaluation.type === "error") {
      return asMaterializationError(
        new MaterializationFailure(
          "policy_evaluation_error",
          evaluation.error.message,
          evaluation.error.path,
        ),
      );
    }

    const policyDefinitionChecksum = await hashValue(source.policy, "policy");
    if (Result.isFailure(policyDefinitionChecksum)) {
      return asMaterializationError(policyDefinitionChecksum.error);
    }
    const selector = cloneDomain(binding.selector, "binding.selector");
    if (Result.isFailure(selector)) return asMaterializationError(selector.error);

    const outcome: PolicyBindingSnapshotOutcome =
      evaluation.type === "matched"
        ? { type: "matched", ruleKey: evaluation.ruleKey, flowType: evaluation.flow.type }
        : { type: "not_matched" };
    policyBindingSnapshots.push({
      bindingId: binding.id,
      policyKey: binding.policyKey,
      policyVersion: source.policyVersion,
      policyDefinitionChecksum: policyDefinitionChecksum.value,
      selector: selector.value,
      ...(binding.compositionOrder !== undefined
        ? { compositionOrder: binding.compositionOrder }
        : {}),
      enabled: binding.enabled,
      outcome,
    });

    if (evaluation.type === "matched" && evaluation.flow.type !== "none") {
      const materialized = await materializeFlow(
        evaluation.flow,
        {
          policyBindingId: binding.id,
          policyKey: binding.policyKey,
          policyVersion: source.policyVersion,
        },
        input.context,
        "root",
      );
      if (Result.isFailure(materialized)) return asMaterializationError(materialized.error);
      materializedFlows.push(materialized.value);
    }
  }

  let flow: MaterializedFlow;
  if (materializedFlows.length === 0) {
    flow = { type: "none" };
  } else if (materializedFlows.length === 1) {
    flow = materializedFlows[0]!;
  } else {
    flow = {
      type: "serial",
      children: materializedFlows,
      ...(input.context.organization.defaultFlowConstraints
        ? { constraints: { ...input.context.organization.defaultFlowConstraints } }
        : {}),
    };
  }

  const action = createActionSnapshot(input.context, input.actionDefinition);
  if (Result.isFailure(action)) return asMaterializationError(action.error);
  const evaluationSnapshot = createEvaluationSnapshot(input.context);
  if (Result.isFailure(evaluationSnapshot)) {
    return asMaterializationError(evaluationSnapshot.error);
  }

  const interpreterSemanticsVersion =
    input.interpreterSemanticsVersion ?? INTERPRETER_SEMANTICS_VERSION;
  const actionFingerprint = await computeActionFingerprint(action.value);
  if (Result.isFailure(actionFingerprint)) return asMaterializationError(actionFingerprint.error);
  const evaluationSnapshotChecksum = await computeEvaluationSnapshotChecksum(
    evaluationSnapshot.value,
  );
  if (Result.isFailure(evaluationSnapshotChecksum)) {
    return asMaterializationError(evaluationSnapshotChecksum.error);
  }
  const approvalPlanChecksum = await computeApprovalPlanChecksum({
    policyBindingSnapshots,
    flow,
    interpreterSemanticsVersion,
  });
  if (Result.isFailure(approvalPlanChecksum)) {
    return asMaterializationError(approvalPlanChecksum.error);
  }
  const approvalBindingFingerprint = await computeApprovalBindingFingerprint({
    actionFingerprint: actionFingerprint.value,
    evaluationSnapshotChecksum: evaluationSnapshotChecksum.value,
    approvalPlanChecksum: approvalPlanChecksum.value,
  });
  if (Result.isFailure(approvalBindingFingerprint)) {
    return asMaterializationError(approvalBindingFingerprint.error);
  }

  return {
    type: "materialized",
    plan: {
      schemaVersion: 1,
      actionRequestId: input.actionRequestId,
      organizationId: input.context.organization.id,
      action: action.value,
      evaluationSnapshot: evaluationSnapshot.value,
      policyBindingSnapshots,
      flow,
      interpreterSemanticsVersion,
      actionFingerprint: actionFingerprint.value,
      evaluationSnapshotChecksum: evaluationSnapshotChecksum.value,
      approvalPlanChecksum: approvalPlanChecksum.value,
      approvalBindingFingerprint: approvalBindingFingerprint.value,
    },
  };
}

export async function createSnapshotApproverCohort(input: {
  step: MaterializedApprovalStep;
  candidateUserIds: readonly UserId[];
  complete: boolean;
  resolvedAt: string;
  sourceRevision?: string;
}): Promise<SnapshotCohortResult> {
  if (input.step.resolution !== "snapshot") {
    return {
      type: "error",
      code: "snapshot_resolution_required",
      message: "candidate cohortを固定するStepはresolution=snapshotである必要があります",
    };
  }
  if (!input.complete) {
    return {
      type: "error",
      code: "incomplete_candidate_set",
      message: "snapshot cohortには完全なcandidate集合が必要です",
    };
  }

  const candidateUserIds = [
    ...new Map(input.candidateUserIds.map((id) => [String(id), id])).values(),
  ].sort((left, right) => compareStrings(String(left), String(right)));
  if (candidateUserIds.length === 0) {
    return {
      type: "error",
      code: "empty_candidate_set",
      message: "snapshot cohortのcandidate集合が空です",
    };
  }
  if (
    typeof input.step.candidateCompletion === "object" &&
    input.step.candidateCompletion.type === "quorum" &&
    input.step.candidateCompletion.count > candidateUserIds.length
  ) {
    return {
      type: "error",
      code: "candidate_quorum_unreachable",
      message: "candidate quorumがsnapshot cohortの人数を超えています",
    };
  }

  const digest = await hashValue({
    materializedStepId: input.step.materializedStepId,
    candidateUserIds,
    resolvedAt: input.resolvedAt,
    ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}),
  });
  if (Result.isFailure(digest)) {
    return { type: "error", code: "snapshot_checksum_failed", message: digest.error.message };
  }
  return {
    type: "materialized",
    cohort: {
      id: `cohort:${String(digest.value).slice("sha256:".length)}` as SnapshotApproverCohortId,
      materializedStepId: input.step.materializedStepId,
      candidateUserIds,
      resolvedAt: input.resolvedAt,
      ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}),
    },
  };
}

async function verifyMaterializedFlowSources(
  flow: MaterializedFlow,
  snapshots: readonly PolicyBindingSnapshot[],
): Promise<MaterializedPlanVerificationResult> {
  if (flow.type === "none") return { type: "valid" };

  if (flow.type === "approval") {
    const snapshot = snapshots.find(
      (candidate) => String(candidate.bindingId) === String(flow.source.policyBindingId),
    );
    if (
      !snapshot ||
      String(snapshot.policyKey) !== String(flow.source.policyKey) ||
      snapshot.policyVersion !== flow.source.policyVersion
    ) {
      return {
        type: "invalid",
        code: "materialized_step_source_mismatch",
        message: `Materialized StepのsourceがPolicy Binding snapshotと一致しません: ${String(flow.stepKey)}`,
      };
    }

    const expectedStepId = await createMaterializedStepId(flow.source);
    if (Result.isFailure(expectedStepId)) {
      return { type: "invalid", code: "invalid_plan", message: expectedStepId.error.message };
    }
    if (String(expectedStepId.value) !== String(flow.materializedStepId)) {
      return {
        type: "invalid",
        code: "materialized_step_id_mismatch",
        message: `MaterializedStepIdがsourceと一致しません: ${String(flow.stepKey)}`,
      };
    }
    return { type: "valid" };
  }

  for (const child of flow.children) {
    const result = await verifyMaterializedFlowSources(child, snapshots);
    if (result.type === "invalid") return result;
  }
  return { type: "valid" };
}

async function verifyMaterializedApprovalPlanUnsafe(
  plan: MaterializedApprovalPlan,
): Promise<MaterializedPlanVerificationResult> {
  if (String(plan.organizationId) !== String(plan.evaluationSnapshot.organization.id)) {
    return {
      type: "invalid",
      code: "organization_mismatch",
      message: "Materialized PlanとEvaluation SnapshotのorganizationIdが一致しません",
    };
  }

  const flowVerification = await verifyMaterializedFlowSources(
    plan.flow,
    plan.policyBindingSnapshots,
  );
  if (flowVerification.type === "invalid") return flowVerification;

  const actionFingerprint = await computeActionFingerprint(plan.action);
  if (Result.isFailure(actionFingerprint)) {
    return { type: "invalid", code: "invalid_plan", message: actionFingerprint.error.message };
  }
  if (String(actionFingerprint.value) !== String(plan.actionFingerprint)) {
    return {
      type: "invalid",
      code: "action_fingerprint_mismatch",
      message: "actionFingerprintがsnapshot内容と一致しません",
    };
  }

  const evaluationSnapshotChecksum = await computeEvaluationSnapshotChecksum(
    plan.evaluationSnapshot,
  );
  if (Result.isFailure(evaluationSnapshotChecksum)) {
    return {
      type: "invalid",
      code: "invalid_plan",
      message: evaluationSnapshotChecksum.error.message,
    };
  }
  if (String(evaluationSnapshotChecksum.value) !== String(plan.evaluationSnapshotChecksum)) {
    return {
      type: "invalid",
      code: "evaluation_snapshot_checksum_mismatch",
      message: "evaluationSnapshotChecksumがsnapshot内容と一致しません",
    };
  }

  const approvalPlanChecksum = await computeApprovalPlanChecksum({
    policyBindingSnapshots: plan.policyBindingSnapshots,
    flow: plan.flow,
    interpreterSemanticsVersion: plan.interpreterSemanticsVersion,
  });
  if (Result.isFailure(approvalPlanChecksum)) {
    return { type: "invalid", code: "invalid_plan", message: approvalPlanChecksum.error.message };
  }
  if (String(approvalPlanChecksum.value) !== String(plan.approvalPlanChecksum)) {
    return {
      type: "invalid",
      code: "approval_plan_checksum_mismatch",
      message: "approvalPlanChecksumがMaterialized Planと一致しません",
    };
  }

  const approvalBindingFingerprint = await computeApprovalBindingFingerprint({
    actionFingerprint: plan.actionFingerprint,
    evaluationSnapshotChecksum: plan.evaluationSnapshotChecksum,
    approvalPlanChecksum: plan.approvalPlanChecksum,
  });
  if (Result.isFailure(approvalBindingFingerprint)) {
    return {
      type: "invalid",
      code: "invalid_plan",
      message: approvalBindingFingerprint.error.message,
    };
  }
  if (String(approvalBindingFingerprint.value) !== String(plan.approvalBindingFingerprint)) {
    return {
      type: "invalid",
      code: "approval_binding_fingerprint_mismatch",
      message: "approvalBindingFingerprintが3 checksumと一致しません",
    };
  }
  return { type: "valid" };
}

const verifyMaterializedApprovalPlanSafely = Result.fn({
  try: verifyMaterializedApprovalPlanUnsafe,
  catch: (error): MaterializedPlanVerificationFailure =>
    new MaterializedPlanVerificationFailure(
      error instanceof Error ? error.message : "Materialized Planを検証できません",
    ),
});

export async function verifyMaterializedApprovalPlan(
  plan: MaterializedApprovalPlan,
): Promise<MaterializedPlanVerificationResult> {
  const result = await verifyMaterializedApprovalPlanSafely(plan);
  if (Result.isFailure(result)) {
    return { type: "invalid", code: "invalid_plan", message: result.error.message };
  }
  return result.value;
}
