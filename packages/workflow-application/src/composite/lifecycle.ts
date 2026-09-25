import { Result } from "@praha/byethrow";

import type { ActionExecutionCompletionService } from "@app/approval-application";
import { parseBrand } from "@app/approval-core";
import type {
  ActionDefinition,
  ActionDefinitionKey,
  ActionFingerprint,
  ActionRequestId,
  AsyncExecutionCompletion,
  MaterializedPlanRepository,
  OrganizationId,
  PrincipalRef,
  SchemaResolver,
  SchemaResolverError,
} from "@app/approval-core";
import { isPlainRecord } from "@app/expression-core";
import type { FieldDefinition, JsonObject } from "@app/expression-core";
import { parseWorkflowId } from "@app/workflow-core";
import type { WorkflowVersion } from "@app/workflow-core";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import { EffectHandlerError } from "../ports.ts";
import type {
  WorkflowCompletionListener,
  WorkflowRunRecord,
  WorkflowRunRepository,
  WorkflowVersionRepository,
} from "../ports.ts";
import type { WorkflowRuntime } from "../runtime.ts";
import type { ChildActionCanceller } from "./child-actions.ts";
import { WORKFLOW_EXECUTOR_KEY } from "./executor.ts";
import type {
  ActionCatalogPublisher,
  ChildActionCorrelationRepository,
  ParentActionContext,
  ParentActionContextResolver,
  WorkflowActionBinding,
  WorkflowActionBindingRepository,
  WorkflowRunScheduler,
} from "./ports.ts";

/** WorkflowRunの終端状態を親Composite Actionのasync completionへ写像する（v1 fail-fast）。 */
export function compositeCompletion(record: WorkflowRunRecord): AsyncExecutionCompletion | null {
  const { state } = record;
  if (state.status === "succeeded") {
    return { status: "executed", ...(state.output !== undefined ? { output: state.output } : {}) };
  }
  if (state.status === "failed") {
    return {
      status: "execution_failed",
      code: state.error?.code ?? "workflow_failed",
      message: state.error?.message ?? "WorkflowRunが失敗しました",
      retriable: false,
    };
  }
  if (state.status === "cancelled") {
    return {
      status: "execution_failed",
      code: "workflow_cancelled",
      message: state.error?.message ?? "WorkflowRunがcancelされました",
      retriable: false,
    };
  }
  return null;
}

/**
 * WorkflowRunの終端を親Composite ActionのActionRequestへ **trusted completion** として届ける。
 * 親binding（fingerprint / executionRef / idempotency key）はrun作成時に固定した値を使う。
 * 親を持つrunが別WorkflowRunのchildなら、その親runを起こす。
 */
export class CompositeActionCompletionListener implements WorkflowCompletionListener {
  constructor(
    private readonly deps: {
      completion: Pick<ActionExecutionCompletionService, "complete">;
      correlations: ChildActionCorrelationRepository;
      scheduler?: WorkflowRunScheduler;
    },
  ) {}

  async completed(record: WorkflowRunRecord): Result.ResultAsync<void, EffectHandlerError> {
    const parent = record.invocation.parentAction;
    const completion = compositeCompletion(record);
    if (!parent || !completion) return Result.succeed(undefined);
    const completed = await this.deps.completion.complete({
      organizationId: record.state.organizationId,
      actionRequestId: parent.actionRequestId,
      actionFingerprint: parent.actionFingerprint,
      executionRef: parent.executionRef,
      idempotencyKey: parent.idempotencyKey,
      completion,
      completedAt: record.state.completedAt ?? record.state.updatedAt,
    });
    if (Result.isFailure(completed)) {
      // WorkflowRunが、executorの呼び出し元がacceptedを記録する前に終端することがある。
      // 受付記録が現れるまでretriableとして待つ（runはcompletionDelivered=falseのまま残る）。
      const retriable =
        completed.error.retriable || completed.error.code === "execution_not_accepted";
      return Result.fail(
        new EffectHandlerError(completed.error.code, retriable, completed.error.message),
      );
    }
    const owner = await this.deps.correlations.findByChild({
      organizationId: record.state.organizationId,
      childActionRequestId: parent.actionRequestId,
    });
    if (Result.isSuccess(owner) && owner.value) {
      await this.deps.scheduler?.schedule({
        organizationId: record.state.organizationId,
        runId: owner.value.runId,
      });
    }
    return Result.succeed(undefined);
  }
}

/**
 * child ActionRequestのcancel伝播。Composite childならasync実行へcancelを要求し、
 * そのWorkflowRunをcancelする（終端はrunのcompletionで確定する）。
 */
export class CompositeAwareChildActionCanceller implements ChildActionCanceller {
  constructor(
    private readonly deps: {
      completion: Pick<ActionExecutionCompletionService, "requestCancel">;
      runs: WorkflowRunRepository;
      runtime: () => WorkflowRuntime;
      /** 承認待ち等のprimitive childをcancelするport（任意）。 */
      primitive?: ChildActionCanceller;
    },
  ) {}

