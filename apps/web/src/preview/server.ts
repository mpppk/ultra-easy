import { env } from "cloudflare:workers";

import { checkPreviewAccess, PREVIEW_TOKEN_HEADER } from "./access.ts";
import type { PreviewScenario } from "./scenarios.ts";

type RuntimeService = {
  fetch(request: Request): Promise<Response>;
};

type PreviewEnv = {
  APPROVAL_RUNTIME_PREVIEW: RuntimeService;
  PREVIEW_HARNESS_ENABLED?: string;
  /** wrangler secret。未設定ならharness APIはfail closed（403）。 */
  PREVIEW_HARNESS_TOKEN?: string;
};

function previewEnv(): PreviewEnv {
  return env as unknown as PreviewEnv;
}

function runtimeRequest(path: string, init?: RequestInit): Promise<Response> {
  return previewEnv().APPROVAL_RUNTIME_PREVIEW.fetch(
    new Request(`https://approval-runtime.internal${path}`, init),
  );
}

export function previewNotFound(): Response {
  return new Response("Not Found", { status: 404 });
}

/**
 * preview harness APIの認可。許可ならnull、拒否ならそのまま返すResponse（#97）。
 */
export async function authorizePreviewRequest(request: Request): Promise<Response | null> {
  const decision = await checkPreviewAccess({
    enabled: previewEnv().PREVIEW_HARNESS_ENABLED === "true",
    expectedToken: previewEnv().PREVIEW_HARNESS_TOKEN,
    presentedToken: request.headers.get(PREVIEW_TOKEN_HEADER),
  });
  if (decision.type === "allowed") return null;
  return decision.status === 404
    ? previewNotFound()
    : Response.json({ error: decision.code }, { status: decision.status });
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export function startPreviewRun(scenario: PreviewScenario): Promise<Response> {
  return runtimeRequest("/preview/approval-runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario }),
  });
}

export function getPreviewRun(actionRequestId: string): Promise<Response> {
  return runtimeRequest(`/preview/approval-runs/${encodeURIComponent(actionRequestId)}`);
}

export function getOperatorDashboard(organizationId: string): Promise<Response> {
  return runtimeRequest(`/operator/dashboard?organizationId=${encodeURIComponent(organizationId)}`);
}

export function sendPreviewForceCancel(input: {
  actionRequestId: string;
  reason: string;
  actor?: { type: string; id: string };
}): Promise<Response> {
  return runtimeRequest(
    `/preview/approval-runs/${encodeURIComponent(input.actionRequestId)}/force-cancel`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reason: input.reason,
        ...(input.actor === undefined ? {} : { actor: input.actor }),
      }),
    },
  );
}

export function sendPreviewDecision(input: {
  actionRequestId: string;
  taskId: string;
  userId: string;
  decision: "approve" | "reject";
}): Promise<Response> {
  return runtimeRequest(
    `/preview/approval-runs/${encodeURIComponent(input.actionRequestId)}/decisions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: input.taskId,
        userId: input.userId,
        decision: input.decision,
      }),
    },
  );
}

/**
 * Workflow Studio（#162）のAPIをpreview runtimeへ中継する。path / method / bodyをそのまま渡し、
 * `/preview/workflow/*` だけに限定する。
 */
export async function proxyWorkflowStudio(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const prefix = "/api/preview/workflow/";
  if (!url.pathname.startsWith(prefix)) return previewNotFound();
  const path = `/preview/workflow/${url.pathname.slice(prefix.length)}${url.search}`;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return runtimeRequest(path, {
    method: request.method,
    headers: { "content-type": "application/json" },
    ...(hasBody ? { body: await request.text() } : {}),
  });
}
