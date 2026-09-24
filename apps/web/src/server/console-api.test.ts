import { describe, expect, it } from "vite-plus/test";

import {
  login,
  logout,
  proxyAdminRequest,
  proxyCreateActionRequest,
  type ConsoleWebEnv,
} from "./console-api.ts";
import { openSession, SESSION_COOKIE, sealSession } from "./session.ts";

const secret = "test-session-secret";

type Seen = { url: string; method: string; authorization: string | null; body: string };

function env(seen: Seen[], overrides: Partial<ConsoleWebEnv> = {}): ConsoleWebEnv {
  return {
    SESSION_SECRET: secret,
    APPROVAL_API: {
      async fetch(request: Request) {
        seen.push({
          url: request.url,
          method: request.method,
          authorization: request.headers.get("authorization"),
          body: request.method === "GET" ? "" : await request.text(),
        });
        if (new URL(request.url).pathname === "/v1/admin/authorization/session") {
          return Response.json({ organizationId: "organization:staging" });
        }
        return Response.json({ ok: true }, { status: 201 });
      },
    },
    ...overrides,
  };
}

async function sessionCookieHeader(): Promise<string> {
  const sealed = await sealSession(
    { accessToken: "access-token-1", expiresAt: Date.now() + 60_000 },
    secret,
  );
  return `${SESSION_COOKIE}=${sealed}`;
}

describe("console session", () => {
  it("seals and opens tokens; tampered or expired cookies are rejected", async () => {
    const sealed = await sealSession({ accessToken: "t", expiresAt: 2_000 }, secret);
    expect(sealed).not.toContain('t"');
    expect(await openSession(sealed, secret, 1_000)).toEqual({
      accessToken: "t",
      expiresAt: 2_000,
    });
    expect(await openSession(sealed, secret, 3_000)).toBeNull();
    expect(await openSession(sealed, "other-secret", 1_000)).toBeNull();
    expect(await openSession(`${sealed.slice(0, -2)}AA`, secret, 1_000)).toBeNull();
  });
});

describe("console proxy (AC-M9-001 / credential boundary)", () => {
  it("requires a session and forwards the bearer server-side only", async () => {
    const seen: Seen[] = [];
    const anonymous = await proxyAdminRequest(
      new Request("https://web.example/api/admin/authorization/relationships"),
      env(seen),
    );
    expect(anonymous.status).toBe(401);
    expect(seen).toHaveLength(0);

    const response = await proxyAdminRequest(
      new Request("https://web.example/api/admin/authorization/relationships?limit=5", {
        headers: { cookie: await sessionCookieHeader() },
      }),
      env(seen),
    );
    expect(response.status).toBe(201);
    expect(seen[0]).toMatchObject({
      url: "https://approval-api.internal/v1/admin/authorization/relationships?limit=5",
      authorization: "Bearer access-token-1",
    });
    expect(await response.text()).not.toContain("access-token-1");
  });

  it("POSTs need the console CSRF header", async () => {
    const seen: Seen[] = [];
    const forged = await proxyAdminRequest(
      new Request("https://web.example/api/admin/authorization/explain", {
        method: "POST",
        headers: { cookie: await sessionCookieHeader() },
        body: "{}",
      }),
      env(seen),
    );
    expect(forged.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("creates only relationship-update ActionRequests, with the org resolved server-side", async () => {
    const seen: Seen[] = [];
    const headers = {
      cookie: await sessionCookieHeader(),
      "x-ue-console": "1",
      "idempotency-key": "k-1",
      "content-type": "application/json",
    };
    const other = await proxyCreateActionRequest(
      new Request("https://web.example/api/action-requests", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: { type: "ticket.update" } }),
      }),
      env(seen),
    );
    expect(other.status).toBe(400);

    const created = await proxyCreateActionRequest(
      new Request("https://web.example/api/action-requests", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: {
            type: "authorization.relationship.update",
            resource: { type: "authorization_admin", id: "root" },
            input: {},
          },
        }),
      }),
      env(seen),
    );
    expect(created.status).toBe(201);
    expect(seen.map((entry) => entry.url)).toEqual([
      "https://approval-api.internal/v1/admin/authorization/session",
      "https://approval-api.internal/v1/organizations/organization%3Astaging/action-requests",
    ]);
  });
});

describe("staging login", () => {
  it("is disabled unless STAGING_PASSWORD_LOGIN=true", async () => {
    const response = await login(
      new Request("https://web.example/api/auth/login", { method: "POST" }),
      env([]),
    );
    expect(response.status).toBe(404);
  });

  it("exchanges credentials server-side and sets an HttpOnly Secure SameSite=Strict cookie", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const response = await login(
      new Request("https://web.example/api/auth/login", {
        method: "POST",
        headers: { "x-ue-console": "1", "content-type": "application/json" },
        body: JSON.stringify({ username: "alice@example.com", password: "pw" }),
      }),
      env([], {
        STAGING_PASSWORD_LOGIN: "true",
        AUTH0_DOMAIN: "tenant.example",
        AUTH0_API_AUDIENCE: "https://api",
        AUTH0_WEB_CLIENT_ID: "client",
        AUTH0_WEB_CLIENT_SECRET: "client-secret",
      }),
      async (_input, init) => {
        calls.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return Response.json({ access_token: "token-xyz", expires_in: 600 });
      },
    );
    expect(response.status).toBe(200);
    expect(calls[0]).toMatchObject({
      grant_type: "http://auth0.com/oauth/grant-type/password-realm",
      realm: "Username-Password-Authentication",
      audience: "https://api",
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("token-xyz");
    expect(await response.text()).not.toContain("token-xyz");
  });

  it("logout clears the cookie and requires the console header", async () => {
    expect(
      logout(new Request("https://web.example/api/auth/logout", { method: "POST" })).status,
    ).toBe(403);
    const cleared = logout(
      new Request("https://web.example/api/auth/logout", {
        method: "POST",
        headers: { "x-ue-console": "1" },
      }),
    );
    expect(cleared.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
