import { Result } from "@praha/byethrow";
import { z } from "zod";

import type { KnowledgeContext } from "@app/knowledge-core";

import type { ApprovalTaskPageView, MeView, PrincipalView } from "../shared/api.ts";
import { FAULT_NOTIFIER, FAULT_SEARCH_INDEX } from "../mcp/tools.ts";
import { KnowledgeServiceError } from "./errors.ts";
import type { KnowledgeRuntime } from "./runtime.ts";
import { ensureDemoSeed } from "./seed.ts";
import { KnowledgeService } from "./service.ts";
import {
  clearSessionCookie,
  openSession,
  readCookie,
  sealSession,
  SESSION_COOKIE,
  sessionCookie,
} from "./session.ts";

/** Header every state-changing request must carry (with SameSite=Strict: CSRF guard). */
export const CLIENT_HEADER = "x-knowledge-client";

type Caller = {
  principal: PrincipalView;
  directory: Map<string, PrincipalView>;
  service: KnowledgeService;
};

function problem(error: KnowledgeServiceError): Response {
  return Response.json(
    { code: error.code, title: error.title, ...(error.detail ? { detail: error.detail } : {}) },
    { status: error.status },
  );
}

function respond<T>(result: Result.Result<T, KnowledgeServiceError>, status = 200): Response {
  return Result.isFailure(result) ? problem(result.error) : Response.json(result.value, { status });
}

async function readJson(request: Request): Promise<unknown> {
  const parsed = await Result.try({
    try: (): Promise<unknown> => request.json(),
    catch: () => null,
  });
  return Result.isSuccess(parsed) ? parsed.value : null;
}

const unauthenticated = () =>
  problem(new KnowledgeServiceError("unauthenticated", "Sign in to continue"));

async function resolveCaller(
  request: Request,
  runtime: KnowledgeRuntime,
): Result.ResultAsync<Caller | null, KnowledgeServiceError> {
  const cookie = readCookie(request, SESSION_COOKIE);
  const session = cookie ? await openSession(cookie, runtime.sessionSecret) : null;
  if (!session || session.organizationId !== runtime.organizationId) return Result.succeed(null);
  const principals = await runtime.ultraEasy.listPrincipals(runtime.organizationId);
  if (Result.isFailure(principals)) {
    return Result.fail(
      new KnowledgeServiceError("platform_unavailable", "ultra-easy is unavailable"),
    );
  }
  const directory = new Map(principals.value.map((principal) => [principal.id, principal]));
  const principal = directory.get(session.principalId);
  if (!principal) return Result.succeed(null);
  const roles = await runtime.ultraEasy.spaceRoles({
    organizationId: runtime.organizationId,
    principalId: principal.id,
  });
  if (Result.isFailure(roles)) {
    return Result.fail(
      new KnowledgeServiceError("platform_unavailable", "ultra-easy is unavailable"),
    );
  }
  const context: KnowledgeContext = {
    organizationId: runtime.organizationId,
    principal,
    spaceRoles: roles.value,
  };
  return Result.succeed({
    principal,
    directory,
    service: new KnowledgeService(runtime, context, directory),
  });
}

type Handler = (input: {
  params: string[];
  request: Request;
  url: URL;
  caller: Caller;
  runtime: KnowledgeRuntime;
}) => Promise<Response>;

const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];

function route(method: string, pattern: string, handler: Handler) {
  const source = pattern.replace(/:([a-zA-Z]+)/g, "([^/]+)");
  routes.push({ method, pattern: new RegExp(`^${source}$`), handler });
}

const SPACE_PAGE = "/api/spaces/:space/pages/:page";

