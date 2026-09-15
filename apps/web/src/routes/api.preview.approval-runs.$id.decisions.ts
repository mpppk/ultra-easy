import { createFileRoute } from "@tanstack/react-router";

import type { ActionRequestId, ApprovalTaskId, UserId } from "@app/approval-core";

import {
  isPreviewHarnessEnabled,
  json,
  previewNotFound,
  sendPreviewDecision,
} from "../preview/server.ts";

export const Route = createFileRoute("/api/preview/approval-runs/$id/decisions")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        if (!isPreviewHarnessEnabled()) return previewNotFound();
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

        return json(
          await sendPreviewDecision({
            actionRequestId: params.id as ActionRequestId,
            taskId: taskId as ApprovalTaskId,
            userId: userId as UserId,
            decision,
          }),
          { status: 202 },
        );
      },
    },
  },
});
