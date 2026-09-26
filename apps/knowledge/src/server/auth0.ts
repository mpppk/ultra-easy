import { Result } from "@praha/byethrow";
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type CryptoKey as JoseCryptoKey,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

import type { PrincipalRef } from "../ultra-easy/client.ts";

/**
 * Auth0 sign-in for the Knowledge app (#182): Universal Login with the
 * Authorization Code flow + PKCE (confidential client). The ID token is
 * verified server-side (RS256 / iss / aud / nonce) and only its `sub` and
 * profile claims become the session principal (`user:<sub>`, the same mapping
 * as approval-api). Nothing the browser sends names the principal or the
 * organization.
 */

/**
 * How organization membership is verified: a token claim (Auth0 Organizations
 * `org_id`, …) or an explicit opt-in that trusts the whole tenant (single
 * organization tenant with public signup disabled). Neither → fail closed.
 */
export type Auth0Membership = { type: "claim"; claim: string; value: string } | { type: "tenant" };

export type Auth0Config = {
  domain: string;
  clientId: string;
  clientSecret: string;
  membership: Auth0Membership;
};

export type Auth0ErrorCode =
  | "token_exchange_failed"
  | "invalid_id_token"
  | "organization_membership_required";

export class Auth0Error extends Error {
  constructor(readonly code: Auth0ErrorCode) {
    super(code);
    this.name = "Auth0Error";
  }
}

export type Auth0Dependencies = {
  fetch?: typeof globalThis.fetch;
  /** Verification key(s); defaults to the tenant JWKS (shared per isolate). */
  key?: JWTVerifyGetKey | JoseCryptoKey;
};

/** A required Auth0 setting is missing. */
export class Auth0ConfigError extends Error {
  constructor(readonly setting: string) {
    super(`${setting} is required`);
    this.name = "Auth0ConfigError";
  }
}

type Env = {
  AUTH0_DOMAIN?: string;
  AUTH0_CLIENT_ID?: string;
  AUTH0_CLIENT_SECRET?: string;
  AUTH0_ORGANIZATION_CLAIM?: string;
  AUTH0_ORGANIZATION_CLAIM_VALUE?: string;
  AUTH0_TENANT_IS_ORGANIZATION?: string;
};

/** Reads the Auth0 settings; a failure names the first missing one (fail closed). */
export function readAuth0Config(env: Env): Result.Result<Auth0Config, Auth0ConfigError> {
  const domain = env.AUTH0_DOMAIN?.trim();
  const clientId = env.AUTH0_CLIENT_ID?.trim();
  const clientSecret = env.AUTH0_CLIENT_SECRET?.trim();
  if (!domain) return Result.fail(new Auth0ConfigError("AUTH0_DOMAIN"));
  if (!clientId) return Result.fail(new Auth0ConfigError("AUTH0_CLIENT_ID"));
  if (!clientSecret) return Result.fail(new Auth0ConfigError("AUTH0_CLIENT_SECRET"));
  const claimValue = env.AUTH0_ORGANIZATION_CLAIM_VALUE?.trim();
  const membership: Auth0Membership | null = claimValue
    ? { type: "claim", claim: env.AUTH0_ORGANIZATION_CLAIM?.trim() || "org_id", value: claimValue }
    : env.AUTH0_TENANT_IS_ORGANIZATION === "true"
      ? { type: "tenant" }
      : null;
  if (!membership) {
    return Result.fail(
      new Auth0ConfigError("AUTH0_ORGANIZATION_CLAIM_VALUE or AUTH0_TENANT_IS_ORGANIZATION"),
    );
  }
  return Result.succeed({ domain, clientId, clientSecret, membership });
}

const keyResolvers = new Map<string, JWTVerifyGetKey>();

/** Tenant JWKS shared per isolate (jose caches keys and refetches on an unknown `kid`). */
function tenantKeys(domain: string, fetchImplementation?: typeof globalThis.fetch) {
  const cached = keyResolvers.get(domain);
  if (cached) return cached;
  const created = createRemoteJWKSet(
    new URL(`https://${domain}/.well-known/jwks.json`),
    fetchImplementation ? { [customFetch]: fetchImplementation } : undefined,
  );
  keyResolvers.set(domain, created);
  return created;
}

export class Auth0Client {
  private readonly issuer: string;

  constructor(
    readonly config: Auth0Config,
    private readonly deps: Auth0Dependencies = {},
  ) {
    this.issuer = `https://${config.domain}/`;
  }

  authorizeUrl(input: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  }): string {
    const url = new URL(`https://${this.config.domain}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: input.redirectUri,
      scope: "openid profile email",
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      // Auth0 Organizations: sign in to the organization this deployment serves.
      ...(this.config.membership.type === "claim" && this.config.membership.claim === "org_id"
        ? { organization: this.config.membership.value }
        : {}),
    }).toString();
    return url.toString();
  }

  logoutUrl(returnTo: string): string {
    const url = new URL(`https://${this.config.domain}/v2/logout`);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      returnTo,
    }).toString();
    return url.toString();
  }

  /** Exchanges the authorization code and returns the verified principal. */
  async signIn(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    nonce: string;
  }): Result.ResultAsync<PrincipalRef, Auth0Error> {
    const fetchImplementation = this.deps.fetch ?? globalThis.fetch;
    const response = await Result.try({
      try: () =>
        fetchImplementation(`https://${this.config.domain}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
            code: input.code,
            code_verifier: input.codeVerifier,
            redirect_uri: input.redirectUri,
          }),
        }),
      catch: () => new Auth0Error("token_exchange_failed"),
    });
    if (Result.isFailure(response)) return response;
    if (!response.value.ok) return Result.fail(new Auth0Error("token_exchange_failed"));
    const body = await Result.try({
      try: (): Promise<unknown> => response.value.json(),
      catch: () => new Auth0Error("token_exchange_failed"),
    });
    if (Result.isFailure(body)) return body;
    const idToken =
      typeof body.value === "object" && body.value !== null
        ? (body.value as { id_token?: unknown }).id_token
        : undefined;
    if (typeof idToken !== "string") return Result.fail(new Auth0Error("token_exchange_failed"));
    return this.verifyIdToken(idToken, input.nonce);
  }

  private async verifyIdToken(
    idToken: string,
    nonce: string,
  ): Result.ResultAsync<PrincipalRef, Auth0Error> {
    const key = this.deps.key ?? tenantKeys(this.config.domain, this.deps.fetch);
    const options = {
      issuer: this.issuer,
      audience: this.config.clientId,
      algorithms: ["RS256"],
    };
    const verified = await Result.try({
      try: (): Promise<{ payload: JWTPayload }> =>
        typeof key === "function"
          ? jwtVerify(idToken, key, options)
          : jwtVerify(idToken, key, options),
      catch: () => new Auth0Error("invalid_id_token"),
    });
    if (Result.isFailure(verified)) return verified;
    const payload = verified.value.payload;
    if (payload.nonce !== nonce || typeof payload.sub !== "string" || payload.sub.length === 0) {
      return Result.fail(new Auth0Error("invalid_id_token"));
    }
    const membership = this.config.membership;
    if (membership.type === "claim" && payload[membership.claim] !== membership.value) {
      return Result.fail(new Auth0Error("organization_membership_required"));
    }
    const displayName = [payload.name, payload.email, payload.sub].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    return Result.succeed({
      id: `user:${payload.sub}`,
      displayName: (displayName ?? payload.sub).slice(0, 128),
    });
  }
}
