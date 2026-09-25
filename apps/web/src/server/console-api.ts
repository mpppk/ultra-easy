import {
  clearSessionCookie,
  openSession,
  readCookie,
  sealSession,
  SESSION_COOKIE,
  sessionCookie,
} from "./session.ts";

type ServiceBinding = { fetch(request: Request): Promise<Response> };

export type ConsoleWebEnv = {
  APPROVAL_API?: ServiceBinding;
  AUTH0_DOMAIN?: string;
  AUTH0_API_AUDIENCE?: string;
  AUTH0_WEB_CLIENT_ID?: string;
  AUTH0_WEB_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  /** Staging-only username/password login (Auth0 password-realm grant). */
  STAGING_PASSWORD_LOGIN?: string;
  AUTH0_PASSWORD_REALM?: string;
};

/** Header required on console POSTs (cannot be set cross-site without CORS preflight). */
export const CSRF_HEADER = "x-ue-console";

const API_ORIGIN = "https://approval-api.internal";
const ADMIN_PREFIX = "/api/admin/authorization";
const RELATIONSHIP_ACTION_TYPE = "authorization.relationship.update";

function problem(status: number, code: string, title: string, headers?: HeadersInit): Response {
  const merged = new Headers(headers);
  merged.set("content-type", "application/problem+json");
  merged.set("cache-control", "no-store");
  return new Response(JSON.stringify({ status, code, title }), { status, headers: merged });
}

async function passthrough(response: Response): Promise<Response> {
  const headers = new Headers();
  headers.set("content-type", response.headers.get("content-type") ?? "application/json");
  headers.set("cache-control", "no-store");
  return new Response(await response.text(), { status: response.status, headers });
}

async function accessToken(request: Request, env: ConsoleWebEnv): Promise<string | null> {
  const cookie = readCookie(request, SESSION_COOKIE);
  if (!cookie || !env.SESSION_SECRET) return null;
  return (await openSession(cookie, env.SESSION_SECRET))?.accessToken ?? null;
}

function csrfOk(request: Request): boolean {
  return request.headers.get(CSRF_HEADER) === "1";
}

function upstream(env: ConsoleWebEnv, path: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  const binding = env.APPROVAL_API;
  if (!binding)
    return Promise.resolve(problem(503, "approval_api_unavailable", "API binding missing"));
  return binding.fetch(new Request(`${API_ORIGIN}${path}`, { ...init, headers }));
}

