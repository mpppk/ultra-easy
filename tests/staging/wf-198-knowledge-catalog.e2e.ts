// #198 staging E2E: Knowledge Application Catalog on the deployed approval-api.
//
// Run with credentials from 1Password (never committed):
//   op run --env-file=<refs> -- bun tests/staging/wf-198-knowledge-catalog.e2e.ts
// Required env: AUTH0_DOMAIN AUTH0_API_AUDIENCE AUTH0_WEB_CLIENT_ID AUTH0_WEB_CLIENT_SECRET
//   ALICE_PASSWORD BOB_PASSWORD AUTH0_KNOWLEDGE_AGENT_CLIENT_ID AUTH0_KNOWLEDGE_AGENT_CLIENT_SECRET
// Optional: API_URL (default staging workers.dev), RUN_ID.
//
// Exercises the registered catalog end to end: public submit → FGA (knowledge_space roles) →
// Composite Action → Workflow runner → child ActionRequest → Service Binding → Knowledge /mcp.
// The space is a fresh ID with no Knowledge pages, so the maintenance run lists nothing and
// changes no Knowledge data.
export {};

const ORG = "organization:staging";
const ORG_PATH = encodeURIComponent(ORG);
const API = process.env.API_URL ?? "https://ultra-easy-approval-api.niboshi.workers.dev";
const RUN = process.env.RUN_ID ?? `wf198-${Date.now().toString(36)}`;
const ALICE = "user:auth0|6ab12807a4ea2a6f7c2ccc09";
const SPACE = `spc-${RUN}`;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing env ${name}`);
    process.exit(2);
  }
  return value;
}

type Check = { id: string; title: string; ok: boolean };
const results: Check[] = [];
function check(id: string, title: string, ok: boolean, evidence: unknown = null) {
  results.push({ id, title, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${title}`);
  if (!ok) console.log(`     evidence: ${JSON.stringify(evidence).slice(0, 1200)}`);
}

