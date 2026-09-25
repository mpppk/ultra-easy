import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_OPERATOR_ALERT_THRESHOLDS,
  evaluateOperatorAlerts,
  OPERATOR_ALERT_KEYS,
  OPERATOR_ALERT_RUNBOOKS,
} from "./operator-alerts.ts";

describe("evaluateOperatorAlerts", () => {
  it("backlog超過が継続するとbreaching→firingへ遷移する", () => {
    const thresholds = DEFAULT_OPERATOR_ALERT_THRESHOLDS;
    const first = evaluateOperatorAlerts({
      thresholds,
      previous: [],
      values: {
        outboxBacklog: 150,
        outboxFailedTotal: 0,
        executorFailureTotal: 0,
        dwellP95Ms: null,
      },
      now: "2026-09-21T00:00:00.000Z",
    });
    expect(first.states.find((state) => state.key === "outbox_backlog")?.status).toBe("breaching");
    expect(first.transitions).toEqual([{ key: "outbox_backlog", from: "ok", to: "breaching" }]);

    const second = evaluateOperatorAlerts({
      thresholds,
      previous: first.states,
      values: {
        outboxBacklog: 150,
        outboxFailedTotal: 0,
        executorFailureTotal: 0,
        dwellP95Ms: null,
      },
      now: "2026-09-21T00:11:00.000Z",
    });
    expect(second.states.find((state) => state.key === "outbox_backlog")?.status).toBe("firing");
    expect(second.transitions).toEqual([
      { key: "outbox_backlog", from: "breaching", to: "firing" },
    ]);

    const recovered = evaluateOperatorAlerts({
      thresholds,
      previous: second.states,
      values: {
        outboxBacklog: 10,
        outboxFailedTotal: 0,
        executorFailureTotal: 0,
        dwellP95Ms: null,
      },
      now: "2026-09-21T00:12:00.000Z",
    });
    expect(recovered.states.find((state) => state.key === "outbox_backlog")?.status).toBe("ok");
    expect(recovered.transitions).toEqual([{ key: "outbox_backlog", from: "firing", to: "ok" }]);
  });

  it("初回観測では増加と判定しない", () => {
    const evaluated = evaluateOperatorAlerts({
      thresholds: DEFAULT_OPERATOR_ALERT_THRESHOLDS,
      previous: [],
      values: {
        outboxBacklog: 0,
        outboxFailedTotal: 5,
        executorFailureTotal: 3,
        dwellP95Ms: null,
      },
      now: "2026-09-21T00:00:00.000Z",
    });
    expect(
      evaluated.states.find((state) => state.key === "outbox_failures_increasing")?.status,
    ).toBe("ok");
    expect(
      evaluated.states.find((state) => state.key === "executor_failures_increasing")?.status,
    ).toBe("ok");
  });

  it("失敗数の増加が継続するとfiringへ遷移する", () => {
    const observed = evaluateOperatorAlerts({
      thresholds: DEFAULT_OPERATOR_ALERT_THRESHOLDS,
      previous: [],
      values: {
        outboxBacklog: 0,
        outboxFailedTotal: 5,
        executorFailureTotal: 3,
        dwellP95Ms: null,
      },
      now: "2026-09-21T00:00:00.000Z",
    });
    const increased = evaluateOperatorAlerts({
      thresholds: DEFAULT_OPERATOR_ALERT_THRESHOLDS,
      previous: observed.states,
      values: {
        outboxBacklog: 0,
        outboxFailedTotal: 6,
        executorFailureTotal: 3,
        dwellP95Ms: null,
      },
      now: "2026-09-21T00:01:00.000Z",
    });
    expect(
      increased.states.find((state) => state.key === "outbox_failures_increasing")?.status,
    ).toBe("breaching");
    const sustained = evaluateOperatorAlerts({
      thresholds: DEFAULT_OPERATOR_ALERT_THRESHOLDS,
      previous: increased.states,
      values: {
        outboxBacklog: 0,
        outboxFailedTotal: 7,
        executorFailureTotal: 3,
        dwellP95Ms: null,
      },
      now: "2026-09-21T00:07:00.000Z",
    });
    expect(
      sustained.states.find((state) => state.key === "outbox_failures_increasing")?.status,
    ).toBe("firing");
  });

  it("dwell SLA未設定ではdwellアラートは無効", () => {
    const evaluated = evaluateOperatorAlerts({
      thresholds: DEFAULT_OPERATOR_ALERT_THRESHOLDS,
      previous: [],
      values: {
        outboxBacklog: 0,
        outboxFailedTotal: 0,
        executorFailureTotal: 0,
        dwellP95Ms: 3_600_000,
      },
      now: "2026-09-21T00:00:00.000Z",
    });
    expect(evaluated.states.find((state) => state.key === "approval_dwell_p95")?.status).toBe("ok");
  });

  describe("#109 minimum alerts", () => {
    const base = {
      outboxBacklog: 0,
      outboxFailedTotal: 0,
      executorFailureTotal: 0,
      dwellP95Ms: null,
    };
    const statusOf = (
      result: ReturnType<typeof evaluateOperatorAlerts>,
      key: Parameters<typeof evaluateOperatorAlerts>[0]["previous"][number]["key"],
    ) => result.states.find((state) => state.key === key)?.status;

    it("docs記載の最小アラートをすべて評価する", () => {
      const result = evaluateOperatorAlerts({
        thresholds: DEFAULT_OPERATOR_ALERT_THRESHOLDS,
        previous: [],
        values: base,
        now: "2026-09-25T00:00:00.000Z",
      });
      expect(result.states.map((state) => state.key).sort()).toEqual(
        [...OPERATOR_ALERT_KEYS].sort(),
      );
      for (const key of OPERATOR_ALERT_KEYS)
        expect(OPERATOR_ALERT_RUNBOOKS[key]).toMatch(/^docs\/runbooks\//);
    });

    it("workflow.failedと滞留は1件でも即firingし、無くなればresolveする", () => {
      const fired = evaluateOperatorAlerts({
        thresholds: DEFAULT_OPERATOR_ALERT_THRESHOLDS,
        previous: [],
        values: { ...base, workflowFailuresInWindow: 1, stuckActionRequests: 2 },
        now: "2026-09-25T00:00:00.000Z",
      });
      expect(statusOf(fired, "workflow_failures")).toBe("firing");
      expect(statusOf(fired, "stuck_action_requests")).toBe("firing");

      const resolved = evaluateOperatorAlerts({
        thresholds: DEFAULT_OPERATOR_ALERT_THRESHOLDS,
        previous: fired.states,
        values: { ...base, workflowFailuresInWindow: 0, stuckActionRequests: 0 },
        now: "2026-09-25T00:06:00.000Z",
      });
      expect(statusOf(resolved, "workflow_failures")).toBe("ok");
      expect(resolved.transitions).toContainEqual({
        key: "stuck_action_requests",
        from: "firing",
        to: "ok",
      });
    });

    it("FGA error率 > 1%は5分、Check p95 > 1秒は10分続くとfiringする", () => {
      const values = { ...base, fgaErrorRate: 0.05, fgaCheckP95Ms: 1_500 };
      const first = evaluateOperatorAlerts({
        thresholds: DEFAULT_OPERATOR_ALERT_THRESHOLDS,
        previous: [],
        values,
        now: "2026-09-25T00:00:00.000Z",
      });
      expect(statusOf(first, "fga_error_rate")).toBe("breaching");
      expect(statusOf(first, "fga_latency_p95")).toBe("breaching");
      const fiveMinutes = evaluateOperatorAlerts({
        thresholds: DEFAULT_OPERATOR_ALERT_THRESHOLDS,
        previous: first.states,
        values,
        now: "2026-09-25T00:05:00.000Z",
      });
      expect(statusOf(fiveMinutes, "fga_error_rate")).toBe("firing");
      expect(statusOf(fiveMinutes, "fga_latency_p95")).toBe("breaching");
      const tenMinutes = evaluateOperatorAlerts({
        thresholds: DEFAULT_OPERATOR_ALERT_THRESHOLDS,
        previous: fiveMinutes.states,
        values,
        now: "2026-09-25T00:10:00.000Z",
      });
      expect(statusOf(tenMinutes, "fga_latency_p95")).toBe("firing");
    });

    it("metric sourceが無い（null）FGA alertはokのまま", () => {
      const result = evaluateOperatorAlerts({
        thresholds: DEFAULT_OPERATOR_ALERT_THRESHOLDS,
        previous: [],
        values: { ...base, fgaErrorRate: null, fgaCheckP95Ms: null },
        now: "2026-09-25T00:00:00.000Z",
      });
      expect(statusOf(result, "fga_error_rate")).toBe("ok");
      expect(statusOf(result, "fga_latency_p95")).toBe("ok");
    });
  });
});
