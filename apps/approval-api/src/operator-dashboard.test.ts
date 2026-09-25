import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import {
  HttpTrustedContextError,
  type AuthorizationAdminAccessChecker,
  type AuthorizationAdminCallerResolver,
} from "@app/approval-application";
import { AuthorizationProviderError, type OrganizationId, type UserId } from "@app/approval-core";

import { handleOperatorDashboard } from "./operator-dashboard.ts";

const organizationId = "organization:staging" as OrganizationId;

function harness(input: { viewers?: string[]; checkFails?: boolean } = {}) {
  const loaded: OrganizationId[] = [];
  const callerResolver: AuthorizationAdminCallerResolver = {
    async resolve(request) {
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      if (!token) {
        return Result.fail(new HttpTrustedContextError(401, "bearer_token_missing", "missing"));
      }
      return Result.succeed({
        organizationId,
        principal: { type: "user", id: `user:${token}` as UserId },
      });
    },
  };
  const accessChecker: AuthorizationAdminAccessChecker = {
    async check({ caller }) {
      if (input.checkFails) {
        return Result.fail(
          new AuthorizationProviderError({
            provider: "openfga",
            code: "fga_unavailable",
            retriable: true,
            detail: "secret internal detail",
          }),
        );
      }
      return Result.succeed((input.viewers ?? []).includes(String(caller.principal.id)));
    },
  };
  const fetch = (query: string, token?: string) =>
    handleOperatorDashboard({
      request: new Request(`https://api.test/operator/dashboard${query}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
      callerResolver,
      accessChecker,
      async load(org) {
        loaded.push(org);
        return Result.succeed({ organizationId: org });
      },
    });
  return { fetch, loaded };
}

describe("#81 operator dashboard", () => {
  it("未認証は401、operator権限なしは403、他orgの指定は403で、snapshotを読まない", async () => {
    const { fetch, loaded } = harness({ viewers: ["user:operator"] });
    expect((await fetch("")).status).toBe(401);

    const denied = await fetch("", "mallory");
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ code: "operator_access_denied" });

    const crossOrg = await fetch("?organizationId=organization%3Aother", "operator");
    expect(crossOrg.status).toBe(403);
    await expect(crossOrg.json()).resolves.toMatchObject({ code: "organization_mismatch" });
    expect(loaded).toEqual([]);
  });

  it("operatorは自組織のsnapshotだけを取得できる", async () => {
    const { fetch, loaded } = harness({ viewers: ["user:operator"] });
    const own = await fetch("?organizationId=organization%3Astaging", "operator");
    expect(own.status).toBe(200);
    await expect(own.json()).resolves.toEqual({ organizationId });
    const implicit = await fetch("", "operator");
    expect(implicit.status).toBe(200);
    expect(loaded).toEqual([organizationId, organizationId]);
  });

  it("権限確認の障害はfail closedで503にし、内部messageを返さない", async () => {
    const { fetch } = harness({ checkFails: true });
    const response = await fetch("", "operator");
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("operator_access_check_failed");
    expect(body).not.toContain("secret internal detail");
  });
});
