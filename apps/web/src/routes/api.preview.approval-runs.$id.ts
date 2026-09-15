import { createFileRoute } from "@tanstack/react-router";

import {
  getPreviewRun,
  isPreviewHarnessEnabled,
  previewNotFound,
} from "../preview/server.ts";

export const Route = createFileRoute("/api/preview/approval-runs/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (!isPreviewHarnessEnabled()) return previewNotFound();
        return getPreviewRun(params.id);
      },
    },
  },
});
