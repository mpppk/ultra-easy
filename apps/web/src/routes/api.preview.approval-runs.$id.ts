import { createFileRoute } from "@tanstack/react-router";

import type { ActionRequestId } from "@app/approval-core";

import {
  getPreviewRun,
  isPreviewHarnessEnabled,
  json,
  previewNotFound,
} from "../preview/server.ts";

export const Route = createFileRoute("/api/preview/approval-runs/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (!isPreviewHarnessEnabled()) return previewNotFound();
        const run = await getPreviewRun(params.id as ActionRequestId);
        return run ? json(run) : json({ error: "preview run not found" }, { status: 404 });
      },
    },
  },
});
