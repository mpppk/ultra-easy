import { Result } from "@praha/byethrow";

import { parseBrand } from "@app/approval-core";
import type {
  ActionAuthority,
  ActionOrigin,
  ActionType,
  FlowDefinition,
  OrganizationId,
  PrincipalRef,
} from "@app/approval-core";
import {
  WORKFLOW_FIELD_NAMESPACES,
  createFieldResolver,
  isPlainRecord,
} from "@app/expression-core";
import type { FieldResolver, JsonObject, JsonValue, ValueTemplate } from "@app/expression-core";
import { allNodes, analyzeNodeReachability, parseWorkflowId } from "@app/workflow-core";
import type { WorkflowNode, WorkflowVersion } from "@app/workflow-core";

import { childAuthority } from "./composite/principals.ts";
import type { EffectHandlerError } from "./ports.ts";

/** Action typeの承認要件を、Approval Policyの評価器でそのまま評価した結果（enforcementではない）。 */
export type ApprovalProbeResult =
  | {
      type: "resolved";
      required: boolean;
      stepCount: number;
      flow: FlowDefinition;
      policies: { bindingId: string; policyKey: string; matchedRuleKey: string | null }[];
    }
  | { type: "unresolved"; reason: string }
  | { type: "action_not_found" };

export type ApprovalProbeInput = {
  organizationId: OrganizationId;
  actionType: ActionType;
  resourceType: string;
  /** 静的に解決できたinput field（runtimeでしか決まらないfieldは含めない）。 */
  input: JsonObject;
  actor: PrincipalRef;
  authority: ActionAuthority;
  origin: ActionOrigin;
  organizationSettings: JsonObject;
  attributes: JsonObject;
  now: string;
};

/**
 * Approval Policyを評価するport（approval-coreのbinding解決 + `evaluateApprovalPlan`を使う）。
 * Workflow側で承認判定ロジックを複製しない。
 */
export interface ApprovalRequirementProbe {
  probe(input: ApprovalProbeInput): Result.ResultAsync<ApprovalProbeResult, EffectHandlerError>;
  /** action typeがComposite Actionなら、そのlatest ActionDefinitionにbindされたWorkflowVersion。 */
  compositeVersion(input: {
    organizationId: OrganizationId;
    actionType: ActionType;
  }): Result.ResultAsync<WorkflowVersion | null, EffectHandlerError>;
}

/**
 * #166 Approval Coverage（親承認evidenceのchild stepへの再利用）の境界。
 * v1では常に`not_covered`で、enforcement pathはこのportを参照しない
 * （child ActionRequestは常に独自のMaterialized Approval Planを実行する）。
 */
export type ApprovalCoverage =
  | { type: "not_covered"; reason: "approval_coverage_not_supported_in_v1" }
  | { type: "covered"; parentApprovalEvidence: string };

export interface ApprovalCoverageEvaluator {
  evaluate(input: { parentActionType?: ActionType; childActionType: ActionType }): ApprovalCoverage;
}

export const NO_APPROVAL_COVERAGE: ApprovalCoverageEvaluator = {
  evaluate: () => ({ type: "not_covered", reason: "approval_coverage_not_supported_in_v1" }),
};

export type ApprovalProjectionClassification =
  | "statically_resolved"
  | "conditional"
  | "potential"
  | "unresolved";

export type ApprovalProjectionItem = {
  /** root workflowからのNode ID列（nested Composite Actionを含む）。 */
  path: string[];
  nodeId: string;
  actionType: string;
  resourceType: string;
  source: "action_node" | "program_capability" | "llm_capability";
  reachability: "always" | "conditional";
  repeated: boolean;
  classification: ApprovalProjectionClassification;
  approval: Extract<ApprovalProbeResult, { type: "resolved" }> | null;
  unresolvedReason?: string;
  /** runtimeでしか決まらないためprojectionに使えなかったinput field。 */
  runtimeInputFields: string[];
  coverage: ApprovalCoverage;
  nested?: ApprovalProjection;
};

/**
 * Workflow Definition / resolved inputから静的・部分的に解析した承認の見通し（#159）。
 *
 * `kind: "projection"` は説明・計画用途で、enforcementの正本ではない。実際の承認は
 * child ActionRequestごとのMaterialized Approval Planが決める（projectionでapprovalをskipしない）。
 */
export type ApprovalProjection = {
  kind: "projection";
  workflow: { definitionId: string; version: number; checksum: string };
  workflowLevel: {
    actionType: string;
    approval: Extract<ApprovalProbeResult, { type: "resolved" }> | null;
    unresolvedReason?: string;
  } | null;
  items: ApprovalProjectionItem[];
  generatedAt: string;
};

const MAX_PROJECTION_DEPTH = 4;
const RUNTIME_ROOTS = new Set(["nodes", "loop"]);

type Known = { known: true; value: JsonValue } | { known: false };

function assignedVariables(version: WorkflowVersion): Set<string> {
  const names = new Set<string>();
  for (const { node } of allNodes(version.definition.graph)) {
    if (node.type === "transform")
      for (const name of Object.keys(node.assign ?? {})) names.add(name);
  }
  return names;
}

