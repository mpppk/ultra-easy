import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

/** #100: 通常のdeployは必ずmigrate → deploy。bootstrap:*（初回のみ）とdry-runは対象外。 */
describe("#100 deploy scripts", () => {
  for (const app of ["approval-api", "approval-runtime"]) {
    it(`${app}: deploy:* はD1 migrationを適用してからdeployする`, () => {
      const manifest = JSON.parse(
        readFileSync(new URL(`../../${app}/package.json`, import.meta.url), "utf8"),
      ) as { scripts: Record<string, string> };
      const deploys = Object.entries(manifest.scripts).filter(
        ([name]) => name.startsWith("deploy:") && !name.startsWith("deploy:dry-run"),
      );
      expect(deploys.length).toBeGreaterThan(0);
      for (const [name, command] of deploys) {
        const steps = command.split("&&").map((step) => step.trim());
        expect(steps[0], name).toMatch(/^wrangler d1 migrations apply DB --remote\b/);
        expect(steps.at(-1), name).toMatch(/^wrangler deploy\b/);
        expect(steps, name).toHaveLength(2);
      }
    });
  }
});