  async cancel(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    reason: string;
    now: string;
  }): Result.ResultAsync<void, EffectHandlerError> {
    const run = await this.deps.runs.findByParentAction(input);
    if (Result.isFailure(run)) {
      return Result.fail(
        new EffectHandlerError(run.error.code, run.error.retriable, run.error.message),
      );
    }
    if (!run.value)
      return this.deps.primitive ? this.deps.primitive.cancel(input) : Result.succeed(undefined);
    const requested = await this.deps.completion.requestCancel({
      organizationId: input.organizationId,
      actionRequestId: input.actionRequestId,
      reason: input.reason,
      requestedAt: input.now,
    });
    if (Result.isFailure(requested)) {
      return Result.fail(
        new EffectHandlerError(
          requested.error.code,
          requested.error.retriable,
          requested.error.message,
        ),
      );
    }
    const cancelled = await this.deps.runtime().cancel({
      organizationId: input.organizationId,
      runId: run.value.state.runId,
      reason: input.reason,
    });
    if (Result.isFailure(cancelled)) {
      return Result.fail(
        new EffectHandlerError(
          cancelled.error.code,
          cancelled.error.retriable,
          cancelled.error.message,
        ),
      );
    }
    return Result.succeed(undefined);
  }
}

/** Materialized Planのevaluation snapshotから、prepare時に固定された親contextを返す。 */
export class PlanParentActionContextResolver implements ParentActionContextResolver {
  constructor(private readonly plans: MaterializedPlanRepository) {}

  async resolve(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    actionFingerprint: ActionFingerprint;
  }): Result.ResultAsync<ParentActionContext, EffectHandlerError> {
    const loaded = await this.plans.load(input);
    if (loaded.type === "repository_error") {
      return Result.fail(
        new EffectHandlerError("parent_context_unavailable", true, loaded.message),
      );
    }
    if (loaded.type !== "found") {
      return Result.fail(
        new EffectHandlerError(
          "parent_context_not_found",
          false,
          "親ActionRequestのPlanが見つかりません",
        ),
      );
    }
    const { plan } = loaded;
    if (String(plan.actionFingerprint) !== String(input.actionFingerprint)) {
      return Result.fail(
        new EffectHandlerError(
          "parent_context_mismatch",
          false,
          "親ActionRequestのfingerprintが実行要求と一致しません",
        ),
      );
    }
    const snapshot = plan.evaluationSnapshot;
    return Result.succeed({
      actor: snapshot.actor,
      authority: snapshot.authority,
      origin: snapshot.origin,
      organizationSettings: (snapshot.organization.settings ?? {}) as JsonObject,
      attributes: (snapshot.attributes ?? {}) as JsonObject,
    });
  }
}

export const WORKFLOW_INPUT_SCHEMA_PREFIX = "workflow-input:";

function fieldMatches(field: FieldDefinition, value: unknown): boolean {
  switch (field.type) {
    case "string":
    case "date_time":
      return typeof value === "string";
    case "number":
    case "money_minor":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string_array":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "number_array":
      return Array.isArray(value) && value.every((item) => typeof item === "number");
    case "boolean_array":
      return Array.isArray(value) && value.every((item) => typeof item === "boolean");
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainRecord(value);
    case "json":
      return true;
  }
}

/** Workflowの`inputFields`からComposite Actionのinput schemaを作る。 */
export function workflowInputSchema(
  version: WorkflowVersion,
): StandardSchemaV1<unknown, Record<string, unknown>> {
  const fields = (version.definition.inputFields ?? []).filter(
    (field) => field.path.startsWith("workflow.input.") && field.path.split(".").length === 3,
  );
  return {
    "~standard": {
      version: 1,
      vendor: "ultra-easy-workflow",
      validate(value: unknown) {
        if (!isPlainRecord(value))
          return { issues: [{ message: "inputはobjectである必要があります" }] };
        const issues: { message: string; path: string[] }[] = [];
        for (const field of fields) {
          const name = field.path.split(".")[2] ?? "";
          if (!Object.hasOwn(value, name)) {
            issues.push({ message: `${name}は必須です`, path: [name] });
          } else if (!fieldMatches(field, value[name])) {
            issues.push({ message: `${name}は${field.type}である必要があります`, path: [name] });
          }
        }
        return issues.length > 0 ? { issues } : { value };
      },
    },
  };
}

/**
 * Composite ActionのSchemaReference（`workflow-input:<definitionId>`, version = WorkflowVersion）を
 * 解決する。それ以外は委譲先へ渡す。
 */
export class WorkflowInputSchemaResolver implements SchemaResolver {
  constructor(
    private readonly deps: {
      organizationId: OrganizationId;
      versions: WorkflowVersionRepository;
      fallback?: SchemaResolver;
    },
  ) {}

  async resolve(
    reference: Parameters<SchemaResolver["resolve"]>[0],
  ): Result.ResultAsync<StandardSchemaV1 | null, SchemaResolverError> {
    const key = String(reference.key);
    if (!key.startsWith(WORKFLOW_INPUT_SCHEMA_PREFIX)) {
      return this.deps.fallback ? this.deps.fallback.resolve(reference) : Result.succeed(null);
    }
    const definitionId = parseWorkflowId(
      "WorkflowDefinitionId",
      key.slice(WORKFLOW_INPUT_SCHEMA_PREFIX.length),
    );
    if (Result.isFailure(definitionId)) return Result.succeed(null);
    const version = await this.deps.versions.load({
      organizationId: this.deps.organizationId,
      definitionId: definitionId.value,
      version: reference.version,
    });
    if (Result.isFailure(version) || !version.value) return Result.succeed(null);
    return Result.succeed(workflowInputSchema(version.value));
  }
}

