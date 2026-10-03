import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const KNOWLEDGE = "https://ultra-easy-knowledge.niboshi.workers.dev";
const APPROVAL = "https://ultra-easy.niboshi.workers.dev";
const API = "https://ultra-easy-approval-api.niboshi.workers.dev";
const ORG = "organization:staging";

type Principal = { id: string; displayName: string };
type Space = { id: string; key: string };
type Rules = {
  rules: Array<{ key: string; requireApproval: boolean; approver: string }>;
  policyVersion: number;
  pendingChange: { approvalUrl: string } | null;
};
type PageView = {
  nextPublication: { draftVersion: number } | null;
  publication: { state: string; approvalUrl: string | null } | null;
  published: { body: string } | null;
};

async function signIn(page: Page, user: "ALICE" | "BOB") {
  const password = process.env[`AUTH0_STAGING_${user}_PASSWORD`];
  expect(password, `${user} staging password is required`).toBeTruthy();
  await page.goto(`${KNOWLEDGE}/login?redirect=/spaces`);
  await page.getByRole("link", { name: "Continue with Auth0" }).click();
  await page.waitForURL(/auth0\.com/);
  await page.locator('input[name="username"]').fill(`staging-${user.toLowerCase()}@example.com`);
  await page.locator('input[name="password"]').fill(password ?? "");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/ultra-easy-knowledge.*\/spaces/);
  const me = await page.context().request.get(`${KNOWLEDGE}/api/me`);
  expect(me.status()).toBe(200);
  return ((await me.json()) as { principal: Principal }).principal;
}

async function grantOwner(spaceId: string, principalId: string) {
  const required = [
    "AUTH0_DOMAIN",
    "AUTH0_API_AUDIENCE",
    "AUTH0_KNOWLEDGE_AGENT_CLIENT_ID",
    "AUTH0_KNOWLEDGE_AGENT_CLIENT_SECRET",
  ];
  for (const name of required) expect(process.env[name], `${name} is required`).toBeTruthy();
  const token = await fetch(`https://${process.env.AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: process.env.AUTH0_KNOWLEDGE_AGENT_CLIENT_ID,
      client_secret: process.env.AUTH0_KNOWLEDGE_AGENT_CLIENT_SECRET,
      audience: process.env.AUTH0_API_AUDIENCE,
    }),
  });
  expect(token.status).toBe(200);
  const credentials = (await token.json()) as { access_token: string };
  const granted = await fetch(
    `${API}/v1/organizations/${encodeURIComponent(ORG)}/action-requests`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.access_token}`,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        action: {
          type: "application.relationship.update",
          resource: { type: "knowledge_space", id: spaceId },
          input: {
            operation: "write",
            tuple: {
              user: principalId,
              relation: "owner",
              object: `knowledge_space:${spaceId}`,
            },
          },
        },
      }),
    },
  );
  expect(granted.status).toBe(201);
  expect((await granted.json()) as { status: string }).toMatchObject({ status: "executed" });
}

async function knowledgeJson(
  context: BrowserContext,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await context.request.fetch(`${KNOWLEDGE}${path}`, {
    method,
    headers: { "x-knowledge-client": "1" },
    ...(body === undefined ? {} : { data: body }),
  });
  return { status: response.status(), body: await response.json() };
}

async function approvalSignIn(context: BrowserContext) {
  const response = await context.request.post(`${APPROVAL}/api/auth/login`, {
    headers: { "x-ue-console": "1" },
    data: {
      username: "staging-bob@example.com",
      password: process.env.AUTH0_STAGING_BOB_PASSWORD,
    },
  });
  expect(response.status()).toBe(200);
}

