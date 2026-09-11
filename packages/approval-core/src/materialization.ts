import type { ActionDefinition } from "./action-definition.ts";
import { canonicalizeJson, sha256CanonicalJson } from "./canonical-json.ts";
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
        | "candidate_quorum_unreachable";
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
        | "invalid_plan";
      message: string;
    };

class MaterializationFailure extends Error {
  constructor(
    readonly code: MaterializationErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

function toJsonValue(value: unknown, path = "$", seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MaterializationFailure("invalid_json_value", `有限でない数値です: ${path}`, path);
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new MaterializationFailure("invalid_json_value", `循環参照があります: ${path}`, path);
    }
    seen.add(value);
    const result = value.map((item, index) => toJsonValue(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }

  if (typeof value !== "object" || value === null) {
    throw new MaterializationFailure("invalid_json_value", `JSON値ではありません: ${path}`, path);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MaterializationFailure(
      "invalid_json_value",
      `plain object以外はsnapshotできません: ${path}`,
      path,
    );
  }
  if (seen.has(value)) {
    throw new MaterializationFailure("invalid_json_value", `循環参照があります: ${path}`, path);
  }

  seen.add(value);
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = toJsonValue(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
  return result;
}

function cloneDomain<T>(value: T): T {
  return JSON.parse(canonicalizeJson(toJsonValue(value))) as T;
}

function requireJsonObject(value: unknown, path: string): JsonObject {
  const json = toJsonValue(value, path);
  if (json === null || Array.isArray(json) || typeof json !== "object") {
    throw new MaterializationFailure("invalid_json_value", `objectが必要です: ${path}`, path);
  }
  return json;
}

function resolveField(path: string, context: PolicyEvaluationContext): JsonValue {
  if (!isAllowedPolicyFieldPath(path)) {
    throw new MaterializationFailure(
      "field_not_allowed",
      `Materializationから参照できないfield pathです: ${path}`,
      path,
    );
  }
  if (path === "now") return context.now;

  const segments = path.split(".");
  let current: unknown = context;
  for (const segment of segments) {
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") {
      throw new MaterializationFailure(
        "field_not_allowed",
        `安全でないfield pathです: ${path}`,
        path,
      );
    }
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
      throw new MaterializationFailure("field_missing", `fieldが存在しません: ${path}`, path);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return toJsonValue(current, path);
}

function resolveValueExpression(
  expression: ValueExpression,
  context: PolicyEvaluationContext,
): JsonValue {
  return expression.type === "field"
    ? resolveField(expression.path, context)
    : toJsonValue(expression.value);
}

function resolvePrincipalExpression(
  expression: PrincipalExpression,
  context: PolicyEvaluationContext,
): PrincipalRef {
  if (expression.type === "actor") return context.actor;
  if (expression.type === "authority_principal") return context.authority.principal;
  if (expression.type === "caller") {
    if (!context.origin.caller) {
      throw new MaterializationFailure("principal_unresolved", "origin.callerが存在しません");
    }
    return context.origin.caller;
  }

  const chain = context.authority.delegation?.chain;
  if (!chain || chain.length === 0) {
    throw new MaterializationFailure("principal_unresolved", "delegatorを解決できません");
  }
  if (expression.depth === "root") return chain[0]!.delegator;

  const depth = expression.depth ?? 0;
  if (!Number.isSafeInteger(depth) || depth < 0 || depth >= chain.length) {
    throw new MaterializationFailure(
      "principal_unresolved",
      `delegator depthを解決できません: ${String(depth)}`,
    );
  }
  return chain[chain.length - 1 - depth]!.delegator;
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
): ResolvedApproverTarget {
  if (approver.type === "principal") {
    const resolved = resolvePrincipalExpression(approver.principal, context);
    if (resolved.type !== "user") {
      throw new MaterializationFailure(
        "approver_must_be_user",
        `直接承認者はuserである必要があります: ${resolved.type}`,
      );
    }
    return { type: "user", userId: resolved.id, sourceKind: "principal" };
  }

  if (approver.type === "user") {
    const userId = resolveValueExpression(approver.userId, context);
    if (typeof userId !== "string") {
      throw new MaterializationFailure(
        "invalid_expression_value",
        "user approverのuserIdはstringである必要があります",
      );
    }
    return { type: "user", userId: userId as UserId, sourceKind: "user" };
  }

  if (approver.type === "principal_relation") {
    const principal = resolvePrincipalExpression(approver.principal, context);
    return {
      type: "relation",
      object: principalObjectRef(principal),
      relation: approver.relation,
      sourceKind: "principal_relation",
    };
  }

  const object = approver.object;
  if (object.type === "literal") {
    return {
      type: "relation",
      object: object.object,
      relation: approver.relation,
      sourceKind: "relation",
    };
  }

  const objectId = resolveValueExpression(object.id, context);
  if (typeof objectId !== "string" && typeof objectId !== "number") {
    throw new MaterializationFailure(
      "invalid_expression_value",
      "relation object idはstringまたはnumberである必要があります",
    );
  }
  return {
    type: "relation",
    object: asAuthorizationObjectRef(String(object.objectType), String(objectId)),
    relation: approver.relation,
    sourceKind: "relation",
  };
}

export async function createMaterializedStepId(
  source: MaterializedStepSource,
): Promise<MaterializedStepId> {
  const digest = await sha256CanonicalJson(
    toJsonValue({
      policyBindingId: source.policyBindingId,
      policyVersion: source.policyVersion,
      flowPath: source.flowPath,
    }),
  );
  return `mstep:${String(digest).slice("sha256:".length)}` as MaterializedStepId;
}

async function materializeFlow(
  flow: FlowDefinition,
  source: Omit<MaterializedStepSource, "flowPath">,
  context: PolicyEvaluationContext,
  flowPath: string,
): Promise<MaterializedFlow> {
  if (flow.type === "none") return { type: "none" };

  if (flow.type === "approval") {
    const stepSource: MaterializedStepSource = { ...source, flowPath };
    const onUnresolved =
      flow.onUnresolved?.type === "fallback"
        ? {
            type: "fallback" as const,
            target: resolveApproverTarget(flow.onUnresolved.approver, context),
          }
        : flow.onUnresolved
          ? { type: "deny" as const }
          : undefined;
    const selfApproval = flow.selfApproval
      ? {
          mode: flow.selfApproval.mode,
          ...(flow.selfApproval.subject
            ? {
                subject: cloneDomain(
                  resolvePrincipalExpression(flow.selfApproval.subject, context),
                ),
              }
            : {}),
        }
      : undefined;

    return {
      type: "approval",
      materializedStepId: await createMaterializedStepId(stepSource),
      stepKey: flow.key,
      source: stepSource,
      target: resolveApproverTarget(flow.approver, context),
      ...(flow.name !== undefined ? { name: flow.name } : {}),
      ...(flow.purpose !== undefined ? { purpose: flow.purpose } : {}),
      ...(flow.resolution !== undefined ? { resolution: flow.resolution } : {}),
      ...(flow.candidateCompletion !== undefined
        ? { candidateCompletion: cloneDomain(flow.candidateCompletion) }
        : {}),
      ...(onUnresolved ? { onUnresolved } : {}),
      ...(flow.expiresAfter ? { expiresAfter: cloneDomain(flow.expiresAfter) } : {}),
      ...(flow.requireCommentOn ? { requireCommentOn: [...flow.requireCommentOn] } : {}),
      ...(selfApproval ? { selfApproval } : {}),
    };
  }

  const children = await Promise.all(
    flow.children.map((child, index) =>
      materializeFlow(child, source, context, `${flowPath}.children[${index}]`),
    ),
  );
  const constraints = flow.constraints ? cloneDomain(flow.constraints) : undefined;

  if (flow.type === "serial") {
    return { type: "serial", children, ...(constraints ? { constraints } : {}) };
  }
  if (flow.strategy === "quorum") {
    return {
      type: "parallel",
      strategy: "quorum",
      quorum: flow.quorum,
      children,
      ...(constraints ? { constraints } : {}),
    };
  }
  return {
    type: "parallel",
    strategy: flow.strategy,
    children,
    ...(constraints ? { constraints } : {}),
  };
}

function actionDefinitionSnapshot(definition: ActionDefinition): ActionDefinitionSnapshot {
  return {
    key: definition.key,
    version: definition.version,
    actionType: definition.actionType,
    inputSchema: cloneDomain(definition.inputSchema),
    executorKey: definition.executorKey,
    ...(definition.normalizationVersion !== undefined
      ? { normalizationVersion: definition.normalizationVersion }
      : {}),
    ...(definition.derivedAttributeCatalog
      ? { derivedAttributeCatalog: cloneDomain(definition.derivedAttributeCatalog) }
      : {}),
  };
}

function createActionSnapshot(
  context: PolicyEvaluationContext,
  definition: ActionDefinition,
): MaterializedActionSnapshot {
  return {
    definition: actionDefinitionSnapshot(definition),
    type: context.action.type,
    resource: cloneDomain(context.action.resource),
    input: requireJsonObject(context.action.input, "action.input"),
  };
}

function createEvaluationSnapshot(context: PolicyEvaluationContext): EvaluationSnapshot {
  return {
    actor: cloneDomain(context.actor),
    authority: cloneDomain(context.authority),
    origin: cloneDomain(context.origin),
    organization: cloneDomain(context.organization),
    ...(context.attributes ? { attributes: cloneDomain(context.attributes) } : {}),
    evaluatedAt: context.now,
  };
}

export async function computeActionFingerprint(
  action: MaterializedActionSnapshot,
): Promise<ActionFingerprint> {
  const digest = await sha256CanonicalJson(
    toJsonValue({
      definition: { key: action.definition.key, version: action.definition.version },
      type: action.type,
      resource: action.resource,
      input: action.input,
    }),
  );
  return digest as unknown as ActionFingerprint;
}

export async function computeEvaluationSnapshotChecksum(
  snapshot: EvaluationSnapshot,
): Promise<EvaluationSnapshotChecksum> {
  return (await sha256CanonicalJson(
    toJsonValue(snapshot),
  )) as unknown as EvaluationSnapshotChecksum;
}

export async function computeApprovalPlanChecksum(input: {
  policyBindingSnapshots: readonly PolicyBindingSnapshot[];
  flow: MaterializedFlow;
  interpreterSemanticsVersion: number;
}): Promise<ApprovalPlanChecksum> {
  return (await sha256CanonicalJson(toJsonValue(input))) as unknown as ApprovalPlanChecksum;
}

export async function computeApprovalBindingFingerprint(input: {
  actionFingerprint: ActionFingerprint;
  evaluationSnapshotChecksum: EvaluationSnapshotChecksum;
  approvalPlanChecksum: ApprovalPlanChecksum;
}): Promise<ApprovalBindingFingerprint> {
  return (await sha256CanonicalJson(toJsonValue(input))) as unknown as ApprovalBindingFingerprint;
}

export async function materializeApprovalPlan(input: {
  actionRequestId: ActionRequestId;
  context: PolicyEvaluationContext;
  actionDefinition: ActionDefinition;
  policyBindings: readonly VersionedApprovalPolicyBinding[];
  interpreterSemanticsVersion?: number;
}): Promise<MaterializationResult> {
  try {
    if (
      !Number.isSafeInteger(input.actionDefinition.version) ||
      input.actionDefinition.version < 1 ||
      String(input.actionDefinition.actionType) !== String(input.context.action.type)
    ) {
      throw new MaterializationFailure(
        "invalid_action_definition",
        "Action Definition version/actionTypeがActionRequestと整合しません",
      );
    }

    const byBindingId = new Map<string, VersionedApprovalPolicyBinding>();
    for (const source of input.policyBindings) {
      const id = String(source.binding.id);
      if (byBindingId.has(id)) {
        throw new MaterializationFailure(
          "policy_binding_source_duplicate",
          `Policy Binding sourceが重複しています: ${id}`,
        );
      }
      if (!Number.isSafeInteger(source.policyVersion) || source.policyVersion < 1) {
        throw new MaterializationFailure(
          "invalid_policy_version",
          `Policy Versionが不正です: ${source.policyVersion}`,
        );
      }
      if (String(source.binding.policyKey) !== String(source.policy.key)) {
        throw new MaterializationFailure(
          "policy_key_mismatch",
          `BindingとPolicyのkeyが一致しません: ${id}`,
        );
      }
      byBindingId.set(id, source);
    }

    const bindingResolution = resolvePolicyBindings(
      input.policyBindings.map((source) => source.binding),
      input.context,
    );
    if (bindingResolution.type === "error") {
      throw new MaterializationFailure(
        "binding_resolution_error",
        bindingResolution.error.message,
        bindingResolution.error.path,
      );
    }

    const policyBindingSnapshots: PolicyBindingSnapshot[] = [];
    const materializedFlows: MaterializedFlow[] = [];

    for (const binding of bindingResolution.bindings) {
      const source = byBindingId.get(String(binding.id));
      if (!source) {
        throw new MaterializationFailure(
          "policy_binding_source_missing",
          `適用Bindingの固定Policy Versionがありません: ${String(binding.id)}`,
        );
      }

      const evaluation = evaluatePolicy(source.policy, input.context);
      if (evaluation.type === "error") {
        throw new MaterializationFailure(
          "policy_evaluation_error",
          evaluation.error.message,
          evaluation.error.path,
        );
      }

      const policyDefinitionChecksum = await sha256CanonicalJson(toJsonValue(source.policy));
      const outcome: PolicyBindingSnapshotOutcome =
        evaluation.type === "matched"
          ? { type: "matched", ruleKey: evaluation.ruleKey, flowType: evaluation.flow.type }
          : { type: "not_matched" };
      policyBindingSnapshots.push({
        bindingId: binding.id,
        policyKey: binding.policyKey,
        policyVersion: source.policyVersion,
        policyDefinitionChecksum,
        selector: cloneDomain(binding.selector),
        ...(binding.compositionOrder !== undefined
          ? { compositionOrder: binding.compositionOrder }
          : {}),
        enabled: binding.enabled,
        outcome,
      });

      if (evaluation.type === "matched" && evaluation.flow.type !== "none") {
        materializedFlows.push(
          await materializeFlow(
            evaluation.flow,
            {
              policyBindingId: binding.id,
              policyKey: binding.policyKey,
              policyVersion: source.policyVersion,
            },
            input.context,
            "root",
          ),
        );
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
          ? { constraints: cloneDomain(input.context.organization.defaultFlowConstraints) }
          : {}),
      };
    }

    const action = createActionSnapshot(input.context, input.actionDefinition);
    const evaluationSnapshot = createEvaluationSnapshot(input.context);
    const interpreterSemanticsVersion =
      input.interpreterSemanticsVersion ?? INTERPRETER_SEMANTICS_VERSION;
    const actionFingerprint = await computeActionFingerprint(action);
    const evaluationSnapshotChecksum = await computeEvaluationSnapshotChecksum(evaluationSnapshot);
    const approvalPlanChecksum = await computeApprovalPlanChecksum({
      policyBindingSnapshots,
      flow,
      interpreterSemanticsVersion,
    });
    const approvalBindingFingerprint = await computeApprovalBindingFingerprint({
      actionFingerprint,
      evaluationSnapshotChecksum,
      approvalPlanChecksum,
    });

    return {
      type: "materialized",
      plan: {
        schemaVersion: 1,
        actionRequestId: input.actionRequestId,
        organizationId: input.context.organization.id,
        action,
        evaluationSnapshot,
        policyBindingSnapshots,
        flow,
        interpreterSemanticsVersion,
        actionFingerprint,
        evaluationSnapshotChecksum,
        approvalPlanChecksum,
        approvalBindingFingerprint,
      },
    };
  } catch (error) {
    if (error instanceof MaterializationFailure) {
      return {
        type: "error",
        code: error.code,
        message: error.message,
        ...(error.path ? { path: error.path } : {}),
      };
    }
    return {
      type: "error",
      code: "invalid_json_value",
      message: error instanceof Error ? error.message : "Materializationに失敗しました",
    };
  }
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
  ].sort((left, right) => String(left).localeCompare(String(right)));
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

  const digest = await sha256CanonicalJson(
    toJsonValue({
      materializedStepId: input.step.materializedStepId,
      candidateUserIds,
      resolvedAt: input.resolvedAt,
      ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}),
    }),
  );
  return {
    type: "materialized",
    cohort: {
      id: `cohort:${String(digest).slice("sha256:".length)}` as SnapshotApproverCohortId,
      materializedStepId: input.step.materializedStepId,
      candidateUserIds,
      resolvedAt: input.resolvedAt,
      ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}),
    },
  };
}

