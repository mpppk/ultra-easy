import { Result } from "@praha/byethrow";

import { ActionExecutorError, brandLiteral, sha256CanonicalJson } from "@app/approval-core";
import type {
  ActionExecutionDispatch,
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutor,
  ActionRequestId,
  OrganizationId,
} from "@app/approval-core";
import { isPlainRecord } from "@app/expression-core";
import type { JsonObject } from "@app/expression-core";
import { parseWorkflowId, verifyWorkflowVersion } from "@app/workflow-core";
import type { WorkflowRunId } from "@app/workflow-core";

import type { WorkflowRunRepository, WorkflowVersionRepository } from "../ports.ts";
import { MAX_WORKFLOW_DEPTH } from "../runtime.ts";
import { delegationTimeBounds } from "./principals.ts";
import type { WorkflowRuntime } from "../runtime.ts";
import type {
  ChildActionCorrelationRepository,
  ParentActionContextResolver,
  WorkflowActionBindingRepository,
  WorkflowRunScheduler,
} from "./ports.ts";

/** Composite Action（Workflow）を実行するexecutorKey。 */
export const WORKFLOW_EXECUTOR_KEY = brandLiteral("ExecutorKey", "workflow");

function executorError(code: string, retriable: boolean, detail: string): ActionExecutorError {
  return new ActionExecutorError({ code, retriable, detail });
}

/** Composite ActionのActionRequestから、そのWorkflowRun IDを決定的に導出する。 */
export async function compositeRunId(input: {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
}): Result.ResultAsync<WorkflowRunId, ActionExecutorError> {
  const digest = await sha256CanonicalJson([
    String(input.organizationId),
    String(input.actionRequestId),
  ]);
  if (Result.isFailure(digest))
    return Result.fail(executorError("workflow_run_id_failed", false, digest.error.message));
  const parsed = parseWorkflowId(
    "WorkflowRunId",
    `wfrun:${String(digest.value).slice("sha256:".length, "sha256:".length + 40)}`,
  );
  return Result.isFailure(parsed)
    ? Result.fail(executorError("workflow_run_id_failed", false, parsed.error.message))
    : parsed;
}

/**
 * Composite ActionのActionExecutor（`executorKey = workflow`, #158）。
 *
 * - 実行対象は **ActionRequestのmaterialized snapshotが持つActionDefinition (key, version)** に
 *   immutableにbindされたWorkflowVersion / checksumだけ。latest versionを再解決しない
 * - WorkflowRunを一意（ActionRequest IDから決定的なrun ID）に開始し、`accepted`を返す。
 *   WorkflowRunの開始は親Actionの完了ではない（終端はtrusted completionで確定する, #165）
 * - child Actionは必ずActionRequest boundaryを通る（WorkflowRuntimeのaction handler）
 * - nest深さとrecursion（祖先runと同じWorkflow）を制限する
 */
export class WorkflowActionExecutor implements ActionExecutor {
  readonly guaranteeLevel = "idempotent" as const;

  constructor(
    private readonly deps: {
      bindings: WorkflowActionBindingRepository;
      versions: WorkflowVersionRepository;
      runs: WorkflowRunRepository;
      correlations: ChildActionCorrelationRepository;
      parentContext: ParentActionContextResolver;
      runtime: () => WorkflowRuntime;
      scheduler?: WorkflowRunScheduler;
      maxDepth?: number;
    },
  ) {}

  async execute(): Result.ResultAsync<ActionExecutionResult, ActionExecutorError> {
    return Result.fail(
      executorError(
        "async_execution_requires_dispatch",
        false,
        "Composite Actionはasync dispatch（accepted）でだけ実行できます",
      ),
    );
  }

