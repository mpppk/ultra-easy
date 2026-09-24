import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

/**
 * M9 security regression for the browser bundle: no FGA / Auth0 client
 * credential names or token plumbing may reach client assets. Runs against
 * the build output (CI builds apps/web before running tests).
 */
const clientDir = new URL("../dist/client/", import.meta.url);

function files(directory: URL): URL[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const entry = new URL(name, directory);
    return statSync(entry).isDirectory() ? files(new URL(`${name}/`, directory)) : [entry];
  });
}

const FORBIDDEN = [
  "FGA_CLIENT_SECRET",
  "FGA_CLIENT_ID",
  "FGA_TUPLE_WRITER",
  "AUTH0_WEB_CLIENT_SECRET",
  "SESSION_SECRET",
  "client_secret",
  "auth.fga.dev/oauth/token",
  "/authorization-models",
];

describe("browser bundle (AC-M9-010 credential boundary)", () => {
  const bundle = files(clientDir).filter((file) => /\.(js|css|html)$/.test(file.pathname));
  const run = bundle.length > 0 ? it : it.skip;

  run("contains no FGA / Auth0 credential names, token endpoints or model APIs", () => {
    for (const file of bundle) {
      const source = readFileSync(file, "utf8");
      for (const needle of FORBIDDEN) {
        expect(source.includes(needle), `${file.pathname} contains ${needle}`).toBe(false);
      }
    }
  });
});