route("GET", "/api/me", async ({ caller, runtime }) => {
  const notifications = await runtime.repos.effects.listNotifications({
    principalId: caller.principal.id,
    limit: 10,
  });
  const views: MeView["notifications"] = [];
  for (const notification of Result.isSuccess(notifications) ? notifications.value : []) {
    // Titles only for pages the recipient can currently read.
    const loaded = await runtime.repos.pages.find(notification.pageId);
    if (Result.isFailure(loaded) || !loaded.value) continue;
    const space = await runtime.repos.spaces.findById(loaded.value.spaceId);
    if (Result.isFailure(space) || !space.value) continue;
    const view = await caller.service.pageView(space.value.key, notification.pageId);
    if (Result.isFailure(view) || !view.value.published) continue;
    views.push({
      pageId: notification.pageId,
      spaceKey: space.value.key,
      title: view.value.published.title,
      revisionNumber: notification.revisionNumber,
      deliveredAt: notification.deliveredAt,
    });
  }
  const faults = async (key: string) => {
    const value = await runtime.repos.effects.demoSetting(key);
    return Result.isSuccess(value) && value.value === "on";
  };
  const me: MeView = {
    principal: caller.principal,
    organizationId: runtime.organizationId,
    demo: runtime.demo
      ? {
          principals: [...caller.directory.values()],
          faults: {
            notifier: await faults(FAULT_NOTIFIER),
            searchIndex: await faults(FAULT_SEARCH_INDEX),
          },
        }
      : null,
    notifications: views,
  };
  return Response.json(me);
});

route("POST", "/api/demo/faults", async ({ request, runtime }) => {
  if (!runtime.demo) return new Response("Not Found", { status: 404 });
  const input = z
    .object({ notifier: z.boolean().optional(), searchIndex: z.boolean().optional() })
    .safeParse(await readJson(request));
  if (!input.success)
    return problem(new KnowledgeServiceError("validation_error", "Invalid faults"));
  for (const [key, value] of [
    [FAULT_NOTIFIER, input.data.notifier],
    [FAULT_SEARCH_INDEX, input.data.searchIndex],
  ] as const) {
    if (value !== undefined) await runtime.repos.effects.setDemoSetting(key, value ? "on" : "off");
  }
  return Response.json({ ok: true });
});

route("GET", "/api/home", async ({ caller }) => respond(await caller.service.home()));
route("GET", "/api/spaces", async ({ caller }) => respond(await caller.service.spaces()));
route("POST", "/api/spaces", async ({ caller, request }) =>
  respond(await caller.service.createSpace(await readJson(request)), 201),
);
route("GET", "/api/spaces/:space", async ({ caller, params, url }) =>
  respond(
    await caller.service.spaceDetail(params[0] ?? "", {
      tag: url.searchParams.get("tag") ?? undefined,
    }),
  ),
);
route("POST", "/api/spaces/:space/pages", async ({ caller, params, request }) =>
  respond(await caller.service.createPage(params[0] ?? "", await readJson(request)), 201),
);
route("POST", "/api/spaces/:space/maintenance", async ({ caller, params }) =>
  respond(await caller.service.runMaintenance(params[0] ?? ""), 201),
);
route("GET", "/api/spaces/:space/settings", async ({ caller, params }) =>
  respond(await caller.service.settings(params[0] ?? "")),
);
route("PUT", "/api/spaces/:space/settings/approval-rules", async ({ caller, params, request }) =>
  respond(await caller.service.saveSettings(params[0] ?? "", await readJson(request))),
);
route("GET", SPACE_PAGE, async ({ caller, params }) =>
  respond(await caller.service.pageView(params[0] ?? "", params[1] ?? "")),
);
route("GET", `${SPACE_PAGE}/edit`, async ({ caller, params }) =>
  respond(await caller.service.editView(params[0] ?? "", params[1] ?? "")),
);
route("PUT", `${SPACE_PAGE}/draft`, async ({ caller, params, request }) =>
  respond(
    await caller.service.saveDraft(params[0] ?? "", params[1] ?? "", await readJson(request)),
  ),
);
route("POST", `${SPACE_PAGE}/publish`, async ({ caller, params, request }) =>
  respond(
    await caller.service.publish(params[0] ?? "", params[1] ?? "", await readJson(request)),
    202,
  ),
);
route("POST", `${SPACE_PAGE}/archive`, async ({ caller, params }) =>
  respond(await caller.service.archive(params[0] ?? "", params[1] ?? ""), 202),
);
route("POST", `${SPACE_PAGE}/restore`, async ({ caller, params }) =>
  respond(await caller.service.restore(params[0] ?? "", params[1] ?? "")),
);
route("PUT", `${SPACE_PAGE}/watch`, async ({ caller, params, request }) =>
  respond(
    await caller.service.setWatching(params[0] ?? "", params[1] ?? "", await readJson(request)),
  ),
);
route("GET", `${SPACE_PAGE}/revisions`, async ({ caller, params }) =>
  respond(await caller.service.revisions(params[0] ?? "", params[1] ?? "")),
);
route("GET", `${SPACE_PAGE}/revisions/:number`, async ({ caller, params }) => {
  const number = Number(params[2]);
  if (!Number.isSafeInteger(number) || number < 1) {
    return problem(new KnowledgeServiceError("not_found", "Not found or you do not have access"));
  }
  return respond(await caller.service.revision(params[0] ?? "", params[1] ?? "", number));
});
route("POST", "/api/publications/:snapshot/cancel", async ({ caller, params }) =>
  respond(await caller.service.cancelPublication(params[0] ?? "")),
);
route("POST", "/api/publications/:snapshot/effects/:effect/retry", async ({ caller, params }) =>
  respond(await caller.service.retryEffect(params[0] ?? "", params[1] ?? ""), 202),
);
route("GET", "/api/search", async ({ caller, url }) =>
  respond(
    await caller.service.search({
      q: url.searchParams.get("q") ?? undefined,
      space: url.searchParams.get("space") || undefined,
      tag: url.searchParams.get("tag") || undefined,
    }),
  ),
);
route("GET", "/api/automation", async ({ caller }) => respond(await caller.service.automation()));
route("GET", "/api/automation/:run", async ({ caller, params }) =>
  respond(await caller.service.automationDetail(params[0] ?? "")),
);
route("POST", "/api/automation/:run/inputs/:input", async ({ caller, params, request }) =>
  respond(
    await caller.service.submitHumanInput(
      params[0] ?? "",
      params[1] ?? "",
      await readJson(request),
    ),
  ),
);

