import { createFileRoute } from "@tanstack/react-router";

import { authorizePreviewRequest, proxyWorkflowStudio } from "../preview/server.ts";

async function handle({ request }: { request: Request }): Promise<Response> {
  const denied = await authorizePreviewRequest(request);
  if (denied) return denied;
  return proxyWorkflowStudio(request);
}

export const Route = createFileRoute("/api/preview/workflow/$")({
  server: {
    handlers: { GET: handle, POST: handle, PUT: handle },
  },
});
