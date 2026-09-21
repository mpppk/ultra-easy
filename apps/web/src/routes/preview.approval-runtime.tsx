import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { previewScenarios, type PreviewScenario } from "../preview/scenarios.ts";

type RuntimeTask = {
  id: string;
  status: string;
  candidateUserIds: string[];
  decisions: Array<{ userId: string; decision: string }>;
};

type RunStatus = {
  actionRequestId: string;
  workflow: { status: string; output?: unknown };
  runtime: null | {
    status: string;
    tasks: RuntimeTask[];
  };
  actionResult: null | {
    status: string;
    guaranteeLevel?: string;
    idempotencyKey?: string;
    result?: unknown;
    code?: string;
    message?: string;
  };
};

export const Route = createFileRoute("/preview/approval-runtime")({
  component: PreviewApprovalRuntime,
});

function PreviewApprovalRuntime() {
  const [scenario, setScenario] = useState<PreviewScenario>("serial-two-users");
  const [runId, setRunId] = useState<string>();
  const [status, setStatus] = useState<RunStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function refresh(id = runId) {
    if (!id) return;
    const response = await fetch(`/api/preview/approval-runs/${encodeURIComponent(id)}`);
    if (!response.ok) return Promise.reject(new Error(await response.text()));
    setStatus((await response.json()) as RunStatus);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    await run(async () => {
      const response = await fetch("/api/preview/approval-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario }),
      });
      if (!response.ok) return Promise.reject(new Error(await response.text()));
      const created = (await response.json()) as { actionRequestId: string };
      setRunId(created.actionRequestId);
      await refresh(created.actionRequestId);
    });
  }

  async function forceCancel() {
    if (!runId) return;
    const reason = window.prompt("force cancel reason", "stuck workflow recovery drill");
    if (reason === null || reason.trim().length === 0) return;
    await run(async () => {
      const response = await fetch(
        `/api/preview/approval-runs/${encodeURIComponent(runId)}/force-cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      );
      if (!response.ok) return Promise.reject(new Error(await response.text()));
      await refresh(runId);
    });
  }

  async function decide(task: RuntimeTask, userId: string, decision: "approve" | "reject") {
    if (!runId) return;
    await run(async () => {
      const response = await fetch(
        `/api/preview/approval-runs/${encodeURIComponent(runId)}/decisions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taskId: task.id, userId, decision }),
        },
      );
      if (!response.ok) return Promise.reject(new Error(await response.text()));
      await new Promise((resolve) => setTimeout(resolve, 250));
      await refresh(runId);
    });
  }

  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: 32, fontFamily: "sans-serif" }}>
      <h1>Approval Runtime Preview</h1>
      <p>Cloudflare Workflows + D1 + Safe Action Execution のPreview E2E確認用ハーネスです。</p>

      <section style={{ display: "flex", gap: 12, alignItems: "center", marginBlock: 24 }}>
        <select
          value={scenario}
          onChange={(event) => setScenario(event.target.value as PreviewScenario)}
        >
          {previewScenarios.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button type="button" disabled={busy} onClick={() => void start()}>
          Start
        </button>
        <button type="button" disabled={busy || !runId} onClick={() => void run(() => refresh())}>
          Refresh
        </button>
        <button type="button" disabled={busy || !runId} onClick={() => void forceCancel()}>
          Force cancel
        </button>
      </section>

      {error ? <pre style={{ whiteSpace: "pre-wrap" }}>{error}</pre> : null}

      {status ? (
        <section>
          <dl>
            <dt>Action request</dt>
            <dd>
              <code>{status.actionRequestId}</code>
            </dd>
            <dt>Workflow</dt>
            <dd>{status.workflow.status}</dd>
            <dt>Runtime</dt>
            <dd>{status.runtime?.status ?? "not projected"}</dd>
            <dt>Action result</dt>
            <dd>{status.actionResult?.status ?? "not projected"}</dd>
            <dt>Guarantee</dt>
            <dd>{status.actionResult?.guaranteeLevel ?? "n/a"}</dd>
            <dt>Idempotency key</dt>
            <dd>
              <code>{status.actionResult?.idempotencyKey ?? "n/a"}</code>
            </dd>
          </dl>

          <h2>Tasks</h2>
          {status.runtime?.tasks.map((task) => (
            <article
              key={task.id}
              style={{ border: "1px solid currentColor", padding: 16, marginBlock: 12 }}
            >
              <div>
                <code>{task.id}</code>
              </div>
              <div>Status: {task.status}</div>
              <div>Candidates: {task.candidateUserIds.join(", ") || "none"}</div>
              {task.status === "pending" ? (
                <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                  {task.candidateUserIds.map((userId) => (
                    <span key={userId} style={{ display: "inline-flex", gap: 4 }}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decide(task, userId, "approve")}
                      >
                        Approve as {userId}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decide(task, userId, "reject")}
                      >
                        Reject as {userId}
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
    </main>
  );
}
