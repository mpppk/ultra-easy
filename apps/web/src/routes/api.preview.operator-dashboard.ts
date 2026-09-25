import { createFileRoute } from "@tanstack/react-router";

import { getOperatorDashboard, authorizePreviewRequest, json } from "../preview/server.ts";

export const Route = createFileRoute("/api/preview/operator-dashboard")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const denied = await authorizePreviewRequest(request);
        if (denied) return denied;
        const organizationId =
          new URL(request.url).searchParams.get("organizationId")?.trim() ?? "";
        if (organizationId.length === 0) {
          return json({ error: "organizationId query is required" }, { status: 400 });
        }
        return getOperatorDashboard(organizationId);
      },
    },
  },
});
