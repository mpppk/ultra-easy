import { useRouter } from "@tanstack/react-router";
import type * as React from "react";

/**
 * Anchor with client-side navigation for server-provided / dynamic paths
 * (typed `<Link to>` needs literal route ids).
 */
export function AppLink({ href, onClick, ...props }: React.ComponentProps<"a"> & { href: string }) {
  const router = useRouter();
  return (
    <a
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          props.target === "_blank" ||
          !href.startsWith("/")
        ) {
          return;
        }
        event.preventDefault();
        router.history.push(href);
      }}
      {...props}
    />
  );
}

export function useGo() {
  const router = useRouter();
  return (href: string) => router.history.push(href);
}
