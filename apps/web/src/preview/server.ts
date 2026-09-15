import { env } from "cloudflare:workers";

import type { PreviewScenario } from "./scenarios.ts";

type RuntimeService = {
  fetch(request: Request): Promise<Response>;
};

type PreviewEnv = {
  APPROVAL_RUNTIME_PREVIEW: RuntimeService;
  PREVIEW_HARNESS_ENABLED?: string;
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

export function isPreviewHarnessEnabled(): boolean {
  return previewEnv().PREVIEW_HARNESS_ENABLED === "true";
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
