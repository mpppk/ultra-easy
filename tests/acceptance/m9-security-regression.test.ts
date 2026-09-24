import { readdirSync, readFileSync, statSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

/**
 * M9 structural security regressions (AC-M9-004 / AC-M9-008 / AC-M9-010):
 * the tuple-write and model-write capabilities stay confined to the
 * reviewed composition roots, and the web app never links the FGA adapter.
 */
const root = new URL("../../", import.meta.url);

function sources(relative: string): Array<{ path: string; text: string }> {
  const directory = new URL(relative, root);
  return readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) return [];
    const entry = new URL(name, directory);
    const path = `${relative}${name}`;
    if (statSync(entry).isDirectory()) return sources(`${path}/`);
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) return [];
    return [{ path, text: readFileSync(entry, "utf8") }];
  });
}

const runtime = [...sources("apps/"), ...sources("packages/")].filter(
  // operator tooling (model publish / admin bootstrap) is not deployed runtime code
  (file) =>
    !file.path.startsWith("packages/approval-fga/openfga/") && !file.path.includes("/testing/"),
);

function filesContaining(pattern: RegExp): string[] {
  return runtime.filter((file) => pattern.test(file.text)).map((file) => file.path);
}

describe("M9 capability containment", () => {
  it("FGA tuple writes only exist in the adapter; the write gateway is built only by the relationship composition root", () => {
    expect(filesContaining(/\.writeTuples\(/)).toEqual(
      expect.arrayContaining(["packages/approval-fga/src/relationship-gateway.ts"]),
    );
    for (const file of filesContaining(/\.writeTuples\(/)) {
      expect([
        "packages/approval-fga/src/openfga.ts",
        "packages/approval-fga/src/relationship-gateway.ts",
      ]).toContain(file);
    }
    expect(filesContaining(/new OpenFgaRelationshipTupleGateway\(/)).toEqual([
      "apps/approval-api/src/relationship-mutation.ts",
    ]);
  });

  it("no runtime code can write authorization models (read of the pinned model only)", () => {
    expect(filesContaining(/authorization-models/)).toEqual([
      "packages/approval-fga/src/openfga.ts",
    ]);
    const adapter = runtime.find((file) => file.path === "packages/approval-fga/src/openfga.ts");
    expect(adapter?.text).not.toMatch(/postJsonObject\([^)]*authorization-models/);
    expect(adapter?.text).not.toMatch(/postResponse\([^)]*authorization-models/);
  });

  it("the web app never links the FGA adapter or holds FGA credentials", () => {
    const web = runtime.filter((file) => file.path.startsWith("apps/web/"));
    for (const file of web) {
      expect(file.text, file.path).not.toContain("@app/approval-fga");
      expect(file.text, file.path).not.toMatch(/FGA_CLIENT|FGA_TUPLE_WRITER/);
    }
  });

  it("the admin HTTP API exposes no relationship or model mutation routes", () => {
    const admin = runtime.find(
      (file) => file.path === "packages/approval-application/src/authorization-admin.ts",
    );
    const methods = [...(admin?.text ?? "").matchAll(/request\.method === "(\w+)"/g)].map(
      (match) => match[1],
    );
    expect(new Set(methods)).toEqual(new Set(["GET", "POST"]));
    const posts = [
      ...(admin?.text ?? "").matchAll(/"POST" && path === `\$\{ADMIN_PREFIX\}(\/[\w-]+)`/g),
    ].map((match) => match[1]);
    expect(posts).toEqual(["/explain"]);
  });
});