test("remote Knowledge runs governed policy and publication through public APIs", async ({
  browser,
}) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const approver = await browser.newContext();
  const alicePage = await alice.newPage();
  const bobPage = await bob.newPage();
  const approvalPage = await approver.newPage();
  const owner = await signIn(alicePage, "ALICE");
  const secondOwner = await signIn(bobPage, "BOB");
  expect(owner.id).not.toBe(secondOwner.id);
  await approvalSignIn(approver);
  const oldPage = await alice.request.get(`${KNOWLEDGE}/mock/ultra-easy/approvals/task%3Asample`);
  const oldApi = await alice.request.get(
    `${KNOWLEDGE}/api/mock-ultra-easy/approvals/task%3Asample`,
  );
  expect(oldPage.status()).toBe(404);
  expect(oldApi.status()).toBe(404);

  const key = `remote-e2e-${Date.now()}`;
  const created = await knowledgeJson(alice, "POST", "/api/spaces", {
    key,
    name: "Remote acceptance",
    description: "Live public API verification",
  });
  expect(created.status).toBe(201);
  const spaces = await knowledgeJson(alice, "GET", "/api/spaces");
  expect(spaces.status).toBe(200);
  const space = (spaces.body as { spaces: Space[] }).spaces.find((entry) => entry.key === key);
  expect(space).toBeDefined();
  await grantOwner(space?.id ?? "", secondOwner.id);

  const settingsPath = `/api/spaces/${key}/settings`;
  const initial = await knowledgeJson(alice, "GET", settingsPath);
  expect(initial.status).toBe(200);
  const rules = (initial.body as Rules).rules.map((entry) => ({
    key: entry.key,
    requireApproval: entry.key === "archive" ? false : entry.requireApproval,
    approver: entry.approver,
  }));
  const proposed = await knowledgeJson(alice, "PUT", `${settingsPath}/approval-rules`, { rules });
  expect(proposed.status).toBe(200);
  const pendingUrl = (proposed.body as Rules).pendingChange?.approvalUrl;
  expect(pendingUrl).toContain(`${APPROVAL}/action-requests/`);
  await expect
    .poll(
      async () => {
        const response = await approver.request.get(
          `${APPROVAL}/api${new URL(pendingUrl ?? APPROVAL).pathname}`,
        );
        return response.status();
      },
      { timeout: 30_000 },
    )
    .toBe(200);
  await approvalPage.goto(pendingUrl ?? "");
  await expect(approvalPage.getByRole("link", { name: /scope_owner/ })).toBeVisible();
  await approvalPage.getByRole("link", { name: /scope_owner/ }).click();
  await expect(approvalPage.getByRole("button", { name: "Approve" })).toBeVisible();
  await approvalPage.getByRole("button", { name: "Approve" }).click();
  await expect(approvalPage.getByRole("status")).toContainText("Decision submitted");
  await expect
    .poll(
      async () => {
        const result = await knowledgeJson(alice, "GET", settingsPath);
        return (result.body as Rules).policyVersion;
      },
      { timeout: 30_000 },
    )
    .toBe(1);

  const pageCreated = await knowledgeJson(alice, "POST", `/api/spaces/${key}/pages`, {
    title: "Governed publication",
  });
  expect(pageCreated.status).toBe(201);
  const pageId = (pageCreated.body as { pageId: string }).pageId;
  const pagePath = `/api/spaces/${key}/pages/${pageId}`;
  const edited = await knowledgeJson(alice, "GET", `${pagePath}/edit`);
  expect(edited.status).toBe(200);
  const draft = (edited.body as { draft: Record<string, unknown> }).draft;
  const content = `# Remote acceptance\n\n${key}`;
  const saved = await knowledgeJson(alice, "PUT", `${pagePath}/draft`, {
    ...draft,
    body: content,
    sensitivity: "confidential",
    visibility: "organization",
    expectedVersion: draft.version,
  });
  expect(saved.status).toBe(200);
  const before = await knowledgeJson(alice, "GET", pagePath);
  expect(before.status).toBe(200);
  const started = await knowledgeJson(alice, "POST", `${pagePath}/publish`, {
    expectedDraftVersion: (before.body as PageView).nextPublication?.draftVersion,
  });
  expect(started.status).toBe(202);
  let publicationApprovalUrl: string | null = null;
  await expect
    .poll(
      async () => {
        const result = await knowledgeJson(alice, "GET", pagePath);
        const publication = (result.body as PageView).publication;
        publicationApprovalUrl = publication?.approvalUrl ?? null;
        return publication?.state;
      },
      { timeout: 30_000 },
    )
    .toBe("waiting_approval");
  expect(publicationApprovalUrl).toContain(`${APPROVAL}/approval-tasks/`);
  await approvalPage.goto(publicationApprovalUrl ?? "");
  await expect(approvalPage.getByRole("button", { name: "Approve" })).toBeVisible();
  await approvalPage.getByRole("button", { name: "Approve" }).click();
  await expect
    .poll(
      async () => {
        const result = await knowledgeJson(alice, "GET", pagePath);
        return (result.body as PageView).published?.body;
      },
      { timeout: 30_000 },
    )
    .toBe(content);
  const automations = await knowledgeJson(alice, "GET", "/api/automation");
  expect(automations.status).toBe(200);
  const publicationRun = (
    automations.body as {
      items: Array<{
        runId: string;
        kind: string;
        space: { key: string };
        page: { id: string } | null;
      }>;
    }
  ).items.find(
    (item) =>
      item.kind === "publish_document" && item.space.key === key && item.page?.id === pageId,
  );
  expect(publicationRun).toBeDefined();
  const detail = await knowledgeJson(
    alice,
    "GET",
    `/api/automation/${encodeURIComponent(publicationRun?.runId ?? "")}`,
  );
  expect(detail.status).toBe(200);
  expect(detail.body).toMatchObject({ runId: publicationRun?.runId, status: "succeeded" });
  await alice.close();
  await bob.close();
  await approver.close();
});
