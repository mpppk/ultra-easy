import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/preview/operator-dashboard")({
  component: PreviewOperatorDashboard,
});

type PercentileSummary = {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
};

type DashboardSnapshot = {
  organizationId: string;
  evaluatedAt: string;
  actionCount: number;
  sli: {
    leadTimeMs: PercentileSummary;
    dwellByStepKey: Record<string, PercentileSummary>;
    rejectedTotal: number;
    expiredTotal: number;
    completedByResult: Record<string, number>;
    executorFailuresByCode: Record<string, number>;
  };
  outbox: {
    pendingOutbox: number;
    failedOutbox: number;
    failedDeliveries: number;
    backlog: number;
  };
  alerts: Array<{
    key: string;
    status: string;
    breachedSince: string | null;
    updatedAt: string;
  }>;
  thresholds: {
    outboxBacklogLimit: number;
    outboxBacklogMinutes: number;
    failureTrendMinutes: number;
    dwellP95SlaMs: number | null;
  };
};

function formatMs(value: number | null) {
  if (value === null) return "n/a";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatSummary(summary: PercentileSummary) {
  return `n=${summary.count} p50=${formatMs(summary.p50Ms)} p95=${formatMs(summary.p95Ms)} p99=${formatMs(summary.p99Ms)}`;
}

function PreviewOperatorDashboard() {
  const [organizationId, setOrganizationId] = useState("organization:preview");
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/preview/operator-dashboard?organizationId=${encodeURIComponent(organizationId)}`,
      );
      if (!response.ok) return Promise.reject(new Error(await response.text()));
      setSnapshot((await response.json()) as DashboardSnapshot);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: 32, fontFamily: "sans-serif" }}>
      <h1>Operator Dashboard (Preview)</h1>
      <p>
        D1 append-only eventsとoutbox
        tablesから算出したSLIです。FGAレイテンシ・Workflowリトライ系はWorkers
        Logs側のクエリ（runbook参照）で確認します。staging実測では再認可Checkで
        <code>fga.check_latency_ms=572ms</code>（初回token交換込み）を観測済み （M8-3、詳細は{" "}
        <code>docs/runbooks/operator-dashboard.md</code>）。
      </p>

      <section style={{ display: "flex", gap: 12, alignItems: "center", marginBlock: 24 }}>
        <label>
          Organization{" "}
          <input
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            style={{ minWidth: 280 }}
          />
        </label>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
      </section>

      {error ? <pre style={{ whiteSpace: "pre-wrap" }}>{error}</pre> : null}

      {snapshot ? (
        <section>
          <p>
            Evaluated at <code>{snapshot.evaluatedAt}</code> / actions: {snapshot.actionCount}
          </p>

          <h2>Approval lead time</h2>
          <p>
            <code>{formatSummary(snapshot.sli.leadTimeMs)}</code>
          </p>

          <h2>Step dwell time by stepKey</h2>
          {Object.keys(snapshot.sli.dwellByStepKey).length === 0 ? (
            <p>n/a</p>
          ) : (
            <ul>
              {Object.entries(snapshot.sli.dwellByStepKey).map(([stepKey, summary]) => (
                <li key={stepKey}>
                  <code>{stepKey}</code>: <code>{formatSummary(summary)}</code>
                </li>
              ))}
            </ul>
          )}

          <h2>Reject / expire / completed</h2>
          <p>
            rejected: {snapshot.sli.rejectedTotal} / expired: {snapshot.sli.expiredTotal} /
            completed: <code>{JSON.stringify(snapshot.sli.completedByResult)}</code>
          </p>

          <h2>ActionExecutor failures by code</h2>
          <p>
            <code>{JSON.stringify(snapshot.sli.executorFailuresByCode)}</code>
          </p>

          <h2>Outbox</h2>
          <p>
            backlog: {snapshot.outbox.backlog} (pending: {snapshot.outbox.pendingOutbox} / failed:{" "}
            {snapshot.outbox.failedOutbox} / failed deliveries: {snapshot.outbox.failedDeliveries})
          </p>

          <h2>Alerts</h2>
          <p>
            thresholds: backlog&gt;{snapshot.thresholds.outboxBacklogLimit} for{" "}
            {snapshot.thresholds.outboxBacklogMinutes}m / trend window{" "}
            {snapshot.thresholds.failureTrendMinutes}m / dwell p95 SLA:{" "}
            {snapshot.thresholds.dwellP95SlaMs === null
              ? "disabled"
              : `${snapshot.thresholds.dwellP95SlaMs}ms`}
          </p>
          <ul>
            {snapshot.alerts.map((alert) => (
              <li key={alert.key}>
                <code>{alert.key}</code>: {alert.status}
                {alert.breachedSince ? ` since ${alert.breachedSince}` : ""} (updated{" "}
                {alert.updatedAt})
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
