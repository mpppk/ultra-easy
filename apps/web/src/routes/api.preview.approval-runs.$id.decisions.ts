import { createFileRoute } from "@tanstack/react-router";

import { authorizePreviewRequest, json, sendPreviewDecision } from "../preview/server.ts";

export const Route = createFileRoute("/api/preview/approval-runs/$id/decisions")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const denied = await authorizePreviewRequest(request);
        if (denied) return denied;
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") {
          return json({ error: "invalid decision payload" }, { status: 400 });
        }

        const taskId = "taskId" in body ? body.taskId : undefined;
        const userId = "userId" in body ? body.userId : undefined;
        const decision = "decision" in body ? body.decision : undefined;
        if (
          typeof taskId !== "string" ||
          typeof userId !== "string" ||
          (decision !== "approve" && decision !== "reject")
        ) {
          return json({ error: "invalid decision payload" }, { status: 400 });
        }

        return sendPreviewDecision({
          actionRequestId: params.id,
          taskId,
          userId,
          decision,
        });
      },
    },
  },
});