export async function verifyMaterializedApprovalPlan(
  plan: MaterializedApprovalPlan,
): Promise<MaterializedPlanVerificationResult> {
  try {
    if (String(await computeActionFingerprint(plan.action)) !== String(plan.actionFingerprint)) {
      return {
        type: "invalid",
        code: "action_fingerprint_mismatch",
        message: "actionFingerprintがsnapshot内容と一致しません",
      };
    }
    if (
      String(await computeEvaluationSnapshotChecksum(plan.evaluationSnapshot)) !==
      String(plan.evaluationSnapshotChecksum)
    ) {
      return {
        type: "invalid",
        code: "evaluation_snapshot_checksum_mismatch",
        message: "evaluationSnapshotChecksumがsnapshot内容と一致しません",
      };
    }
    if (
      String(
        await computeApprovalPlanChecksum({
          policyBindingSnapshots: plan.policyBindingSnapshots,
          flow: plan.flow,
          interpreterSemanticsVersion: plan.interpreterSemanticsVersion,
        }),
      ) !== String(plan.approvalPlanChecksum)
    ) {
      return {
        type: "invalid",
        code: "approval_plan_checksum_mismatch",
        message: "approvalPlanChecksumがMaterialized Planと一致しません",
      };
    }
    if (
      String(
        await computeApprovalBindingFingerprint({
          actionFingerprint: plan.actionFingerprint,
          evaluationSnapshotChecksum: plan.evaluationSnapshotChecksum,
          approvalPlanChecksum: plan.approvalPlanChecksum,
        }),
      ) !== String(plan.approvalBindingFingerprint)
    ) {
      return {
        type: "invalid",
        code: "approval_binding_fingerprint_mismatch",
        message: "approvalBindingFingerprintが3 checksumと一致しません",
      };
    }
    return { type: "valid" };
  } catch (error) {
    return {
      type: "invalid",
      code: "invalid_plan",
      message: error instanceof Error ? error.message : "Materialized Planを検証できません",
    };
  }
}
