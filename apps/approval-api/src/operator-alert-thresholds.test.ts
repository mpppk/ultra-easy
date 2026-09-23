import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_OPERATOR_ALERT_THRESHOLDS } from "@app/approval-core";

import { readOperatorAlertThresholds } from "./operator-alert-thresholds.ts";

describe("readOperatorAlertThresholds", () => {
  it("未設定時はspec baselineを返す", () => {
    expect(readOperatorAlertThresholds({})).toEqual(DEFAULT_OPERATOR_ALERT_THRESHOLDS);
  });

  it("staging drill用の上書きを読む", () => {
    const thresholds = readOperatorAlertThresholds({
      OPERATOR_ALERT_OUTBOX_BACKLOG: "1",
      OPERATOR_ALERT_OUTBOX_BACKLOG_MINUTES: "1",
    });
    expect(thresholds.outboxBacklogLimit).toBe(1);
    expect(thresholds.outboxBacklogMinutes).toBe(1);
    expect(thresholds.failureTrendMinutes).toBe(
      DEFAULT_OPERATOR_ALERT_THRESHOLDS.failureTrendMinutes,
    );
  });

  it("不正値はfallbackする", () => {
    const thresholds = readOperatorAlertThresholds({
      OPERATOR_ALERT_OUTBOX_BACKLOG: "not-a-number",
      OPERATOR_ALERT_DWELL_P95_SLA_MS: "-5",
    });
    expect(thresholds.outboxBacklogLimit).toBe(
      DEFAULT_OPERATOR_ALERT_THRESHOLDS.outboxBacklogLimit,
    );
    expect(thresholds.dwellP95SlaMs).toBeNull();
  });
});
