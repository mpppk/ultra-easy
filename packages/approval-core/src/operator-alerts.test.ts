import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_OPERATOR_ALERT_THRESHOLDS, evaluateOperatorAlerts } from "./operator-alerts.ts";

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
});
