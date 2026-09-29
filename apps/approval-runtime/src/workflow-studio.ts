import { Result } from "@praha/byethrow";
import { parseBrand, type ActionRequestId, type ApprovalDecisionEvent } from "@app/approval-core";
import { D1ApprovalRuntimeProjectionRepository } from "@app/approval-d1";
import { actionWorkflowInstanceId } from "@app/approval-runtime-cloudflare";

import { handleWorkflowStudio as handleSharedWorkflowStudio } from "@app/workflow-platform";

import { PREVIEW_ORGANIZATION_ID } from "./preview-plan.ts";
import {
  PREVIEW_ACTOR,
  PREVIEW_CAPABILITY_POLICY,
  PREVIEW_LLM_MODEL,
  bootstrapPreviewCatalog,
  previewWorkflowPlatform,
  type WorkflowPreviewEnv,
} from "./workflow-platform.ts";

export const WORKFLOW_STUDIO_PREFIX = "/preview/workflow";

async function decide(
  env: WorkflowPreviewEnv,
  id: ActionRequestId,
  input: Record<string, unknown>,
): Promise<Response> {
  const runtime = await new D1ApprovalRuntimeProjectionRepository(env.DB).load({
    organizationId: PREVIEW_ORGANIZATION_ID,
    actionRequestId: id,
  });
  if (Result.isFailure(runtime)) {
    return Response.json(
      { error: "runtime_unavailable", message: runtime.error.message },
      { status: 500 },
    );
  }
  const task = runtime.value?.tasks.find((candidate) => candidate.status === "pending");
  if (!task) return Response.json({ error: "no_pending_task" }, { status: 409 });
  const target = task.target;
  const userId = parseBrand(
    "UserId",
    typeof input["userId"] === "string"
      ? input["userId"]
      : target.type === "user"
        ? String(target.userId)
        : "",
  );
  if (Result.isFailure(userId)) {
    return Response.json({ error: "invalid_user", message: "userIdが必要です" }, { status: 400 });
  }
  const decision = input["decision"] === "reject" ? "reject" : "approve";
  const event: ApprovalDecisionEvent = {
    idempotencyKey: crypto.randomUUID(),
    taskId: task.id,
    userId: userId.value,
    decision,
    decidedAt: new Date().toISOString(),
  };
  const instance = await env.ACTION_WORKFLOW.get(
    await actionWorkflowInstanceId({
      organizationId: PREVIEW_ORGANIZATION_ID,
      actionRequestId: id,
    }),
  );
  await instance.sendEvent({ type: "approval-decision", payload: event });
  return Response.json(
    { accepted: true, taskId: String(task.id), userId: String(userId.value), decision },
    { status: 202 },
  );
}

/** Preview-only wrapper around the shared Studio operations. */
export function handleWorkflowStudio(
  request: Request,
  env: WorkflowPreviewEnv,
): Promise<Response | null> {
  const platform = previewWorkflowPlatform(env);
  return handleSharedWorkflowStudio(request, {
    prefix: WORKFLOW_STUDIO_PREFIX,
    env,
    platform,
    organizationId: PREVIEW_ORGANIZATION_ID,
    actor: PREVIEW_ACTOR,
    capabilityPolicy: PREVIEW_CAPABILITY_POLICY,
    llmModel: PREVIEW_LLM_MODEL,
    decide: (id, input) => decide(env, id, input),
    bootstrap: async () => {
      const booted = await bootstrapPreviewCatalog(platform, new Date().toISOString());
      return Result.isFailure(booted)
        ? Response.json(
            { error: "bootstrap_failed", message: booted.error.message },
            { status: 500 },
          )
        : Response.json(booted.value);
    },
  });
}
