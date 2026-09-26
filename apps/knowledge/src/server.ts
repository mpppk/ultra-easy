import handler from "@tanstack/react-start/server-entry";

import { Result } from "@praha/byethrow";

import { knowledgeRuntime } from "./server/env.ts";
import { runScheduledMaintenance } from "./server/maintenance.ts";

/** One structured JSON line per scheduled invocation (the worker's only console exit). */
function log(record: Record<string, unknown>) {
  // oxlint-disable-next-line no-console
  console.log(JSON.stringify({ app: "knowledge", ...record }));
}

/**
 * Worker entry: TanStack Start serves every request; the Cron Trigger
 * (`wrangler.jsonc` → `triggers.crons`) starts the weekly
 * `knowledge.maintain_space` run per space (#184). This is the interim trigger
 * until the ultra-easy Workflow scheduler / Timer Trigger is public.
 */
export default {
  fetch: handler.fetch,

  async scheduled(controller: ScheduledController): Promise<void> {
    const runtime = knowledgeRuntime();
    if (!runtime) {
      log({ event: "scheduled.maintenance", outcome: "misconfigured", cron: controller.cron });
      return;
    }
    const outcomes = await runScheduledMaintenance(runtime, new Date(controller.scheduledTime));
    log(
      Result.isFailure(outcomes)
        ? { event: "scheduled.maintenance", outcome: "failed", errorCode: outcomes.error.code }
        : { event: "scheduled.maintenance", outcome: "completed", spaces: outcomes.value },
    );
  },
};
