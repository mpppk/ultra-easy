import { env } from "cloudflare:workers";

import type { ConsoleWebEnv } from "./console-api.ts";

export function consoleEnv(): ConsoleWebEnv {
  return env as unknown as ConsoleWebEnv;
}
