import { defineConfig, lazyPlugins } from "vite-plus";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig(({ command }) => ({
  resolve: { tsconfigPaths: true },
  plugins: lazyPlugins(() => [
    // Cloudflare Vite plugin is incompatible with Vitest (sets resolve.external in ssr env).
    ...(process.env.VITEST
      ? []
      : [
          cloudflare({
            viteEnvironment: { name: "ssr" },
            // E2E runs use an isolated, freshly migrated local D1 state.
            persistState: process.env.KNOWLEDGE_PERSIST_PATH
              ? { path: process.env.KNOWLEDGE_PERSIST_PATH }
              : true,
            // #182: the deployed Worker signs in through Auth0 only. Demo principals
            // exist for the local dev server alone (`vp dev`, E2E); set
            // KNOWLEDGE_AUTH_MODE=auth0 (+ .dev.vars) to try Auth0 locally.
            ...(command === "serve"
              ? {
                  config: (worker: { vars?: Record<string, unknown> }) => ({
                    vars: {
                      ...worker.vars,
                      KNOWLEDGE_AUTH_MODE: process.env.KNOWLEDGE_AUTH_MODE ?? "demo",
                    },
                  }),
                }
              : {}),
          }),
        ]),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ]),
}));
