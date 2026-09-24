// Applies version-controlled authorization_admin viewer/editor membership (IaC bootstrap path).
// Usage: bun packages/approval-fga/openfga/bootstrap-admins.ts <environment> [--dry-run]
// Writes only missing tuples (idempotent) and never deletes: removals are a separate,
// reviewed operation documented in docs/runbooks/authorization-console.md.
import { readFileSync } from "node:fs";

import type { OrganizationId } from "@app/approval-core";

import { tenantScopedOpenFgaObject } from "../src/openfga.ts";
import { fgaRequest, fgaToolEnv } from "./fga-admin-client.ts";

type Membership = { organizationId: string; viewers: string[]; editors: string[] };

const [environment] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");
const config = JSON.parse(
  readFileSync(new URL("./bootstrap/admins.json", import.meta.url), "utf8"),
) as Record<string, Membership | string>;
const membership = environment ? config[environment] : undefined;
if (!membership || typeof membership === "string") {
  console.error(`unknown environment: ${environment}`);
  process.exit(1);
}
for (const user of [...membership.viewers, ...membership.editors]) {
  if (!/^user:[\x21-\x7e]+$/.test(user) || user.includes("@")) {
    console.error(`invalid stable user id: ${user}`);
    process.exit(1);
  }
}
const object = tenantScopedOpenFgaObject(
  membership.organizationId as OrganizationId,
  "authorization_admin:root",
);
const desired = [
  ...membership.viewers.map((user) => ({ user, relation: "viewer", object })),
  ...membership.editors.map((user) => ({ user, relation: "editor", object })),
];
const env = await fgaToolEnv();
for (const tuple of desired) {
  const read = await fgaRequest(env, "POST", "/read", { tuple_key: tuple, page_size: 1 });
  const present = ((read.json as { tuples?: unknown[] } | null)?.tuples ?? []).length > 0;
  if (present) {
    console.log(`present  ${tuple.user} ${tuple.relation} ${tuple.object}`);
    continue;
  }
  if (dryRun) {
    console.log(`would write ${tuple.user} ${tuple.relation} ${tuple.object}`);
    continue;
  }
  const written = await fgaRequest(env, "POST", "/write", { writes: { tuple_keys: [tuple] } });
  if (written.status !== 200) {
    console.error(`write failed: HTTP ${written.status} ${JSON.stringify(written.json)}`);
    process.exit(1);
  }
  console.log(`written  ${tuple.user} ${tuple.relation} ${tuple.object}`);
}
