import { adminPath, consoleGet, type ConsoleCatalog } from "#lib/console-client";

import { useConsoleQuery } from "./use-console-query.ts";

export function useConsoleCatalog() {
  return useConsoleQuery(() => consoleGet<ConsoleCatalog>(adminPath("/catalog")), []);
}
