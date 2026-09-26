import { Result } from "@praha/byethrow";

import { newId } from "@app/knowledge-core";

import {
  MAINTENANCE_SCHEDULE_TRIGGER,
  type PrincipalRef,
  type UltraEasyClient,
  type UltraEasyError,
} from "../ultra-easy/client.ts";
import type { KnowledgeRuntime } from "./runtime.ts";

export type MaintenanceStart = { runId: string; status: string; started: boolean };

/**
 * Starts `knowledge.maintain_space` for one space unless a run is already
 * running / waiting for it. Manual runs and the weekly trigger (#184) share
 * this path, so both start the same Workflow Definition; only the requesting
 * principal and the idempotency key differ.
 */
export async function startSpaceMaintenance(input: {
  ultraEasy: UltraEasyClient;
  organizationId: string;
  spaceId: string;
  actor: PrincipalRef;
  idempotencyKey: string;
}): Result.ResultAsync<MaintenanceStart, UltraEasyError> {
  const runs = await input.ultraEasy.listRuns({
    organizationId: input.organizationId,
    spaceIds: [input.spaceId],
    limit: 50,
  });
  if (Result.isFailure(runs)) return runs;
  const active = runs.value.find(
    (run) =>
      run.actionType === "knowledge.maintain_space" &&
      (run.status === "running" ||
        run.status === "waiting_input" ||
        run.status === "waiting_approval"),
  );
  if (active) return Result.succeed({ runId: active.id, status: active.status, started: false });
  const started = await input.ultraEasy.startAction({
    organizationId: input.organizationId,
    actor: input.actor,
    actionType: "knowledge.maintain_space",
    resource: { type: "knowledge_space", id: input.spaceId },
    input: { spaceId: input.spaceId },
    correlation: { spaceId: input.spaceId },
    idempotencyKey: input.idempotencyKey,
  });
  if (Result.isFailure(started)) return started;
  return Result.succeed({
    runId: started.value.run.id,
    status: started.value.run.status,
    started: true,
  });
}

export function manualMaintenanceKey(spaceId: string): string {
  return `maintain:${spaceId}:${newId("m")}`;
}

/** Monday (UTC) of the week `at` falls in: one scheduled run per space and week. */
export function maintenanceWeek(at: Date): string {
  const monday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

export function scheduledMaintenanceKey(spaceId: string, at: Date): string {
  return `maintain:${spaceId}:weekly:${maintenanceWeek(at)}`;
}

export type ScheduledMaintenanceOutcome = {
  spaceId: string;
  spaceKey: string;
  outcome: "started" | "skipped_active" | "failed";
  runId?: string;
  errorCode?: string;
};

/**
 * Weekly trigger (#184): one `knowledge.maintain_space` run per space of the
 * organization, requested by the schedule trigger principal. A space whose
 * maintenance run is still running / waiting is skipped; the week-scoped
 * idempotency key makes a redelivered Cron event a no-op. One failing space
 * never stops the sweep.
 */
export async function runScheduledMaintenance(
  runtime: Pick<KnowledgeRuntime, "repos" | "ultraEasy" | "organizationId">,
  scheduledAt: Date,
): Result.ResultAsync<ScheduledMaintenanceOutcome[], { code: "store_unavailable" }> {
  const spaces = await runtime.repos.spaces.listAll(runtime.organizationId);
  if (Result.isFailure(spaces)) return Result.fail({ code: "store_unavailable" });
  const outcomes: ScheduledMaintenanceOutcome[] = [];
  for (const space of spaces.value) {
    const started = await startSpaceMaintenance({
      ultraEasy: runtime.ultraEasy,
      organizationId: runtime.organizationId,
      spaceId: space.id,
      actor: MAINTENANCE_SCHEDULE_TRIGGER,
      idempotencyKey: scheduledMaintenanceKey(space.id, scheduledAt),
    });
    outcomes.push(
      Result.isFailure(started)
        ? {
            spaceId: space.id,
            spaceKey: space.key,
            outcome: "failed",
            errorCode: started.error.code,
          }
        : {
            spaceId: space.id,
            spaceKey: space.key,
            outcome: started.value.started ? "started" : "skipped_active",
            runId: started.value.runId,
          },
    );
  }
  return Result.succeed(outcomes);
}