/** 固定contextで解決できる部分だけを評価する（runtime値・未指定値はunknown）。 */
function partial(
  template: ValueTemplate,
  resolver: FieldResolver,
  runtimeVariables: Set<string>,
  unknownFields: string[],
  location: string,
): Known {
  if (template.type === "literal") return { known: true, value: template.value };
  if (template.type === "field") {
    const segments = template.path.split(".");
    const runtime =
      RUNTIME_ROOTS.has(segments[0] ?? "") ||
      (segments[0] === "variables" && runtimeVariables.has(segments[1] ?? ""));
    if (runtime) {
      unknownFields.push(location);
      return { known: false };
    }
    const resolved = resolver.resolve(template.path);
    if (Result.isFailure(resolved)) {
      unknownFields.push(location);
      return { known: false };
    }
    return { known: true, value: resolved.value };
  }
  if (template.type === "array") {
    const items: JsonValue[] = [];
    for (const [index, item] of template.items.entries()) {
      const value = partial(
        item,
        resolver,
        runtimeVariables,
        unknownFields,
        `${location}[${index}]`,
      );
      if (!value.known) return { known: false };
      items.push(value.value);
    }
    return { known: true, value: items };
  }
  // objectは既知fieldだけで部分的に使う（policyが未知fieldを参照すればunresolvedになる）。
  const fields: JsonObject = {};
  for (const [key, child] of Object.entries(template.fields)) {
    const value = partial(
      child,
      resolver,
      runtimeVariables,
      unknownFields,
      location ? `${location}.${key}` : key,
    );
    if (value.known) fields[key] = value.value;
  }
  return { known: true, value: fields };
}

export type ProjectionRequester = {
  actor: PrincipalRef;
  authority: ActionAuthority;
  origin: ActionOrigin;
  organizationSettings: JsonObject;
  attributes: JsonObject;
};

/**
 * Workflow VersionのApproval Projectionを作る。child Actionの承認要件は、実行時と同じ
 * Policy評価器（`ApprovalRequirementProbe`）で評価し、runtime値に依存する場合は
 * `unresolved`、Branch / loop配下は`conditional`、Program / LLMのcapabilityは`potential`とする。
 */
export class WorkflowApprovalProjector {
  constructor(
    private readonly deps: {
      probe: ApprovalRequirementProbe;
      coverage?: ApprovalCoverageEvaluator;
    },
  ) {}

  async project(input: {
    organizationId: OrganizationId;
    version: WorkflowVersion;
    input: JsonObject;
    requester: ProjectionRequester;
    now: string;
    /** Composite Actionとして呼ばれる場合のaction type（workflow-level approvalを評価する）。 */
    compositeActionType?: ActionType;
  }): Result.ResultAsync<ApprovalProjection, EffectHandlerError> {
    return this.projectAt({ ...input, path: [], depth: 0, conditional: false });
  }

  private async probe(
    base: { organizationId: OrganizationId; requester: ProjectionRequester; now: string },
    actionType: ActionType,
    resourceType: string,
    actionInput: JsonObject,
    principals?: { actor: PrincipalRef; authority: ActionAuthority; origin: ActionOrigin },
  ) {
    return this.deps.probe.probe({
      organizationId: base.organizationId,
      actionType,
      resourceType,
      input: actionInput,
      actor: principals?.actor ?? base.requester.actor,
      authority: principals?.authority ?? base.requester.authority,
      origin: principals?.origin ?? base.requester.origin,
      organizationSettings: base.requester.organizationSettings,
      attributes: base.requester.attributes,
      now: base.now,
    });
  }

  /** 実行時のchild ActionRequestと同じactor / authority / originでPolicyを評価する。 */
  private childPrincipals(
    version: WorkflowVersion,
    requester: ProjectionRequester,
    node: WorkflowNode,
    actionType: ActionType,
  ): { actor: PrincipalRef; authority: ActionAuthority; origin: ActionOrigin } | undefined {
    const runId = parseWorkflowId("WorkflowRunId", "projection");
    if (Result.isFailure(runId)) return undefined;
    const principals = childAuthority({
      parentActor: requester.authority.principal,
      parentAuthority: { principal: requester.authority.principal },
      definition: version.definition,
      runId: runId.value,
      nodeId: node.id,
      nodeScope: { actionTypes: [actionType] },
    });
    if (Result.isFailure(principals)) return undefined;
    return {
      actor: principals.value.actor,
      authority: principals.value.authority,
      origin: { type: "system", caller: principals.value.workflowAgent },
    };
  }