/** GET/POST /api/admin/authorization/* → approval-api /v1/admin/authorization/* */
export async function proxyAdminRequest(request: Request, env: ConsoleWebEnv): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${ADMIN_PREFIX}/`)) return problem(404, "not_found", "Not Found");
  if (request.method !== "GET" && request.method !== "POST") {
    return problem(405, "method_not_allowed", "Method Not Allowed");
  }
  if (request.method === "POST" && !csrfOk(request)) {
    return problem(403, "csrf_header_required", "Console header required");
  }
  const token = await accessToken(request, env);
  if (!token) return problem(401, "session_required", "Sign in required");
  const path = `/v1/admin/authorization${url.pathname.slice(ADMIN_PREFIX.length)}${url.search}`;
  const response = await upstream(env, path, token, {
    method: request.method,
    ...(request.method === "POST"
      ? { body: await request.text(), headers: { "content-type": "application/json" } }
      : {}),
  });
  return passthrough(response);
}

async function organizationId(env: ConsoleWebEnv, token: string): Promise<string | Response> {
  const session = await upstream(env, "/v1/admin/authorization/session", token);
  if (!session.ok) return passthrough(session);
  const body = (await session.json().catch(() => null)) as { organizationId?: unknown } | null;
  return typeof body?.organizationId === "string"
    ? body.organizationId
    : problem(502, "invalid_session_response", "Invalid session");
}

/**
 * POST /api/action-requests — the console only creates governed
 * `authorization.relationship.update` ActionRequests. The organization is
 * resolved server-side from the caller's identity.
 */
export async function proxyCreateActionRequest(
  request: Request,
  env: ConsoleWebEnv,
): Promise<Response> {
  if (request.method !== "POST") return problem(405, "method_not_allowed", "Method Not Allowed");
  if (!csrfOk(request)) return problem(403, "csrf_header_required", "Console header required");
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) return problem(400, "invalid_idempotency_key", "Idempotency-Key required");
  const token = await accessToken(request, env);
  if (!token) return problem(401, "session_required", "Sign in required");
  const body = (await request.json().catch(() => null)) as { action?: { type?: unknown } } | null;
  if (body?.action?.type !== RELATIONSHIP_ACTION_TYPE) {
    return problem(400, "unsupported_console_action", "Console only submits relationship updates");
  }
  const org = await organizationId(env, token);
  if (org instanceof Response) return org;
  return passthrough(
    await upstream(env, `/v1/organizations/${encodeURIComponent(org)}/action-requests`, token, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(body),
    }),
  );
}

/** GET /api/action-requests/:id — status of a console-submitted ActionRequest. */
export async function proxyGetActionRequest(
  request: Request,
  env: ConsoleWebEnv,
  actionRequestId: string,
): Promise<Response> {
  const token = await accessToken(request, env);
  if (!token) return problem(401, "session_required", "Sign in required");
  const org = await organizationId(env, token);
  if (org instanceof Response) return org;
  return passthrough(
    await upstream(
      env,
      `/v1/organizations/${encodeURIComponent(org)}/action-requests/${encodeURIComponent(actionRequestId)}`,
      token,
    ),
  );
}

/** Staging password login. Disabled unless STAGING_PASSWORD_LOGIN=true. */
export async function login(
  request: Request,
  env: ConsoleWebEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (env.STAGING_PASSWORD_LOGIN !== "true") return problem(404, "not_found", "Not Found");
  if (request.method !== "POST") return problem(405, "method_not_allowed", "Method Not Allowed");
  if (!csrfOk(request)) return problem(403, "csrf_header_required", "Console header required");
  if (
    !env.AUTH0_DOMAIN ||
    !env.AUTH0_API_AUDIENCE ||
    !env.AUTH0_WEB_CLIENT_ID ||
    !env.AUTH0_WEB_CLIENT_SECRET ||
    !env.SESSION_SECRET
  ) {
    return problem(503, "login_not_configured", "Login is not configured");
  }
  const body = (await request.json().catch(() => null)) as {
    username?: unknown;
    password?: unknown;
  } | null;
  if (typeof body?.username !== "string" || typeof body.password !== "string") {
    return problem(400, "invalid_login", "username and password are required");
  }
  const response = await fetchImpl(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "http://auth0.com/oauth/grant-type/password-realm",
      realm: env.AUTH0_PASSWORD_REALM ?? "Username-Password-Authentication",
      username: body.username,
      password: body.password,
      client_id: env.AUTH0_WEB_CLIENT_ID,
      client_secret: env.AUTH0_WEB_CLIENT_SECRET,
      audience: env.AUTH0_API_AUDIENCE,
      // approval-apiは操作ごとにscopeを検証する（#82）。consoleはsubmit / readを行う。
      scope: "openid read:action-requests write:action-requests",
    }),
  }).catch(() => null);
  if (!response?.ok) return problem(401, "login_failed", "Sign in failed");
  const token = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
  } | null;
  if (typeof token?.access_token !== "string")
    return problem(401, "login_failed", "Sign in failed");
  const ttl = typeof token.expires_in === "number" ? Math.min(token.expires_in, 8 * 3600) : 3600;
  const sealed = await sealSession(
    { accessToken: token.access_token, expiresAt: Date.now() + ttl * 1000 },
    env.SESSION_SECRET,
  );
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "set-cookie": sessionCookie(sealed, ttl),
    },
  });
}

export function logout(request: Request): Response {
  if (request.method !== "POST" || !csrfOk(request)) {
    return problem(403, "csrf_header_required", "Console header required");
  }
  return new Response(null, { status: 204, headers: { "set-cookie": clearSessionCookie() } });
}
