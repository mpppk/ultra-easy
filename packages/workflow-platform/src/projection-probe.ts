import { Result } from "@praha/byethrow";

import type { VersionedPolicyBindingResolver } from "@app/approval-application";
import { evaluateApprovalPlan, parseBrand } from "@app/approval-core";
import type {
  ActionDefinitionResolver,
  ActionType,
  FlowDefinition,
  OrganizationId,
  PolicyEvaluationContext,
} from "@app/approval-core";
import { EffectHandlerError, WORKFLOW_EXECUTOR_KEY } from "@app/workflow-application";
import type {
  ApprovalProbeInput,
  ApprovalProbeResult,
  ApprovalRequirementProbe,
  WorkflowActionBindingRepository,
  WorkflowVersionRepository,
} from "@app/workflow-application";
import type { WorkflowVersion } from "@app/workflow-core";

function countSteps(flow: FlowDefinition): number {
  if (flow.type === "none") return 0;
  if (flow.type === "approval") return 1;
  return flow.children.reduce((total, child) => total + countSteps(child), 0);
}

/** error chainの最も内側のcode（例: `field_missing:action.input.amount`）。 */
function causeCode(error: unknown): string {
  let found: string | undefined;
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth += 1) {
    if ("code" in current && typeof current.code === "string" && current.code !== "") {
      const path = "path" in current && typeof current.path === "string" ? `:${current.path}` : "";
      found = `${current.code}${path}`;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return found ?? (error instanceof Error ? error.message : "policy_evaluation_failed");
}

/**
 * Approval Projection用のprobe（#159）。実行時と同じbinding解決（`VersionedPolicyBindingResolver`）と
 * `evaluateApprovalPlan`で評価し、判定ロジックを複製しない。runtime値が無いためにfield参照が
 * 解決できない場合はfail-closedなerrorを`unresolved`として返す（enforcementへは使わない）。
 */
export class PolicyApprovalRequirementProbe implements ApprovalRequirementProbe {
  constructor(
    private readonly deps: {
      definitions: ActionDefinitionResolver;
      policyBindings: VersionedPolicyBindingResolver;
      bindings: WorkflowActionBindingRepository;
      versions: WorkflowVersionRepository;
    },
  ) {}

  async probe(
    input: ApprovalProbeInput,
  ): Result.ResultAsync<ApprovalProbeResult, EffectHandlerError> {
    const definition = await this.deps.definitions.resolve(input.actionType);
    if (Result.isFailure(definition)) {
      return Result.fail(
        new EffectHandlerError(
          definition.error.code,
          definition.error.retriable,
          definition.error.message,
        ),
      );
    }
    if (!definition.value) return Result.succeed({ type: "action_not_found" });
    const resourceType = parseBrand("ResourceType", input.resourceType);
    const resourceId = parseBrand("ResourceId", "projection");
    if (Result.isFailure(resourceType) || Result.isFailure(resourceId)) {
      return Result.succeed({ type: "unresolved", reason: "resource_type_invalid" });
    }
    const context: PolicyEvaluationContext = {
      actor: input.actor,
      authority: input.authority,
      origin: input.origin,
      action: {
        type: input.actionType,
        resource: { type: resourceType.value, id: resourceId.value },
        input: input.input,
      },
      organization: { id: input.organizationId, settings: input.organizationSettings },
      attributes: input.attributes,
      now: input.now,
    };
    const bindings = await this.deps.policyBindings.resolve({
      context,
      actionDefinition: definition.value,
    });
    if (Result.isFailure(bindings)) {
      if (bindings.error.retriable) {
        return Result.fail(
          new EffectHandlerError(bindings.error.code, true, bindings.error.message),
        );
      }
      return Result.succeed({ type: "unresolved", reason: causeCode(bindings.error) });
    }
    const evaluated = evaluateApprovalPlan({
      context,
      bindings: bindings.value.map((source) => source.binding),
      policies: bindings.value.map((source) => source.policy),
    });
    if (Result.isFailure(evaluated)) {
      return Result.succeed({ type: "unresolved", reason: causeCode(evaluated.error) });
    }
    const flow = evaluated.value.flow;
    return Result.succeed({
      type: "resolved",
      required: flow.type !== "none",
      stepCount: countSteps(flow),
      flow,
      policies: evaluated.value.policyEvaluations.map(({ binding, evaluation }) => ({
        bindingId: String(binding.id),
        policyKey: String(binding.policyKey),
        matchedRuleKey: evaluation.type === "matched" ? String(evaluation.ruleKey) : null,
      })),
    });
  }

  async compositeVersion(input: {
    organizationId: OrganizationId;
    actionType: ActionType;
  }): Result.ResultAsync<WorkflowVersion | null, EffectHandlerError> {
    const definition = await this.deps.definitions.resolve(input.actionType);
    if (Result.isFailure(definition)) {
      return Result.fail(
        new EffectHandlerError(
          definition.error.code,
          definition.error.retriable,
          definition.error.message,
        ),
      );
    }
    if (
      !definition.value ||
      String(definition.value.executorKey) !== String(WORKFLOW_EXECUTOR_KEY)
    ) {
      return Result.succeed(null);
    }
    const binding = await this.deps.bindings.load({
      organizationId: input.organizationId,
      actionDefinitionKey: definition.value.key,
      actionDefinitionVersion: definition.value.version,
    });
    if (Result.isFailure(binding)) {
      return Result.fail(
        new EffectHandlerError(binding.error.code, binding.error.retriable, binding.error.message),
      );
    }
    if (!binding.value) return Result.succeed(null);
    const version = await this.deps.versions.load({
      organizationId: input.organizationId,
      definitionId: binding.value.workflowDefinitionId,
      version: binding.value.workflowVersion,
    });
    if (Result.isFailure(version)) {
      return Result.fail(
        new EffectHandlerError(version.error.code, version.error.retriable, version.error.message),
      );
    }
    return Result.succeed(version.value);
  }
}
