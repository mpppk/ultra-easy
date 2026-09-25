import { env } from "cloudflare:workers";

import { Result } from "@praha/byethrow";

import { createRuntime, type KnowledgeEnv, type KnowledgeRuntime } from "./runtime.ts";

let cached: KnowledgeRuntime | null = null;

/** Worker-scoped runtime (bindings from `cloudflare:workers`). */
export function knowledgeRuntime(): KnowledgeRuntime | null {
  if (cached) return cached;
  const created = createRuntime(env as unknown as KnowledgeEnv);
  if (Result.isFailure(created)) return null;
  cached = created.value;
  return cached;
}

export function misconfigured(): Response {
  return Response.json(
    { code: "misconfigured", title: "Knowledge Workspace is not configured" },
    { status: 503 },
  );
}