async function oauthToken(body: Record<string, string>): Promise<string> {
  const response = await fetch(`https://${required("AUTH0_DOMAIN")}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audience: required("AUTH0_API_AUDIENCE"), ...body }),
  });
  const parsed = (await response.json()) as { access_token?: string; error?: string };
  if (!parsed.access_token) {
    console.error(`token request failed: ${parsed.error ?? response.status}`);
    process.exit(2);
  }
  return parsed.access_token;
}

const userToken = (username: string, password: string) =>
  oauthToken({
    grant_type: "http://auth0.com/oauth/grant-type/password-realm",
    realm: "Username-Password-Authentication",
    username,
    password,
    client_id: required("AUTH0_WEB_CLIENT_ID"),
    client_secret: required("AUTH0_WEB_CLIENT_SECRET"),
    scope: "openid read:action-requests write:action-requests",
  });

async function api(
  bearer: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: response.status, body: parsed };
}

const submit = (
  bearer: string,
  action: { type: string; resource: { type: string; id: string }; input: unknown },
) =>
  api(
    bearer,
    "POST",
    `/v1/organizations/${ORG_PATH}/action-requests`,
    { action, correlation: { spaceId: SPACE } },
    { "idempotency-key": crypto.randomUUID() },
  );
const actionRequest = (bearer: string, id: string) =>
  api(bearer, "GET", `/v1/organizations/${ORG_PATH}/action-requests/${encodeURIComponent(id)}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function settled(bearer: string, id: string, timeoutMs = 240_000) {
  const started = Date.now();
  let current = await actionRequest(bearer, id);
  while (
    !["executed", "execution_failed", "rejected", "cancelled", "authorization_revoked"].includes(
      current.body?.status,
    ) &&
    Date.now() - started < timeoutMs
  ) {
    await sleep(5_000);
    current = await actionRequest(bearer, id);
  }
  return current;
}

const alice = await userToken("staging-alice@example.com", required("ALICE_PASSWORD"));
const bob = await userToken("staging-bob@example.com", required("BOB_PASSWORD"));
const knowledgeAgent = await oauthToken({
  grant_type: "client_credentials",
  client_id: required("AUTH0_KNOWLEDGE_AGENT_CLIENT_ID"),
  client_secret: required("AUTH0_KNOWLEDGE_AGENT_CLIENT_SECRET"),
});
console.log(`run ${RUN} against ${API} (space ${SPACE})`);

const listStale = {
  type: "knowledge.pages.list_stale",
  resource: { type: "knowledge_space", id: SPACE },
  input: {},
};

// ---------------------------------------------------------------- Authorization
const beforeRole = await submit(alice, listStale);
check(
  "WF198-1",
  "knowledge.* on a space without a role is denied before any execution",
  beforeRole.status === 403,
  beforeRole,
);

const grant = (operation: "write" | "delete") =>
  submit(knowledgeAgent, {
    type: "application.relationship.update",
    resource: { type: "knowledge_space", id: SPACE },
    input: {
      operation,
      tuple: { user: ALICE, relation: "owner", object: `knowledge_space:${SPACE}` },
    },
  });
const granted = await grant("write");
check(
  "WF198-2",
  "Knowledge agent grants Alice owner on the space (governed relationship)",
  granted.status === 201 && granted.body?.status === "executed",
  granted,
);
await sleep(3_000);

try {
  // -------------------------------------------------------------- Primitive via catalog route
  const primitive = await submit(alice, listStale);
  const primitiveDone =
    primitive.status === 201 ? await settled(alice, primitive.body.id) : primitive;
  check(
    "WF198-3",
    "primitive knowledge.pages.list_stale executes through the catalog route to Knowledge /mcp",
    primitiveDone.body?.status === "executed" &&
      Array.isArray(primitiveDone.body?.result?.output?.pages),
    primitiveDone,
  );

  const invalid = await submit(alice, { ...listStale, input: { spaceId: "spc-someone-else" } });
  check(
    "WF198-4",
    "input outside the registered schema (resource ID override) is rejected",
    invalid.status === 400 || invalid.status === 422,
    invalid,
  );

  // -------------------------------------------------------------- Composite Action
  const composite = await submit(alice, {
    type: "knowledge.maintain_space",
    resource: { type: "knowledge_space", id: SPACE },
    input: { spaceId: SPACE },
  });
  const compositeDone =
    composite.status === 201 ? await settled(alice, composite.body.id) : composite;
  check(
    "WF198-5",
    "Composite knowledge.maintain_space runs its Workflow and completes the parent ActionRequest",
    compositeDone.body?.status === "executed" &&
      compositeDone.body?.result?.output?.spaceId === SPACE,
    compositeDone,
  );
  const run =
    composite.status === 201
      ? await api(
          alice,
          "GET",
          `/v1/organizations/${ORG_PATH}/action-requests/${encodeURIComponent(composite.body.id)}/workflow-run`,
        )
      : composite;
  check(
    "WF198-6",
    "the run projection shows the child knowledge.pages.list_stale ActionRequest",
    run.status === 200 &&
      run.body?.status === "succeeded" &&
      (run.body?.childActions ?? []).some(
        (child: any) =>
          child.actionType === "knowledge.pages.list_stale" && child.status === "succeeded",
      ),
    run,
  );

  // -------------------------------------------------------------- Ownership / roles
  const bobDenied = await submit(bob, {
    type: "knowledge.maintain_space",
    resource: { type: "knowledge_space", id: SPACE },
    input: { spaceId: SPACE },
  });
  check(
    "WF198-7",
    "a user without a space role cannot run the Composite",
    bobDenied.status === 403,
    bobDenied,
  );

  const hijack = await api(alice, "POST", "/v1/admin/workflow/definitions/wf:shadow-198/publish", {
    definition: {},
    actionType: "knowledge.maintain_space",
  });
  const catalogWorkflow = await api(
    alice,
    "POST",
    "/v1/admin/workflow/definitions/wf:knowledge-maintain-space/publish",
    { definition: {} },
  );
  check(
    "WF198-8",
    "Studio editors cannot publish over catalog-owned action types or Workflows",
    hijack.status === 409 &&
      hijack.body?.code === "catalog_owned" &&
      catalogWorkflow.status === 409,
    { hijack, catalogWorkflow },
  );
} finally {
  const revoked = await grant("delete");
  check(
    "WF198-9",
    "cleanup: Alice's owner role on the test space is revoked",
    revoked.status === 201 && revoked.body?.status === "executed",
    revoked,
  );
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed (run ${RUN})`);
process.exit(failed.length === 0 ? 0 : 1);
