// Publishes openfga/model.fga to the configured store (GitOps step after CI `fga model test`).
// Usage: bun packages/approval-fga/openfga/publish-model.ts [--dry-run]
// Then pin the printed model ID in apps/*/wrangler.jsonc (OPENFGA_AUTHORIZATION_MODEL_ID) via PR.
// Additive-only: the script refuses to publish if the current model has relations the source lacks.
import { readFileSync } from "node:fs";

import { transformer } from "@openfga/syntax-transformer";

import { normalizeAuthorizationModel } from "../src/authorization-model.ts";
import { fgaRequest, fgaToolEnv } from "./fga-admin-client.ts";

const dryRun = process.argv.includes("--dry-run");
const dsl = readFileSync(new URL("./model.fga", import.meta.url), "utf8");
const model = transformer.transformDSLToJSONObject(dsl);
const env = await fgaToolEnv();

const latest = await fgaRequest(env, "GET", "/authorization-models?page_size=1");
const current = (latest.json as { authorization_models?: unknown[] } | null)
  ?.authorization_models?.[0];
if (current) {
  const before = normalizeAuthorizationModel(current);
  const after = normalizeAuthorizationModel(model);
  const missing = (before?.typeDefinitions ?? []).flatMap((definition) => {
    const next = after?.typeDefinitions.find((candidate) => candidate.type === definition.type);
    return definition.relations
      .filter((relation) => !next?.relations.includes(relation))
      .map((relation) => `${definition.type}#${relation}`);
  });
  if (missing.length > 0) {
    console.error(`refusing non-additive change; source drops: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`current latest model: ${(current as { id?: string }).id}`);
}
if (dryRun) {
  console.log(JSON.stringify(model, null, 2));
  process.exit(0);
}
const written = await fgaRequest(env, "POST", "/authorization-models", model);
if (written.status !== 201 && written.status !== 200) {
  console.error(`publish failed: HTTP ${written.status} ${JSON.stringify(written.json)}`);
  process.exit(1);
}
console.log(
  `published authorization_model_id=${(written.json as { authorization_model_id: string }).authorization_model_id}`,
);
