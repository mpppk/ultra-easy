import { Result } from "@praha/byethrow";

import {
  UltraEasyError,
  type KnowledgeActionType,
  type RunStatus,
  type StartActionInput,
  type UltraEasyClient,
  type WorkflowRunView,
} from "../client.ts";

type WorkflowMethods = Pick<
  UltraEasyClient,
  "startAction" | "getRun" | "findRunByActionRequest" | "listRuns" | "submitHumanInput"
>;

export type RemoteWorkflowOptions = {
  baseUrl: string;
  organizationId: string;
  /** Principal verified alongside this access token by Knowledge's auth boundary. */
  principalId: string;
  accessToken: string;
  send?: (request: Request) => Promise<Response>;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(string);
}

function error(code: UltraEasyError["code"]): UltraEasyError {
  return new UltraEasyError(code, `ultra-easy ${code}`);
}

function responseError(status: number): UltraEasyError {
  if (status === 401 || status === 403) return error("forbidden");
  if (status === 404) return error("not_found");
  if (status === 400 || status === 422) return error("invalid_request");
  if (status === 409) return error("invalid_state");
  return error("platform_unavailable");
}

function actionType(value: unknown): value is KnowledgeActionType {
  return (
    value === "knowledge.publish_document" ||
    value === "knowledge.maintain_space" ||
    value === "knowledge.search.reindex" ||
    value === "knowledge.watchers.notify" ||
    value === "knowledge.page.archive"
  );
}

function runStatus(value: unknown): value is RunStatus {
  return (
    value === "running" ||
    value === "waiting_approval" ||
    value === "waiting_input" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "rejected"
  );
}

function actionStatus(value: unknown): RunStatus | null {
  if (value === "pending_approval") return "waiting_approval";
  if (value === "executed") return "succeeded";
  if (value === "rejected" || value === "expired") return "rejected";
  if (value === "cancelled") return "cancelled";
  if (
    value === "failed" ||
    value === "execution_failed" ||
    value === "execution_unknown" ||
    value === "authorization_revoked" ||
    value === "authorization_check_failed"
  )
    return "failed";
  if (
    value === "received" ||
    value === "evaluating" ||
    value === "authorized" ||
    value === "approved" ||
    value === "executing"
  )
    return "running";
  return null;
}

