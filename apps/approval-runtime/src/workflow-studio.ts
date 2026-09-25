import { Result } from "@praha/byethrow";

import { decodeUriComponent, parseBrand } from "@app/approval-core";
import type { ActionRequestId, ApprovalDecisionEvent } from "@app/approval-core";
import {
  D1ApprovalRuntimeProjectionRepository,
  listPublishedActionDefinitions,
} from "@app/approval-d1";
import { actionWorkflowInstanceId } from "@app/approval-runtime-cloudflare";
import {
  DELEGATION_FIELD_NAMESPACES,
  WORKFLOW_FIELD_NAMESPACES,
  describeFieldCatalog,
} from "@app/expression-core";
import type { JsonObject } from "@app/expression-core";
import { WORKFLOW_EXECUTOR_KEY, workflowDefinitionIdOfActionKey } from "@app/workflow-application";
import {
  parseWorkflowDefinition,
  parseWorkflowId,
  validateWorkflowDefinition,
} from "@app/workflow-core";
import type { WorkflowDefinitionId, WorkflowRunId } from "@app/workflow-core";
import type { WorkflowPlatform } from "@app/workflow-platform";

import { PREVIEW_ORGANIZATION_ID } from "./preview-plan.ts";
import {
  PREVIEW_ACTOR,
  PREVIEW_CAPABILITY_POLICY,
  PREVIEW_LLM_MODEL,
  bootstrapPreviewCatalog,
  previewWorkflowPlatform,
  type WorkflowPreviewEnv,
} from "./workflow-platform.ts";

