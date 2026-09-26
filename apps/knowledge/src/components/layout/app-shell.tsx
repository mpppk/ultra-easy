import { useRouterState } from "@tanstack/react-router";
import {
  BellIcon,
  BotIcon,
  HomeIcon,
  LayoutGridIcon,
  SearchIcon,
  WorkflowIcon,
} from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type * as React from "react";

import { AppLink, useGo } from "#components/layout/app-link";
import { ErrorState } from "#components/layout/states";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "#components/ui/dropdown-menu";
import { Skeleton } from "#components/ui/skeleton";
import { useApiQuery } from "#hooks/use-api-query";
import { apiGet, apiSend } from "#lib/api-client";
import { initials, relativeTime } from "#lib/format";
import { cn } from "#lib/utils";

import type { MeView } from "../../shared/api.ts";

const MeContext = createContext<{ me: MeView; refresh: () => void } | null>(null);

export function useMe() {
  const value = useContext(MeContext);
  return value ?? null;
}

const NAV = [
  { href: "/", label: "Home", icon: HomeIcon, match: (path: string) => path === "/" },
  {
    href: "/spaces",
    label: "Spaces",
    icon: LayoutGridIcon,
    match: (path: string) => path.startsWith("/spaces"),
  },
  {
    href: "/search",
    label: "Search",
    icon: SearchIcon,
    match: (path: string) => path.startsWith("/search"),
  },
  {
    href: "/automation",
    label: "Automation",
    icon: WorkflowIcon,
    match: (path: string) => path.startsWith("/automation"),
  },
];

/** Authenticated shell: sidebar navigation, global search, user menu. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const me = useApiQuery(() => apiGet<MeView>("/api/me"), []);

  useEffect(() => {
    if (me.status === "error" && me.error.status === 401) {
      window.location.assign(
        `/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`,
      );
    }
  }, [me.status, me.error]);

  return (
    <div className="min-h-dvh bg-background">
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r bg-sidebar px-4 py-6 md:flex">
        <Brand />
        <nav aria-label="Main" className="mt-8 flex flex-col gap-1">
          {NAV.map((item) => (
            <NavItem key={item.href} item={item} active={item.match(pathname)} />
          ))}
        </nav>
      </aside>
      <div className="md:pl-60">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b bg-card px-4 sm:px-6">
          <div className="md:hidden">
            <Brand compact />
          </div>
          <div className="flex-1" />
          <GlobalSearch />
          {me.data ? (
            <UserMenu me={me.data} onChange={me.refetch} />
          ) : (
            <Skeleton className="size-8 rounded-full" />
          )}
        </header>
        <nav
          aria-label="Main"
          className="flex gap-1 overflow-x-auto border-b bg-card px-2 py-1 md:hidden"
        >
          {NAV.map((item) => (
            <NavItem key={item.href} item={item} active={item.match(pathname)} />
          ))}
        </nav>
        <main>
          {me.data ? (
            <MeContext.Provider value={{ me: me.data, refresh: me.refetch }}>
              {children}
            </MeContext.Provider>
          ) : me.status === "error" && me.error.status !== 401 ? (
            <div className="px-4 py-8">
              <ErrorState code={me.error.code} onRetry={me.refetch} />
            </div>
          ) : (
            <div className="mx-auto flex max-w-6xl flex-col gap-4 px-8 py-8" role="status">
              <span className="sr-only">Loading</span>
              <Skeleton className="h-7 w-60" />
              <Skeleton className="h-4 w-96" />
              <Skeleton className="h-32 w-full" />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <AppLink href="/" className="block">
      <p className={cn("font-bold tracking-tight", compact ? "text-lg" : "text-2xl")}>Knowledge</p>
      {compact ? null : <p className="text-xs text-muted-foreground">ultra-easy workspace</p>}
    </AppLink>
  );
}

function NavItem({ item, active }: { item: (typeof NAV)[number]; active: boolean }) {
  const Icon = item.icon;
  return (
    <AppLink
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
        active ? "bg-accent text-accent-foreground" : "text-sidebar-foreground hover:bg-muted",
      )}
    >
      <Icon className="size-4" />
      {item.label}
    </AppLink>
  );
}

function GlobalSearch() {
  const go = useGo();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        go(`/search?q=${encodeURIComponent(value.trim())}`);
      }}
      className="relative"
    >
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={input}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search"
        aria-label="Search the workspace"
        className="h-9 w-40 rounded-lg border bg-muted pr-10 pl-8 text-sm outline-none focus:border-ring focus:bg-card sm:w-64"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border bg-card px-1 text-[10px] text-muted-foreground sm:block">
        ⌘K
      </kbd>
    </form>
  );
}

function UserMenu({ me, onChange }: { me: MeView; onChange: () => void }) {
  const unread = me.notifications.length;
  const switchPrincipal = (principalId: string) =>
    apiSend("POST", "/api/demo/session", { principalId }).then(() => window.location.reload());
  const setFault = (faults: Record<string, boolean>) =>
    apiSend("POST", "/api/demo/faults", faults).then(onChange);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex items-center gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="User menu"
      >
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {me.principal.displayName}
        </span>
        <span className="relative flex size-8 items-center justify-center rounded-full bg-muted text-xs font-medium">
          {initials(me.principal.displayName)}
          {unread > 0 ? (
            <span
              className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-primary"
              aria-label={`${unread} notifications`}
            />
          ) : null}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>
          <p>{me.principal.displayName}</p>
          <p className="text-xs font-normal text-muted-foreground">
            {me.principal.id} · {me.organizationId}
          </p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-2 text-xs text-muted-foreground">
          <BellIcon className="size-3.5" /> Notifications
        </DropdownMenuLabel>
        {me.notifications.length === 0 ? (
          <p className="px-2 pb-2 text-xs text-muted-foreground">No notifications yet.</p>
        ) : (
          me.notifications.slice(0, 5).map((notification) => (
            <DropdownMenuItem key={`${notification.pageId}-${notification.revisionNumber}`} asChild>
              <AppLink href={`/spaces/${notification.spaceKey}/pages/${notification.pageId}`}>
                <span className="flex flex-col">
                  <span className="text-sm">
                    {notification.title} · #{notification.revisionNumber}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Published {relativeTime(notification.deliveredAt)}
                  </span>
                </span>
              </AppLink>
            </DropdownMenuItem>
          ))
        )}
        {me.demo ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-2 text-xs text-muted-foreground">
              <BotIcon className="size-3.5" /> Local demo controls
            </DropdownMenuLabel>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Switch principal</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={me.principal.id}
                  onValueChange={(value) => void switchPrincipal(value)}
                >
                  {me.demo.principals.map((principal) => (
                    <DropdownMenuRadioItem key={principal.id} value={principal.id}>
                      {principal.displayName}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuCheckboxItem
              checked={me.demo.faults.notifier}
              onCheckedChange={(checked) => void setFault({ notifier: checked === true })}
            >
              Simulate notifier outage
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={me.demo.faults.searchIndex}
              onCheckedChange={(checked) => void setFault({ searchIndex: checked === true })}
            >
              Simulate search index outage
            </DropdownMenuCheckboxItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() =>
            void apiSend<{ redirectTo: string }>("POST", "/api/auth/logout").then((result) =>
              window.location.assign(result.redirectTo),
            )
          }
        >
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