  private async projectAt(input: {
    organizationId: OrganizationId;
    version: WorkflowVersion;
    input: JsonObject;
    requester: ProjectionRequester;
    now: string;
    compositeActionType?: ActionType;
    path: string[];
    depth: number;
    conditional: boolean;
  }): Result.ResultAsync<ApprovalProjection, EffectHandlerError> {
    const coverage = this.deps.coverage ?? NO_APPROVAL_COVERAGE;
    let workflowLevel: ApprovalProjection["workflowLevel"] = null;
    if (input.compositeActionType) {
      const probed = await this.probe(input, input.compositeActionType, "workflow", input.input);
      if (Result.isFailure(probed)) return probed;
      workflowLevel = {
        actionType: String(input.compositeActionType),
        approval: probed.value.type === "resolved" ? probed.value : null,
        ...(probed.value.type === "unresolved" ? { unresolvedReason: probed.value.reason } : {}),
      };
    }

    const resolver = createFieldResolver({
      policy: WORKFLOW_FIELD_NAMESPACES,
      dateTimeFields: ["now"],
      root: {
        workflow: { input: input.input },
        variables: input.version.definition.variables ?? {},
        actor: input.requester.actor,
        organization: { settings: input.requester.organizationSettings },
        attributes: input.requester.attributes,
        now: input.now,
      },
    });
    const runtimeVariables = assignedVariables(input.version);
    const reachability = analyzeNodeReachability(input.version.definition.graph);
    const items: ApprovalProjectionItem[] = [];

    for (const { node } of allNodes(input.version.definition.graph)) {
      const reach = reachability.get(String(node.id)) ?? {
        reachability: "conditional" as const,
        repeated: false,
        loopPath: [],
      };
      const conditional = input.conditional || reach.reachability === "conditional";
      const base = {
        path: [...input.path, String(node.id)],
        nodeId: String(node.id),
        reachability: conditional ? ("conditional" as const) : ("always" as const),
        repeated: reach.repeated,
      };
      for (const candidate of this.candidates(node)) {
        const unknownFields: string[] = [];
        const known =
          candidate.input === undefined
            ? { known: true as const, value: {} }
            : partial(candidate.input, resolver, runtimeVariables, unknownFields, "");
        const actionInput =
          known.known && isPlainRecord(known.value) ? (known.value as JsonObject) : {};
        const probed = await this.probe(
          input,
          candidate.actionType,
          candidate.resourceType,
          actionInput,
          this.childPrincipals(input.version, input.requester, node, candidate.actionType),
        );
        if (Result.isFailure(probed)) return probed;
        const resolved = probed.value.type === "resolved" ? probed.value : null;
        const classification: ApprovalProjectionClassification =
          probed.value.type !== "resolved"
            ? "unresolved"
            : candidate.source !== "action_node"
              ? "potential"
              : conditional
                ? "conditional"
                : "statically_resolved";
        const item: ApprovalProjectionItem = {
          ...base,
          actionType: String(candidate.actionType),
          resourceType: candidate.resourceType,
          source: candidate.source,
          classification,
          approval: resolved,
          ...(probed.value.type === "unresolved"
            ? { unresolvedReason: probed.value.reason }
            : probed.value.type === "action_not_found"
              ? { unresolvedReason: "action_type_not_found" }
              : {}),
          runtimeInputFields: unknownFields,
          coverage: coverage.evaluate({
            ...(input.compositeActionType ? { parentActionType: input.compositeActionType } : {}),
            childActionType: candidate.actionType,
          }),
        };
        if (candidate.source === "action_node" && input.depth < MAX_PROJECTION_DEPTH) {
          const nested = await this.deps.probe.compositeVersion({
            organizationId: input.organizationId,
            actionType: candidate.actionType,
          });
          if (Result.isFailure(nested)) return nested;
          if (nested.value) {
            const projected = await this.projectAt({
              organizationId: input.organizationId,
              version: nested.value,
              input: actionInput,
              requester: input.requester,
              now: input.now,
              compositeActionType: candidate.actionType,
              path: base.path,
              depth: input.depth + 1,
              conditional,
            });
            if (Result.isFailure(projected)) return projected;
            item.nested = projected.value;
          }
        }
        items.push(item);
      }
    }
    return Result.succeed({
      kind: "projection",
      workflow: {
        definitionId: String(input.version.definitionId),
        version: input.version.version,
        checksum: String(input.version.checksum),
      },
      workflowLevel,
      items,
      generatedAt: input.now,
    });
  }

  private candidates(node: WorkflowNode): {
    actionType: ActionType;
    resourceType: string;
    input?: ValueTemplate;
    source: ApprovalProjectionItem["source"];
  }[] {
    if (node.type === "action") {
      return [
        {
          actionType: node.actionType,
          resourceType: node.resource.type,
          input: node.input,
          source: "action_node",
        },
      ];
    }
    if (node.type === "program" || node.type === "llm") {
      return (node.capabilities?.actions ?? []).flatMap((granted) => {
        const actionType = parseBrand("ActionType", String(granted.actionType));
        return Result.isSuccess(actionType)
          ? [
              {
                actionType: actionType.value,
                resourceType: granted.resourceType ?? "*",
                source:
                  node.type === "program"
                    ? ("program_capability" as const)
                    : ("llm_capability" as const),
              },
            ]
          : [];
      });
    }
    return [];
  }
}
