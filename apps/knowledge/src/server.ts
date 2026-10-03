import handler from "@tanstack/react-start/server-entry";

import type { KnowledgeEnv } from "./server/runtime.ts";

/**
 * Worker entry: TanStack Start serves requests. Weekly maintenance is
 * registered as a governed schedule in ultra-easy when a space is created.
 */
export default {
  fetch(request: Request, env: KnowledgeEnv): Promise<Response> | Response {
    const pathname = new URL(request.url).pathname;
    if (
      env.ULTRA_EASY_MODE === "remote" &&
      (pathname === "/mock/ultra-easy" || pathname.startsWith("/mock/ultra-easy/"))
    ) {
      return new Response("Not Found", { status: 404 });
    }
    return handler.fetch(request);
  },
};
