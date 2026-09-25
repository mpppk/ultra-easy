// M9 staging E2E (AC-M9-011) against the deployed approval-api + Auth0 FGA staging store.
//
// Run with credentials from 1Password (never committed):
//   op run --env-file=<refs> -- bun tests/staging/m9-authorization-console.e2e.ts
// Required env: AUTH0_DOMAIN AUTH0_API_AUDIENCE AUTH0_WEB_CLIENT_ID AUTH0_WEB_CLIENT_SECRET
//   ALICE_PASSWORD BOB_PASSWORD OPENFGA_STORE_ID FGA_CLIENT_ID FGA_CLIENT_SECRET
// Optional: API_URL (default staging workers.dev), RUN_ID.
//
// Crash / response-loss scenarios are constructed with the same D1 rows the
// executor writes (via `wrangler d1 execute --remote`) plus a direct FGA tuple
// write standing in for "provider applied, response lost"; the deployed cron
// reconciler must then converge them.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { Result } from "@praha/byethrow";

import type { OrganizationId } from "@app/approval-core";
import { relationshipTupleKey } from "@app/approval-core";
import { ClientCredentialsTokenProvider, OpenFgaClient } from "@app/approval-fga";

const ORG = "organization:staging";
const ORG_PATH = encodeURIComponent(ORG);
const API = process.env.API_URL ?? "https://ultra-easy-approval-api.niboshi.workers.dev";
const RUN = process.env.RUN_ID ?? `m9-${Date.now().toString(36)}`;
const ALICE = "user:auth0|6ab12807a4ea2a6f7c2ccc09";
const BOB = "user:auth0|6ab12aa04a279d37e02306c6";
const repo = new URL("../../", import.meta.url).pathname;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing env ${name}`);
    process.exit(2);
  }
  return value;
}

type Check = { id: string; title: string; ok: boolean; evidence: unknown };
const results: Check[] = [];
function check(id: string, title: string, ok: boolean, evidence: unknown = null) {
  results.push({ id, title, ok, evidence });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${title}`);
  if (!ok) console.log(`     evidence: ${JSON.stringify(evidence).slice(0, 800)}`);
}

