import { Result } from "@praha/byethrow";

import type { OrganizationId } from "@app/approval-core";
import type { JsonObject } from "@app/expression-core";
import {
  applyWorkflowRunEvent,
  cancellationsToPropagate,
  dispatchableEffects,
  findNode,
  graphAtPath,
  isTerminalWorkflowRunStatus,
  nextEffectWakeAt,
  startWorkflowRun,
  workflowRunTransitionEvents,
} from "@app/workflow-core";
import type {
  EffectRecord,
  WorkflowDefinitionId,
  WorkflowNode,
  WorkflowRunContext,
  WorkflowRunEvent,
  WorkflowRunId,
  WorkflowRunState,
  WorkflowRunStatus,
  WorkflowVersion,
} from "@app/workflow-core";

import type {
  Clock,
  EffectContext,
  EffectHandlers,
  EffectOutcomeReport,
  WorkflowAdmissionController,
  WorkflowCompletionListener,
  WorkflowInvocation,
  WorkflowRunRecord,
  WorkflowRunRepository,
  WorkflowVersionRepository,
} from "./ports.ts";

export class WorkflowRuntimeError extends Error {
  override readonly name = "WorkflowRuntimeError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export type WorkflowRuntimeDependencies = {
  versions: WorkflowVersionRepository;
  runs: WorkflowRunRepository;
  effects: EffectHandlers;
  clock: Clock;
  completion?: WorkflowCompletionListener;
  admission?: WorkflowAdmissionController;
  /** in-flight作用をpollする間隔（秒）。child ActionRequestの承認待ち等。 */
  pollIntervalSeconds?: number;
};

export type WorkflowAdvanceResult = {
  runId: WorkflowRunId;
  status: WorkflowRunStatus;
  revision: number;
  /** 次に進めるべき時刻。終端済みかつ親へ通知済みならundefined。 */
  wakeAt?: string;
};

const MAX_ROUNDS = 64;
const DEFAULT_POLL_SECONDS = 30;
/** 1 runあたりの最大nest深さ（Composite Action recursionのrunaway guard, #158）。 */
export const MAX_WORKFLOW_DEPTH = 5;

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString();
}

function earliest(values: readonly (string | undefined)[]): string | undefined {
  return values.filter((value): value is string => value !== undefined).sort()[0];
}

/** in-flightのtimer作用が満了する時刻。 */
function timerDueAt(state: WorkflowRunState): string | undefined {
  return earliest(
    Object.values(state.effects)
      .filter((effect) => effect.status === "in_flight" && effect.request.kind === "timer")
      .map((effect) =>
        effect.request.kind === "timer"
          ? addSeconds(effect.requestedAt, effect.request.seconds)
          : undefined,
      ),
  );
}

/** poll（例: child ActionRequestの状態確認）が必要なin-flight作用があるか。 */
function needsPolling(state: WorkflowRunState): boolean {
  return Object.values(state.effects).some(
    (effect) =>
      effect.status === "in_flight" &&
      effect.request.kind !== "timer" &&
      effect.request.kind !== "human_input",
  );
}

function summary(record: WorkflowRunRecord): WorkflowAdvanceResult {
  return {
    runId: record.state.runId,
    status: record.state.status,
    revision: record.revision,
    ...(record.wakeAt !== undefined ? { wakeAt: record.wakeAt } : {}),
  };
}

function repositoryFailure(error: { code: string; retriable: boolean; message: string }) {
  return Result.fail(new WorkflowRuntimeError(error.code, error.retriable, error.message));
}

/** 作用を要求したNode。Program yieldの作用もProgram Nodeに属する。 */
function nodeOfEffect(
  version: WorkflowVersion,
  state: WorkflowRunState,
  effect: EffectRecord,
): WorkflowNode | undefined {
  const nodeRun = state.nodeRuns[String(effect.nodeRunId)];
  const scope = nodeRun ? state.scopes[String(nodeRun.scopeId)] : undefined;
  const graph = scope ? graphAtPath(version.definition.graph, scope.path) : undefined;
  return graph && nodeRun ? findNode(graph, nodeRun.nodeId) : undefined;
}

function reportEvents(
  effect: EffectRecord,
  report: EffectOutcomeReport,
  dispatched: boolean,
): WorkflowRunEvent[] {
  const events: WorkflowRunEvent[] = [];
  const reference = "reference" in report ? report.reference : undefined;
  if (dispatched) {
    events.push({
      type: "effect_dispatched",
      effectId: effect.id,
      ...(reference !== undefined ? { reference } : {}),
    });
  }
  switch (report.type) {
    case "completed":
      events.push({ type: "effect_completed", effectId: effect.id, output: report.output });
      break;
    case "failed":
      events.push({
        type: "effect_failed",
        effectId: effect.id,
        code: report.code,
        message: report.message,
        ...(report.retriable !== undefined ? { retriable: report.retriable } : {}),
      });
      break;
    case "in_flight":
      events.push({ type: "effect_waiting", effectId: effect.id, reason: report.waitingReason });
      break;
    case "yielded":
      events.push({
        type: "program_yielded",
        effectId: effect.id,
        state: report.state,
        effect: report.effect,
      });
      break;
  }
  return events;
}

