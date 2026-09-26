import { Result } from "@praha/byethrow";
import { generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { assert, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { migratedKnowledgeD1, sqliteD1WithMigrations } from "@app/knowledge-d1/testing";

import type { MeView } from "../shared/api.ts";
import { handleKnowledgeApi } from "./api.ts";
import {
  createRuntime,
  type KnowledgeEnv,
  type KnowledgeRuntime,
  type RuntimeConfigError,
} from "./runtime.ts";

const MOCK_MIGRATIONS = new URL("../../ultra-easy-mock/migrations/", import.meta.url);
const ORIGIN = "https://knowledge.test";
const DOMAIN = "tenant.auth0.test";
const CLIENT_ID = "knowledge-client";

let signingKey: CryptoKey;
let verifyKey: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  verifyKey = pair.publicKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
});

const AUTH0_ENV = {
  KNOWLEDGE_AUTH_MODE: "auth0",
  SESSION_SECRET: "s".repeat(40),
  KNOWLEDGE_MCP_TOKEN: "mcp-token",
  AUTH0_DOMAIN: DOMAIN,
  AUTH0_CLIENT_ID: CLIENT_ID,
  AUTH0_CLIENT_SECRET: "client-secret",
  AUTH0_TENANT_IS_ORGANIZATION: "true",
} satisfies Partial<KnowledgeEnv>;

type TokenRequest = Record<string, string>;
let tokenRequests: TokenRequest[];
let idToken: (nonce: string) => Promise<string>;
let tokenStatus: number;

function runtimeWith(
  env: Partial<KnowledgeEnv>,
): Result.Result<KnowledgeRuntime, RuntimeConfigError> {
  return createRuntime(
    {
      KNOWLEDGE_DB: migratedKnowledgeD1(),
      ULTRA_EASY_MOCK_DB: sqliteD1WithMigrations(MOCK_MIGRATIONS),
      ...env,
    },
    {
      auth0: {
        key: verifyKey,
        fetch: async (input, init) => {
          expect(input instanceof Request ? input.url : input.toString()).toBe(
            `https://${DOMAIN}/oauth/token`,
          );
          assert(init?.body instanceof URLSearchParams);
          const body = Object.fromEntries(init.body);
          tokenRequests.push(body);
          if (tokenStatus !== 200) return new Response("{}", { status: tokenStatus });
          return Response.json({ id_token: await idToken(currentNonce) });
        },
      },
    },
  );
}

let currentNonce = "";
let runtime: KnowledgeRuntime;

function sign(claims: Record<string, unknown>, options: { key?: CryptoKey } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(`https://${DOMAIN}/`)
    .setAudience(CLIENT_ID)
    .setSubject("auth0|alice")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(options.key ?? signingKey);
}

beforeEach(() => {
  tokenRequests = [];
  tokenStatus = 200;
  idToken = (nonce) => sign({ nonce, name: "Alice Auth0", email: "alice@example.com" });
  const created = runtimeWith(AUTH0_ENV);
  assert(Result.isSuccess(created));
  runtime = created.value;
});

function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("x-knowledge-client", "1");
  return handleKnowledgeApi(new Request(`${ORIGIN}${path}`, { ...init, headers }), runtime);
}

function cookies(response: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const [pair = ""] = header.split(";");
    const [name = "", ...value] = pair.split("=");
    jar.set(name, value.join("="));
  }
  return jar;
}

