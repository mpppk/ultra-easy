import { Result } from "@praha/byethrow";

import {
  authenticatePublicApi,
  authorizePublicAction,
  idempotent,
  matchHttpRoute,
  type ApprovalReadRepository,
  type IdempotencyRepository,
  type PublicHttpClock,
  type PublicHttpIdentityProvider,
} from "@app/approval-application";
import {
  parseBrand,
  type ActionRequestId,
  type ClientId,
  type OrganizationId,
  type UserPrincipalRef,
} from "@app/approval-core";
import { isPlainRecord, jsonValueIssue, type JsonValue } from "@app/expression-core";
import type { WorkflowRunRecord } from "@app/workflow-application";
import { parseWorkflowId, type EffectRecord, type WorkflowRunId } from "@app/workflow-core";
import { allRows, type D1DatabaseLike } from "@app/workflow-d1";

import type { WorkflowPlatform } from "./platform.ts";

export const PUBLIC_HUMAN_INPUT_ROUTES = [
  "/v1/organizations/{organizationId}/me/human-inputs",
  "/v1/organizations/{organizationId}/workflow-runs/{runId}/human-inputs/{effectId}/answer",
] as const;

export type PublicHumanInputView = {
  key: string;
  runId: string;
  actionRequestId: string;
  prompt: string;
  assigneeId: string;
  options?: string[];
  answerSchema?: Extract<EffectRecord["request"], { kind: "human_input" }>["answerSchema"];
  subject?: { type: string; id: string; title: string };
  analysis?: string;
  status: "waiting";
  requestedAt: string;
};

type InputKeyRow = {
  run_id: string;
  effect_id: string;
  parent_action_request_id: string;
  created_at: string;
};

type Cursor = { createdAt: string; runId: string; effectId: string };

function problem(status: number, code: string, title: string): Response {
  return Response.json(
    { type: `urn:ultra-easy:problem:${code}`, title, status, code },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

function notFound(): Response {
  return problem(404, "human_input_not_found", "Human Input not found");
}

function repositoryProblem(error: { code: string; retriable: boolean }): Response {
  return problem(error.retriable ? 503 : 500, error.code, "Human Inputを読み取れません");
}

function assigned(
  effect: EffectRecord | undefined,
  record: WorkflowRunRecord,
  actor: UserPrincipalRef,
) {
  if (!effect || effect.request.kind !== "human_input") return false;
  const assignee =
    effect.request.assignee ??
    (record.invocation.actor.type === "user" ? record.invocation.actor : undefined);
  return assignee?.type === "user" && String(assignee.id) === String(actor.id);
}

function waiting(effect: EffectRecord, record: WorkflowRunRecord): boolean {
  const node = record.state.nodeRuns[String(effect.nodeRunId)];
  return (
    record.state.status === "waiting" &&
    effect.status === "in_flight" &&
    node?.status === "waiting" &&
    node.waitingReason === "waiting_input"
  );
}

function view(
  effect: EffectRecord,
  record: WorkflowRunRecord,
  actionRequestId: ActionRequestId,
): PublicHumanInputView | null {
  const request = effect.request;
  if (request.kind !== "human_input") return null;
  const assignee = request.assignee ?? record.invocation.actor;
  return {
    key: String(effect.id),
    runId: String(record.state.runId),
    actionRequestId: String(actionRequestId),
    prompt: request.prompt,
    assigneeId: String(assignee.id),
    ...(request.options ? { options: request.options } : {}),
    ...(request.answerSchema ? { answerSchema: request.answerSchema } : {}),
    ...(request.subject ? { subject: request.subject } : {}),
    ...(request.analysis ? { analysis: request.analysis } : {}),
    status: "waiting",
    requestedAt: effect.requestedAt,
  };
}

const parseBody = Result.fn({
  try: (text: string): unknown => JSON.parse(text),
  catch: () => null,
});

function cursorFrom(value: string | null): Cursor | null | Response {
  if (value === null) return null;
  if (value.length > 2048) return problem(400, "invalid_cursor", "cursorが不正です");
  const parsed = parseBody(value);
  if (Result.isFailure(parsed) || !isPlainRecord(parsed.value))
    return problem(400, "invalid_cursor", "cursorが不正です");
  const { createdAt, runId, effectId } = parsed.value;
  if (
    typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt)) ||
    typeof runId !== "string" ||
    typeof effectId !== "string" ||
    Result.isFailure(parseWorkflowId("WorkflowRunId", runId)) ||
    Result.isFailure(parseWorkflowId("EffectId", effectId))
  )
    return problem(400, "invalid_cursor", "cursorが不正です");
  return { createdAt, runId, effectId };
}

