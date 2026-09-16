import { createFileRoute } from "@tanstack/react-router";

import { isPreviewScenario } from "../preview/scenarios.ts";
import {
  isPreviewHarnessEnabled,
  json,
  previewNotFound,
  startPreviewRun,
} from "../preview/server.ts";

export const Route = createFileRoute("/api/preview/approval-runs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isPreviewHarnessEnabled()) return previewNotFound();
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
