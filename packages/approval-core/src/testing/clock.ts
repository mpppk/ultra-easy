export interface FixedClock {
  now(): string;
}

/**
 * テスト中の現在時刻を固定する。
 */
export function createFixedClock(instant: string): FixedClock {
  const parsed = new Date(instant);

  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`不正な時刻です: ${instant}`);
  }

  const normalized = parsed.toISOString();

  return Object.freeze({
    now: () => normalized,
  });
}