async function inputBatch(input: {
  db: D1DatabaseLike;
  organizationId: OrganizationId;
  actor: UserPrincipalRef;
  cursor: Cursor | null;
}) {
  return allRows<InputKeyRow>(
    input.db
      .prepare(
        `SELECT wr.run_id, effect.key AS effect_id, wr.parent_action_request_id, wr.created_at
         FROM workflow_runs wr, json_each(wr.state_json, '$.effects') effect
        WHERE wr.organization_id = ? AND wr.status = 'waiting'
          AND wr.parent_action_request_id IS NOT NULL
          AND json_extract(effect.value, '$.request.kind') = 'human_input'
          AND json_extract(effect.value, '$.status') = 'in_flight'
          AND (
            json_extract(effect.value, '$.request.assignee.id') = ?
            OR (json_type(effect.value, '$.request.assignee') IS NULL
                AND json_extract(wr.invocation_json, '$.actor.type') = 'user'
                AND json_extract(wr.invocation_json, '$.actor.id') = ?)
          )
          AND (? IS NULL OR wr.created_at < ?
            OR (wr.created_at = ? AND wr.run_id < ?)
            OR (wr.created_at = ? AND wr.run_id = ? AND effect.key < ?))
        ORDER BY wr.created_at DESC, wr.run_id DESC, effect.key DESC
        LIMIT 100`,
      )
      .bind(
        String(input.organizationId),
        String(input.actor.id),
        String(input.actor.id),
        input.cursor?.createdAt ?? null,
        input.cursor?.createdAt ?? null,
        input.cursor?.createdAt ?? null,
        input.cursor?.runId ?? null,
        input.cursor?.createdAt ?? null,
        input.cursor?.runId ?? null,
        input.cursor?.effectId ?? null,
      ),
  );
}

