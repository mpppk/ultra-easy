import { Result } from "@praha/byethrow";

export interface FixedClock {
  now(): string;
}

export class InvalidFixedClockInstantError extends Error {
  readonly name = "InvalidFixedClockInstantError";
}

/**
 * テスト中の現在時刻を固定する。
 */
export function createFixedClock(
  instant: string,
): Result.Result<FixedClock, InvalidFixedClockInstantError> {
  const parsed = new Date(instant);

  if (Number.isNaN(parsed.valueOf())) {
    return Result.fail(new InvalidFixedClockInstantError(`不正な時刻です: ${instant}`));
  }

  const normalized = parsed.toISOString();

  return Result.succeed(
    Object.freeze({
      now: () => normalized,
    }),
  );
}
