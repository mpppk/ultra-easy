import { Result } from "@praha/byethrow";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { assert, describe, expect, it } from "vite-plus/test";

import type { OrganizationId } from "@app/approval-core";

import {
  Auth0IdentityProvider,
  auth0KeyResolver,
  readAuth0OrganizationMembership,
  type Auth0OrganizationMembership,
} from "./auth0-identity.ts";

const organizationId = "organization:staging" as OrganizationId;
const domain = "dev-67c6cfj2y51bmeyf.us.auth0.com";
const audience = "https://ultra-easy/approval-api";
const allScopes = "openid read:action-requests write:action-requests";

async function harness(membership: Auth0OrganizationMembership | null = { type: "tenant" }) {
  const pair = await generateKeyPair("RS256");
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key" };
  const provider = new Auth0IdentityProvider(
    { domain, audience, organizationId, ...(membership ? { membership } : {}) },
    createLocalJWKSet({ keys: [publicJwk] }),
  );
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT({ scope: allScopes, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(`https://${domain}/`)
      .setAudience(audience)
      .setExpirationTime(new Date("2030-01-01T00:00:00Z"))
      .sign(pair.privateKey);
  return { provider, sign };
}

function requestWith(token: string | null): Request {
  return new Request("https://api.internal/v1/organizations/organization:staging/action-requests", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("Auth0IdentityProvider", () => {
  it("有効なuser JWTのsubをuser principalへ写像する", async () => {
    const { provider, sign } = await harness();
    const token = await sign({ sub: "auth0|staging-alice", gty: "password" });
    const principal = await provider.authenticate({
      request: requestWith(token),
      organizationId,
      operation: "action_request.read",
    });
    assert(Result.isSuccess(principal));
    expect(principal.value).toEqual({ type: "user", id: "user:auth0|staging-alice" });
  });

  it("tokenなし・不正token・別組織を拒否する", async () => {
    const { provider, sign } = await harness();
    const operation = "action_request.read" as const;
    const missing = await provider.authenticate({
      request: requestWith(null),
      organizationId,
      operation,
    });
    expect(Result.isFailure(missing)).toBe(true);

    const broken = await provider.authenticate({
      request: requestWith("not-a-jwt"),
      organizationId,
      operation,
    });
    assert(Result.isFailure(broken));
    expect(broken.error.status).toBe(401);

    const token = await sign({ sub: "auth0|staging-alice" });
    const other = await provider.authenticate({
      request: requestWith(token),
      organizationId: "organization:other" as OrganizationId,
      operation,
    });
    assert(Result.isFailure(other));
    expect(other.error.status).toBe(403);
  });

  it("#82: org claimが一致しないtoken・membership未設定のdeploymentを拒否する", async () => {
    const membership = { type: "claim" as const, claim: "org_id", value: "org_staging" };
    const { provider, sign } = await harness(membership);
    const input = (token: string) => ({
      request: requestWith(token),
      organizationId,
      operation: "action_request.read" as const,
    });

    const member = await provider.authenticate(
      input(await sign({ sub: "auth0|alice", org_id: "org_staging" })),
    );
    assert(Result.isSuccess(member));

    for (const claims of [{ org_id: "org_other" }, {}]) {
      const rejected = await provider.authenticate(
        input(await sign({ sub: "auth0|mallory", ...claims })),
      );
      assert(Result.isFailure(rejected));
      expect(rejected.error).toMatchObject({
        status: 403,
        code: "organization_membership_required",
      });
    }

    const unconfigured = await harness(null);
    const failClosed = await unconfigured.provider.authenticate({
      request: requestWith(await unconfigured.sign({ sub: "auth0|alice" })),
      organizationId,
      operation: "action_request.read",
    });
    assert(Result.isFailure(failClosed));
    expect(failClosed.error).toMatchObject({
      status: 403,
      code: "organization_membership_unverified",
    });
  });

  it("#82: 操作に必要なscope / permissionsが無ければ403にする", async () => {
    const { provider, sign } = await harness();
    const readOnly = await sign({ sub: "auth0|alice", scope: "openid read:action-requests" });
    const read = await provider.authenticate({
      request: requestWith(readOnly),
      organizationId,
      operation: "action_request.read",
    });
    expect(Result.isSuccess(read)).toBe(true);
    for (const operation of ["action_request.submit", "approval_decision.submit"] as const) {
      const write = await provider.authenticate({
        request: requestWith(readOnly),
        organizationId,
        operation,
      });
      assert(Result.isFailure(write));
      expect(write.error).toMatchObject({ status: 403, code: "insufficient_scope" });
    }

    const rbac = await sign({
      sub: "auth0|alice",
      scope: "openid",
      permissions: ["write:action-requests"],
    });
    const submit = await provider.authenticate({
      request: requestWith(rbac),
      organizationId,
      operation: "action_request.submit",
    });
    expect(Result.isSuccess(submit)).toBe(true);
  });

  it("#82: client credentials tokenをagent principalへ写像し、未知のtoken種別を拒否する", async () => {
    const { provider, sign } = await harness();
    const machine = await provider.authenticate({
      request: requestWith(
        await sign({
          sub: "ci-client@clients",
          azp: "ci-client",
          gty: "client-credentials",
          scope: "read:action-requests",
        }),
      ),
      organizationId,
      operation: "action_request.read",
    });
    assert(Result.isSuccess(machine));
    expect(machine.value).toEqual({ type: "agent", id: "agent:ci-client" });

    for (const claims of [
      { sub: "auth0|alice", gty: "device_code" },
      { sub: "ci-client@clients", gty: "password" },
      { sub: "auth0|alice", gty: "client-credentials" },
    ]) {
      const rejected = await provider.authenticate({
        request: requestWith(await sign(claims)),
        organizationId,
        operation: "action_request.read",
      });
      assert(Result.isFailure(rejected));
      expect(rejected.error).toMatchObject({ status: 401, code: "unsupported_token_type" });
    }
  });

  it("admin caller: organization comes from deployment config; machine tokens are rejected", async () => {
    const { provider, sign } = await harness();
    const human = await provider.resolve(requestWith(await sign({ sub: "auth0|staging-alice" })));
    assert(Result.isSuccess(human));
    expect(human.value).toEqual({
      organizationId,
      principal: { type: "user", id: "user:auth0|staging-alice" },
    });

    const machine = await provider.resolve(
      requestWith(await sign({ sub: "client-1@clients", gty: "client-credentials" })),
    );
    assert(Result.isFailure(machine));
    expect(machine.error).toMatchObject({ status: 403, code: "machine_principal_not_allowed" });

    const anonymous = await provider.resolve(requestWith(null));
    assert(Result.isFailure(anonymous));
    expect(anonymous.error.status).toBe(401);
  });

  it("membership設定はclaim値を優先し、tenant信頼は明示opt-inのときだけ有効にする", () => {
    expect(readAuth0OrganizationMembership({})).toBeUndefined();
    expect(
      readAuth0OrganizationMembership({ AUTH0_TENANT_IS_ORGANIZATION: "yes" }),
    ).toBeUndefined();
    expect(readAuth0OrganizationMembership({ AUTH0_TENANT_IS_ORGANIZATION: "true" })).toEqual({
      type: "tenant",
    });
    expect(
      readAuth0OrganizationMembership({
        AUTH0_ORGANIZATION_CLAIM_VALUE: "org_1",
        AUTH0_TENANT_IS_ORGANIZATION: "true",
      }),
    ).toEqual({ type: "claim", claim: "org_id", value: "org_1" });
    expect(
      readAuth0OrganizationMembership({
        AUTH0_ORGANIZATION_CLAIM: "https://ultra-easy/org",
        AUTH0_ORGANIZATION_CLAIM_VALUE: "organization:staging",
      }),
    ).toEqual({ type: "claim", claim: "https://ultra-easy/org", value: "organization:staging" });
  });
});

describe("auth0KeyResolver (#90)", () => {
  it("同一isolateの連続したリクエストでJWKS取得は1回だけ", async () => {
    const isolateDomain = "jwks-cache.example.auth0.com";
    const pair = await generateKeyPair("RS256");
    const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "cache-key", alg: "RS256" };
    let jwksFetches = 0;
    auth0KeyResolver(isolateDomain, (async () => {
      jwksFetches += 1;
      return Response.json({ keys: [publicJwk] });
    }) as typeof globalThis.fetch);

    const token = await new SignJWT({ scope: allScopes, sub: "auth0|alice", gty: "password" })
      .setProtectedHeader({ alg: "RS256", kid: "cache-key" })
      .setIssuer(`https://${isolateDomain}/`)
      .setAudience(audience)
      .setExpirationTime(new Date("2030-01-01T00:00:00Z"))
      .sign(pair.privateKey);

    // buildApiはリクエストごとにproviderを作る。resolverはdomain単位で共有される。
    for (let request = 0; request < 3; request += 1) {
      const provider = new Auth0IdentityProvider({
        domain: isolateDomain,
        audience,
        organizationId,
        membership: { type: "tenant" },
      });
      const principal = await provider.authenticate({
        request: requestWith(token),
        organizationId,
        operation: "action_request.read",
      });
      assert(Result.isSuccess(principal));
    }
    expect(jwksFetches).toBe(1);
    expect(auth0KeyResolver(isolateDomain)).toBe(auth0KeyResolver(isolateDomain));
  });
});