/**
 * WorkflowVersionをAction CatalogへComposite Actionとしてpublishする。
 *
 * 新しいWorkflowVersionごとに **新しいActionDefinition version** を作り、
 * (key, version) -> WorkflowVersion / checksumのbindingをinsert-onlyで保存してからcatalogへ公開する
 * （既存versionのbindingは差し替えない）。承認待ちのActionRequestは旧ActionDefinition versionを
 * snapshotしているため旧WorkflowVersionを実行する。
 */
export class CompositeActionPublisher {
  constructor(
    private readonly deps: {
      bindings: WorkflowActionBindingRepository;
      catalog: ActionCatalogPublisher;
    },
  ) {}

  async publish(input: {
    organizationId: OrganizationId;
    version: WorkflowVersion;
    actionType: string;
    publishedBy: PrincipalRef;
    publishedAt: string;
  }): Result.ResultAsync<
    { definition: ActionDefinition; binding: WorkflowActionBinding },
    EffectHandlerError
  > {
    const actionType = parseBrand("ActionType", input.actionType);
    const key = parseBrand("ActionDefinitionKey", `workflow:${String(input.version.definitionId)}`);
    const schemaKey = parseBrand(
      "SchemaKey",
      `${WORKFLOW_INPUT_SCHEMA_PREFIX}${String(input.version.definitionId)}`,
    );
    if (Result.isFailure(actionType) || Result.isFailure(key) || Result.isFailure(schemaKey)) {
      return Result.fail(
        new EffectHandlerError("composite_action_invalid", false, "action typeが不正です"),
      );
    }
    const existing = await this.deps.bindings.listForWorkflow({
      organizationId: input.organizationId,
      workflowDefinitionId: input.version.definitionId,
    });
    if (Result.isFailure(existing)) {
      return Result.fail(
        new EffectHandlerError(
          existing.error.code,
          existing.error.retriable,
          existing.error.message,
        ),
      );
    }
    const already = existing.value.find(
      (binding) =>
        binding.workflowVersion === input.version.version &&
        String(binding.actionType) === String(actionType.value),
    );
    const latest = await this.deps.catalog.latestVersion({
      organizationId: input.organizationId,
      actionDefinitionKey: key.value,
    });
    if (Result.isFailure(latest)) return latest;
    const actionDefinitionVersion = already?.actionDefinitionVersion ?? (latest.value ?? 0) + 1;
    const definition: ActionDefinition = {
      key: key.value,
      version: actionDefinitionVersion,
      actionType: actionType.value,
      inputSchema: { key: schemaKey.value, version: input.version.version },
      executorKey: WORKFLOW_EXECUTOR_KEY,
    };
    const binding: WorkflowActionBinding = {
      organizationId: input.organizationId,
      actionDefinitionKey: key.value,
      actionDefinitionVersion,
      actionType: actionType.value,
      workflowDefinitionId: input.version.definitionId,
      workflowVersion: input.version.version,
      workflowChecksum: input.version.checksum,
      createdAt: input.publishedAt,
    };
    const saved = await this.deps.bindings.save(binding);
    if (Result.isFailure(saved)) {
      return Result.fail(
        new EffectHandlerError(saved.error.code, saved.error.retriable, saved.error.message),
      );
    }
    if (!already) {
      const published = await this.deps.catalog.publish({
        organizationId: input.organizationId,
        definition,
        publishedBy: input.publishedBy,
        publishedAt: input.publishedAt,
      });
      if (Result.isFailure(published)) return published;
    }
    return Result.succeed({ definition, binding });
  }
}

/** Composite ActionのkeyからWorkflow Definition IDを得る（UIのnested drilldown用）。 */
export function workflowDefinitionIdOfActionKey(key: ActionDefinitionKey | string): string | null {
  const value = String(key);
  return value.startsWith("workflow:") ? value.slice("workflow:".length) : null;
}

/** in-processでrunを進めるscheduler（memory / 単一isolate）。 */
export class InProcessWorkflowRunScheduler implements WorkflowRunScheduler {
  private readonly queue: { organizationId: OrganizationId; runId: string }[] = [];
  private draining = false;

  constructor(private readonly runtime: () => WorkflowRuntime) {}

  async schedule(input: {
    organizationId: OrganizationId;
    runId: Parameters<WorkflowRuntime["advance"]>[0]["runId"];
  }): Promise<void> {
    this.queue.push(input);
    if (this.draining) return;
    this.draining = true;
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      const runId = parseWorkflowId("WorkflowRunId", next.runId);
      if (Result.isSuccess(runId)) {
        await this.runtime().advance({ organizationId: next.organizationId, runId: runId.value });
      }
    }
    this.draining = false;
  }
}