function parseRun(
  value: unknown,
  organizationId: string,
  principalId: string,
): WorkflowRunView | null {
  if (!record(value) || !string(value.id) || !string(value.actionRequestId)) return null;
  if (value.organizationId !== organizationId || !actionType(value.actionType)) return null;
  if (!runStatus(value.status) || !record(value.correlation) || !string(value.correlation.spaceId))
    return null;
  if (
    !record(value.requestedBy) ||
    !string(value.requestedBy.id) ||
    !string(value.requestedBy.displayName)
  )
    return null;
  if (!string(value.startedAt) || !string(value.updatedAt)) return null;
  if (!Array.isArray(value.nodes) || !Array.isArray(value.childActions)) return null;
  if (
    !Array.isArray(value.approvals) ||
    !Array.isArray(value.humanInputs) ||
    !Array.isArray(value.audit)
  )
    return null;

  const correlation = value.correlation;
  if (
    (correlation.pageId !== undefined && !string(correlation.pageId)) ||
    (correlation.publicationSnapshotId !== undefined && !string(correlation.publicationSnapshotId))
  )
    return null;
  const nodes: WorkflowRunView["nodes"] = [];
  for (const node of value.nodes) {
    if (!record(node) || !string(node.key) || !string(node.label)) return null;
    if (
      !["pending", "running", "waiting", "succeeded", "failed", "skipped", "cancelled"].includes(
        String(node.status),
      )
    )
      return null;
    nodes.push({
      key: node.key,
      label: node.label,
      status: node.status as WorkflowRunView["nodes"][number]["status"],
      ...(string(node.childActionRequestId)
        ? { childActionRequestId: node.childActionRequestId }
        : {}),
      ...(string(node.errorCode) ? { errorCode: node.errorCode } : {}),
    });
  }
  const childActions: WorkflowRunView["childActions"] = [];
  for (const child of value.childActions) {
    if (!record(child) || !string(child.actionRequestId) || !string(child.actionType)) return null;
    if (
      !["pending", "waiting_approval", "succeeded", "failed", "rejected", "cancelled"].includes(
        String(child.status),
      )
    )
      return null;
    childActions.push({
      actionRequestId: child.actionRequestId,
      actionType: child.actionType,
      status: child.status as WorkflowRunView["childActions"][number]["status"],
      ...(string(child.subjectResourceId) ? { subjectPageId: child.subjectResourceId } : {}),
      ...(string(child.approvalTaskId) ? { approvalTaskId: child.approvalTaskId } : {}),
      ...(string(child.errorCode) ? { errorCode: child.errorCode } : {}),
    });
  }
  const approvals: WorkflowRunView["approvals"] = [];
  for (const task of value.approvals) {
    if (
      !record(task) ||
      !string(task.taskId) ||
      !string(task.actionRequestId) ||
      !string(task.actionType)
    )
      return null;
    if (
      !["pending", "approved", "rejected", "cancelled"].includes(String(task.status)) ||
      !strings(task.candidateIds) ||
      !string(task.url)
    )
      return null;
    approvals.push({
      taskId: task.taskId,
      actionRequestId: task.actionRequestId,
      actionType: task.actionType,
      status: task.status as WorkflowRunView["approvals"][number]["status"],
      candidateIds: task.candidateIds,
      url: task.url,
    });
  }
  const humanInputs: WorkflowRunView["humanInputs"] = [];
  for (const item of value.humanInputs) {
    if (!record(item) || !string(item.key)) return null;
    // The public projection includes redacted stubs for other assignees. Never
    // fabricate the required Knowledge fields or expose those stubs to views.
    if (item.assigneeId !== principalId) continue;
    if (!record(item.subject) || item.subject.type !== "knowledge_page") continue;
    if (!string(item.subject.id) || !string(item.subject.title) || !string(item.prompt)) continue;
    if (item.status !== "waiting" && item.status !== "answered") continue;
    if (item.options !== undefined && !strings(item.options)) continue;
    humanInputs.push({
      key: item.key,
      subject: { pageId: item.subject.id, title: item.subject.title },
      prompt: item.prompt,
      analysis: typeof item.analysis === "string" ? item.analysis : "",
      assigneeId: principalId,
      options: item.options ?? [],
      status: item.status,
      ...(typeof item.answer === "string" ? { answer: item.answer } : {}),
      ...(string(item.answeredBy) ? { answeredBy: item.answeredBy } : {}),
    });
  }
  const audit: WorkflowRunView["audit"] = [];
  for (const entry of value.audit) {
    if (
      !record(entry) ||
      !string(entry.at) ||
      !string(entry.type) ||
      !string(entry.actionRequestId) ||
      !string(entry.detail)
    )
      return null;
    audit.push({
      at: entry.at,
      type: entry.type,
      actionRequestId: entry.actionRequestId,
      detail: entry.detail,
    });
  }
  let failure: WorkflowRunView["failure"] = null;
  if (value.failure !== null) {
    if (
      !record(value.failure) ||
      !string(value.failure.code) ||
      !string(value.failure.message) ||
      typeof value.failure.nodeKey !== "string"
    )
      return null;
    failure = {
      code: value.failure.code,
      message: value.failure.message,
      nodeKey: value.failure.nodeKey,
    };
  }
  return {
    id: value.id,
    actionRequestId: value.actionRequestId,
    actionType: value.actionType,
    organizationId,
    status: value.status,
    correlation: {
      spaceId: correlation.spaceId as string,
      ...(string(correlation.pageId) ? { pageId: correlation.pageId } : {}),
      ...(string(correlation.publicationSnapshotId)
        ? { publicationSnapshotId: correlation.publicationSnapshotId }
        : {}),
    },
    requestedBy: { id: value.requestedBy.id, displayName: value.requestedBy.displayName },
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    nodes,
    childActions,
    approvals,
    humanInputs,
    failure,
    audit,
  };
}

/** Request-scoped public API adapter; the server never accepts a token or actor from browser input. */
export class RemoteWorkflowClient implements WorkflowMethods {
  private readonly send: (request: Request) => Promise<Response>;

  constructor(private readonly options: RemoteWorkflowOptions) {
    this.send = options.send ?? ((request) => fetch(request));
  }

