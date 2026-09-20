import { Result } from "@praha/byethrow";

import type { OrganizationId } from "./domain/brand.ts";
import type { PrincipalRef } from "./domain/principal.ts";

export type RateLimitOperation =
  | "action_request.submit"
  | "approval_decision.submit"
  | "mcp.tools.call";

export type RateLimitPolicy = {
  limit: number;
  windowSeconds: number;
};

export type RateLimitRequest = {
  organizationId: OrganizationId;
  principal: PrincipalRef;
  operation: RateLimitOperation;
  policy: RateLimitPolicy;
  now: string;
};

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: string;
  retryAfterSeconds: number;
};

export class RateLimitProviderError extends Error {
  readonly name = "RateLimitProviderError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export interface RateLimiter {
  consume(
    request: RateLimitRequest,
  ): Result.ResultAsync<RateLimitDecision, RateLimitProviderError>;
}

export function rateLimitScopeKey(input: {
  organizationId: OrganizationId;
  principal: PrincipalRef;
  operation: RateLimitOperation;
}): string {
  return [
    encodeURIComponent(String(input.organizationId)),
    encodeURIComponent(input.principal.type),
    encodeURIComponent(String(input.principal.id)),
    encodeURIComponent(input.operation),
  ].join(":");
}

function invalidPolicy(policy: RateLimitPolicy): boolean {
  return (
    !Number.isSafeInteger(policy.limit) ||
    policy.limit < 1 ||
    !Number.isSafeInteger(policy.windowSeconds) ||
    policy.windowSeconds < 1
  );
}

type FixedWindowCounter = {
  windowStartMs: number;
  count: number;
};

export class InMemoryFixedWindowRateLimiter implements RateLimiter {
  private readonly counters = new Map<string, FixedWindowCounter>();

  consume(
    request: RateLimitRequest,
  ): Result.ResultAsync<RateLimitDecision, RateLimitProviderError> {
    if (invalidPolicy(request.policy)) {
      return Promise.resolve(
        Result.fail(
          new RateLimitProviderError(
            "invalid_rate_limit_policy",
            false,
            "rate limit policyは正のsafe integerである必要があります",
          ),
        ),
      );
    }

    const nowMs = Date.parse(request.now);
    if (!Number.isFinite(nowMs)) {
      return Promise.resolve(
        Result.fail(
          new RateLimitProviderError(
            "invalid_rate_limit_timestamp",
            false,
            `rate limit timestampが不正です: ${request.now}`,
          ),
        ),
      );
    }

    const windowMs = request.policy.windowSeconds * 1000;
    const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
    const scopeKey = rateLimitScopeKey(request);
    const counterKey = `${scopeKey}:${windowStartMs}`;
    const current = this.counters.get(counterKey) ?? { windowStartMs, count: 0 };
    const nextCount = current.count + 1;
    this.counters.set(counterKey, { windowStartMs, count: nextCount });

    const resetAtMs = windowStartMs + windowMs;
    const allowed = nextCount <= request.policy.limit;
    return Promise.resolve(
      Result.succeed({
        allowed,
        limit: request.policy.limit,
        remaining: Math.max(0, request.policy.limit - nextCount),
        resetAt: new Date(resetAtMs).toISOString(),
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
      }),
    );
  }
}

export const DEFAULT_ACTION_REQUEST_RATE_LIMIT: RateLimitPolicy = {
  limit: 60,
  windowSeconds: 60,
};
