import { createFileRoute } from "@tanstack/react-router";

import { isPreviewScenario } from "../preview/scenarios.ts";
import { authorizePreviewRequest, json, startPreviewRun } from "../preview/server.ts";

export const Route = createFileRoute("/api/preview/approval-runs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await authorizePreviewRequest(request);
        if (denied) return denied;
        const body = await request.json().catch(() => null);
        const scenario =
          body && typeof body === "object" && "scenario" in body ? body.scenario : undefined;
        if (!isPreviewScenario(scenario)) {
          return json({ error: "invalid preview scenario" }, { status: 400 });
        }

        return startPreviewRun(scenario);
      },
    },
  },
});
