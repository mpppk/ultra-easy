import { expect, test, type Page } from "@playwright/test";

const CF = "/spaces/engineering/pages/pg_cf_workers_deploy";

async function signIn(page: Page, principalId: string) {
  await page.goto("/login");
  await page.locator(`input[value="${principalId}"]`).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("/");
}

/** Demo control endpoints (same-origin fetch with the CSRF header). */
async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ([method, path, body]) =>
      (
        await fetch(path, {
          method,
          headers: { "x-knowledge-client": "1", "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      ).status,
    [method, path, body] as const,
  );
}

async function appendToDraft(page: Page, line: string) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(`\n\n${line}`);
}

async function choose(page: Page, label: string, option: string) {
  await page.getByLabel(label).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test.describe.configure({ mode: "serial" });

test("draft save needs no approval; publication waits for child approval", async ({ page }) => {
  await signIn(page, "user:yuki");
  await page.goto(`${CF}/edit`);
  await appendToDraft(page, "E2E: approved content line.");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await choose(page, "Sensitivity", "Confidential");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Publish changes" }).click();
  await page.waitForURL(CF);
  await expect(page.getByText("This page is awaiting approval before publishing.")).toBeVisible();
  // viewers still see the previous published revision meanwhile
  await expect(page.getByText("E2E: approved content line.")).toHaveCount(0);
});

test("approval happens in ultra-easy; the exact snapshot is published", async ({ page }) => {
  await signIn(page, "user:yuki");
  await page.goto(CF);
  await page.getByRole("link", { name: /View in Approval/ }).click();
  await expect(page.getByText(/who is not an approver/)).toBeVisible();

  await api(page, "POST", "/api/demo/session", { principalId: "user:morgan" });
  await page.reload();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("approved", { exact: true })).toBeVisible();

  await api(page, "POST", "/api/demo/session", { principalId: "user:yuki" });
  await page.goto(CF);
  await expect(page.getByText("E2E: approved content line.").first()).toBeVisible();
  await expect(page.getByText("Published revision #4")).toBeVisible();
});

test("notification failure keeps the page published and is retried alone", async ({ page }) => {
  await signIn(page, "user:yuki");
  await api(page, "POST", "/api/demo/faults", { notifier: true });
  await page.goto(`${CF}/edit`);
  await appendToDraft(page, "E2E: published during notifier outage.");
  await choose(page, "Visibility", "Space");
  await choose(page, "Sensitivity", "Normal");
  await page.getByRole("button", { name: "Publish changes" }).click();
  await page.waitForURL(CF);
  await expect(
    page.getByRole("alert").getByText("Downstream notification temporarily unavailable"),
  ).toBeVisible();
  await expect(page.getByText("E2E: published during notifier outage.")).toBeVisible();

  await api(page, "POST", "/api/demo/faults", { notifier: false });
  await page.getByRole("button", { name: "Retry notification" }).click();
  await expect(page.getByText("Recovered by retry")).toBeVisible();
});

test("maintenance workflow waits for owner input and resumes", async ({ page }) => {
  await signIn(page, "user:yuki");
  await page.goto("/automation");
  await page.getByRole("button", { name: "Run maintenance" }).click();
  await expect(page.getByRole("heading", { name: "Owner review" })).toBeVisible();
  await expect(page.getByText(/Suggestion \(LLM, not a decision\)/)).toBeVisible();
  await page.getByRole("button", { name: "Needs update" }).click();
  await expect(page.getByText("Answered:")).toBeVisible();
  await page.goto("/");
  await expect(page.getByText("API authentication guide needs an update")).toBeVisible();
});

test("viewers never see drafts, history or authoring actions", async ({ page }) => {
  await signIn(page, "user:sam");
  await page.goto("/spaces/engineering/pages/pg_service_ownership");
  await expect(
    page.getByText("Core runbook detailing operational responsibilities and deployment targets."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Edit/ })).toHaveCount(0);
  await expect(page.getByText(/View \d+ revisions/)).toHaveCount(0);

  await page.goto("/spaces/engineering/pages/pg_edge_caching");
  await expect(page.getByText("Page not found or forbidden")).toBeVisible();

  await page.goto("/search?q=caching");
  await expect(page.getByText("No results found")).toBeVisible();
  await page.goto("/");
  await expect(page.getByText("Edge caching strategy")).toHaveCount(0);
});
