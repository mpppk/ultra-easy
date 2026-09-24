import { AlertCircleIcon, InboxIcon } from "lucide-react";
import type * as React from "react";

import { Alert, AlertDescription, AlertTitle } from "#components/ui/alert";
import { Skeleton } from "#components/ui/skeleton";
import { cn } from "#lib/utils";

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center",
        className,
      )}
    >
      <InboxIcon aria-hidden className="size-6 text-muted-foreground" />
      <p className="font-medium">{title}</p>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({
  title,
  description,
  code,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Stable machine-readable error code (never a raw provider message or secret). */
  code?: string;
  className?: string;
}) {
  return (
    <Alert data-slot="error-state" variant="destructive" className={className}>
      <AlertCircleIcon aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      {description || code ? (
        <AlertDescription>
          {description ? <p>{description}</p> : null}
          {code ? (
            <p>
              code: <code className="font-mono">{code}</code>
            </p>
          ) : null}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

export function LoadingState({ label = "Loading", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div data-slot="loading-state" role="status" aria-live="polite" className="flex flex-col gap-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-6 w-full" />
      ))}
    </div>
  );
}
