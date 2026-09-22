import { Result } from "@praha/byethrow";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { assert, describe, expect, it } from "vite-plus/test";

import type { OrganizationId } from "@app/approval-core";

import { Auth0IdentityProvider } from "./auth0-identity.ts";

const organizationId = "organization:staging" as OrganizationId;
const domain = "dev-67c6cfj2y51bmeyf.us.auth0.com";
const audience = "https://ultra-easy/approval-api";

async function harness() {
  const pair = await generateKeyPair("RS256");
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key" };
  const provider = new Auth0IdentityProvider(
    { domain, audience, organizationId },
    createLocalJWKSet({ keys: [publicJwk] }),
  );
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT({ ...claims })
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
  it("有効なJWTのsubをUserIdへ写像する", async () => {
    const { provider, sign } = await harness();
    const token = await sign({ sub: "auth0|staging-alice" });
    const user = await provider.resolveUser({
      request: requestWith(token),
      organizationId,
    });
    assert(Result.isSuccess(user));
    expect(user.value).toBe("user:auth0|staging-alice");
  });

  it("tokenなし・不正token・別組織を拒否する", async () => {
    const { provider, sign } = await harness();
    const missing = await provider.resolveUser({ request: requestWith(null), organizationId });
    expect(Result.isFailure(missing)).toBe(true);

    const broken = await provider.resolveUser({
      request: requestWith("not-a-jwt"),
      organizationId,
    });
    expect(Result.isFailure(broken)).toBe(true);
    if (Result.isFailure(broken)) expect(broken.error.status).toBe(401);

    const token = await sign({ sub: "auth0|staging-alice" });
    const other = await provider.resolveUser({
      request: requestWith(token),
      organizationId: "organization:other" as OrganizationId,
    });
    expect(Result.isFailure(other)).toBe(true);
    if (Result.isFailure(other)) expect(other.error.status).toBe(403);
  });
});
