// #199 staging E2E: governed Knowledge space approval rules on the deployed approval-api.
//
// Run with credentials from 1Password (never committed):
//   op run --env-file=<refs> -- bun tests/staging/wf-199-application-policy.e2e.ts
// Required env: AUTH0_DOMAIN AUTH0_API_AUDIENCE AUTH0_WEB_CLIENT_ID AUTH0_WEB_CLIENT_SECRET
//   ALICE_PASSWORD BOB_PASSWORD AUTH0_KNOWLEDGE_AGENT_CLIENT_ID AUTH0_KNOWLEDGE_AGENT_CLIENT_SECRET
// Optional: API_URL (default staging workers.dev), RUN_ID.
//
// Uses a fresh space ID. Alice and Bob become its owners; Alice proposes rule changes and Bob
// (the other owner) gives the meta-approval. No Knowledge action is executed.
export {};

const ORG = "organization:staging";
const ORG_PATH = encodeURIComponent(ORG);
const API = process.env.API_URL ?? "https://ultra-easy-approval-api.niboshi.workers.dev";
const RUN = process.env.RUN_ID ?? `wf199-${Date.now().toString(36)}`;
const ALICE = "user:auth0|6ab12807a4ea2a6f7c2ccc09";
const BOB = "user:auth0|6ab12aa04a279d37e02306c6";
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll<T>(load: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 240_000) {
  const started = Date.now();
  let value = await load();
  while (!done(value) && Date.now() - started < timeoutMs) {
    await sleep(5_000);
    value = await load();
  }
  return value;
}

const submit = (bearer: string, action: unknown) =>
  api(
    bearer,
    "POST",
    `/v1/organizations/${ORG_PATH}/action-requests`,
    { action },
    { "idempotency-key": crypto.randomUUID() },
  );
const actionRequest = (bearer: string, id: string) =>
  api(bearer, "GET", `/v1/organizations/${ORG_PATH}/action-requests/${encodeURIComponent(id)}`);
const rules = (bearer: string, space = SPACE) =>
  api(bearer, "GET", `/v1/organizations/${ORG_PATH}/application-policies/knowledge_space/${space}`);
const propose = (bearer: string, baseVersion: number, policy: unknown) =>
  submit(bearer, {
    type: "application.approval_policy.update",
    resource: { type: "knowledge_space", id: SPACE },
    input: { baseVersion, policy },
  });
const role = (agentToken: string, operation: "write" | "delete", user: string) =>
  submit(agentToken, {
    type: "application.relationship.update",
    resource: { type: "knowledge_space", id: SPACE },
    input: { operation, tuple: { user, relation: "owner", object: `knowledge_space:${SPACE}` } },
  });

/** 自分が候補のpending taskを承認する（parallel anyなので、候補でないtaskは403になる）。 */
async function approveAs(bearer: string, actionRequestId: string) {
  const tasks = await poll(
    () =>
      api(
        bearer,
        "GET",
        `/v1/organizations/${ORG_PATH}/action-requests/${encodeURIComponent(actionRequestId)}/tasks`,
      ),
    (value) =>
      Array.isArray(value.body?.items) &&
      value.body.items.some((task: any) => task.status === "pending"),
    120_000,
  );
  const decisions = [];
  for (const task of (tasks.body?.items ?? []).filter((entry: any) => entry.status === "pending")) {
    const decided = await api(
      bearer,
      "POST",
      `/v1/organizations/${ORG_PATH}/approval-tasks/${encodeURIComponent(task.id)}/decisions`,
      { decision: "approve" },
      { "idempotency-key": crypto.randomUUID() },
    );
    decisions.push(decided);
    if (decided.status >= 200 && decided.status < 300) return decided;
  }
  return decisions.at(-1) ?? { status: 0, body: tasks.body };
}

async function settled(bearer: string, id: string) {
  return poll(
    () => actionRequest(bearer, id),
    (value) =>
      ["executed", "execution_failed", "rejected", "cancelled", "authorization_revoked"].includes(
        value.body?.status,
      ),
  );
}

const alice = await userToken("staging-alice@example.com", required("ALICE_PASSWORD"));
const bob = await userToken("staging-bob@example.com", required("BOB_PASSWORD"));
const knowledgeAgent = await oauthToken({
  grant_type: "client_credentials",
  client_id: required("AUTH0_KNOWLEDGE_AGENT_CLIENT_ID"),
  client_secret: required("AUTH0_KNOWLEDGE_AGENT_CLIENT_SECRET"),
});
console.log(`run ${RUN} against ${API} (space ${SPACE})`);

