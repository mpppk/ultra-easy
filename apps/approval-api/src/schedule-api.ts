import { Result } from "@praha/byethrow";

import {
  actionRequestProblem,
  parseActionRequestCreateBody,
  type ActionRequestApplicationService,
  type TrustedActionRequestContext,
} from "@app/approval-application";
import {
  decodeUriComponent,
  parseBrand,
  type Action,
  type OrganizationId,
} from "@app/approval-core";
import { D1PublishedActionDefinitionResolver } from "@app/approval-d1";
import { nextScheduleSlot, WORKFLOW_EXECUTOR_KEY } from "@app/workflow-application";
import {
  D1WorkflowScheduleRepository,
  type WorkflowSchedule,
  type WorkflowScheduleSlot,
} from "@app/workflow-d1";

import type { Auth0IdentityProvider } from "./auth0-identity.ts";

export const PUBLIC_SCHEDULE_ROUTES = [
  "/v1/organizations/:organizationId/schedules",
  "/v1/organizations/:organizationId/schedules/:scheduleId",
  "/v1/organizations/:organizationId/schedules/:scheduleId/stop",
  "/v1/organizations/:organizationId/schedules/:scheduleId/resume",
  "/v1/organizations/:organizationId/schedules/:scheduleId/slots",
];

type ScheduleApiInput = {
  db: D1Database;
  organizationId: OrganizationId;
  identity: Auth0IdentityProvider;
  service: ActionRequestApplicationService;
};

const BASE = /^\/v1\/organizations\/([^/]+)\/schedules(?:\/([^/]+)(?:\/(stop|resume|slots))?)?$/;

function problem(status: number, code: string): Response {
  return actionRequestProblem({ status, code, title: code });
}