  async dispatch(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionDispatch, ActionExecutorError> {
    const { organizationId, actionRequestId } = request;
    const definition = request.action.definition;
    const binding = await this.deps.bindings.load({
      organizationId,
      actionDefinitionKey: definition.key,
      actionDefinitionVersion: definition.version,
    });
    if (Result.isFailure(binding)) {
      return Result.fail(
        executorError(binding.error.code, binding.error.retriable, binding.error.message),
      );
    }
    if (!binding.value || String(binding.value.actionType) !== String(request.action.type)) {
      return Result.fail(
        executorError(
          "workflow_binding_not_found",
          false,
          `ActionDefinition ${String(definition.key)}@${definition.version} にbindされたWorkflowがありません`,
        ),
      );
    }

    const runId = await compositeRunId({ organizationId, actionRequestId });
    if (Result.isFailure(runId)) return runId;
    const existing = await this.deps.runs.findByParentAction({ organizationId, actionRequestId });
    if (Result.isFailure(existing)) {
      return Result.fail(
        executorError(existing.error.code, existing.error.retriable, existing.error.message),
      );
    }
    if (existing.value) {
      // 再配送（step retry / crash replay）。同じrunへのacceptedへ収束させる。
      await this.deps.scheduler?.schedule({ organizationId, runId: existing.value.state.runId });
      return Result.succeed({ type: "accepted", executionRef: String(existing.value.state.runId) });
    }

    const version = await this.deps.versions.load({
      organizationId,
      definitionId: binding.value.workflowDefinitionId,
      version: binding.value.workflowVersion,
    });
    if (Result.isFailure(version)) {
      return Result.fail(
        executorError(version.error.code, version.error.retriable, version.error.message),
      );
    }
    if (
      !version.value ||
      String(version.value.checksum) !== String(binding.value.workflowChecksum)
    ) {
      return Result.fail(
        executorError(
          "workflow_version_binding_mismatch",
          false,
          "bindされたWorkflowVersion / checksumが見つからないか一致しません",
        ),
      );
    }
    const verified = await verifyWorkflowVersion(version.value);
    if (Result.isFailure(verified)) {
      return Result.fail(
        executorError("workflow_version_binding_mismatch", false, verified.error.message),
      );
    }

    const correlation = await this.deps.correlations.findByChild({
      organizationId,
      childActionRequestId: actionRequestId,
    });
    if (Result.isFailure(correlation)) {
      return Result.fail(
        executorError(
          correlation.error.code,
          correlation.error.retriable,
          correlation.error.message,
        ),
      );
    }
    const parentLink = correlation.value;
    const depth = parentLink ? parentLink.depth + 1 : 0;
    const ancestry = parentLink?.ancestry ?? [];
    if (
      ancestry.some(
        (definitionId) => String(definitionId) === String(binding.value?.workflowDefinitionId),
      )
    ) {
      return Result.fail(
        executorError(
          "workflow_recursion_detected",
          false,
          `Workflow ${String(binding.value.workflowDefinitionId)} は既に祖先runで実行中です`,
        ),
      );
    }
    if (depth > (this.deps.maxDepth ?? MAX_WORKFLOW_DEPTH)) {
      return Result.fail(
        executorError(
          "workflow_nesting_limit_exceeded",
          false,
          `Composite Actionのnestが上限（${this.deps.maxDepth ?? MAX_WORKFLOW_DEPTH}）を超えました`,
        ),
      );
    }

    const parent = await this.deps.parentContext.resolve({
      organizationId,
      actionRequestId,
      actionFingerprint: request.actionFingerprint,
    });
    if (Result.isFailure(parent)) {
      return Result.fail(
        executorError(parent.error.code, parent.error.retriable, parent.error.message),
      );
    }
    const input = isPlainRecord(request.action.input) ? (request.action.input as JsonObject) : {};
    const started = await this.deps.runtime().start({
      organizationId,
      runId: runId.value,
      definitionId: binding.value.workflowDefinitionId,
      version: binding.value.workflowVersion,
      checksum: String(binding.value.workflowChecksum),
      input,
      context: {
        actor: parent.value.actor,
        organizationSettings: parent.value.organizationSettings,
        attributes: parent.value.attributes,
      },
      invocation: {
        // Composite Actionの境界で委任を再rootする: 内部Actionは「authority principalが
        // このComposite Actionを実行する」ことの内訳として、publish済みWorkflowの定義どおりに
        // Workflow Agent / Node Agentへ委任される（各child Actionは改めて認可・承認される）。
        // 親chainの時間境界は引き継ぎ、親の委任が失効すれば内部Actionも拒否される。
        actor: parent.value.authority.principal,
        authority: { principal: parent.value.authority.principal },
        delegationTimeBounds: delegationTimeBounds(parent.value.authority.delegation?.chain ?? []),
        origin: parent.value.origin,
        parentAction: {
          actionRequestId,
          actionFingerprint: request.actionFingerprint,
          idempotencyKey: request.idempotencyKey,
          executionRef: String(runId.value),
        },
        ...(parentLink
          ? { parentRunId: parentLink.runId, parentNodeRunId: parentLink.nodeRunId }
          : {}),
        ancestry,
      },
      depth,
      advance: false,
    });
    if (Result.isFailure(started)) {
      return Result.fail(
        executorError(started.error.code, started.error.retriable, started.error.message),
      );
    }
    await this.deps.scheduler?.schedule({ organizationId, runId: runId.value });
    return Result.succeed({ type: "accepted", executionRef: String(runId.value) });
  }
}
