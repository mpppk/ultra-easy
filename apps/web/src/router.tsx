import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import "@tanstack/react-start";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}

// `tsr generate` no longer emits the `@tanstack/react-start` Register block,
// but the installed Start build still keys `server` route handlers off it.
// Keep it in this hand-owned file so route regenerations stay green.
declare module "@tanstack/react-start" {
  interface Register {
    ssr: true;
    router: Awaited<ReturnType<typeof getRouter>>;
  }
}
