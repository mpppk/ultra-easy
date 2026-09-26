import { createFileRoute } from "@tanstack/react-router";
import { LogInIcon } from "lucide-react";
import { useState } from "react";

import { ErrorState } from "#components/layout/states";
import { Button } from "#components/ui/button";
import { useApiQuery, useMutation } from "#hooks/use-api-query";
import { apiGet, apiSend } from "#lib/api-client";

import type { PrincipalView } from "../shared/api.ts";

const SIGN_IN_ERRORS: Record<string, string> = {
  access_denied: "Sign-in was cancelled or denied by Auth0.",
  invalid_state: "The sign-in session expired. Please try again.",
  organization_membership_required: "This account is not a member of the organization.",
};

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect: string; error?: string } => ({
    redirect:
      typeof search.redirect === "string" &&
      search.redirect.startsWith("/") &&
      !search.redirect.startsWith("//")
        ? search.redirect
        : "/",
    ...(typeof search.error === "string" ? { error: search.error.slice(0, 64) } : {}),
  }),
  component: Login,
});

/**
 * Sign-in. Deployed: Auth0 Universal Login only; the server verifies the ID
 * token and seals the principal into an encrypted HttpOnly session. The local
 * dev server (demo mode) instead lets you pick a fixture principal.
 */
function Login() {
  const { redirect, error } = Route.useSearch();
  const config = useApiQuery(() => apiGet<{ mode: "auth0" | "demo" }>("/api/auth/config"), []);
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="flex w-full max-w-md flex-col gap-5 rounded-xl border bg-card p-8">
        <div>
          <p className="text-2xl font-bold">Knowledge</p>
          <p className="text-xs text-muted-foreground">ultra-easy workspace</p>
        </div>
        {config.status === "error" ? (
          <ErrorState compact code={config.error.code} onRetry={config.refetch} />
        ) : config.data?.mode === "auth0" ? (
          <Auth0SignIn redirect={redirect} error={error} />
        ) : config.data?.mode === "demo" ? (
          <DemoSignIn redirect={redirect} />
        ) : null}
      </div>
    </main>
  );
}

function Auth0SignIn({ redirect, error }: { redirect: string; error?: string }) {
  return (
    <>
      <div>
        <h1 className="text-lg font-semibold">Sign in</h1>
        <p className="text-sm text-muted-foreground">
          Use your organization account. Roles come from ultra-easy authorization relationships.
        </p>
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {SIGN_IN_ERRORS[error] ?? `Sign-in failed (${error}). Please try again.`}
        </p>
      ) : null}
      <Button asChild>
        <a href={`/api/auth/login?returnTo=${encodeURIComponent(redirect)}`}>
          <LogInIcon /> Continue with Auth0
        </a>
      </Button>
    </>
  );
}

function DemoSignIn({ redirect }: { redirect: string }) {
  const principals = useApiQuery(
    () => apiGet<{ principals: PrincipalView[] }>("/api/demo/principals"),
    [],
  );
  const [selected, setSelected] = useState("user:yuki");
  const mutation = useMutation();
  return (
    <>
      <div>
        <h1 className="text-lg font-semibold">Sign in (local demo)</h1>
        <p className="text-sm text-muted-foreground">
          Choose a demo principal. Roles come from ultra-easy authorization relationships.
        </p>
      </div>
      {principals.status === "error" ? (
        <ErrorState compact code={principals.error.code} onRetry={principals.refetch} />
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Principal</legend>
          {(principals.data?.principals ?? []).map((principal) => (
            <label
              key={principal.id}
              className="flex items-center gap-3 rounded-lg border p-3 text-sm has-checked:border-primary"
            >
              <input
                type="radio"
                name="principal"
                value={principal.id}
                checked={selected === principal.id}
                onChange={() => setSelected(principal.id)}
              />
              <span className="flex flex-col">
                <span className="font-medium">{principal.displayName}</span>
                <span className="text-xs text-muted-foreground">{principal.id}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {mutation.error ? <p className="text-sm text-destructive">{mutation.error.title}</p> : null}
      <Button
        disabled={mutation.busy || !principals.data}
        onClick={() =>
          void mutation
            .run(() => apiSend("POST", "/api/demo/session", { principalId: selected }))
            .then((result) => result !== null && window.location.assign(redirect))
        }
      >
        <LogInIcon /> Continue
      </Button>
    </>
  );
}