const outsider = await rules(bob);
check(
  "WF199-1",
  "a non-member cannot read a space's approval rules",
  outsider.status === 403,
  outsider,
);
const aliceOutsideProposal = await propose(alice, 0, { rules: [] });
check(
  "WF199-2",
  "a non-owner cannot propose rule changes (authorization before approval)",
  aliceOutsideProposal.status === 403,
  aliceOutsideProposal,
);

const grants = [
  await role(knowledgeAgent, "write", ALICE),
  await role(knowledgeAgent, "write", BOB),
];
check(
  "WF199-3",
  "setup: Alice and Bob own the test space",
  grants.every((grant) => grant.status === 201 && grant.body?.status === "executed"),
  grants,
);
await sleep(3_000);

try {
  const initial = await rules(alice);
  check(
    "WF199-4",
    "a space without its own rules reads the default rules as version 0",
    initial.status === 200 &&
      initial.body?.version === 0 &&
      initial.body?.pendingChange === null &&
      (initial.body?.policy?.rules ?? []).map((rule: any) => rule.key).join(",") ===
        "publish_confidential,publish_organization,archive",
    initial,
  );

  const invalid = await propose(alice, 0, {
    rules: [
      { key: "x", actionType: "ticket.update", when: { always: true }, approvers: "space_owners" },
    ],
  });
  check(
    "WF199-5",
    "a rule outside Knowledge's vocabulary is rejected at submit",
    invalid.status === 400 || invalid.status === 422,
    invalid,
  );

  const emptied = await propose(alice, 0, { rules: [] });
  check(
    "WF199-6",
    "a rule change waits for meta-approval",
    emptied.status === 201 && emptied.body?.status === "pending_approval",
    emptied,
  );
  const stale = await propose(alice, 0, {
    rules: [
      {
        key: "archive",
        actionType: "knowledge.page.archive",
        when: { always: true },
        approvers: "space_owners",
      },
    ],
  });

  const pending = await rules(alice);
  check(
    "WF199-7",
    "the rules are unchanged while the change is pending, which is shown as pendingChange",
    pending.body?.version === 0 &&
      [emptied.body?.id, stale.body?.id].includes(pending.body?.pendingChange?.actionRequestId),
    pending,
  );

  const selfApproval = await approveAs(alice, emptied.body.id);
  const stillPending = await actionRequest(alice, emptied.body.id);
  check(
    "WF199-8",
    "the proposer cannot give the meta-approval",
    !(selfApproval.status >= 200 && selfApproval.status < 300) &&
      stillPending.body?.status === "pending_approval",
    { selfApproval, stillPending },
  );

  const approved = await approveAs(bob, emptied.body.id);
  const applied = await settled(alice, emptied.body.id);
  const after = await rules(alice);
  check(
    "WF199-9",
    "after the other owner approves, the space's rules move to version 1",
    approved.status >= 200 &&
      approved.status < 300 &&
      applied.body?.status === "executed" &&
      after.body?.version === 1 &&
      (after.body?.policy?.rules ?? []).length === 0 &&
      after.body?.pendingChange === null,
    { approved, applied, after },
  );

  const staleApproved = await approveAs(bob, stale.body.id);
  const staleDone = await settled(alice, stale.body.id);
  const unchanged = await rules(alice);
  check(
    "WF199-10",
    "a proposal based on an older version is not applied after approval",
    staleApproved.status >= 200 &&
      staleDone.body?.status === "execution_failed" &&
      staleDone.body?.result?.code === "application_policy_conflict" &&
      unchanged.body?.version === 1,
    { staleDone, unchanged },
  );

  const other = await rules(knowledgeAgent, `${SPACE}-other`);
  check(
    "WF199-11",
    "other spaces keep the default rules (read by the Knowledge agent)",
    other.status === 200 && other.body?.version === 0,
    other,
  );
} finally {
  const revoked = [
    await role(knowledgeAgent, "delete", BOB),
    await role(knowledgeAgent, "delete", ALICE),
  ];
  check(
    "WF199-12",
    "cleanup: owner roles on the test space are revoked",
    revoked.every((entry) => entry.status === 201 && entry.body?.status === "executed"),
    revoked,
  );
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed (run ${RUN})`);
process.exit(failed.length === 0 ? 0 : 1);