async function token(username: string, password: string): Promise<string> {
  const response = await fetch(`https://${required("AUTH0_DOMAIN")}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "http://auth0.com/oauth/grant-type/password-realm",
      realm: "Username-Password-Authentication",
      username,
      password,
      client_id: required("AUTH0_WEB_CLIENT_ID"),
      client_secret: required("AUTH0_WEB_CLIENT_SECRET"),
      audience: required("AUTH0_API_AUDIENCE"),
      // #82: Public APIは操作ごとにscopeを検証する。
      scope: "openid read:action-requests write:action-requests",
    }),
  });
  const body = (await response.json()) as { access_token?: string; error?: string };
  if (!body.access_token) {
    console.error(`login failed for ${username}: ${body.error ?? response.status}`);
    process.exit(2);
  }
  return body.access_token;
}

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

function d1(sql: string): any[] {
  const run = spawnSync(
    "bunx",
    ["wrangler", "d1", "execute", "DB", "--remote", "--json", "--command", sql],
    { cwd: `${repo}apps/approval-api`, encoding: "utf8" },
  );
  if (run.status !== 0) {
    console.error(run.stderr || run.stdout);
    process.exit(3);
  }
  const parsed = JSON.parse(run.stdout) as Array<{ results: any[] }>;
  return parsed.flatMap((entry) => entry.results);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll<T>(
  label: string,
  load: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 240_000,
): Promise<T> {
  const started = Date.now();
  let value = await load();
  while (!done(value) && Date.now() - started < timeoutMs) {
    await sleep(5_000);
    value = await load();
  }
  if (!done(value)) console.log(`     (poll timeout: ${label})`);
  return value;
}

const tokens = new ClientCredentialsTokenProvider({
  tokenUrl: "https://auth.fga.dev/oauth/token",
  audience: "https://api.us1.fga.dev/",
  clientId: required("FGA_CLIENT_ID"),
  clientSecret: required("FGA_CLIENT_SECRET"),
});
const fga = new OpenFgaClient({
  apiUrl: "https://api.us1.fga.dev",
  storeId: required("OPENFGA_STORE_ID"),
  authorizationModelId: "01M38K1Q55CCNETS1V6XHJZJTB",
  organizationId: ORG as OrganizationId,
  tokenSupplier: tokens,
});

async function fgaCheck(user: string, relation: string, object: string): Promise<boolean | string> {
  const checked = await fga.check({ user, relation, object, consistency: "higher_consistency" });
  return Result.isSuccess(checked) ? checked.value : checked.error.code;
}

async function fgaWrite(
  tuple: { user: string; relation: string; object: string },
  present: boolean,
) {
  const written = await fga.writeTuples(present ? { writes: [tuple] } : { deletes: [tuple] });
  return Result.isSuccess(written) ? "ok" : written.error.code;
}

const alice = await token("staging-alice@example.com", required("ALICE_PASSWORD"));
const bob = await token("staging-bob@example.com", required("BOB_PASSWORD"));
const explain = (bearer: string, body: unknown) =>
  api(bearer, "POST", "/v1/admin/authorization/explain", body);
const submit = (bearer: string, input: unknown, key = crypto.randomUUID()) =>
  api(
    bearer,
    "POST",
    `/v1/organizations/${ORG_PATH}/action-requests`,
    {
      action: {
        type: "authorization.relationship.update",
        resource: { type: "authorization_admin", id: "root" },
        input,
      },
    },
    { "idempotency-key": key },
  );
const actionRequest = (bearer: string, id: string) =>
  api(bearer, "GET", `/v1/organizations/${ORG_PATH}/action-requests/${encodeURIComponent(id)}`);
async function relationshipOf(tuple: { user: string; relation: string; object: string }) {
  const key = await relationshipTupleKey({ organizationId: ORG as OrganizationId, tuple });
  if (Result.isFailure(key)) return null;
  const detail = await api(
    alice,
    "GET",
    `/v1/admin/authorization/relationships/${encodeURIComponent(key.value)}?observe=true`,
  );
  return { tupleKey: key.value, ...detail };
}
async function approveAs(bearer: string, actionRequestId: string) {
  const tasks = await poll(
    "approval task",
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
  const task = (tasks.body?.items ?? []).find((entry: any) => entry.status === "pending");
  if (!task) return { status: 0, body: tasks.body };
  return api(
    bearer,
    "POST",
    `/v1/organizations/${ORG_PATH}/approval-tasks/${encodeURIComponent(task.id)}/decisions`,
    { decision: "approve" },
    { "idempotency-key": crypto.randomUUID() },
  );
}

console.log(`# M9 staging E2E run ${RUN} against ${API}`);

// ---------------------------------------------------------------- Read / Explorer
const aliceSession = await api(alice, "GET", "/v1/admin/authorization/session");
const reads = await Promise.all(
  ["relationships", "model", "audit", "catalog"].map((path) =>
    api(alice, "GET", `/v1/admin/authorization/${path}`),
  ),
);
check(
  "E2E-1",
  "viewer (editor) can read the console APIs",
  aliceSession.body?.permissions?.viewer === true && reads.every((read) => read.status === 200),
  { session: aliceSession.body, statuses: reads.map((read) => read.status) },
);
const model = reads[1]?.body;
const bobSession = await api(bob, "GET", "/v1/admin/authorization/session");
const bobRead = await api(bob, "GET", "/v1/admin/authorization/relationships");
const bobExplain = await explain(bob, {});
check(
  "E2E-2",
  "non-viewer is denied console reads",
  bobSession.body?.permissions?.viewer === false &&
    bobRead.status === 403 &&
    bobExplain.status === 403,
  { bobSession: bobSession.body, bobRead: bobRead.status, bobExplain: bobExplain.status },
);

const ticket = (id: string, type = "ticket.update") => ({
  type,
  resource: { type: "ticket", id },
  input: { ticketId: id },
});
const allowed = await explain(alice, {
  principal: { type: "user", id: ALICE },
  action: ticket("staging-m8-3-1"),
});
check(
  "E2E-3",
  "Explorer: valid input / allowed",
  allowed.body?.authorization?.outcome === "allow" &&
    allowed.body?.authorization?.relation === "can_execute",
  allowed.body?.authorization,
);
const denied = await explain(alice, {
  principal: { type: "user", id: BOB },
  action: ticket("staging-m8-3-1"),
});
check(
  "E2E-4",
  "Explorer: valid input / denied",
  denied.body?.effectiveOutcome === "deny",
  denied.body?.authorization,
);
check(
  "E2E-5",
  "Explorer: approval-required simulation",
  allowed.body?.effectiveOutcome === "allowed_requires_approval" &&
    allowed.body?.approvalFlow?.requiresApproval === true,
  allowed.body?.effectiveOutcome,
);
const serialKeys = (allowed.body?.approvalFlow?.root?.children ?? []).map(
  (child: any) => child.stepKey,
);
check(
  "E2E-6",
  "Simulation flow: serial order matches the Materialized Plan (manager → finance)",
  allowed.body?.approvalFlow?.root?.type === "serial" &&
    JSON.stringify(serialKeys) === JSON.stringify(["manager", "finance"]),
  allowed.body?.approvalFlow?.root,
);
const escalate = await explain(alice, {
  principal: { type: "user", id: ALICE },
  action: ticket("staging-m8-3-1", "ticket.escalate"),
});
const groups = (escalate.body?.approvalFlow?.root?.children ?? []).map((group: any) => ({
  type: group.type,
  required: group.required,
  total: group.total,
  keys: group.children?.map((child: any) => child.stepKey),
}));
check(
  "E2E-7",
  "Simulation flow: parallel any / all keep branches + completion semantics",
  JSON.stringify(groups.slice(0, 2)) ===
    JSON.stringify([
      { type: "any", required: 1, total: 2, keys: ["triage-alice", "triage-bob"] },
      { type: "all", required: 2, total: 2, keys: ["review-alice", "review-bob"] },
    ]),
  groups,
);
const quorum = escalate.body?.approvalFlow?.root?.children?.[2];
check(
  "E2E-8",
  "Simulation flow: quorum 2/3 + step metadata",
  quorum?.type === "quorum" &&
    quorum.required === 2 &&
    quorum.total === 3 &&
    quorum.label === "quorum 2/3" &&
    quorum.children?.[2]?.resolution === "snapshot" &&
    quorum.children?.[0]?.source?.policyKey === "policy:staging-parallel-escalation" &&
    quorum.children?.[0]?.target?.userId === ALICE,
  quorum,
);
const missing = await explain(alice, {
  principal: { type: "user", id: ALICE },
  action: { type: "ticket.update", resource: { type: "ticket", id: "staging-m8-3-1" } },
});
check(
  "E2E-9",
  "required action.input missing → evaluation_error",
  missing.body?.effectiveOutcome === "evaluation_error" &&
    missing.body?.error?.code === "action_input_validation_failed",
  missing.body?.error,
);
const invalid = await explain(alice, {
  principal: { type: "user", id: ALICE },
  action: { ...ticket("staging-m8-3-1"), input: { ticketId: "" } },
});
check(
  "E2E-10",
  "invalid action.input → evaluation_error",
  invalid.body?.effectiveOutcome === "evaluation_error" &&
    Array.isArray(invalid.body?.error?.issues),
  invalid.body?.error,
);
const providerError = await explain(alice, {
  principal: { type: "user", id: "has whitespace" },
  action: ticket("staging-m8-3-1"),
});
check(
  "E2E-11",
  "provider failure → evaluation_error (not deny / no-approval)",
  providerError.body?.effectiveOutcome === "evaluation_error" &&
    providerError.body?.authorization?.outcome === "error",
  providerError.body,
);

// ---------------------------------------------------------------- Governed mutation
const object = `ticket:${RUN}-t1`;
const grantExec = { user: BOB, relation: "can_execute", object };
const write1 = await submit(alice, { operation: "write", tuple: grantExec });
check(
  "E2E-12",
  "editor write → no approval → confirmed",
  write1.status === 201 &&
    write1.body?.status === "executed" &&
    write1.body?.result?.output?.relationship?.status === "confirmed" &&
    write1.body?.result?.output?.relationship?.effectConfirmed === true,
  write1.body,
);
const recheck = await explain(alice, {
  principal: { type: "user", id: BOB },
  action: ticket(`${RUN}-t1`),
});
const directCheck = await fgaCheck(BOB, "can_execute", object);
check(
  "E2E-14",
  "Check reflects the write (Explorer + direct FGA)",
  recheck.body?.authorization?.outcome === "allow" && directCheck === true,
  { explorer: recheck.body?.authorization, directCheck },
);

const grantApprove = { user: BOB, relation: "can_approve", object };
const pending = await submit(alice, { operation: "write", tuple: grantApprove });
const pendingNoChange = await fgaCheck(BOB, "can_approve", object);
const decision = await approveAs(bob, pending.body?.id);
const approved = await poll(
  "approved write",
  () => actionRequest(alice, pending.body?.id),
  (value) => value.body?.status === "executed" || String(value.body?.status).includes("failed"),
);
const approvedRel = await relationshipOf(grantApprove);
check(
  "E2E-13",
  "editor write with approval → pending (no change) → approve → confirmed",
  pending.body?.status === "pending_approval" &&
    pendingNoChange === false &&
    decision.status === 202 &&
    approved.body?.status === "executed" &&
    approvedRel?.body?.relationship?.syncStatus === "confirmed" &&
    approvedRel?.body?.provider?.observedState === "present",
  {
    pending: pending.body?.status,
    pendingNoChange,
    decision: decision.status,
    approved: approved.body,
    relationship: approvedRel?.body,
  },
);

const deleted = await submit(alice, { operation: "delete", tuple: grantExec });
const afterDelete = await explain(alice, {
  principal: { type: "user", id: BOB },
  action: ticket(`${RUN}-t1`),
});
check(
  "E2E-15",
  "delete → confirmed → Check deny",
  deleted.body?.result?.output?.relationship?.status === "confirmed" &&
    afterDelete.body?.effectiveOutcome === "deny" &&
    (await fgaCheck(BOB, "can_execute", object)) === false,
  { deleted: deleted.body?.result, afterDelete: afterDelete.body?.effectiveOutcome },
);

// editor revoke while waiting for approval (membership changed via the IaC path, then restored)
const revokeTuple = { user: BOB, relation: "can_approve", object: `ticket:${RUN}-t2` };
const revokePending = await submit(alice, { operation: "write", tuple: revokeTuple });
const adminTuple = { user: ALICE, relation: "editor", object: "authorization_admin:root" };
const removed = await fgaWrite(adminTuple, false);
const revokeDecision = await approveAs(bob, revokePending.body?.id);
const revoked = await poll(
  "revoked",
  () => actionRequest(alice, revokePending.body?.id),
  (value) =>
    value.body?.status !== "pending_approval" &&
    value.body?.status !== "approved" &&
    value.body?.status !== "executing",
);
const restored = await fgaWrite(adminTuple, true);
check(
  "E2E-16",
  "editor revoked during approval → re-authorization deny, no mutation",
  revokePending.body?.status === "pending_approval" &&
    removed === "ok" &&
    revokeDecision.status === 202 &&
    revoked.body?.status === "authorization_revoked" &&
    (await relationshipOf(revokeTuple))?.status === 404 &&
    restored === "ok",
  { status: revoked.body?.status, result: revoked.body?.result, removed, restored },
);

const otherOrg = await api(
  alice,
  "POST",
  `/v1/organizations/${encodeURIComponent("organization:other")}/action-requests`,
  {
    action: {
      type: "authorization.relationship.update",
      resource: { type: "authorization_admin", id: "root" },
      input: { operation: "write", tuple: grantExec },
    },
  },
  { "idempotency-key": crypto.randomUUID() },
);
const injected = await submit(alice, {
  operation: "write",
  tuple: { ...grantExec, object: "ticket:organization%3Aother/x" },
});
const listed = await api(alice, "GET", "/v1/admin/authorization/relationships?limit=100");
const foreignRows = (listed.body?.items ?? []).filter(
  (item: any) => !String(item.providerObject).includes("organization%3Astaging"),
);
check(
  "E2E-17",
  "other organization is invisible and unmodifiable; cross-tenant object injection rejected",
  otherOrg.status === 403 &&
    injected.status === 422 &&
    listed.status === 200 &&
    foreignRows.length === 0,
  { otherOrg: otherOrg.status, injected: injected.status, foreignRows },
);
const escalation = await Promise.all(
  ["editor", "viewer"].map((relation) =>
    submit(alice, {
      operation: "write",
      tuple: { user: BOB, relation, object: "authorization_admin:root" },
    }),
  ),
);
check(
  "E2E-18",
  "authorization_admin:root#editor/viewer mutation rejected",
  escalation.every((response) => response.status === 422) &&
    (await fgaCheck(BOB, "viewer", "authorization_admin:root")) === false,
  escalation.map((response) => response.body),
);
const outside = await submit(alice, {
  operation: "write",
  tuple: { user: BOB, relation: "owner", object },
});
check("E2E-19", "non-catalog relation rejected", outside.status === 422, outside.body);

// ---------------------------------------------------------------- Retry / ordering / crash safety
const retryKey = crypto.randomUUID();
const retryTuple = { user: BOB, relation: "can_execute", object: `ticket:${RUN}-t3` };
const first = await submit(alice, { operation: "write", tuple: retryTuple }, retryKey);
const replay = await submit(alice, { operation: "write", tuple: retryTuple }, retryKey);
const retryRows = d1(
  `SELECT COUNT(*) AS mutations, (SELECT COUNT(*) FROM authorization_relationship_events WHERE organization_id='${ORG}' AND source_action_request_id='${first.body?.id}' AND event_type='authorization.relationship_change_requested') AS requested FROM authorization_relationship_mutations WHERE organization_id='${ORG}' AND action_request_id='${first.body?.id}'`,
);
check(
  "E2E-20",
  "same mutation retry → same ActionRequest/revision, no duplicate logical audit",
  first.body?.id === replay.body?.id &&
    retryRows[0]?.mutations === 1 &&
    retryRows[0]?.requested === 1,
  { first: first.body?.id, replay: replay.body?.id, rows: retryRows },
);

// helpers constructing the durable rows the executor writes (prepare/apply)
async function seedMutation(input: {
  mutationKey: string;
  tuple: { user: string; relation: string; object: string };
  desiredPresent: boolean;
  status: "applying" | "indeterminate";
  idleSeconds: number;
}) {
  const key = await relationshipTupleKey({
    organizationId: ORG as OrganizationId,
    tuple: input.tuple,
  });
  if (Result.isFailure(key)) return "";
  const at = new Date(Date.now() - input.idleSeconds * 1000).toISOString();
  const actor = JSON.stringify({ type: "user", id: ALICE });
  const q = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const operation = input.desiredPresent ? "write" : "delete";
  d1(`INSERT INTO authorization_relationship_mutations (organization_id, mutation_key, action_request_id, tuple_key, revision, operation, desired_present, subject, relation, logical_object, actor_json, status, authorization_model_id, attempt_count, requested_at, apply_started_at, updated_at, last_error_code)
      SELECT ${q(ORG)}, ${q(input.mutationKey)}, ${q(`action:${input.mutationKey}`)}, ${q(key.value)}, COALESCE((SELECT MAX(revision) FROM authorization_relationship_mutations WHERE organization_id=${q(ORG)} AND tuple_key=${q(key.value)}),0)+1, ${q(operation)}, ${input.desiredPresent ? 1 : 0}, ${q(input.tuple.user)}, ${q(input.tuple.relation)}, ${q(input.tuple.object)}, ${q(actor)}, ${q(input.status)}, '01M38K1Q55CCNETS1V6XHJZJTB', 1, ${q(at)}, ${q(at)}, ${q(at)}, ${input.status === "indeterminate" ? q("network_error") : "NULL"};
    INSERT INTO authorization_relationships (organization_id, tuple_key, subject, relation, logical_object, object_type, desired_present, revision, latest_mutation_key, latest_action_request_id, confirmed_revision, confirmed_present, sync_status, created_at, updated_at)
      SELECT organization_id, tuple_key, subject, relation, logical_object, 'ticket', desired_present, revision, mutation_key, action_request_id, NULL, NULL, status, requested_at, requested_at FROM authorization_relationship_mutations WHERE organization_id=${q(ORG)} AND mutation_key=${q(input.mutationKey)}
      ON CONFLICT (organization_id, tuple_key) DO UPDATE SET desired_present=excluded.desired_present, revision=excluded.revision, latest_mutation_key=excluded.latest_mutation_key, latest_action_request_id=excluded.latest_action_request_id, sync_status=excluded.sync_status, updated_at=excluded.updated_at;
    INSERT OR IGNORE INTO authorization_relationship_events (organization_id, event_key, event_type, occurred_at, actor_type, actor_id, source_action_request_id, mutation_key, tuple_key, revision, operation, desired_present, subject, relation, logical_object, authorization_model_id)
      SELECT organization_id, organization_id||':'||mutation_key||':requested', 'authorization.relationship_change_requested', requested_at, 'user', ${q(ALICE)}, action_request_id, mutation_key, tuple_key, revision, operation, desired_present, subject, relation, logical_object, authorization_model_id FROM authorization_relationship_mutations WHERE organization_id=${q(ORG)} AND mutation_key=${q(input.mutationKey)};
    INSERT OR IGNORE INTO authorization_relationship_events (organization_id, event_key, event_type, occurred_at, actor_type, actor_id, source_action_request_id, mutation_key, tuple_key, revision, operation, desired_present, subject, relation, logical_object, authorization_model_id)
      SELECT organization_id, organization_id||':'||mutation_key||':apply_started:1', 'authorization.relationship_apply_started', requested_at, 'user', ${q(ALICE)}, action_request_id, mutation_key, tuple_key, revision, operation, desired_present, subject, relation, logical_object, authorization_model_id FROM authorization_relationship_mutations WHERE organization_id=${q(ORG)} AND mutation_key=${q(input.mutationKey)};`);
  return key.value;
}
const mutationStatus = (mutationKey: string) =>
  d1(
    `SELECT status, revision FROM authorization_relationship_mutations WHERE organization_id='${ORG}' AND mutation_key='${mutationKey}'`,
  )[0];
const eventsOf = (mutationKey: string) =>
  d1(
    `SELECT event_type FROM authorization_relationship_events WHERE organization_id='${ORG}' AND mutation_key='${mutationKey}' ORDER BY sequence`,
  ).map((row) => String(row.event_type).replace("authorization.relationship_", ""));

// E2E-21 / 25: A grant applied at provider but response lost → B revoke confirmed → A retry superseded
const abTuple = { user: BOB, relation: "can_execute", object: `ticket:${RUN}-ab` };
const aKey = `${RUN}-A`;
await seedMutation({
  mutationKey: aKey,
  tuple: abTuple,
  desiredPresent: true,
  status: "indeterminate",
  idleSeconds: 0,
});
const aApplied = await fgaWrite(abTuple, true);
const b = await submit(alice, { operation: "delete", tuple: abTuple });
const aAfter = await poll(
  "A superseded",
  async () => mutationStatus(aKey),
  (row) => row?.status === "superseded",
);
const abFinal = await fgaCheck(BOB, "can_execute", abTuple.object);
check(
  "E2E-21",
  "A grant (response lost) → B revoke confirmed → A retry superseded; final state is revoke",
  aApplied === "ok" &&
    b.body?.result?.output?.relationship?.status === "confirmed" &&
    aAfter?.status === "superseded" &&
    abFinal === false,
  { b: b.body?.result, a: aAfter, abFinal, events: eventsOf(aKey) },
);
check(
  "E2E-25",
  "stale revision reconciliation supersedes without resending the old grant",
  aAfter?.status === "superseded" &&
    !eventsOf(aKey).includes("change_confirmed") &&
    abFinal === false,
  eventsOf(aKey),
);

// E2E-22 / 23: FGA success → crash before D1 confirmation → durable intent → reconcile confirms
const crashTuple = { user: BOB, relation: "can_approve", object: `ticket:${RUN}-crash` };
const crashKey = `${RUN}-crash`;
await seedMutation({
  mutationKey: crashKey,
  tuple: crashTuple,
  desiredPresent: true,
  status: "applying",
  idleSeconds: 90,
});
const crashApplied = await fgaWrite(crashTuple, true);
const durable = eventsOf(crashKey);
check(
  "E2E-22",
  "FGA success then crash: requested/applying intent remains durable",
  crashApplied === "ok" &&
    durable.includes("change_requested") &&
    durable.includes("apply_started") &&
    !durable.includes("change_confirmed"),
  durable,
);
const crashAfter = await poll(
  "crash confirmed",
  async () => mutationStatus(crashKey),
  (row) => row?.status === "confirmed",
);
const crashRel = await relationshipOf(crashTuple);
check(
  "E2E-23",
  "reconciliation confirms the latest desired state after the crash",
  crashAfter?.status === "confirmed" &&
    crashRel?.body?.relationship?.syncStatus === "confirmed" &&
    eventsOf(crashKey).includes("change_confirmed"),
  { crashAfter, events: eventsOf(crashKey), relationship: crashRel?.body?.relationship },
);

// E2E-24: ambiguous timeout (not applied) → indeterminate → reconcile applies latest
const ambTuple = { user: BOB, relation: "can_execute", object: `ticket:${RUN}-amb` };
const ambKey = `${RUN}-amb`;
await seedMutation({
  mutationKey: ambKey,
  tuple: ambTuple,
  desiredPresent: true,
  status: "indeterminate",
  idleSeconds: 0,
});
const ambAfter = await poll(
  "indeterminate reconciled",
  async () => mutationStatus(ambKey),
  (row) => row?.status === "confirmed",
);
check(
  "E2E-24",
  "ambiguous timeout → indeterminate → reconcile → confirmed",
  ambAfter?.status === "confirmed" &&
    (await fgaCheck(BOB, "can_execute", ambTuple.object)) === true,
  { ambAfter, events: eventsOf(ambKey) },
);

// E2E-26: concurrent same-tuple mutations → unique revision order, converge to latest
const concTuple = { user: BOB, relation: "can_execute", object: `ticket:${RUN}-conc` };
const [cw, cd] = await Promise.all([
  submit(alice, { operation: "write", tuple: concTuple }),
  submit(alice, { operation: "delete", tuple: concTuple }),
]);
const concRel = await poll(
  "concurrent converge",
  () => relationshipOf(concTuple),
  (value) => value?.body?.relationship?.syncStatus === "confirmed",
);
const revisions = (concRel?.body?.mutations ?? [])
  .map((mutation: any) => mutation.revision)
  .sort((x: number, y: number) => x - y);
const latestDesired = concRel?.body?.relationship?.desiredState;
const concFinal = await fgaCheck(BOB, "can_execute", concTuple.object);
check(
  "E2E-26",
  "concurrent mutations get unique revisions and converge to the latest desired state",
  JSON.stringify(revisions) === JSON.stringify([1, 2]) &&
    (latestDesired === "present") === (concFinal === true),
  {
    statuses: [cw.status, cd.status],
    revisions,
    latestDesired,
    concFinal,
    mutations: concRel?.body?.mutations,
  },
);

// ---------------------------------------------------------------- Model / audit
const modelWrite = await Promise.all(
  ["PUT", "POST", "DELETE"].map((method) =>
    api(alice, method, "/v1/admin/authorization/model", {}),
  ),
);
check(
  "E2E-27",
  "model is read-only (active model = pinned GitOps model, no write endpoint)",
  model?.readOnly === true &&
    model?.activeModelId === "01M38K1Q55CCNETS1V6XHJZJTB" &&
    model?.source?.matchesProvider === true &&
    modelWrite.every((response) => response.status === 404),
  {
    model: { id: model?.activeModelId, matches: model?.source?.matchesProvider },
    writes: modelWrite.map((response) => response.status),
  },
);
const audit = await api(
  alice,
  "GET",
  `/v1/admin/authorization/audit?actionRequestId=${encodeURIComponent(write1.body?.id)}`,
);
const auditItems: any[] = audit.body?.items ?? [];
const phases = [...auditItems].reverse().map((event) => event.phase);
check(
  "E2E-30",
  "audit keeps actor/time/tuple/source ActionRequest/mutation revision",
  auditItems.length >= 3 &&
    auditItems.every(
      (event) =>
        event.actor?.id === ALICE &&
        event.occurredAt &&
        event.subject === BOB &&
        event.relation === "can_execute" &&
        event.object === object &&
        event.sourceActionRequestId === write1.body?.id &&
        event.revision >= 1 &&
        event.mutationKey,
    ),
  auditItems,
);
check(
  "E2E-31/32",
  "requested precedes apply/confirmed; confirmed only after observed effect",
  JSON.stringify(phases) === JSON.stringify(["requested", "apply_started", "confirmed"]),
  phases,
);
const indeterminateAudit = await api(
  alice,
  "GET",
  `/v1/admin/authorization/audit?mutationKey=${encodeURIComponent(aKey)}`,
);
check(
  "E2E-33",
  "indeterminate / superseded are distinguishable in the audit API",
  (indeterminateAudit.body?.items ?? []).some((event: any) => event.phase === "superseded"),
  (indeterminateAudit.body?.items ?? []).map((event: any) => event.phase),
);
check(
  "E2E-SEC",
  "audit/API payloads carry no action input body or credentials",
  !JSON.stringify(auditItems).includes('"input"') &&
    !JSON.stringify(reads).includes("client_secret"),
  null,
);

const failed = results.filter((result) => !result.ok);
console.log(`\n# ${results.length - failed.length}/${results.length} passed (run ${RUN})`);
writeFileSync(
  `${repo}tests/staging/.last-m9-e2e.json`,
  JSON.stringify({ run: RUN, api: API, at: new Date().toISOString(), results }, null, 2),
);
process.exit(failed.length === 0 ? 0 : 1);