function publicSchedule(schedule: WorkflowSchedule) {
  return {
    id: schedule.id,
    key: schedule.key,
    cron: schedule.cron,
    timezone: "UTC",
    action: schedule.action,
    correlation: schedule.correlation,
    ownerUserId: schedule.ownerUserId,
    status: schedule.status,
    nextSlotAt: schedule.nextSlotAt,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}

function publicSlot(slot: WorkflowScheduleSlot) {
  return {
    slotAt: slot.slotAt,
    actionRequestId: slot.actionRequestId,
    status: slot.status,
    attemptCount: slot.attemptCount,
    errorCode: slot.errorCode,
    createdAt: slot.createdAt,
    updatedAt: slot.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scheduleContext(input: {
  organizationId: OrganizationId;
  ownerUserId: string;
  clientId: string;
  scheduleId: string;
  action: Action;
  now: string;
}): Result.Result<TrustedActionRequestContext, { code: string }> {
  const ownerId = parseBrand("UserId", input.ownerUserId);
  const actorId = parseBrand("ServiceId", `service:schedule:${input.scheduleId}`);
  const grantId = parseBrand("DelegationGrantId", `schedule:${input.scheduleId}`);
  const clientId = parseBrand("ClientId", input.clientId);
  if (
    Result.isFailure(ownerId) ||
    Result.isFailure(actorId) ||
    Result.isFailure(grantId) ||
    Result.isFailure(clientId)
  ) {
    return Result.fail({ code: "invalid_schedule_principal" });
  }
  const owner = { type: "user" as const, id: ownerId.value };
  const actor = { type: "service" as const, id: actorId.value };
  return Result.succeed({
    actor,
    authority: {
      principal: owner,
      delegation: {
        chain: [
          {
            delegator: owner,
            delegatee: actor,
            grantId: grantId.value,
            scope: {
              // Child ActionRequests use their own action types. The persisted root
              // action is immutable; all descendants remain bound to this resource.
              resourceTypes: [input.action.resource.type],
              resourceIds: [input.action.resource.id],
            },
          },
        ],
      },
    },
    origin: { type: "system", clientId: clientId.value },
    organization: { id: input.organizationId },
    now: input.now,
  });
}

function sameDefinition(
  schedule: WorkflowSchedule,
  input: {
    cron: string;
    action: Action;
    correlation: Record<string, string>;
  },
): boolean {
  return (
    schedule.cron === input.cron &&
    JSON.stringify(schedule.action) === JSON.stringify(input.action) &&
    JSON.stringify(schedule.correlation) === JSON.stringify(input.correlation)
  );
}

export function createPublicScheduleApi(input: ScheduleApiInput) {
  const repository = new D1WorkflowScheduleRepository(input.db);
  const definitions = new D1PublishedActionDefinitionResolver(input.db, input.organizationId);

  return {
    handles(request: Request): boolean {
      return BASE.test(new URL(request.url).pathname);
    },
    async fetch(request: Request): Promise<Response> {
      const matched = BASE.exec(new URL(request.url).pathname);
      if (!matched) return problem(404, "not_found");
      const [, rawOrganizationId, rawScheduleId, operation] = matched;
      const organizationId = decodeUriComponent(rawOrganizationId ?? "");
      const scheduleId = rawScheduleId ? decodeUriComponent(rawScheduleId) : null;
      if (Result.isFailure(organizationId) || (scheduleId && Result.isFailure(scheduleId)))
        return problem(400, "invalid_path_parameter");
      if (organizationId.value !== String(input.organizationId)) return problem(404, "not_found");
      const id = scheduleId?.value;
      if (id && !/^schedule:[a-f0-9-]{36}$/.test(id)) return problem(400, "invalid_schedule_id");
      if (request.method !== "GET" && request.method !== "POST")
        return problem(405, "method_not_allowed");

      const body = request.method === "POST" && !id ? await request.json().catch(() => null) : null;
      const posted = isRecord(body) ? body : null;
      const actionBody = posted
        ? parseActionRequestCreateBody({ action: posted.action, correlation: posted.correlation })
        : null;
      if (request.method === "POST" && !id && (!posted || !actionBody)) {
        return problem(400, "invalid_schedule_body");
      }
      const authenticated = await input.identity.authenticateWithClient({
        request,
        organizationId: input.organizationId,
        operation: "action_request.submit",
        ...(actionBody
          ? {
              actionType: String(actionBody.action.type),
              resourceType: String(actionBody.action.resource.type),
            }
          : {}),
      });
      if (Result.isFailure(authenticated))
        return problem(authenticated.error.status, authenticated.error.code);
      if (authenticated.value.principal.type !== "user") return problem(403, "user_required");
      const ownerUserId = String(authenticated.value.principal.id);
      const now = new Date().toISOString();

      if (!id && request.method === "GET") {
        const listed = await repository.list({ organizationId: input.organizationId, ownerUserId });
        return Result.isFailure(listed)
          ? problem(503, listed.error.code)
          : Response.json({ schedules: listed.value.map(publicSchedule) });
      }

      if (!id && request.method === "POST" && posted && actionBody) {
        const key = posted.key;
        const cron = posted.cron;
        if (
          typeof key !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(key) ||
          typeof cron !== "string" ||
          cron.length > 128
        )
          return problem(400, "invalid_schedule_body");
        const next = nextScheduleSlot(cron, now);
        if (Result.isFailure(next)) return problem(400, "invalid_cron");
        const existing = await repository.findByKey({
          organizationId: input.organizationId,
          key,
        });
        if (Result.isFailure(existing)) return problem(503, existing.error.code);
        const definition = await definitions.resolve(actionBody.action.type);
        if (Result.isFailure(definition)) return problem(503, definition.error.code);
        if (definition.value?.executorKey !== WORKFLOW_EXECUTOR_KEY)
          return problem(400, "composite_action_required");
        const correlation = actionBody.correlation ?? {};
        if (existing.value) {
          return existing.value.ownerUserId === ownerUserId &&
            sameDefinition(existing.value, { cron, action: actionBody.action, correlation })
            ? Response.json(publicSchedule(existing.value), { status: 200 })
            : problem(409, "schedule_key_conflict");
        }
        const newId = `schedule:${crypto.randomUUID()}`;
        const context = scheduleContext({
          organizationId: input.organizationId,
          ownerUserId,
          clientId: String(authenticated.value.clientId),
          scheduleId: newId,
          action: actionBody.action,
          now,
        });
        if (Result.isFailure(context)) return problem(400, context.error.code);
        const prepared = await input.service.prepare({
          action: actionBody.action,
          trustedContext: context.value,
        });
        if (Result.isFailure(prepared))
          return problem(prepared.error.retriable ? 503 : 400, prepared.error.code);
        if (prepared.value.type === "authorization_denied")
          return problem(403, prepared.value.code);
        const schedule: WorkflowSchedule = {
          organizationId: input.organizationId,
          id: newId,
          key,
          ownerUserId,
          clientId: String(authenticated.value.clientId),
          cron,
          action: actionBody.action,
          correlation,
          status: "active",
          nextSlotAt: next.value,
          createdAt: now,
          updatedAt: now,
        };
        const created = await repository.create(schedule);
        if (Result.isFailure(created)) return problem(503, created.error.code);
        if (created.value) return Response.json(publicSchedule(schedule), { status: 201 });
        const raced = await repository.findByKey({
          organizationId: input.organizationId,
          key,
        });
        return Result.isSuccess(raced) &&
          raced.value &&
          raced.value.ownerUserId === ownerUserId &&
          sameDefinition(raced.value, { cron, action: actionBody.action, correlation })
          ? Response.json(publicSchedule(raced.value))
          : problem(409, "schedule_key_conflict");
      }

      if (!id) return problem(405, "method_not_allowed");
      const loaded = await repository.find({
        organizationId: input.organizationId,
        id,
      });
      if (Result.isFailure(loaded)) return problem(503, loaded.error.code);
      if (!loaded.value || loaded.value.ownerUserId !== ownerUserId)
        return problem(404, "not_found");
      const schedule = loaded.value;
      if (request.method === "GET" && operation === "slots") {
        const slots = await repository.slots({
          organizationId: input.organizationId,
          scheduleId: schedule.id,
        });
        return Result.isFailure(slots)
          ? problem(503, slots.error.code)
          : Response.json({ slots: slots.value.map(publicSlot) });
      }
      if (request.method === "GET" && !operation) return Response.json(publicSchedule(schedule));
      if (request.method === "POST" && (operation === "stop" || operation === "resume")) {
        const nextSlotAt = operation === "stop" ? null : nextScheduleSlot(schedule.cron, now);
        if (nextSlotAt && Result.isFailure(nextSlotAt)) return problem(400, "invalid_cron");
        const next = nextSlotAt ? nextSlotAt.value : null;
        const saved = await repository.setStatus({
          organizationId: input.organizationId,
          id: schedule.id,
          ownerUserId,
          status: operation === "stop" ? "stopped" : "active",
          nextSlotAt: next,
          now,
        });
        if (Result.isFailure(saved)) return problem(503, saved.error.code);
        return Response.json({
          ...publicSchedule(schedule),
          status: operation === "stop" ? "stopped" : "active",
          nextSlotAt: next,
          updatedAt: now,
        });
      }
      return problem(405, "method_not_allowed");
    },
  };
}

/** The every-minute Worker Cron is a dispatcher; schedule definitions remain in D1. */
export async function sweepWorkflowSchedules(input: {
  db: D1Database;
  organizationId: OrganizationId;
  service: ActionRequestApplicationService;
  clientAllowed: (schedule: WorkflowSchedule) => boolean;
  now: string;
}): Result.ResultAsync<{ processed: number }, { code: string }> {
  const repository = new D1WorkflowScheduleRepository(input.db);
  const due = await repository.due({ organizationId: input.organizationId, now: input.now });
  if (Result.isFailure(due)) return Result.fail({ code: due.error.code });
  for (const schedule of due.value) {
    if (!schedule.nextSlotAt) continue;
    const next = nextScheduleSlot(schedule.cron, schedule.nextSlotAt);
    if (Result.isFailure(next)) return Result.fail({ code: "invalid_stored_cron" });
    const enqueued = await repository.enqueueSlot({
      schedule,
      nextSlotAt: next.value,
      now: input.now,
    });
    if (Result.isFailure(enqueued)) return Result.fail({ code: enqueued.error.code });
  }
  const pending = await repository.pending({
    organizationId: input.organizationId,
    now: input.now,
  });
  if (Result.isFailure(pending)) return Result.fail({ code: pending.error.code });
  let processed = 0;
  let failedCode: string | null = null;
  for (const slot of pending.value) {
    const claimed = await repository.claimSlot({
      slot,
      now: input.now,
      lockedUntil: new Date(Date.parse(input.now) + 5 * 60_000).toISOString(),
    });
    if (Result.isFailure(claimed)) {
      failedCode ??= claimed.error.code;
      continue;
    }
    if (!claimed.value) continue;
    const loaded = await repository.find({
      organizationId: input.organizationId,
      id: slot.scheduleId,
    });
    if (Result.isFailure(loaded) || !loaded.value || loaded.value.status !== "active") {
      await repository.finishSlot({
        slot,
        status: "failed",
        errorCode: "schedule_stopped",
        now: input.now,
      });
      if (Result.isFailure(loaded)) failedCode ??= loaded.error.code;
      continue;
    }
    const schedule = loaded.value;
    let preparation = slot.preparation;
    if (!preparation) {
      if (!input.clientAllowed(schedule)) {
        const denied = await repository.finishSlot({
          slot,
          status: "denied",
          errorCode: "client_grant_revoked",
          now: input.now,
        });
        if (Result.isFailure(denied)) failedCode ??= denied.error.code;
        continue;
      }
      const active = await repository.hasActiveRun({ slot });
      if (Result.isFailure(active)) {
        failedCode ??= active.error.code;
        continue;
      }
      if (active.value) {
        const skipped = await repository.finishSlot({
          slot,
          status: "skipped",
          errorCode: "previous_run_active",
          now: input.now,
        });
        if (Result.isFailure(skipped)) failedCode ??= skipped.error.code;
        continue;
      }
      const actionRequestId = parseBrand("ActionRequestId", slot.actionRequestId);
      if (Result.isFailure(actionRequestId)) {
        failedCode ??= "invalid_action_request_id";
        continue;
      }
      const context = scheduleContext({
        organizationId: input.organizationId,
        ownerUserId: schedule.ownerUserId,
        clientId: schedule.clientId,
        scheduleId: schedule.id,
        action: schedule.action,
        now: input.now,
      });
      if (Result.isFailure(context)) {
        failedCode ??= context.error.code;
        continue;
      }
      const prepared = await input.service.prepare({
        action: schedule.action,
        trustedContext: context.value,
        actionRequestId: actionRequestId.value,
        correlation: { ...schedule.correlation, scheduleId: schedule.id, slotAt: slot.slotAt },
      });
      if (Result.isFailure(prepared)) {
        await repository.finishSlot({
          slot,
          status: prepared.error.retriable ? "pending" : "failed",
          errorCode: prepared.error.code,
          now: input.now,
        });
        failedCode ??= prepared.error.code;
        continue;
      }
      preparation = prepared.value;
      const saved = await repository.savePreparation({ slot, preparation, now: input.now });
      if (Result.isFailure(saved) || !saved.value) {
        failedCode ??= "schedule_preparation_save_failed";
        continue;
      }
    }
    const committed = await input.service.commit({ preparation, now: input.now, resume: true });
    if (Result.isFailure(committed)) {
      await repository.finishSlot({
        slot,
        status: committed.error.retriable ? "pending" : "failed",
        errorCode: committed.error.code,
        now: input.now,
      });
      failedCode ??= committed.error.code;
      continue;
    }
    const finished = await repository.finishSlot({
      slot,
      status: committed.value.type === "authorization_denied" ? "denied" : "accepted",
      ...(committed.value.type === "authorization_denied"
        ? { errorCode: committed.value.code }
        : {}),
      now: input.now,
    });
    if (Result.isFailure(finished)) failedCode ??= finished.error.code;
    else processed += 1;
  }
  return failedCode ? Result.fail({ code: failedCode }) : Result.succeed({ processed });
}
