import { Result } from "@praha/byethrow";
import { CronExpressionParser } from "cron-parser";

/** Schedule times are UTC minute boundaries. Seconds and nonstandard Cron extensions are rejected. */
export class ScheduleExpressionError extends Error {
  readonly code = "invalid_cron";
}

export function nextScheduleSlot(
  expression: string,
  after: string,
): Result.Result<string, ScheduleExpressionError> {
  if (!/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(expression)) {
    return Result.fail(
      new ScheduleExpressionError("A schedule requires a five-field UTC cron expression"),
    );
  }
  return Result.try({
    try: () =>
      CronExpressionParser.parse(expression, { currentDate: after, tz: "UTC" })
        .next()
        .toDate()
        .toISOString(),
    catch: () => new ScheduleExpressionError("Invalid cron expression"),
  });
}