// --- mock ultra-easy Approval UI backend (stand-in; not part of Knowledge) ---

route("GET", "/api/mock-ultra-easy/approvals/:task", async ({ caller, params, runtime }) => {
  const task = await runtime.ultraEasy.getApprovalTask({
    organizationId: runtime.organizationId,
    taskId: params[0] ?? "",
  });
  if (Result.isFailure(task))
    return problem(new KnowledgeServiceError("platform_unavailable", "ultra-easy is unavailable"));
  if (!task.value)
    return problem(new KnowledgeServiceError("not_found", "Approval task not found"));
  const summary = task.value.summary;
  const input =
    typeof summary.input === "object" && summary.input !== null
      ? (summary.input as Record<string, unknown>)
      : {};
  const context: ApprovalTaskPageView["context"] = [];
  for (const [label, value] of [
    ["Policy rule", summary.rule],
    ["Visibility", summary.visibility],
    ["Sensitivity", summary.sensitivity],
    ["Publication snapshot", input.publicationSnapshotId],
    ["Page", summary.pageId ?? input.pageId],
  ] as const) {
    if (typeof value === "string" && value.length > 0) context.push({ label, value });
  }
  let subjectLink: string | null = null;
  let returnLink: string | null = null;
  const pageId =
    typeof summary.pageId === "string"
      ? summary.pageId
      : typeof input.pageId === "string"
        ? input.pageId
        : null;
  const spaceId = typeof summary.spaceId === "string" ? summary.spaceId : null;
  if (spaceId) {
    const space = await runtime.repos.spaces.findById(spaceId);
    if (Result.isSuccess(space) && space.value) {
      if (pageId) {
        returnLink = `/spaces/${space.value.key}/pages/${pageId}`;
        // Reviewers can open the immutable revision the snapshot pins (read-only).
        const snapshotId =
          typeof input.publicationSnapshotId === "string" ? input.publicationSnapshotId : null;
        const snapshot = snapshotId ? await runtime.repos.revisions.findSnapshot(snapshotId) : null;
        subjectLink =
          snapshot && Result.isSuccess(snapshot) && snapshot.value
            ? `${returnLink}?revision=${snapshot.value.revisionNumber}`
            : returnLink;
      } else {
        returnLink = `/spaces/${space.value.key}/settings`;
      }
    }
  }
  const view: ApprovalTaskPageView = {
    taskId: task.value.taskId,
    actionType: task.value.actionType,
    status: task.value.status,
    requestedBy: task.value.requestedBy,
    candidates: task.value.candidates,
    decidedBy: task.value.decidedBy,
    decidedAt: task.value.decidedAt,
    createdAt: task.value.createdAt,
    canDecide:
      task.value.status === "pending" && task.value.candidateIds.includes(caller.principal.id),
    viewer: caller.principal,
    context,
    subjectLink,
    returnLink,
  };
  return Response.json(view);
});

