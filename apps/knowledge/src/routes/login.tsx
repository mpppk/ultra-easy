import { createFileRoute } from "@tanstack/react-router";
import { LogInIcon } from "lucide-react";
import { useState } from "react";

import { ErrorState } from "#components/layout/states";
import { Button } from "#components/ui/button";
import { useApiQuery, useMutation } from "#hooks/use-api-query";
import { apiGet, apiSend } from "#lib/api-client";

import type { PrincipalView } from "../shared/api.ts";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect: string } => ({
    redirect:
      typeof search.redirect === "string" &&
      search.redirect.startsWith("/") &&
      !search.redirect.startsWith("//")
        ? search.redirect
        : "/",
  }),
  component: Login,
});

/**
 * Local / demo sign-in: pick a fixture principal. The server seals it into an
 * encrypted HttpOnly session; production uses the trusted Auth0 session only.
 */
function Login() {
  const { redirect } = Route.useSearch();
  const principals = useApiQuery(
    () => apiGet<{ principals: PrincipalView[] }>("/api/demo/principals"),
    [],
  );
  const [selected, setSelected] = useState("user:yuki");
  const mutation = useMutation();
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="flex w-full max-w-md flex-col gap-5 rounded-xl border bg-card p-8">
        <div>
          <p className="text-2xl font-bold">Knowledge</p>
          <p className="text-xs text-muted-foreground">ultra-easy workspace</p>
        </div>
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
      </div>
    </main>
  );
}
