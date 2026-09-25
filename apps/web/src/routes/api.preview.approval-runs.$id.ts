import { createFileRoute } from "@tanstack/react-router";

import { getPreviewRun, authorizePreviewRequest } from "../preview/server.ts";

export const Route = createFileRoute("/api/preview/approval-runs/$id")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const denied = await authorizePreviewRequest(request);
        if (denied) return denied;
        return getPreviewRun(params.id);
      },
    },
  },
});
