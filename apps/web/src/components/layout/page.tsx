import type * as React from "react";

import { cn } from "#lib/utils";

/**
 * App shell primitives shared by admin / operations screens.
 * They only arrange content; feature navigation and business logic live in
 * feature folders (e.g. `components/authorization`).
 */
export function PageContainer({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="page-container"
      className={cn("mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6", className)}
      {...props}
    />
  );
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      data-slot="page-header"
      className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function PageSection({
  title,
  description,
  actions,
  className,
  children,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section data-slot="page-section" className={cn("flex flex-col gap-3", className)}>
      {title || actions ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title ? <h2 className="text-lg font-semibold">{title}</h2> : null}
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Responsive filter / action bar. Wraps on narrow viewports. */
export function Toolbar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="toolbar"
      role="toolbar"
      className={cn("flex flex-wrap items-end gap-3", className)}
      {...props}
    />
  );
}