const ORG = PREVIEW_ORGANIZATION_ID;
export const WORKFLOW_STUDIO_PREFIX = "/preview/workflow";

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function problem(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return json({ error: code, message, ...extra }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const parsed: unknown = await request.json().catch(() => null);
  return isRecord(parsed) ? parsed : {};
}

function now(): string {
  return new Date().toISOString();
}

function definitionId(raw: string): WorkflowDefinitionId | null {
  const parsed = parseWorkflowId("WorkflowDefinitionId", raw);
  return Result.isSuccess(parsed) ? parsed.value : null;
}

function runId(raw: string): WorkflowRunId | null {
  const parsed = parseWorkflowId("WorkflowRunId", raw);
  return Result.isSuccess(parsed) ? parsed.value : null;
}

function actionRequestId(raw: string): ActionRequestId | null {
  const parsed = parseBrand("ActionRequestId", raw);
  return Result.isSuccess(parsed) ? parsed.value : null;
}

async function catalogView(env: WorkflowPreviewEnv, platform: WorkflowPlatform) {
  const definitions = await listPublishedActionDefinitions(env.DB, ORG);
  if (Result.isFailure(definitions)) return definitions;
  const bindings = await platform.repositories.bindings.list({ organizationId: ORG });
  if (Result.isFailure(bindings)) return Result.fail(bindings.error);
  const workflowFields = describeFieldCatalog(WORKFLOW_FIELD_NAMESPACES, []);
  const delegationFields = describeFieldCatalog(DELEGATION_FIELD_NAMESPACES, []);
  return Result.succeed({
    actions: definitions.value.map((definition) => {
      const composite = String(definition.executorKey) === String(WORKFLOW_EXECUTOR_KEY);
      const binding = composite
        ? bindings.value.find(
            (candidate) =>
              String(candidate.actionDefinitionKey) === String(definition.key) &&
              candidate.actionDefinitionVersion === definition.version,
          )
        : undefined;
      return {
        actionType: String(definition.actionType),
        kind: composite ? "composite" : "primitive",
        definitionKey: String(definition.key),
        version: definition.version,
        ...(binding
          ? {
              workflow: {
                definitionId: String(binding.workflowDefinitionId),
                version: binding.workflowVersion,
              },
            }
          : composite
            ? { workflow: { definitionId: workflowDefinitionIdOfActionKey(definition.key) } }
            : {}),
      };
    }),
    fields: {
      workflow: Result.isSuccess(workflowFields) ? workflowFields.value : null,
      delegation: Result.isSuccess(delegationFields) ? delegationFields.value : null,
    },
    capabilityPolicy: PREVIEW_CAPABILITY_POLICY,
    llmModel: PREVIEW_LLM_MODEL,
    llmAvailable: env.AI !== undefined,
  });
}

async function listDefinitions(platform: WorkflowPlatform) {
  const drafts = await platform.repositories.drafts.list({ organizationId: ORG });
  const versions = await platform.repositories.versions.list({ organizationId: ORG });
  if (Result.isFailure(drafts)) return drafts;
  if (Result.isFailure(versions)) return versions;
  const ids = new Set([
    ...drafts.value.map((draft) => String(draft.definition.id)),
    ...versions.value.map((version) => String(version.definitionId)),
  ]);
  return Result.succeed(
    [...ids].sort().map((id) => {
      const draft = drafts.value.find((candidate) => String(candidate.definition.id) === id);
      const published = versions.value.filter((version) => String(version.definitionId) === id);
      const latest = published.at(-1);
      return {
        id,
        name: draft?.definition.name ?? latest?.definition.name ?? id,
        draftRevision: draft?.revision ?? null,
        updatedAt: draft?.updatedAt ?? latest?.publishedAt ?? null,
        versions: published.map((version) => ({
          version: version.version,
          checksum: String(version.checksum),
          publishedAt: version.publishedAt,
        })),
      };
    }),
  );
}

async function validate(platform: WorkflowPlatform, raw: unknown) {
  const parsed = parseWorkflowDefinition(raw);
  if (Result.isFailure(parsed)) return { definition: null, issues: parsed.error, capabilities: [] };
  const validation = validateWorkflowDefinition(parsed.value);
  const reviewed = platform.capabilities
    ? await platform.capabilities.review({ organizationId: ORG, definition: parsed.value })
    : Result.succeed([]);
  return {
    definition: parsed.value,
    issues: validation.valid ? [] : validation.issues,
    capabilities: Result.isSuccess(reviewed) ? reviewed.value : [],
  };
}

async function runView(platform: WorkflowPlatform, id: WorkflowRunId) {
  const record = await platform.repositories.runs.load({ organizationId: ORG, runId: id });
  if (Result.isFailure(record)) return record;
  if (!record.value) return Result.succeed(null);
  const events = await platform.repositories.runs.listEvents({ organizationId: ORG, runId: id });
  const children = await platform.repositories.correlations.listForRun({
    organizationId: ORG,
    runId: id,
  });
  if (Result.isFailure(events)) return events;
  if (Result.isFailure(children)) return children;
  const childViews = [];
  for (const child of children.value) {
    const status = await platform.statuses.status({
      organizationId: ORG,
      actionRequestId: child.childActionRequestId,
    });
    const childRun = await platform.repositories.runs.findByParentAction({
      organizationId: ORG,
      actionRequestId: child.childActionRequestId,
    });
    childViews.push({
      actionRequestId: String(child.childActionRequestId),
      actionType: String(child.actionType),
      nodeRunId: String(child.nodeRunId),
      effectId: String(child.effectId),
      status: Result.isSuccess(status) ? (status.value?.status ?? null) : null,
      approvalRequired: Result.isSuccess(status) ? (status.value?.approvalRequired ?? null) : null,
      output: Result.isSuccess(status) ? (status.value?.output ?? null) : null,
      code: Result.isSuccess(status) ? (status.value?.code ?? null) : null,
      childRunId:
        Result.isSuccess(childRun) && childRun.value ? String(childRun.value.state.runId) : null,
    });
  }
  const version = await platform.repositories.versions.load({
    organizationId: ORG,
    definitionId: record.value.state.definitionId,
    version: record.value.state.version,
  });
  return Result.succeed({
    run: {
      state: record.value.state,
      depth: record.value.depth,
      invocation: record.value.invocation,
      completionDelivered: record.value.completionDelivered,
      wakeAt: record.value.wakeAt ?? null,
    },
    definition: Result.isSuccess(version) ? (version.value?.definition ?? null) : null,
    events: events.value,
    children: childViews,
  });
}

async function actionView(
  env: WorkflowPreviewEnv,
  platform: WorkflowPlatform,
  id: ActionRequestId,
) {
  const status = await platform.statuses.status({ organizationId: ORG, actionRequestId: id });
  if (Result.isFailure(status)) return Result.fail(status.error);
  const result = await platform.repositories.results.load({
    organizationId: ORG,
    actionRequestId: id,
  });
  const runtime = await new D1ApprovalRuntimeProjectionRepository(env.DB).load({
    organizationId: ORG,
    actionRequestId: id,
  });
  const run = await platform.repositories.runs.findByParentAction({
    organizationId: ORG,
    actionRequestId: id,
  });
  const plan = await platform.repositories.plans.load({ organizationId: ORG, actionRequestId: id });
  return Result.succeed({
    actionRequestId: String(id),
    status: status.value,
    result: Result.isSuccess(result) ? result.value : null,
    approval: Result.isSuccess(runtime) ? runtime.value : null,
    actor: plan.type === "found" ? plan.plan.evaluationSnapshot.actor : null,
    authority: plan.type === "found" ? plan.plan.evaluationSnapshot.authority : null,
    action:
      plan.type === "found" ? { type: plan.plan.action.type, input: plan.plan.action.input } : null,
    runId: Result.isSuccess(run) && run.value ? String(run.value.state.runId) : null,
    trace: await platform.trace(id),
  });
}

async function decide(
  env: WorkflowPreviewEnv,
  id: ActionRequestId,
  input: Record<string, unknown>,
) {
  const runtime = await new D1ApprovalRuntimeProjectionRepository(env.DB).load({
    organizationId: ORG,
    actionRequestId: id,
  });
  if (Result.isFailure(runtime)) return problem(500, "runtime_unavailable", runtime.error.message);
  const task = runtime.value?.tasks.find((candidate) => candidate.status === "pending");
  if (!task) return problem(409, "no_pending_task", "承認待ちのtaskがありません");
  const target = task.target;
  const userId = parseBrand(
    "UserId",
    typeof input["userId"] === "string"
      ? input["userId"]
      : target.type === "user"
        ? String(target.userId)
        : "",
  );
  if (Result.isFailure(userId)) return problem(400, "invalid_user", "userIdが必要です");
  const decision = input["decision"] === "reject" ? "reject" : "approve";
  const event: ApprovalDecisionEvent = {
    idempotencyKey: crypto.randomUUID(),
    taskId: task.id,
    userId: userId.value,
    decision,
    decidedAt: now(),
  };
  const instance = await env.ACTION_WORKFLOW.get(
    await actionWorkflowInstanceId({ organizationId: ORG, actionRequestId: id }),
  );
  await instance.sendEvent({ type: "approval-decision", payload: event });
  return json(
    { accepted: true, taskId: String(task.id), userId: String(userId.value), decision },
    { status: 202 },
  );
}

/** Workflow Studio（#162）のpreview API。`/preview/workflow/*` だけを扱い、それ以外はnull。 */
export async function handleWorkflowStudio(
  request: Request,
  env: WorkflowPreviewEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${WORKFLOW_STUDIO_PREFIX}/`)) return null;
  const decoded = decodeUriComponent(url.pathname.slice(WORKFLOW_STUDIO_PREFIX.length + 1));
  if (Result.isFailure(decoded)) return problem(400, "invalid_path", "pathをdecodeできません");
  const segments = decoded.value.split("/").filter((segment) => segment.length > 0);
  const method = request.method;
  const platform = previewWorkflowPlatform(env);
  const [resource, id, sub, subId, subAction] = segments;

  if (method === "POST" && resource === "bootstrap") {
    const booted = await bootstrapPreviewCatalog(platform, now());
    return Result.isFailure(booted)
      ? problem(500, "bootstrap_failed", booted.error.message)
      : json(booted.value);
  }
  if (method === "GET" && resource === "catalog") {
    const view = await catalogView(env, platform);
    return Result.isFailure(view)
      ? problem(500, "catalog_failed", view.error.message)
      : json(view.value);
  }

  if (resource === "definitions") {
    if (method === "GET" && id === undefined) {
      const listed = await listDefinitions(platform);
      return Result.isFailure(listed)
        ? problem(500, "list_failed", listed.error.message)
        : json({ definitions: listed.value });
    }
    const defId = id ? definitionId(id) : null;
    if (!defId) return problem(400, "invalid_definition_id", "definition idが不正です");
    if (method === "GET" && sub === undefined) {
      const draft = await platform.repositories.drafts.load({
        organizationId: ORG,
        definitionId: defId,
      });
      const versions = await platform.repositories.versions.list({
        organizationId: ORG,
        definitionId: defId,
      });
      const bindings = await platform.repositories.bindings.listForWorkflow({
        organizationId: ORG,
        workflowDefinitionId: defId,
      });
      if (Result.isFailure(draft) || Result.isFailure(versions) || Result.isFailure(bindings)) {
        return problem(500, "load_failed", "definitionを読み込めません");
      }
      return json({ draft: draft.value, versions: versions.value, bindings: bindings.value });
    }
    if (method === "POST" && sub === "validate") {
      return json(await validate(platform, (await body(request))["definition"]));
    }
    if (method === "PUT" && sub === undefined) {
      const input = await body(request);
      const checked = await validate(platform, input["definition"]);
      if (!checked.definition || String(checked.definition.id) !== String(defId)) {
        return problem(422, "invalid_definition", "Workflow Definitionが不正です", {
          issues: checked.issues,
        });
      }
      const revision =
        typeof input["expectedRevision"] === "number" ? input["expectedRevision"] : null;
      const saved = await platform.publishing.saveDraft({
        organizationId: ORG,
        definition: checked.definition,
        expectedRevision: revision,
        now: now(),
      });
      if (Result.isFailure(saved)) return problem(409, saved.error.code, saved.error.message);
      return json({
        revision: saved.value.revision,
        issues: checked.issues,
        capabilities: checked.capabilities,
      });
    }
    if (method === "POST" && sub === "publish") {
      const input = await body(request);
      const parsed = parseWorkflowDefinition(input["definition"]);
      if (Result.isFailure(parsed) || String(parsed.value.id) !== String(defId)) {
        return problem(422, "invalid_definition", "Workflow Definitionが不正です", {
          issues: Result.isFailure(parsed) ? parsed.error : [],
        });
      }
      const actionType =
        typeof input["actionType"] === "string" && input["actionType"].length > 0
          ? input["actionType"]
          : undefined;
      const published = await platform.publishing.publish({
        organizationId: ORG,
        definition: parsed.value,
        publishedBy: PREVIEW_ACTOR,
        now: now(),
        ...(actionType ? { actionType } : {}),
      });
      if (Result.isFailure(published)) {
        return problem(422, published.error.code, published.error.message, {
          issues: published.error.issues ?? [],
        });
      }
      return json(published.value, { status: 201 });
    }
    if (method === "POST" && sub === "projection") {
      const input = await body(request);
      const versionNumber = typeof input["version"] === "number" ? input["version"] : null;
      const version = versionNumber
        ? await platform.repositories.versions.load({
            organizationId: ORG,
            definitionId: defId,
            version: versionNumber,
          })
        : await platform.repositories.versions.latest({ organizationId: ORG, definitionId: defId });
      if (Result.isFailure(version) || !version.value)
        return problem(404, "version_not_found", "publish済みversionがありません");
      const bindings = await platform.repositories.bindings.listForWorkflow({
        organizationId: ORG,
        workflowDefinitionId: defId,
      });
      const composite = Result.isSuccess(bindings)
        ? bindings.value.find((binding) => binding.workflowVersion === version.value?.version)
        : undefined;
      const projected = await platform.projector.project({
        organizationId: ORG,
        version: version.value,
        input: isRecord(input["input"]) ? (input["input"] as JsonObject) : {},
        requester: {
          actor: PREVIEW_ACTOR,
          authority: { principal: PREVIEW_ACTOR },
          origin: { type: "ui" },
          organizationSettings: {},
          attributes: {},
        },
        now: now(),
        ...(composite ? { compositeActionType: composite.actionType } : {}),
      });
      return Result.isFailure(projected)
        ? problem(500, projected.error.code, projected.error.message)
        : json(projected.value);
    }
  }

  if (resource === "programs") {
    const authoring = platform.programAuthoring;
    if (!authoring) return problem(503, "sandbox_unavailable", "sandboxが設定されていません");
    if (method === "GET") {
      const listed = await platform.repositories.programs.list({ organizationId: ORG });
      return Result.isFailure(listed)
        ? problem(500, "list_failed", listed.error.message)
        : json({
            programs: listed.value.map(({ source, ...version }) => ({
              ...version,
              sourceBytes: source.length,
              source,
            })),
          });
    }
    if (method === "POST" && id === "draft") {
      const input = await body(request);
      const drafted = await authoring.draft({
        organizationId: ORG,
        programId: typeof input["programId"] === "string" ? input["programId"] : "program:untitled",
        ...(typeof input["instruction"] === "string" ? { instruction: input["instruction"] } : {}),
        ...(typeof input["source"] === "string" ? { source: input["source"] } : {}),
        ...(typeof input["description"] === "string" ? { description: input["description"] } : {}),
        inputSchema: (isRecord(input["inputSchema"])
          ? input["inputSchema"]
          : { type: "any" }) as never,
        outputSchema: (isRecord(input["outputSchema"])
          ? input["outputSchema"]
          : { type: "any" }) as never,
        requestedCapabilities: (isRecord(input["requestedCapabilities"])
          ? input["requestedCapabilities"]
          : {}) as never,
        samples: (Array.isArray(input["samples"]) ? input["samples"] : []) as never,
        ...(typeof input["model"] === "string" ? { model: input["model"] } : {}),
      });
      return Result.isFailure(drafted)
        ? problem(422, drafted.error.code, drafted.error.message)
        : json(drafted.value);
    }
    if (method === "POST" && id === "publish") {
      const input = await body(request);
      if (!isRecord(input["draft"])) return problem(400, "invalid_draft", "draftが必要です");
      const published = await authoring.publish({
        organizationId: ORG,
        draft: input["draft"] as never,
        samples: (Array.isArray(input["samples"]) ? input["samples"] : []) as never,
        publishedBy: String(PREVIEW_ACTOR.id),
      });
      return Result.isFailure(published)
        ? problem(422, published.error.code, published.error.message)
        : json(published.value, { status: 201 });
    }
  }

  if (resource === "runs") {
    if (method === "POST" && id === undefined) {
      const input = await body(request);
      const type = parseBrand("ActionType", input["actionType"]);
      const resourceId = parseBrand(
        "ResourceId",
        typeof input["resourceId"] === "string" && input["resourceId"]
          ? input["resourceId"]
          : `studio-${Date.now()}`,
      );
      const resourceType = parseBrand("ResourceType", "workflow_subject");
      if (
        Result.isFailure(type) ||
        Result.isFailure(resourceId) ||
        Result.isFailure(resourceType)
      ) {
        return problem(400, "invalid_action", "actionTypeが必要です");
      }
      const submitted = await platform.service.submit({
        action: {
          type: type.value,
          resource: { type: resourceType.value, id: resourceId.value },
          input: isRecord(input["input"]) ? input["input"] : {},
        },
        trustedContext: {
          actor: PREVIEW_ACTOR,
          authority: { principal: PREVIEW_ACTOR },
          origin: { type: "ui" },
          organization: { id: ORG, settings: {} },
          now: now(),
        },
        clientReference: "workflow-studio",
      });
      if (Result.isFailure(submitted)) {
        return problem(422, submitted.error.code, submitted.error.message, {
          executionErrorCode: submitted.error.executionErrorCode ?? null,
        });
      }
      if (submitted.value.type !== "accepted")
        return problem(403, submitted.value.code, submitted.value.reason);
      return json(
        {
          actionRequestId: String(submitted.value.actionRequestId),
          status: submitted.value.view.status,
        },
        { status: 201 },
      );
    }
    if (method === "GET" && id === undefined) {
      const listed = await platform.repositories.runs.list({ organizationId: ORG, limit: 50 });
      return Result.isFailure(listed)
        ? problem(500, "list_failed", listed.error.message)
        : json({
            runs: listed.value.map((record) => ({
              runId: String(record.state.runId),
              definitionId: String(record.state.definitionId),
              version: record.state.version,
              status: record.state.status,
              depth: record.depth,
              parentActionRequestId: record.invocation.parentAction
                ? String(record.invocation.parentAction.actionRequestId)
                : null,
              createdAt: record.state.createdAt,
              completedAt: record.state.completedAt ?? null,
            })),
          });
    }
    const run = id ? runId(id) : null;
    if (!run) return problem(400, "invalid_run_id", "run idが不正です");
    if (method === "GET" && sub === undefined) {
      const view = await runView(platform, run);
      if (Result.isFailure(view)) return problem(500, view.error.code, view.error.message);
      return view.value
        ? json(view.value)
        : problem(404, "run_not_found", "WorkflowRunが見つかりません");
    }
    if (method === "POST" && sub === "advance") {
      const advanced = await platform.runtime.advance({ organizationId: ORG, runId: run });
      return Result.isFailure(advanced)
        ? problem(500, advanced.error.code, advanced.error.message)
        : json(advanced.value);
    }
    if (method === "POST" && sub === "cancel") {
      const cancelled = await platform.runtime.cancel({
        organizationId: ORG,
        runId: run,
        reason: "cancelled from Workflow Studio",
      });
      return Result.isFailure(cancelled)
        ? problem(500, cancelled.error.code, cancelled.error.message)
        : json(cancelled.value);
    }
    if (method === "POST" && sub === "effects" && subId && subAction === "input") {
      const effectId = parseWorkflowId("EffectId", subId);
      if (Result.isFailure(effectId))
        return problem(400, "invalid_effect_id", "effect idが不正です");
      const input = await body(request);
      const delivered = await platform.runtime.deliver({
        organizationId: ORG,
        runId: run,
        event: {
          type: "effect_completed",
          effectId: effectId.value,
          output: (input["value"] ?? null) as never,
        },
      });
      return Result.isFailure(delivered)
        ? problem(409, delivered.error.code, delivered.error.message)
        : json(delivered.value);
    }
  }

  if (resource === "actions") {
    const action = id ? actionRequestId(id) : null;
    if (!action) return problem(400, "invalid_action_request_id", "ActionRequest idが不正です");
    if (method === "GET" && sub === undefined) {
      const view = await actionView(env, platform, action);
      return Result.isFailure(view)
        ? problem(500, view.error.code, view.error.message)
        : json(view.value);
    }
    if (method === "POST" && sub === "decision") return decide(env, action, await body(request));
  }

  return problem(404, "not_found", "Not Found");
}
