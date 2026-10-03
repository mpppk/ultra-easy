import { defineConfig } from "@playwright/test";

/** Live staging acceptance for ULTRA_EASY_MODE=remote. Requires the local secret env file. */
export default defineConfig({
  testDir: ".",
  testMatch: "remote.e2e.ts",
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: "https://ultra-easy-knowledge.niboshi.workers.dev",
    viewport: { width: 1440, height: 1000 },
  },
});
