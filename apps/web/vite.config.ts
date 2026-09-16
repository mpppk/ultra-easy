import { defineConfig, lazyPlugins } from "vite-plus";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

const isCloudflarePreviewBuild =
  process.env.WORKERS_CI === "1" &&
  process.env.WORKERS_CI_BRANCH !== undefined &&
  process.env.WORKERS_CI_BRANCH !== "main";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: lazyPlugins(() => [
    // Cloudflare Vite plugin is incompatible with Vitest (sets resolve.external in ssr env).
    // Skip it during `vp test` / Vitest runs.
    ...(process.env.VITEST
      ? []
      : [
          cloudflare({
            configPath: isCloudflarePreviewBuild ? "./wrangler.preview.jsonc" : undefined,
            viteEnvironment: { name: "ssr" },
          }),
        ]),

    tanstackStart(),
    viteReact(),
  ]),
});
