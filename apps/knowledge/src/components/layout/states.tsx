import { AlertCircleIcon, LockIcon, SearchIcon } from "lucide-react";
import type * as React from "react";

import { Button } from "#components/ui/button";
import { Skeleton } from "#components/ui/skeleton";
import { cn } from "#lib/utils";

/** Empty state: icon tile, title, description, optional action (see mock). */
export function EmptyState({
  icon: Icon = SearchIcon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-xl border bg-card px-6 py-12 text-center",
        className,
      )}
    >
      <div className="mb-1 flex size-14 items-center justify-center rounded-2xl bg-accent">
        <Icon className="size-6 text-primary" />
      </div>
      <p className="font-semibold">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Recoverable error with retry. Only stable codes are shown, never raw provider text. */
export function ErrorState({
  title = "We couldn't load this page",
  description = "Something went wrong on our end. Try again to refresh the workspace, or check your connection and come back later.",
  code,
  onRetry,
  compact = false,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  code?: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div
      data-slot="error-state"
      role="alert"
      className={cn(
        "mx-auto flex w-full flex-col items-center gap-3 rounded-xl border bg-card text-center",
        compact ? "px-4 py-6" : "max-w-xl px-8 py-10",
      )}
    >
      <div className="flex size-14 items-center justify-center rounded-full bg-accent">
        <AlertCircleIcon className="size-6 text-primary" />
      </div>
      <h2 className={cn("font-bold", compact ? "text-base" : "text-2xl")}>{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
      {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
      {code ? (
        <p className="text-xs text-muted-foreground">
          code: <code className="font-mono">{code}</code>
        </p>
      ) : null}
    </div>
  );
}

/** Same presentation for missing and forbidden resources (no existence leak). */
export function NotFoundState() {
  return (
    <div
      data-slot="not-found-state"
      className="mx-auto mt-16 flex w-full max-w-xl flex-col items-center gap-3 rounded-xl border bg-card px-8 py-10 text-center"
    >
      <div className="flex size-14 items-center justify-center rounded-full bg-accent">
        <LockIcon className="size-6 text-primary" />
      </div>
      <h2 className="text-2xl font-bold">Page not found or forbidden</h2>
      <p className="text-sm text-muted-foreground">
        The page you&apos;re looking for either does not exist or you do not have permission to view
        it.
      </p>
      <div className="mt-2 flex gap-2">
        <Button asChild>
          <a href="/">Go to Home</a>
        </Button>
        <Button asChild variant="outline">
          <a href="/search">Search spaces</a>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        If you believe this is an error, try checking the URL or asking a workspace admin for
        access.
      </p>
    </div>
  );
}

export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2 rounded-xl border bg-card p-4", className)}>
      <Skeleton className="h-5 w-1/3" />
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn("h-3", index % 2 ? "w-1/5" : "w-1/4")} />
      ))}
    </div>
  );
}

export function LoadingState({ label = "Loading", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div data-slot="loading-state" role="status" aria-live="polite" className="flex flex-col gap-3">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-4 w-96 max-w-full" />
      {Array.from({ length: rows }, (_, index) => (
        <CardSkeleton key={index} />
      ))}
    </div>
  );
}

/** Maps an API error to the right safe presentation. */
export function QueryError({
  error,
  onRetry,
}: {
  error: { status: number; code: string };
  onRetry: () => void;
}) {
  if (error.status === 404) return <NotFoundState />;
  if (error.status === 401) {
    return (
      <ErrorState
        title="Your session has ended"
        description="Sign in again to continue."
        onRetry={() => window.location.assign("/login")}
      />
    );
  }
  return <ErrorState code={error.code} onRetry={onRetry} />;
}