  private scoped(organizationId: string): Result.Result<string, UltraEasyError> {
    return organizationId === this.options.organizationId
      ? Result.succeed(`/v1/organizations/${encodeURIComponent(organizationId)}`)
      : Result.fail(error("forbidden"));
  }

  private async json(
    path: string,
    init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
  ): Result.ResultAsync<JsonRecord, UltraEasyError> {
    const response = await Result.try({
      try: () => {
        const headers = new Headers({ authorization: `Bearer ${this.options.accessToken}` });
        if (init.body !== undefined) headers.set("content-type", "application/json");
        if (init.idempotencyKey) headers.set("idempotency-key", init.idempotencyKey);
        return this.send(
          new Request(new URL(path, this.options.baseUrl), {
            method: init.method ?? "GET",
            headers,
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          }),
        );
      },
      catch: () => error("platform_unavailable"),
    });
    if (Result.isFailure(response)) return response;
    if (!response.value.ok) return Result.fail(responseError(response.value.status));
    const parsed = await Result.try({
      try: (): Promise<unknown> => response.value.json(),
      catch: () => error("platform_unavailable"),
    });
    return Result.isSuccess(parsed) && record(parsed.value)
      ? Result.succeed(parsed.value)
      : Result.fail(error("platform_unavailable"));
  }

  private async readRun(path: string): Result.ResultAsync<WorkflowRunView | null, UltraEasyError> {
    const loaded = await this.json(path);
    if (Result.isFailure(loaded))
      return loaded.error.code === "not_found" ? Result.succeed(null) : loaded;
    const run = parseRun(loaded.value, this.options.organizationId, this.options.principalId);
    return run ? Result.succeed(run) : Result.fail(error("platform_unavailable"));
  }

  async startAction(input: StartActionInput) {
    const base = this.scoped(input.organizationId);
    if (Result.isFailure(base)) return base;
    if (input.actor.id !== this.options.principalId) return Result.fail(error("forbidden"));
    if (
      !actionType(input.actionType) ||
      !string(input.correlation.spaceId) ||
      !string(input.idempotencyKey) ||
      input.idempotencyKey.length > 255
    )
      return Result.fail(error("invalid_request"));
    if (
      input.resource.id !== input.correlation.spaceId &&
      input.resource.id !== input.correlation.pageId
    )
      return Result.fail(error("invalid_request"));
    const submitted = await this.json(`${base.value}/action-requests`, {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      body: {
        action: {
          type: input.actionType,
          // Catalog authorization is scoped to the Knowledge space.
          resource: { type: "knowledge_space", id: input.correlation.spaceId },
          input: { ...input.input, spaceId: input.correlation.spaceId },
        },
        correlation: input.correlation,
      },
    });
    if (Result.isFailure(submitted)) return submitted;
    if (
      !string(submitted.value.id) ||
      submitted.value.organizationId !== input.organizationId ||
      !record(submitted.value.actor) ||
      submitted.value.actor.id !== input.actor.id
    )
      return Result.fail(error("platform_unavailable"));
    const status = actionStatus(submitted.value.status);
    if (!status) return Result.fail(error("platform_unavailable"));
    const actionRequestId = submitted.value.id;
    const composite =
      input.actionType === "knowledge.publish_document" ||
      input.actionType === "knowledge.maintain_space";
    const run = composite
      ? await this.findRunByActionRequest({ organizationId: input.organizationId, actionRequestId })
      : Result.succeed(null);
    if (Result.isFailure(run)) return run;
    let approvalUrl: string | null =
      run.value?.approvals.find((task) => task.status === "pending")?.url ?? null;
    if (!approvalUrl && status === "waiting_approval") {
      const tasks = await this.json(
        `${base.value}/action-requests/${encodeURIComponent(actionRequestId)}/tasks?limit=100`,
      );
      if (Result.isFailure(tasks)) return tasks;
      if (!Array.isArray(tasks.value.items)) return Result.fail(error("platform_unavailable"));
      const pending = tasks.value.items.find(
        (item) => record(item) && item.status === "pending" && string(item.id),
      );
      if (record(pending) && string(pending.id))
        approvalUrl = new URL(
          `${base.value}/approval-tasks/${encodeURIComponent(pending.id)}`,
          this.options.baseUrl,
        ).toString();
    }
    return Result.succeed({
      actionRequestId,
      run: run.value,
      status: run.value?.status ?? status,
      approvalUrl,
    });
  }