export function createPublicHumanInputApi(input: {
  db: D1DatabaseLike;
  platform: WorkflowPlatform;
  readRepository: ApprovalReadRepository;
  identityProvider: PublicHttpIdentityProvider;
  idempotencyRepository: IdempotencyRepository;
  clock: PublicHttpClock;
  onAnswerAccepted?: (key: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
  }) => Promise<void>;
}): { handles(request: Request): boolean; fetch(request: Request): Promise<Response> } {
  async function authorizedAction(
    request: Request,
    organizationId: OrganizationId,
    actionRequestId: string,
    operation: "action_request.read" | "action_request.submit",
  ) {
    const parsed = parseBrand("ActionRequestId", actionRequestId);
    if (Result.isFailure(parsed)) return notFound();
    const loaded = await input.readRepository.getActionRequest({
      organizationId,
      actionRequestId: parsed.value,
    });
    if (Result.isFailure(loaded)) return repositoryProblem(loaded.error);
    if (!loaded.value) return notFound();
    const restricted = await authorizePublicAction({
      identityProvider: input.identityProvider,
      request,
      organizationId,
      operation,
      action: loaded.value,
    });
    return restricted ?? loaded.value;
  }

  return {
    handles(request) {
      const matched = matchHttpRoute(PUBLIC_HUMAN_INPUT_ROUTES, new URL(request.url).pathname);
      return matched !== null && (request.method === "GET" || request.method === "POST");
    },
    async fetch(request) {
      const url = new URL(request.url);
      const matched = matchHttpRoute(PUBLIC_HUMAN_INPUT_ROUTES, url.pathname);
      if (!matched) return notFound();
      const isList = matched.route.endsWith("/me/human-inputs");
      if ((isList && request.method !== "GET") || (!isList && request.method !== "POST"))
        return notFound();
      const organization = parseBrand("OrganizationId", matched.parameters["organizationId"]);
      if (Result.isFailure(organization))
        return problem(400, "invalid_organization_id", "Organization IDが不正です");
      const organizationId = organization.value;
      const principal = await authenticatePublicApi({
        identityProvider: input.identityProvider,
        request,
        organizationId,
        operation: isList ? "action_request.read" : "action_request.submit",
      });
      if (principal instanceof Response) return principal;
      if (principal.type !== "user")
        return problem(403, "machine_principal_not_allowed", "User principalが必要です");
      const actor = principal;
      let clientId: ClientId | undefined;
      if (!isList && input.identityProvider.authenticateWithClient) {
        const identified = await input.identityProvider.authenticateWithClient({
          request,
          organizationId,
          operation: "action_request.submit",
        });
        if (Result.isFailure(identified))
          return problem(identified.error.status, identified.error.code, "Forbidden");
        if (
          identified.value.principal.type !== "user" ||
          String(identified.value.principal.id) !== String(actor.id)
        )
          return problem(403, "invalid_caller", "Forbidden");
        clientId = identified.value.clientId;
      }

      if (isList) {
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 50 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
          return problem(400, "invalid_limit", "limitが不正です");
        const parsedCursor = cursorFrom(url.searchParams.get("cursor"));
        if (parsedCursor instanceof Response) return parsedCursor;
        const items: PublicHumanInputView[] = [];
        let cursor = parsedCursor;
        let exhausted = false;
        while (items.length < limit && !exhausted) {
          const batch = await inputBatch({ db: input.db, organizationId, actor, cursor });
          if (Result.isFailure(batch)) return repositoryProblem(batch.error);
          if (batch.value.length === 0) {
            exhausted = true;
            break;
          }
          for (const [index, row] of batch.value.entries()) {
            cursor = { createdAt: row.created_at, runId: row.run_id, effectId: row.effect_id };
            const runId = parseWorkflowId("WorkflowRunId", row.run_id);
            if (Result.isFailure(runId))
              return repositoryProblem({ code: "workflow_stored_id_invalid", retriable: false });
            const loaded = await input.platform.repositories.runs.load({
              organizationId,
              runId: runId.value,
            });
            if (Result.isFailure(loaded)) return repositoryProblem(loaded.error);
            if (!loaded.value) continue;
            const effect = loaded.value.state.effects[row.effect_id];
            if (!assigned(effect, loaded.value, actor) || !effect || !waiting(effect, loaded.value))
              continue;
            const action = await authorizedAction(
              request,
              organizationId,
              row.parent_action_request_id,
              "action_request.read",
            );
            if (action instanceof Response) {
              if (action.status === 403 || action.status === 404) continue;
              return action;
            }
            const item = view(effect, loaded.value, action.id);
            if (item) items.push(item);
            if (items.length >= limit) {
              exhausted = index === batch.value.length - 1 && batch.value.length < 100;
              break;
            }
          }
          if (items.length >= limit) break;
          if (batch.value.length < 100) exhausted = true;
        }
        return Response.json({
          items,
          ...(exhausted ? {} : { nextCursor: JSON.stringify(cursor) }),
        });
      }

      if (!matched.parameters["runId"] || !matched.parameters["effectId"])
        return problem(400, "invalid_path_parameter", "path parameterが不正です");
      const runId = parseWorkflowId("WorkflowRunId", matched.parameters["runId"]);
      const effectId = parseWorkflowId("EffectId", matched.parameters["effectId"]);
      if (Result.isFailure(runId) || Result.isFailure(effectId))
        return problem(400, "invalid_path_parameter", "path parameterが不正です");
      const loaded = await input.platform.repositories.runs.load({
        organizationId,
        runId: runId.value,
      });
      if (Result.isFailure(loaded)) return repositoryProblem(loaded.error);
      const record = loaded.value;
      const effect = record?.state.effects[String(effectId.value)];
      if (!record || !assigned(effect, record, actor) || !record.invocation.parentAction)
        return notFound();
      const action = await authorizedAction(
        request,
        organizationId,
        String(record.invocation.parentAction.actionRequestId),
        "action_request.submit",
      );
      if (action instanceof Response) return action;

      return idempotent({
        request,
        organizationId,
        operation: `human_input.answer:${String(runId.value)}:${String(effectId.value)}:${String(actor.id)}`,
        repository: input.idempotencyRepository,
        clock: input.clock,
        execute: async () => {
          const text = await request.text();
          if (text.length > 65_536)
            return problem(400, "invalid_human_input_answer", "回答が長すぎます");
          const body = parseBody(text);
          if (
            Result.isFailure(body) ||
            !isPlainRecord(body.value) ||
            Object.keys(body.value).length !== 1 ||
            !Object.hasOwn(body.value, "answer") ||
            jsonValueIssue(body.value["answer"])
          ) {
            return problem(400, "invalid_human_input_answer", "回答が不正です");
          }
          const accepted = await input.platform.runtime.answerHumanInput({
            organizationId,
            runId: runId.value,
            effectId: effectId.value,
            answer: body.value["answer"] as JsonValue,
            actor,
            ...(clientId ? { clientId } : {}),
            idempotencyKey: request.headers.get("idempotency-key") ?? "",
          });
          if (Result.isFailure(accepted)) {
            if (
              accepted.error.code === "workflow_run_not_found" ||
              accepted.error.code === "human_input_not_found" ||
              accepted.error.code === "human_input_not_assigned"
            )
              return notFound();
            if (accepted.error.code === "human_input_already_answered")
              return problem(409, accepted.error.code, "回答済みです");
            if (accepted.error.code === "invalid_human_input_answer")
              return problem(400, accepted.error.code, "回答がschemaに一致しません");
            return repositoryProblem(accepted.error);
          }
          if (input.onAnswerAccepted) {
            const wake = Result.fn({ try: input.onAnswerAccepted, catch: () => undefined });
            await wake({ organizationId, runId: runId.value });
          }
          return Response.json({
            runId: String(runId.value),
            inputKey: String(effectId.value),
            status: "answered",
          });
        },
      });
    },
  };
}
