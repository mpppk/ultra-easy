import { Result } from "@praha/byethrow";

import { parseBrand, type OrganizationId } from "@app/approval-core";

import {
  authenticatePublicApi,
  type PublicHttpClock,
  type PublicHttpIdentityProvider,
} from "./public-http.ts";
import { matchHttpRoute } from "./http-access-log.ts";
import type {
  PrincipalDirectoryEntry,
  PrincipalDirectoryRepository,
} from "./principal-directory.ts";

export const PUBLIC_PRINCIPAL_DIRECTORY_ROUTES = [
  "/v1/organizations/{organizationId}/principals",
  "/v1/organizations/{organizationId}/me/principal",
] as const;

function problem(status: number, code: string, title: string): Response {
  return Response.json(
    { type: `urn:ultra-easy:problem:${code}`, title, status, code },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

function repositoryProblem(error: { code: string; retriable: boolean }): Response {
  return problem(error.retriable ? 503 : 500, error.code, "Principal directoryを利用できません");
}

const parseJson = Result.fn({
  try: (text: string): unknown => JSON.parse(text),
  catch: () => new Error("invalid JSON"),
});

const readText = Result.fn({
  try: (request: Request): Promise<string> => request.text(),
  catch: () => new Error("body read failed"),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cursorFrom(value: string | null): PrincipalDirectoryEntry | null | Response {
  if (value === null) return null;
  if (value.length > 2048) return problem(400, "invalid_cursor", "cursorが不正です");
  const parsed = parseJson(value);
  if (Result.isFailure(parsed) || !isRecord(parsed.value))
    return problem(400, "invalid_cursor", "cursorが不正です");
  const { id, displayName } = parsed.value;
  const principalId = parseBrand("UserId", id);
  if (
    Result.isFailure(principalId) ||
    typeof displayName !== "string" ||
    displayName.length < 1 ||
    displayName.length > 200
  )
    return problem(400, "invalid_cursor", "cursorが不正です");
  return { id: principalId.value, displayName };
}

function displayNameFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (
    name.length < 1 ||
    name.length > 200 ||
    Array.from(name).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    return null;
  return name;
}

export function createPublicPrincipalDirectoryApi(input: {
  repository: PrincipalDirectoryRepository;
  identityProvider: PublicHttpIdentityProvider;
  clock: PublicHttpClock;
}): { handles(request: Request): boolean; fetch(request: Request): Promise<Response> } {
  return {
    handles(request) {
      const matched = matchHttpRoute(
        PUBLIC_PRINCIPAL_DIRECTORY_ROUTES,
        new URL(request.url).pathname,
      );
      return matched !== null && (request.method === "GET" || request.method === "PUT");
    },
    async fetch(request) {
      const url = new URL(request.url);
      const matched = matchHttpRoute(PUBLIC_PRINCIPAL_DIRECTORY_ROUTES, url.pathname);
      if (!matched) return problem(404, "route_not_found", "Route not found");
      const isList = matched.route.endsWith("/principals");
      if ((isList && request.method !== "GET") || (!isList && request.method !== "PUT"))
        return problem(404, "route_not_found", "Route not found");
      const organization = parseBrand("OrganizationId", matched.parameters["organizationId"]);
      if (Result.isFailure(organization))
        return problem(400, "invalid_organization_id", "Organization IDが不正です");
      const organizationId: OrganizationId = organization.value;
      const principal = await authenticatePublicApi({
        identityProvider: input.identityProvider,
        request,
        organizationId,
        operation: isList ? "principal_directory.read" : "principal_directory.ensure",
      });
      if (principal instanceof Response) return principal;
      if (principal.type !== "user")
        return problem(403, "machine_principal_not_allowed", "User principalが必要です");

      if (isList) {
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 100 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
          return problem(400, "invalid_limit", "limitが不正です");
        const cursor = cursorFrom(url.searchParams.get("cursor"));
        if (cursor instanceof Response) return cursor;
        const listed = await input.repository.list({
          organizationId,
          ...(cursor ? { after: cursor } : {}),
          limit: limit + 1,
        });
        if (Result.isFailure(listed)) return repositoryProblem(listed.error);
        const items = listed.value.slice(0, limit);
        const last = items.at(-1);
        return Response.json({
          items: items.map((item) => ({ id: String(item.id), displayName: item.displayName })),
          ...(listed.value.length > limit && last
            ? { nextCursor: JSON.stringify({ id: String(last.id), displayName: last.displayName }) }
            : {}),
        });
      }

      const text = await readText(request);
      if (Result.isFailure(text)) return problem(400, "invalid_principal_body", "bodyを読めません");
      if (text.value.length > 4096)
        return problem(400, "invalid_principal_body", "bodyが長すぎます");
      const body = parseJson(text.value);
      if (Result.isFailure(body) || !isRecord(body.value))
        return problem(400, "invalid_principal_body", "bodyが不正です");
      if (!Object.keys(body.value).every((key) => key === "id" || key === "displayName"))
        return problem(400, "invalid_principal_body", "bodyが不正です");
      const id = parseBrand("UserId", body.value["id"]);
      const displayName = displayNameFrom(body.value["displayName"]);
      if (Result.isFailure(id) || displayName === null)
        return problem(400, "invalid_principal_body", "idまたはdisplayNameが不正です");
      if (String(id.value) !== String(principal.id))
        return problem(403, "principal_self_only", "本人のprincipalのみ登録できます");
      const entry: PrincipalDirectoryEntry = { id: id.value, displayName };
      const saved = await input.repository.upsert({
        organizationId,
        principal: entry,
        now: input.clock.now(),
      });
      if (Result.isFailure(saved)) return repositoryProblem(saved.error);
      return Response.json({ id: String(entry.id), displayName: entry.displayName });
    },
  };
}