/**
 * Durable Workflow Runtime。stateは毎回repositoryから読み、CASで保存する（process memoryを持たない）。
 *
 * 1 round: cancel伝播 → in-flight作用のpoll → 予約済み作用の配送 → kernelへ適用 → CAS保存。
 * 作用の予約（EffectRecord）は配送前に保存済みで、配送はeffect IDで冪等なため、crash / CAS競合で
 * 再配送されてもchild ActionRequest等は重複しない。
 */
export class WorkflowRuntime {
  private readonly versionCache = new Map<string, WorkflowVersion>();

  constructor(private readonly deps: WorkflowRuntimeDependencies) {}

  private async loadVersion(
    organizationId: OrganizationId,
    definitionId: WorkflowDefinitionId,
    version: number,
  ): Result.ResultAsync<WorkflowVersion, WorkflowRuntimeError> {
    const key = JSON.stringify([String(organizationId), String(definitionId), version]);
    const cached = this.versionCache.get(key);
    if (cached) return Result.succeed(cached);
    const loaded = await this.deps.versions.load({ organizationId, definitionId, version });
    if (Result.isFailure(loaded)) return repositoryFailure(loaded.error);
    if (!loaded.value) {
      return Result.fail(
        new WorkflowRuntimeError(
          "workflow_version_not_found",
          false,
          `Workflow Versionが見つかりません: ${String(definitionId)}@${version}`,
        ),
      );
    }
    this.versionCache.set(key, loaded.value);
    return Result.succeed(loaded.value);
  }

