import { Result } from "@praha/byethrow";

import {
  RateLimitProviderError,
  rateLimitScopeKey,
  type RateLimitDecision,
  type RateLimiter,
  type RateLimitRequest,
} from "@app/approval-core";

import type { D1DatabaseLike, D1PreparedStatementLike } from "./materialized-plan-repository.ts";

type StoredCountRow = { count: number };

const incrementCounter = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<StoredCountRow | null> =>
    statement.first<StoredCountRow>(),
  catch: (error): RateLimitProviderError =>
    new RateLimitProviderError(
      "rate_limit_store_failed",
      true,
      error instanceof Error ? error.message : "rate limit counterの更新に失敗しました",
    ),
});

function invalidPolicy(request: RateLimitRequest): boolean {
  return (
    !Number.isSafeInteger(request.policy.limit) ||
    request.policy.limit < 1 ||
    !Number.isSafeInteger(request.policy.windowSeconds) ||
    request.policy.windowSeconds < 1
  );
}

/**
 * Shared fixed-window limiter backed by D1.
 *
 * The primary key includes organization + principal + operation through
 * rateLimitScopeKey(), so one tenant/principal cannot consume another scope.
 * SQLite UPSERT increments the counter atomically across Worker isolates.
 */
export class D1FixedWindowRateLimiter implements RateLimiter {
  constructor(private readonly db: D1DatabaseLike) {}

  async consume(
    request: RateLimitRequest,
  ): Result.ResultAsync<RateLimitDecision, RateLimitProviderError> {
    if (invalidPolicy(request)) {
      return Result.fail(
        new RateLimitProviderError(
          "invalid_rate_limit_policy",
          false,
          "rate limit policyは正のsafe integerである必要があります",
        ),
      );
    }

    const nowMs = Date.parse(request.now);
    if (!Number.isFinite(nowMs)) {
      return Result.fail(
        new RateLimitProviderError(
          "invalid_rate_limit_timestamp",
          false,
          `rate limit timestampが不正です: ${request.now}`,
        ),
      );
    }

    const windowMs = request.policy.windowSeconds * 1000;
    const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
    const resetAtMs = windowStartMs + windowMs;
    const scopeKey = rateLimitScopeKey(request);

    const incremented = await incrementCounter(
      this.db
        .prepare(
          `INSERT INTO rate_limit_counters (
             scope_key, window_start_ms, count, reset_at_ms
           ) VALUES (?, ?, 1, ?)
           ON CONFLICT(scope_key, window_start_ms)
           DO UPDATE SET count = rate_limit_counters.count + 1
           RETURNING count`,
        )
        .bind(scopeKey, windowStartMs, resetAtMs),
    );
    if (Result.isFailure(incremented)) return incremented;
    if (!incremented.value || !Number.isFinite(incremented.value.count)) {
      return Result.fail(
        new RateLimitProviderError(
          "invalid_rate_limit_store_result",
          true,
          "rate limit counterの更新結果が不正です",
        ),
      );
    }

    const count = incremented.value.count;
    const allowed = count <= request.policy.limit;
    return Result.succeed({
      allowed,
      limit: request.policy.limit,
      remaining: Math.max(0, request.policy.limit - count),
      resetAt: new Date(resetAtMs).toISOString(),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
    });
  }
}
