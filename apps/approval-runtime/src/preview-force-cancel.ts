import { Result } from "@praha/byethrow";

import type { PrincipalRef } from "@app/approval-core";

export class PreviewForceCancelValidationError extends Error {
  override readonly name = "PreviewForceCancelValidationError";

  constructor(
    readonly code: "invalid_reason" | "invalid_actor",
    message: string,
  ) {
    super(message);
  }
}

export type PreviewForceCancelRequest = {
  reason: string;
  actor: PrincipalRef;
};

const DEFAULT_ACTOR: PrincipalRef = {
  type: "user",
  id: "user:preview-operator",
} as PrincipalRef;

function fail(
  code: PreviewForceCancelValidationError["code"],
  message: string,
): Result.Result<never, PreviewForceCancelValidationError> {
  return Result.fail(new PreviewForceCancelValidationError(code, message));
}

function parseActor(
  value: unknown,
): Result.Result<PrincipalRef, PreviewForceCancelValidationError> {
  if (value === undefined) return Result.succeed(DEFAULT_ACTOR);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("invalid_actor", "actorは{type, id}のobjectである必要があります");
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "user" && record.type !== "agent" && record.type !== "service") {
    return fail("invalid_actor", "actor.typeはuser/agent/serviceのいずれかである必要があります");
  }
  if (typeof record.id !== "string" || record.id.trim().length === 0) {
    return fail("invalid_actor", "actor.idは空でない文字列である必要があります");
  }
  return Result.succeed({ type: record.type, id: record.id } as PrincipalRef);
}

/**
 * Preview force-cancel drillのリクエストbodyを検証する。
 * pure関数のためunit testで直接検証できる。I/OやD1アクセスは行わない。
 */
export function parseForceCancelBody(
  body: unknown,
): Result.Result<PreviewForceCancelRequest, PreviewForceCancelValidationError> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("invalid_reason", "reasonを含むJSON objectを送信してください");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
    return fail("invalid_reason", "force cancelにはhuman-readableなreasonが必要です");
  }
  if (record.reason.length > 500) {
    return fail("invalid_reason", "reasonは500文字以内で指定してください");
  }
  const actor = parseActor(record.actor);
  if (Result.isFailure(actor)) return actor;
  return Result.succeed({ reason: record.reason.trim(), actor: actor.value });
}