  /**
   * 固定済みversion（definitionId / version / checksum）でWorkflowRunを開始する。runIdで冪等。
   * latest versionを再解決しない。
   */
  async start(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
    definitionId: WorkflowDefinitionId;
    version: number;
    checksum: string;
    input: JsonObject;
    context: WorkflowRunContext;
    invocation: WorkflowInvocation;
    depth: number;
    /** falseならrunを作成するだけで進めない（scheduler / runnerに任せる）。既定true。 */
    advance?: boolean;
  }): Result.ResultAsync<WorkflowAdvanceResult, WorkflowRuntimeError> {
    const version = await this.loadVersion(input.organizationId, input.definitionId, input.version);
    if (Result.isFailure(version)) return version;
    if (String(version.value.checksum) !== input.checksum) {
      return Result.fail(
        new WorkflowRuntimeError(
          "workflow_version_checksum_mismatch",
          false,
          "固定されたWorkflow Version checksumと保存済みversionが一致しません",
        ),
      );
    }
    if (input.depth > MAX_WORKFLOW_DEPTH) {
      return Result.fail(
        new WorkflowRuntimeError(
          "workflow_nesting_limit_exceeded",
          false,
          `Workflowのnestが上限（${MAX_WORKFLOW_DEPTH}）を超えました`,
        ),
      );
    }

    const existing = await this.deps.runs.load({
      organizationId: input.organizationId,
      runId: input.runId,
    });
    if (Result.isFailure(existing)) return repositoryFailure(existing.error);
    if (existing.value) {
      if (input.advance === false) return Result.succeed(summary(existing.value));
      return this.advance({ organizationId: input.organizationId, runId: input.runId });
    }

    if (this.deps.admission) {
      const admitted = await this.deps.admission.admitRun({
        organizationId: input.organizationId,
        definitionId: input.definitionId,
        runId: input.runId,
        depth: input.depth,
      });
      if (Result.isFailure(admitted)) {
        return Result.fail(
          new WorkflowRuntimeError(
            admitted.error.code,
            admitted.error.retriable,
            admitted.error.message,
          ),
        );
      }
      if (admitted.value.type === "denied") {
        return Result.fail(
          new WorkflowRuntimeError(admitted.value.code, false, admitted.value.message),
        );
      }
    }

    const now = this.deps.clock.now();
    const state = startWorkflowRun({
      runId: input.runId,
      organizationId: input.organizationId,
      version: version.value,
      input: input.input,
      context: input.context,
      now,
    });
    const record: WorkflowRunRecord = {
      state,
      revision: 0,
      depth: input.depth,
      invocation: input.invocation,
      completionDelivered: false,
      ...(isTerminalWorkflowRunStatus(state.status) ? {} : { wakeAt: now }),
    };
    const created = await this.deps.runs.create({
      record,
      events: workflowRunTransitionEvents(null, state),
    });
    if (Result.isFailure(created)) return repositoryFailure(created.error);
    if (input.advance === false) {
      const current =
        created.value.type === "existing" ? created.value.record : { ...record, revision: 1 };
      return Result.succeed(summary(current));
    }
    return this.advance({ organizationId: input.organizationId, runId: input.runId });
  }

  async load(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
  }): Result.ResultAsync<WorkflowRunRecord, WorkflowRuntimeError> {
    const loaded = await this.deps.runs.load(input);
    if (Result.isFailure(loaded)) return repositoryFailure(loaded.error);
    if (!loaded.value) {
      return Result.fail(
        new WorkflowRuntimeError("workflow_run_not_found", false, "WorkflowRunが見つかりません"),
      );
    }
    return Result.succeed(loaded.value);
  }

  /** 外部event（human input・cancel等）を適用してから進める。 */
  async deliver(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
    event: WorkflowRunEvent;
  }): Result.ResultAsync<WorkflowAdvanceResult, WorkflowRuntimeError> {
    for (let attempt = 0; attempt < MAX_ROUNDS; attempt += 1) {
      const loaded = await this.load(input);
      if (Result.isFailure(loaded)) return loaded;
      const record = loaded.value;
      const version = await this.loadVersion(
        record.state.organizationId,
        record.state.definitionId,
        record.state.version,
      );
      if (Result.isFailure(version)) return version;
      const now = this.deps.clock.now();
      const applied = applyWorkflowRunEvent(
        record.state,
        version.value.definition,
        input.event,
        now,
      );
      if (Result.isFailure(applied)) {
        return Result.fail(
          new WorkflowRuntimeError(applied.error.code, false, applied.error.message),
        );
      }
      if (applied.value.outcome !== "applied") break;
      const saved = await this.save(record, applied.value.state, now);
      if (Result.isFailure(saved)) return saved;
      if (saved.value) break;
    }
    return this.advance(input);
  }

  async cancel(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
    reason: string;
  }): Result.ResultAsync<WorkflowAdvanceResult, WorkflowRuntimeError> {
    return this.deliver({ ...input, event: { type: "cancel", reason: input.reason } });
  }

  /** CAS保存。競合ならfalse（呼び出し側で再読込する）。 */
  private async save(
    record: WorkflowRunRecord,
    state: WorkflowRunState,
    now: string,
    overrides: Partial<Pick<WorkflowRunRecord, "completionDelivered">> = {},
  ): Result.ResultAsync<boolean, WorkflowRuntimeError> {
    const terminal = isTerminalWorkflowRunStatus(state.status);
    const completionDelivered = overrides.completionDelivered ?? record.completionDelivered;
    const wakeAt =
      terminal && completionDelivered && cancellationsToPropagate(state).length === 0
        ? undefined
        : terminal
          ? now
          : earliest([
              nextEffectWakeAt(state),
              timerDueAt(state),
              needsPolling(state)
                ? addSeconds(now, this.deps.pollIntervalSeconds ?? DEFAULT_POLL_SECONDS)
                : undefined,
            ]);
    const next: WorkflowRunRecord = {
      state,
      revision: record.revision,
      depth: record.depth,
      invocation: record.invocation,
      completionDelivered,
      ...(wakeAt !== undefined ? { wakeAt } : {}),
    };
    const saved = await this.deps.runs.save({
      record: next,
      expectedRevision: record.revision,
      events: workflowRunTransitionEvents(record.state, state),
    });
    if (Result.isFailure(saved)) return repositoryFailure(saved.error);
    return Result.succeed(saved.value.type === "saved");
  }

  private async report(
    kind: "dispatch" | "poll",
    context: EffectContext,
  ): Result.ResultAsync<EffectOutcomeReport | null, WorkflowRuntimeError> {
    const handler = this.deps.effects[context.effect.request.kind];
    if (!handler) {
      return Result.succeed(
        kind === "dispatch"
          ? {
              type: "failed",
              code: "effect_handler_not_configured",
              message: `作用 ${context.effect.request.kind} のhandlerが設定されていません`,
            }
          : null,
      );
    }
    if (kind === "poll" && !handler.poll) return Result.succeed(null);
    const reported =
      kind === "dispatch" ? await handler.dispatch(context) : await handler.poll?.(context);
    if (!reported) return Result.succeed(null);
    if (Result.isFailure(reported)) {
      // 一時障害は作用を未確定のまま残し、次のroundで再試行する。
      if (reported.error.retriable) return Result.succeed(null);
      return Result.succeed({
        type: "failed",
        code: reported.error.code,
        message: reported.error.message,
      });
    }
    return Result.succeed(reported.value);
  }

  /**
   * 終端 / 待機まで進める。複数writerが同時に進めても、CASで1つの遷移だけが確定する。
   */
  async advance(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
  }): Result.ResultAsync<WorkflowAdvanceResult, WorkflowRuntimeError> {
    let last: WorkflowRunRecord | undefined;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const loaded = await this.load(input);
      if (Result.isFailure(loaded)) return loaded;
      const record = loaded.value;
      last = record;
      const version = await this.loadVersion(
        record.state.organizationId,
        record.state.definitionId,
        record.state.version,
      );
      if (Result.isFailure(version)) return version;
      const now = this.deps.clock.now();
      const context = (effect: EffectRecord): EffectContext | null => {
        const node = nodeOfEffect(version.value, record.state, effect);
        return node ? { run: record, version: version.value, effect, node, now } : null;
      };

      const events: WorkflowRunEvent[] = [];
      for (const effect of cancellationsToPropagate(record.state)) {
        const handler = this.deps.effects[effect.request.kind];
        const effectContext = context(effect);
        if (handler?.cancel && effectContext) {
          const cancelled = await handler.cancel(effectContext);
          if (Result.isFailure(cancelled) && cancelled.error.retriable) continue;
        }
        events.push({ type: "effect_cancel_propagated", effectId: effect.id });
      }

      const terminal = isTerminalWorkflowRunStatus(record.state.status);
      if (!terminal) {
        for (const effect of Object.values(record.state.effects)) {
          if (effect.status !== "in_flight") continue;
          const effectContext = context(effect);
          if (!effectContext) continue;
          const polled = await this.report("poll", effectContext);
          if (Result.isFailure(polled)) return polled;
          if (!polled.value) continue;
          if (
            polled.value.type === "in_flight" &&
            record.state.nodeRuns[String(effect.nodeRunId)]?.waitingReason ===
              polled.value.waitingReason
          ) {
            continue;
          }
          events.push(...reportEvents(effect, polled.value, false));
        }
        for (const effect of dispatchableEffects(record.state, now)) {
          const effectContext = context(effect);
          if (!effectContext) continue;
          const dispatched = await this.report("dispatch", effectContext);
          if (Result.isFailure(dispatched)) return dispatched;
          if (!dispatched.value) continue;
          events.push(...reportEvents(effect, dispatched.value, true));
        }
      }

      if (events.length === 0) {
        if (terminal) return this.finish(record, now);
        const expectedWake = earliest([
          nextEffectWakeAt(record.state),
          timerDueAt(record.state),
          needsPolling(record.state)
            ? addSeconds(now, this.deps.pollIntervalSeconds ?? DEFAULT_POLL_SECONDS)
            : undefined,
        ]);
        return Result.succeed({
          runId: record.state.runId,
          status: record.state.status,
          revision: record.revision,
          ...(expectedWake !== undefined ? { wakeAt: expectedWake } : {}),
        });
      }

      let state = record.state;
      for (const event of events) {
        const applied = applyWorkflowRunEvent(state, version.value.definition, event, now);
        if (Result.isFailure(applied)) continue;
        state = applied.value.state;
      }
      const saved = await this.save(record, state, now);
      if (Result.isFailure(saved)) return saved;
    }
    return Result.succeed({
      runId: input.runId,
      status: last?.state.status ?? "running",
      revision: last?.revision ?? 0,
      wakeAt: this.deps.clock.now(),
    });
  }

  /** 終端runの結果を親へ一度だけ届ける（listenerは冪等、配送済みフラグはCASで記録）。 */
  private async finish(
    record: WorkflowRunRecord,
    now: string,
  ): Result.ResultAsync<WorkflowAdvanceResult, WorkflowRuntimeError> {
    if (record.completionDelivered) {
      return Result.succeed({
        runId: record.state.runId,
        status: record.state.status,
        revision: record.revision,
      });
    }
    if (this.deps.completion) {
      const delivered = await this.deps.completion.completed(record);
      if (Result.isFailure(delivered)) {
        if (delivered.error.retriable) {
          return Result.succeed({
            runId: record.state.runId,
            status: record.state.status,
            revision: record.revision,
            wakeAt: addSeconds(now, this.deps.pollIntervalSeconds ?? DEFAULT_POLL_SECONDS),
          });
        }
        return Result.fail(
          new WorkflowRuntimeError(delivered.error.code, false, delivered.error.message),
        );
      }
    }
    if (this.deps.admission?.releaseRun) {
      await this.deps.admission.releaseRun({
        organizationId: record.state.organizationId,
        runId: record.state.runId,
      });
    }
    const saved = await this.save(record, record.state, now, { completionDelivered: true });
    if (Result.isFailure(saved)) return saved;
    return Result.succeed({
      runId: record.state.runId,
      status: record.state.status,
      revision: record.revision + (saved.value ? 1 : 0),
    });
  }
}
