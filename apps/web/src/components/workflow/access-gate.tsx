import { useRouterState } from "@tanstack/react-router";
import { LogInIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ErrorState, LoadingState } from "#components/layout/states";
import { Button } from "#components/ui/button";
import { useConsoleQuery } from "#hooks/use-console-query";
import { adminPath, consoleGet, type ConsoleSession } from "#lib/console-client";

/** The API enforces access too; this gate gives anonymous users a useful sign-in path. */
export function WorkflowAccessGate({ children }: { children: ReactNode }) {
  const session = useConsoleQuery(() => consoleGet<ConsoleSession>(adminPath("/session")), []);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  if (session.status === "loading" || session.status === "idle") {
    return <LoadingState label="Loading session" />;
  }
  if (session.status === "error") {
    return session.error.status === 401 ? (
      <div className="flex flex-col items-start gap-3">
        <ErrorState title="Sign in required" code={session.error.code} />
        <Button asChild>
          <a href={`/login?redirect=${encodeURIComponent(pathname)}`}>
            <LogInIcon aria-hidden /> Sign in
          </a>
        </Button>
      </div>
    ) : (
      <ErrorState title="Could not load the session" code={session.error.code} />
    );
  }
  if (session.status !== "success") return null;
  if (!session.data.permissions.viewer) {
    return <ErrorState title="Forbidden" code="workflow_studio_forbidden" />;
  }
  return children;
}
