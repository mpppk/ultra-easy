import { createFileRoute } from "@tanstack/react-router";

import { authorizePreviewRequest, json, sendPreviewForceCancel } from "../preview/server.ts";

export const Route = createFileRoute("/api/preview/approval-runs/$id/force-cancel")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const denied = await authorizePreviewRequest(request);
        if (denied) return denied;
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") {
          return json({ error: "reasonを含むJSON objectを送信してください" }, { status: 400 });
        }

        const reason = "reason" in body ? body.reason : undefined;
        const actor = "actor" in body ? body.actor : undefined;
        if (typeof reason !== "string" || reason.trim().length === 0) {
          return json(
            { error: "force cancelにはhuman-readableなreasonが必要です" },
            { status: 400 },
          );
        }
        if (
          actor !== undefined &&
          (typeof actor !== "object" ||
            actor === null ||
            Array.isArray(actor) ||
            typeof (actor as Record<string, unknown>).type !== "string" ||
            typeof (actor as Record<string, unknown>).id !== "string")
        ) {
          return json({ error: "actorは{type, id}のobjectである必要があります" }, { status: 400 });
        }

        return sendPreviewForceCancel({
          actionRequestId: params.id,
          reason,
          ...(actor === undefined
            ? {}
            : {
                actor: {
                  type: (actor as Record<string, unknown>).type as string,
                  id: (actor as Record<string, unknown>).id as string,
                },
              }),
        });
      },
    },
  },
});