async function startLogin(returnTo = "/spaces") {
  const response = await call(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  expect(response.status).toBe(302);
  const authorize = new URL(response.headers.get("location") ?? "");
  const transaction = cookies(response).get("ue_knowledge_auth") ?? "";
  currentNonce = authorize.searchParams.get("nonce") ?? "";
  return { authorize, transaction };
}

async function completeLogin(returnTo = "/spaces") {
  const { authorize, transaction } = await startLogin(returnTo);
  const state = authorize.searchParams.get("state") ?? "";
  return call(`/api/auth/callback?code=code-1&state=${state}`, {
    cookie: `ue_knowledge_auth=${transaction}`,
  });
}

describe("Auth0 sign-in (#182)", () => {
  it("redirects to Universal Login with state, nonce and PKCE", async () => {
    const { authorize, transaction } = await startLogin();
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`https://${DOMAIN}/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: `${ORIGIN}/api/auth/callback`,
      scope: "openid profile email",
      code_challenge_method: "S256",
    });
    expect(authorize.searchParams.get("state")?.length).toBeGreaterThan(20);
    expect(authorize.searchParams.get("code_challenge")?.length).toBeGreaterThan(20);
    expect(transaction.length).toBeGreaterThan(20);
  });

  it("signs in from the verified ID token only and returns to the requested page", async () => {
    const callback = await completeLogin("/spaces/engineering");
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/spaces/engineering");
    const jar = cookies(callback);
    expect(jar.get("ue_knowledge_auth")).toBe("");
    const session = jar.get("ue_knowledge_session") ?? "";
    expect(session.length).toBeGreaterThan(20);
    expect(callback.headers.getSetCookie().join("\n")).toContain(
      "HttpOnly; Secure; SameSite=Strict",
    );

    // PKCE verifier + confidential client + the same redirect_uri go to the token endpoint.
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]).toMatchObject({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: "client-secret",
      code: "code-1",
      redirect_uri: `${ORIGIN}/api/auth/callback`,
    });
    expect(tokenRequests[0]?.code_verifier?.length).toBeGreaterThan(40);

    const me = await call("/api/me", { cookie: `ue_knowledge_session=${session}` });
    expect(me.status).toBe(200);
    const body = (await me.json()) as MeView;
    expect(body.principal).toEqual({ id: "user:auth0|alice", displayName: "Alice Auth0" });
    expect(body.organizationId).toBe("org_acme");
    // No principal switcher / demo faults outside demo mode.
    expect(body.demo).toBeNull();

    // A fresh Auth0 user can create a space and becomes its owner through ultra-easy.
    const created = await call("/api/spaces", {
      method: "POST",
      cookie: `ue_knowledge_session=${session}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "alice", name: "Alice", description: "" }),
    });
    expect(created.status).toBe(201);
  });

  it("never redirects off-site after sign-in", async () => {
    for (const returnTo of ["//evil.test/x", "https://evil.test", "/\\evil.test", "/api/me"]) {
      const callback = await completeLogin(returnTo);
      expect(callback.headers.get("location")).toBe("/");
    }
  });

  it("rejects a callback whose state does not match this browser's transaction", async () => {
    const { transaction } = await startLogin();
    const forged = await call("/api/auth/callback?code=code-1&state=forged", {
      cookie: `ue_knowledge_auth=${transaction}`,
    });
    expect(forged.headers.get("location")).toBe("/login?error=invalid_state");
    const { authorize } = await startLogin();
    const noCookie = await call(
      `/api/auth/callback?code=code-1&state=${authorize.searchParams.get("state")}`,
    );
    expect(noCookie.headers.get("location")).toBe("/login?error=invalid_state");
    expect(tokenRequests).toHaveLength(0);
  });

  it("maps Auth0 errors without calling the token endpoint", async () => {
    const { authorize, transaction } = await startLogin();
    const denied = await call(
      `/api/auth/callback?error=access_denied&state=${authorize.searchParams.get("state")}`,
      { cookie: `ue_knowledge_auth=${transaction}` },
    );
    expect(denied.headers.get("location")).toBe("/login?error=access_denied");
    expect(tokenRequests).toHaveLength(0);
  });

  it.each([
    ["wrong nonce", () => sign({ nonce: "other" })],
    ["wrong signing key", () => sign({ nonce: currentNonce }, { key: otherKey })],
    [
      "wrong audience",
      () =>
        new SignJWT({ nonce: currentNonce })
          .setProtectedHeader({ alg: "RS256" })
          .setIssuer(`https://${DOMAIN}/`)
          .setAudience("someone-else")
          .setSubject("auth0|alice")
          .setExpirationTime("5m")
          .sign(signingKey),
    ],
  ])("rejects an ID token with a %s", async (_label, token) => {
    idToken = () => token();
    const callback = await completeLogin();
    expect(callback.headers.get("location")).toBe("/login?error=invalid_id_token");
    expect(cookies(callback).has("ue_knowledge_session")).toBe(false);
  });

  it("reports a failed code exchange", async () => {
    tokenStatus = 403;
    const callback = await completeLogin();
    expect(callback.headers.get("location")).toBe("/login?error=token_exchange_failed");
  });

  it("requires the organization claim when membership is claim-based", async () => {
    const created = runtimeWith({
      ...AUTH0_ENV,
      AUTH0_TENANT_IS_ORGANIZATION: undefined,
      AUTH0_ORGANIZATION_CLAIM_VALUE: "org_123",
    });
    assert(Result.isSuccess(created));
    runtime = created.value;
    const { authorize } = await startLogin();
    expect(authorize.searchParams.get("organization")).toBe("org_123");
    idToken = (nonce) => sign({ nonce, org_id: "org_other" });
    expect((await completeLogin()).headers.get("location")).toBe(
      "/login?error=organization_membership_required",
    );
    idToken = (nonce) => sign({ nonce, org_id: "org_123" });
    expect((await completeLogin()).headers.get("location")).toBe("/spaces");
  });

  it("signs out of the app and Auth0", async () => {
    const response = await call("/api/auth/logout", { method: "POST" });
    expect(response.status).toBe(200);
    expect(cookies(response).get("ue_knowledge_session")).toBe("");
    const { redirectTo } = (await response.json()) as { redirectTo: string };
    const logout = new URL(redirectTo);
    expect(`${logout.origin}${logout.pathname}`).toBe(`https://${DOMAIN}/v2/logout`);
    expect(logout.searchParams.get("returnTo")).toBe(`${ORIGIN}/login`);
    // Cross-site form posts cannot carry the client header.
    const forged = await handleKnowledgeApi(
      new Request(`${ORIGIN}/api/auth/logout`, { method: "POST" }),
      runtime,
    );
    expect(forged.status).toBe(403);
  });

  it("returns 404 for every demo endpoint and seeds no fixture principals", async () => {
    expect(await (await call("/api/auth/config")).json()).toEqual({ mode: "auth0" });
    expect((await call("/api/demo/principals")).status).toBe(404);
    expect(
      (
        await call("/api/demo/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ principalId: "user:yuki" }),
        })
      ).status,
    ).toBe(404);
    expect((await call("/api/demo/session", { method: "DELETE" })).status).toBe(404);
    const session = cookies(await completeLogin()).get("ue_knowledge_session") ?? "";
    const faults = await call("/api/demo/faults", {
      method: "POST",
      cookie: `ue_knowledge_session=${session}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notifier: true }),
    });
    expect(faults.status).toBe(404);
    const principals = await runtime.ultraEasy.listPrincipals(runtime.organizationId);
    assert(Result.isSuccess(principals));
    expect(principals.value.map((principal) => principal.id)).toEqual(["user:auth0|alice"]);
  });

  it("the Auth0 endpoints do not exist in demo mode", async () => {
    const created = runtimeWith({ KNOWLEDGE_AUTH_MODE: "demo" });
    assert(Result.isSuccess(created));
    runtime = created.value;
    expect(await (await call("/api/auth/config")).json()).toEqual({ mode: "demo" });
    expect((await call("/api/auth/login")).status).toBe(404);
    expect((await call("/api/auth/callback?code=x&state=y")).status).toBe(404);
  });
});

describe("runtime configuration fails closed (#182)", () => {
  it.each([
    [{ KNOWLEDGE_AUTH_MODE: undefined }, "KNOWLEDGE_AUTH_MODE"],
    [{ KNOWLEDGE_AUTH_MODE: "oidc" }, "KNOWLEDGE_AUTH_MODE"],
    [{ SESSION_SECRET: undefined }, "SESSION_SECRET"],
    [{ SESSION_SECRET: "short" }, "SESSION_SECRET"],
    [{ KNOWLEDGE_MCP_TOKEN: "" }, "KNOWLEDGE_MCP_TOKEN"],
    [{ AUTH0_DOMAIN: undefined }, "AUTH0_DOMAIN"],
    [{ AUTH0_CLIENT_ID: undefined }, "AUTH0_CLIENT_ID"],
    [{ AUTH0_CLIENT_SECRET: undefined }, "AUTH0_CLIENT_SECRET"],
    [{ AUTH0_TENANT_IS_ORGANIZATION: undefined }, "AUTH0_ORGANIZATION_CLAIM_VALUE"],
  ])("rejects %o", (override, message) => {
    const created = runtimeWith({ ...AUTH0_ENV, ...override });
    assert(Result.isFailure(created));
    expect(created.error.message).toContain(message);
  });
});