  async getRun(input: { organizationId: string; runId: string }) {
    const base = this.scoped(input.organizationId);
    if (Result.isFailure(base)) return base;
    if (!string(input.runId)) return Result.fail(error("invalid_request"));
    const loaded = await this.readRun(
      `${base.value}/workflow-runs/${encodeURIComponent(input.runId)}`,
    );
    return Result.isSuccess(loaded) && loaded.value && loaded.value.id !== input.runId
      ? Result.fail(error("platform_unavailable"))
      : loaded;
  }

  async findRunByActionRequest(input: { organizationId: string; actionRequestId: string }) {
    const base = this.scoped(input.organizationId);
    if (Result.isFailure(base)) return base;
    if (!string(input.actionRequestId)) return Result.fail(error("invalid_request"));
    const loaded = await this.readRun(
      `${base.value}/action-requests/${encodeURIComponent(input.actionRequestId)}/workflow-run`,
    );
    return Result.isSuccess(loaded) &&
      loaded.value &&
      loaded.value.actionRequestId !== input.actionRequestId
      ? Result.fail(error("platform_unavailable"))
      : loaded;
  }

  async listRuns(input: { organizationId: string; spaceIds: readonly string[]; limit: number }) {
    const base = this.scoped(input.organizationId);
    if (Result.isFailure(base)) return base;
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      return Result.fail(error("invalid_request"));
    if (input.spaceIds.length === 0) {
      const empty: WorkflowRunView[] = [];
      return Result.succeed(empty);
    }
    if (input.spaceIds.some((id) => !string(id) || id.length > 255))
      return Result.fail(error("invalid_request"));
    const unique = [...new Set(input.spaceIds)];
    const runs: WorkflowRunView[] = [];
    for (let offset = 0; offset < unique.length; offset += 100) {
      const query = new URLSearchParams({ limit: String(input.limit), correlationKey: "spaceId" });
      for (const id of unique.slice(offset, offset + 100)) query.append("correlationValue", id);
      const loaded = await this.json(`${base.value}/workflow-runs?${query}`);
      if (Result.isFailure(loaded)) return loaded;
      if (!Array.isArray(loaded.value.items) || loaded.value.items.length > input.limit)
        return Result.fail(error("platform_unavailable"));
      for (const item of loaded.value.items) {
        if (record(item) && !actionType(item.actionType)) continue;
        const run = parseRun(item, input.organizationId, this.options.principalId);
        if (!run || !unique.includes(run.correlation.spaceId))
          return Result.fail(error("platform_unavailable"));
        runs.push(run);
      }
    }
    return Result.succeed(
      runs
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
        .slice(0, input.limit),
    );
  }

  async submitHumanInput(input: {
    organizationId: string;
    runId: string;
    inputKey: string;
    answer: string;
    actor: { id: string; displayName: string };
  }) {
    const base = this.scoped(input.organizationId);
    if (Result.isFailure(base)) return base;
    if (input.actor.id !== this.options.principalId) return Result.fail(error("forbidden"));
    if (!string(input.runId) || !string(input.inputKey) || !string(input.answer))
      return Result.fail(error("invalid_request"));
    const path = `${base.value}/workflow-runs/${encodeURIComponent(input.runId)}/human-inputs/${encodeURIComponent(input.inputKey)}/answer`;
    const accepted = await this.json(path, {
      method: "POST",
      body: { answer: input.answer },
      // The server also scopes the command by run, effect and actor. Reusing
      // the effect ID lets a retry recover the same accepted answer.
      idempotencyKey: input.inputKey.slice(0, 255),
    });
    if (Result.isFailure(accepted)) return accepted;
    if (
      accepted.value.runId !== input.runId ||
      accepted.value.inputKey !== input.inputKey ||
      accepted.value.status !== "answered"
    )
      return Result.fail(error("platform_unavailable"));
    const run = await this.getRun({ organizationId: input.organizationId, runId: input.runId });
    if (Result.isFailure(run)) return run;
    return run.value ? Result.succeed(run.value) : Result.fail(error("platform_unavailable"));
  }
}
