import { defineConfig } from "@playwright/test";

const port = Number(process.env.KNOWLEDGE_E2E_PORT ?? 3101);

/**
 * Browser E2E for the Knowledge Workspace demo scenario (#167).
 * Run: `vp -C apps/knowledge run test:e2e` (starts a dev server on a fresh local D1).
 * Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to use a preinstalled Chromium.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: {
    command: "sh e2e/start-server.sh",
    cwd: "..",
    url: `http://localhost:${port}/api/demo/principals`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { CI: "1", KNOWLEDGE_E2E_PORT: String(port) },
  },
});
