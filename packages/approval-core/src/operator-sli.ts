import type { ActionCompletedResult, ActionEventRecord } from "./action-event.ts";

export type PercentileSummary = {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
};

export type OrganizationActionSli = {
  leadTimeMs: PercentileSummary;
  dwellByStepKey: Record<string, PercentileSummary>;
  rejectedTotal: number;
  expiredTotal: number;
  completedByResult: Partial<Record<ActionCompletedResult, number>>;
  executorFailuresByCode: Record<string, number>;
};

function parseTime(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function summarize(values: readonly number[]): PercentileSummary {
  if (values.length === 0) {
    return { count: 0, p50Ms: null, p95Ms: null, p99Ms: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number): number => {
    const rank = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
  };
  return {
    count: sorted.length,
    p50Ms: percentile(50),
    p95Ms: percentile(95),
    p99Ms: percentile(99),
  };
}

/**
 * D1 append-only Action eventsから組織単位のSLIを算出するpure関数。
 * dashboardとaudit再構成が同じsource of truthを使うための単一実装。
 */
export function computeOrganizationActionSli(
  records: readonly ActionEventRecord[],
): OrganizationActionSli {
  const receivedAt = new Map<string, number>();
  const leadTimes: number[] = [];
  const activatedAt = new Map<string, number>();
  const dwellByStepKey = new Map<string, number[]>();
  let rejectedTotal = 0;
  let expiredTotal = 0;
  const completedByResult: Partial<Record<ActionCompletedResult, number>> = {};
  const executorFailuresByCode: Record<string, number> = {};

  for (const record of records) {
    const event = record.event;
    const actionId = String(event.actionRequestId);
    switch (event.type) {
      case "action.received": {
        const at = parseTime(record.occurredAt);
        if (at !== null && !receivedAt.has(actionId)) receivedAt.set(actionId, at);
        break;
      }
      case "action.completed": {
        const start = receivedAt.get(actionId);
        const at = parseTime(record.occurredAt);
        if (start !== undefined && at !== null && at >= start) {
          leadTimes.push(at - start);
        }
        completedByResult[event.result] = (completedByResult[event.result] ?? 0) + 1;
        break;
      }
      case "step.activated": {
        const at = parseTime(record.occurredAt);
        if (at !== null) activatedAt.set(String(event.materializedStepId), at);
        break;
      }
      case "step.approved":
      case "step.rejected":
      case "step.expired": {
        const start = activatedAt.get(String(event.materializedStepId));
        const at = parseTime(record.occurredAt);
        if (start !== undefined && at !== null && at >= start) {
          const samples = dwellByStepKey.get(String(event.stepKey)) ?? [];
          samples.push(at - start);
          dwellByStepKey.set(String(event.stepKey), samples);
        }
        if (event.type === "step.rejected") rejectedTotal += 1;
        if (event.type === "step.expired") expiredTotal += 1;
        break;
      }
      case "action.execution_failed": {
        executorFailuresByCode[event.code] = (executorFailuresByCode[event.code] ?? 0) + 1;
        break;
      }
      default:
        break;
    }
  }

  const dwell: Record<string, PercentileSummary> = {};
  for (const [stepKey, samples] of dwellByStepKey) {
    dwell[stepKey] = summarize(samples);
  }
  return {
    leadTimeMs: summarize(leadTimes),
    dwellByStepKey: dwell,
    rejectedTotal,
    expiredTotal,
    completedByResult,
    executorFailuresByCode,
  };
}
