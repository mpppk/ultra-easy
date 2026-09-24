import { createFileRoute } from "@tanstack/react-router";
import { LogInIcon } from "lucide-react";
import { useState } from "react";

import { PageContainer, PageHeader } from "#components/layout/page";
import { ErrorState } from "#components/layout/states";
import { Button } from "#components/ui/button";
import { Card, CardContent } from "#components/ui/card";
import { Input } from "#components/ui/input";
import { ConsoleApiError, consolePost } from "#lib/console-client";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect:
      typeof search.redirect === "string" && search.redirect.startsWith("/admin/")
        ? search.redirect
        : "/admin/authorization",
  }),
  component: Login,
});

/**
 * Staging sign-in (Auth0 password-realm grant, enabled only where
 * STAGING_PASSWORD_LOGIN=true). The token is stored server-side in an
 * encrypted HttpOnly cookie; Universal Login is a follow-up.
 */
function Login() {
  const { redirect } = Route.useSearch();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <PageContainer className="max-w-md">
      <PageHeader title="Sign in" description="Authorization Console (staging)" />
      <Card>
        <CardContent>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              setError(undefined);
              consolePost("/api/auth/login", { username, password })
                .then(() => window.location.assign(redirect))
                .catch((caught: unknown) =>
                  setError(caught instanceof ConsoleApiError ? caught.code : "login_failed"),
                )
                .finally(() => setBusy(false));
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              Email
              <Input
                type="email"
                autoComplete="username"
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Password
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {error ? <ErrorState title="Sign in failed" code={error} /> : null}
            <Button type="submit" disabled={busy}>
              <LogInIcon aria-hidden /> Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
