import { createContext, useContext } from "react";

import type { ConsoleSession } from "#lib/console-client";

export const ConsoleSessionContext = createContext<ConsoleSession | null>(null);

export function useConsoleSession(): ConsoleSession {
  const session = useContext(ConsoleSessionContext);
  // The admin shell only renders pages after a viewer session is loaded.
  return session as ConsoleSession;
}
