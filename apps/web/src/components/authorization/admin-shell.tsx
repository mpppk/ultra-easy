import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { LogInIcon, LogOutIcon, ShieldIcon } from "lucide-react";

import { PageContainer } from "#components/layout/page";
import { ErrorState, LoadingState } from "#components/layout/states";
import { Badge } from "#components/ui/badge";
import { Button } from "#components/ui/button";
import { adminPath, consoleGet, consolePost, type ConsoleSession } from "#lib/console-client";
import { cn } from "#lib/utils";
import { useConsoleQuery } from "#hooks/use-console-query";

import { ConsoleSessionContext } from "./console-session.tsx";
import { CopyableId } from "./copyable-id.tsx";

const NAV = [
  { to: "/admin/authorization/explorer", label: "Explorer" },
  { to: "/admin/authorization/relationships", label: "Relationships" },
  { to: "/admin/authorization/model", label: "Model" },
  { to: "/admin/authorization/audit", label: "Audit" },
] as const;

export function AdminShell() {
  const session = useConsoleQuery(() => consoleGet<ConsoleSession>(adminPath("/session")), []);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <PageContainer className="max-w-7xl">
      <header className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ShieldIcon aria-hidden className="size-6" />
            Authorization Console
          </h1>
          <p className="text-sm text-muted-foreground">
            Inspect and operate authorization. Relationship changes are governed ActionRequests; the
            model is read-only (GitOps).
          </p>
        </div>
        {session.status === "success" ? (
          <div className="flex flex-col gap-1 text-sm sm:items-end">
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">Organization</span>
              <CopyableId value={session.data.organizationId} label="organization id" />
            </span>
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">Signed in as</span>
              <CopyableId value={String(session.data.principal.id)} label="principal id" />
              <Badge variant="secondary">
                {session.data.permissions.editor
                  ? "editor"
                  : session.data.permissions.viewer
                    ? "viewer"
                    : "no access"}
              </Badge>
            </span>
            {session.data.provider ? (
              <span className="text-xs text-muted-foreground">
                FGA {session.data.provider.apiHost} · store {session.data.provider.storeId} · model{" "}
                {session.data.provider.authorizationModelId}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void consolePost("/api/auth/logout", {}).finally(() =>
                  window.location.assign("/login"),
                )
              }
            >
              <LogOutIcon aria-hidden /> Sign out
            </Button>
          </div>
        ) : null}
      </header>

      {session.status === "loading" || session.status === "idle" ? (
        <LoadingState label="Loading session" />
      ) : session.status === "error" ? (
        session.error.status === 401 ? (
          <div className="flex flex-col items-start gap-3">
            <ErrorState title="Sign in required" code={session.error.code} />
            <Button asChild>
              <a href={`/login?redirect=${encodeURIComponent(pathname)}`}>
                <LogInIcon aria-hidden /> Sign in
              </a>
            </Button>
          </div>
        ) : (
          <ErrorState
            title={
              session.error.status === 503
                ? "Authorization provider unavailable (fail closed)"
                : "Could not load the console session"
            }
            code={session.error.code}
          />
        )
      ) : session.status !== "success" ? null : !session.data.permissions.viewer ? (
        <ErrorState
          title="Forbidden"
          description="authorization_admin:root#viewer is required. Membership is managed by version-controlled bootstrap, not from this console."
          code="authorization_admin_forbidden"
        />
      ) : (
        <ConsoleSessionContext.Provider value={session.data}>
          <nav aria-label="Authorization console" className="flex flex-wrap gap-1 border-b pb-2">
            {NAV.map((item) => {
              const active = pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium hover:bg-accent",
                    active ? "bg-accent text-accent-foreground" : "text-muted-foreground",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <Outlet />
        </ConsoleSessionContext.Provider>
      )}
    </PageContainer>
  );
}