route(
  "POST",
  "/api/mock-ultra-easy/approvals/:task/decision",
  async ({ caller, params, request, runtime }) => {
    const input = z
      .object({ decision: z.enum(["approve", "reject"]) })
      .safeParse(await readJson(request));
    if (!input.success)
      return problem(new KnowledgeServiceError("validation_error", "Invalid decision"));
    const decided = await runtime.ultraEasy.decideApproval({
      organizationId: runtime.organizationId,
      taskId: params[0] ?? "",
      decision: input.data.decision,
      actor: caller.principal,
    });
    if (Result.isFailure(decided)) {
      const code = decided.error.code;
      return problem(
        new KnowledgeServiceError(
          code === "forbidden"
            ? "forbidden"
            : code === "not_found"
              ? "not_found"
              : code === "invalid_state"
                ? "invalid_state"
                : "platform_unavailable",
          decided.error.message,
        ),
      );
    }
    return Response.json({ ok: true });
  },
);

const SEED_ONCE = new WeakSet<object>();

/** Entry point for `/api/*` on the Knowledge worker. */
export async function handleKnowledgeApi(
  request: Request,
  runtime: KnowledgeRuntime,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    request.headers.get(CLIENT_HEADER) !== "1"
  ) {
    return problem(new KnowledgeServiceError("forbidden", "Missing client header"));
  }
  if (runtime.demo && !SEED_ONCE.has(runtime.repos)) {
    const seeded = await ensureDemoSeed(runtime);
    if (Result.isSuccess(seeded)) SEED_ONCE.add(runtime.repos);
  }

  // Demo sign-in: choose a fixture principal (local / demo mode only).
  if (url.pathname === "/api/demo/session") {
    if (!runtime.demo) return new Response("Not Found", { status: 404 });
    if (request.method === "DELETE") {
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": clearSessionCookie(true) },
      });
    }
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const input = z
      .object({ principalId: z.string().min(1).max(128) })
      .safeParse(await readJson(request));
    if (!input.success)
      return problem(new KnowledgeServiceError("validation_error", "Choose a principal"));
    const principals = await runtime.ultraEasy.listPrincipals(runtime.organizationId);
    if (Result.isFailure(principals)) {
      return problem(
        new KnowledgeServiceError("platform_unavailable", "ultra-easy is unavailable"),
      );
    }
    if (!principals.value.some((principal) => principal.id === input.data.principalId)) {
      return problem(new KnowledgeServiceError("validation_error", "Unknown principal"));
    }
    const sealed = await sealSession(
      { principalId: input.data.principalId, organizationId: runtime.organizationId },
      runtime.sessionSecret,
    );
    return new Response(null, {
      status: 204,
      headers: { "set-cookie": sessionCookie(sealed, true) },
    });
  }
  if (url.pathname === "/api/demo/principals" && request.method === "GET") {
    if (!runtime.demo) return new Response("Not Found", { status: 404 });
    const principals = await runtime.ultraEasy.listPrincipals(runtime.organizationId);
    return Result.isFailure(principals)
      ? problem(new KnowledgeServiceError("platform_unavailable", "ultra-easy is unavailable"))
      : Response.json({ principals: principals.value });
  }

  const matched = routes
    .map((entry) => ({ entry, match: entry.pattern.exec(url.pathname) }))
    .filter((candidate) => candidate.match !== null);
  if (matched.length === 0)
    return problem(new KnowledgeServiceError("not_found", "Unknown endpoint"));
  const found = matched.find((candidate) => candidate.entry.method === request.method);
  if (!found?.match) return new Response("Method Not Allowed", { status: 405 });

  const caller = await resolveCaller(request, runtime);
  if (Result.isFailure(caller)) return problem(caller.error);
  if (!caller.value) return unauthenticated();
  // Keys / IDs are URL-safe ([a-z0-9_-]); encoded input simply matches nothing.
  const params = found.match.slice(1).map((value) => value ?? "");
  return found.entry.handler({ params, request, url, caller: caller.value, runtime });
}
