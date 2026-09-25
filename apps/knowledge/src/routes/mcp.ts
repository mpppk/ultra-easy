import { createFileRoute } from "@tanstack/react-router";

import { knowledgeRuntime, misconfigured } from "../server/env.ts";

/** Streamable HTTP MCP endpoint for the ultra-easy MCP Gateway. */
export const Route = createFileRoute("/mcp")({
  server: {
    handlers: {
      POST: ({ request }) => {
        const runtime = knowledgeRuntime();
        return runtime ? runtime.mcp(request) : misconfigured();
      },
    },
  },
});
