import { Result } from "@praha/byethrow";

import { parseBrand, type OrganizationId, type UserId } from "@app/approval-core";

import { matchHttpRoute } from "./http-access-log.ts";
import type {
  ApplicationRelationshipReadRepository,
  SpaceMemberCursor,
  SpaceRoleCursor,
} from "./application-relationship.ts";
import { authenticatePublicApi, type PublicHttpIdentityProvider } from "./public-http.ts";

export const PUBLIC_APPLICATION_RELATIONSHIP_ROUTES = [
  "/v1/organizations/{organizationId}/me/space-roles",
  "/v1/organizations/{organizationId}/spaces/{spaceId}/members",
] as const;

export interface SpaceRelationshipAccessChecker {
  canManage(input: {
    organizationId: OrganizationId;
    spaceId: string;
    userId: UserId;
  }): Result.ResultAsync<boolean, { code: string; retriable: boolean }>;
}

function problem(status: number, code: string, title: string): Response {
  return Response.json(
    { type: `urn:ultra-easy:problem:${code}`, title, status, code },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

const parseJson = Result.fn({
  try: (value: string): unknown => JSON.parse(value),
  catch: () => new Error("invalid cursor"),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRole(value: unknown): value is "viewer" | "editor" | "owner" {
  return value === "viewer" || value === "editor" || value === "owner";
}

function cursorFrom(
  value: string | null,
  kind: "roles" | "members",
): SpaceRoleCursor | SpaceMemberCursor | null | Response {
  if (value === null) return null;
  if (value.length > 512) return problem(400, "invalid_cursor", "cursorが不正です");
  const parsed = parseJson(value);
  if (Result.isFailure(parsed) || !isRecord(parsed.value))
    return problem(400, "invalid_cursor", "cursorが不正です");
  const entry = parsed.value;
  if (!validRole(entry["relation"])) return problem(400, "invalid_cursor", "cursorが不正です");
  if (kind === "roles") {
    if (typeof entry["object"] !== "string" || !entry["object"].startsWith("knowledge_space:"))
      return problem(400, "invalid_cursor", "cursorが不正です");
    return { object: entry["object"], relation: entry["relation"] };
  }
  if (typeof entry["subject"] !== "string" || !entry["subject"].startsWith("user:"))
    return problem(400, "invalid_cursor", "cursorが不正です");
  return { subject: entry["subject"], relation: entry["relation"] };
}

export function createPublicApplicationRelationshipApi(input: {
  repository: ApplicationRelationshipReadRepository;
  identityProvider: PublicHttpIdentityProvider;
  accessChecker: SpaceRelationshipAccessChecker;
  applicationAgentId?: string;
}): { handles(request: Request): boolean; fetch(request: Request): Promise<Response> } {
  return {
    handles(request) {
      return (
        request.method === "GET" &&
        matchHttpRoute(PUBLIC_APPLICATION_RELATIONSHIP_ROUTES, new URL(request.url).pathname) !==
          null
      );
    },
    async fetch(request) {
      const url = new URL(request.url);
      const matched = matchHttpRoute(PUBLIC_APPLICATION_RELATIONSHIP_ROUTES, url.pathname);
      if (!matched || request.method !== "GET")
        return problem(404, "route_not_found", "Route not found");
      const organization = parseBrand("OrganizationId", matched.parameters["organizationId"]);
      if (Result.isFailure(organization))
        return problem(400, "invalid_organization_id", "Organization IDが不正です");
      const organizationId = organization.value;
      const principal = await authenticatePublicApi({
        identityProvider: input.identityProvider,
        request,
        organizationId,
        operation: "application_relationship.read",
      });
      if (principal instanceof Response) return principal;
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? 100 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return problem(400, "invalid_limit", "limitが不正です");

      const isRoles = matched.route.endsWith("/space-roles");
      const cursor = cursorFrom(url.searchParams.get("cursor"), isRoles ? "roles" : "members");
      if (cursor instanceof Response) return cursor;
      if (isRoles) {
        if (principal.type !== "user")
          return problem(403, "machine_principal_not_allowed", "User principalが必要です");
        const listed = await input.repository.roles({
          organizationId,
          subject: principal.id,
          ...(cursor ? { after: cursor as SpaceRoleCursor } : {}),
          limit: limit + 1,
        });
        if (Result.isFailure(listed))
          return problem(
            listed.error.retriable ? 503 : 500,
            listed.error.code,
            "Roleを取得できません",
          );
        const items = listed.value.slice(0, limit);
        const last = items.at(-1);
        return Response.json({
          items,
          ...(listed.value.length > limit && last
            ? {
                nextCursor: JSON.stringify({
                  object: `knowledge_space:${last.spaceId}`,
                  relation: last.role,
                }),
              }
            : {}),
        });
      }

      const spaceId = matched.parameters["spaceId"];
      if (!spaceId || !/^[A-Za-z0-9:_-]{1,128}$/.test(spaceId))
        return problem(400, "invalid_space_id", "Space IDが不正です");
      if (principal.type === "user") {
        const allowed = await input.accessChecker.canManage({
          organizationId,
          spaceId,
          userId: principal.id,
        });
        if (Result.isFailure(allowed))
          return problem(503, "space_access_check_failed", "Space権限を確認できません");
        if (!allowed.value)
          return problem(403, "space_owner_required", "Space owner権限が必要です");
      } else if (principal.type !== "agent" || String(principal.id) !== input.applicationAgentId) {
        return problem(403, "application_agent_required", "登録済みapplication agentが必要です");
      }
      const listed = await input.repository.members({
        organizationId,
        spaceId,
        ...(cursor ? { after: cursor as SpaceMemberCursor } : {}),
        limit: limit + 1,
      });
      if (Result.isFailure(listed))
        return problem(
          listed.error.retriable ? 503 : 500,
          listed.error.code,
          "Memberを取得できません",
        );
      const items = listed.value.slice(0, limit);
      const last = items.at(-1);
      return Response.json({
        items,
        ...(listed.value.length > limit && last
          ? { nextCursor: JSON.stringify({ subject: String(last.id), relation: last.role }) }
          : {}),
      });
    },
  };
}
