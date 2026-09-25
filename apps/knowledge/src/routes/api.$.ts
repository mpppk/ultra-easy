import { createFileRoute } from "@tanstack/react-router";

import { handleKnowledgeApi } from "../server/api.ts";
import { knowledgeRuntime, misconfigured } from "../server/env.ts";

function handle({ request }: { request: Request }) {
  const runtime = knowledgeRuntime();
  return runtime ? handleKnowledgeApi(request, runtime) : misconfigured();
}

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: { GET: handle, POST: handle, PUT: handle, DELETE: handle },
  },
});
