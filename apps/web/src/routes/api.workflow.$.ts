import { createFileRoute } from "@tanstack/react-router";

import { proxyWorkflowStudioRequest } from "../server/console-api.ts";
import { consoleEnv } from "../server/console-env.ts";

const handle = ({ request }: { request: Request }) =>
  proxyWorkflowStudioRequest(request, consoleEnv());

export const Route = createFileRoute("/api/workflow/$")({
  server: { handlers: { GET: handle, POST: handle, PUT: handle } },
});
