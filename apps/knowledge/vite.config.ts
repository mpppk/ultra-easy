import { defineConfig, lazyPlugins } from "vite-plus";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
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
          }),
        ]),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ]),
});
