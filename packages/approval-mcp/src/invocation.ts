import { Result } from "@praha/byethrow";

import { sha256CanonicalJson } from "@app/approval-core";
import type {
  ActionAuthority,
  ActionFingerprint,
  ActionOrigin,
  ActionRequestId,
  ActionType,
  ClientId,
  JsonValue,
  OrganizationId,
  PrincipalRef,
} from "@app/approval-core";
import type { ActionRequestPreparation } from "@app/approval-application";

import { McpGatewayError, type McpToolBinding } from "./binding.ts";
import type { McpCallToolResult, McpProtocolError } from "./protocol.ts";

/**
 * logical invocation / MCP Taskのowner identity。
 *
 * 2026-07-28ではtransport sessionをidentity boundaryにしないため、per-requestのtrusted contextから
 * 毎回組み立て、Task作成時のsnapshotと完全一致した場合だけ同じownerとみなす。
 */
export type McpInvocationOwner = {
  organizationId: OrganizationId;
  actor: PrincipalRef;
  authorityPrincipal: PrincipalRef;
  caller?: PrincipalRef;
  clientId?: ClientId;
};

export function invocationOwner(input: {
  organizationId: OrganizationId;
  actor: PrincipalRef;
  authority: ActionAuthority;
  origin: ActionOrigin;
}): McpInvocationOwner {
  return {
    organizationId: input.organizationId,
    actor: { ...input.actor },
    authorityPrincipal: { ...input.authority.principal },
    ...(input.origin.caller ? { caller: { ...input.origin.caller } } : {}),
    ...(input.origin.clientId !== undefined ? { clientId: input.origin.clientId } : {}),
  };
}

function principalKey(principal: PrincipalRef | undefined): string | null {
  return principal ? `${principal.type}:${String(principal.id)}` : null;
}

function ownerKey(owner: McpInvocationOwner): JsonValue {
  return {
    organizationId: String(owner.organizationId),
    actor: principalKey(owner.actor),
    authorityPrincipal: principalKey(owner.authorityPrincipal),
    caller: principalKey(owner.caller),
    clientId: owner.clientId === undefined ? null : String(owner.clientId),
  };
}

export function sameInvocationOwner(left: McpInvocationOwner, right: McpInvocationOwner): boolean {
  return JSON.stringify(ownerKey(left)) === JSON.stringify(ownerKey(right));
}

/** organization / actor / authority / caller / client scopeでlogical invocation keyを閉じたID。 */
export async function mcpInvocationId(input: {
  owner: McpInvocationOwner;
  invocationKey: string;
}): Result.ResultAsync<string, McpGatewayError> {
  const digest = await sha256CanonicalJson({
    version: 1,
    owner: ownerKey(input.owner),
    invocationKey: input.invocationKey,
  });
  if (Result.isFailure(digest)) {
    return Result.fail(new McpGatewayError("invocation_id_failed", false, digest.error.message));
  }
  return Result.succeed(String(digest.value));
}

/**
 * tool名 + canonical argumentsのrequest hash。security-relevantなidentityはinvocation scope側に入る。
 * policy / routingの現在値は含めない（変化しても既存invocationを新規実行へすり替えない）。
 */
export async function mcpInvocationRequestHash(input: {
  toolName: string;
  arguments: Record<string, unknown> | undefined;
}): Result.ResultAsync<string, McpProtocolError> {
  const digest = await sha256CanonicalJson({
    method: "tools/call",
    name: input.toolName,
    arguments: (input.arguments ?? {}) as JsonValue,
  });
  if (Result.isFailure(digest)) {
    return Result.fail({
      code: -32602,
      message: "tools/call arguments cannot be canonicalized",
      data: { detail: digest.error.message },
    });
  }
  return Result.succeed(String(digest.value));
}

export type McpStoredResponse =
  | { type: "result"; result: McpCallToolResult }
  | { type: "error"; error: McpProtocolError }
  /** commit前にtasks/cancelされたlogical invocation。 */
  | { type: "cancelled" };

/**
 * logical `tools/call` 1件のGateway状態（protocol projection / routing / invocation metadataのみ）。
 *
 * - reserved: key予約済み。まだprepareしていない（副作用なし）
 * - prepared: prepare + admission（Task予約）済み、commit未完了。crash時はpreparationから同じPlanで再commitする
 * - committed: ActionRequestがcommit済みでMCP Taskとして追跡中
 * - completed: 最終responseを保存済み。replayは同じresponseを返す
 *
 * Approval / Authorization / execution lifecycleの正本はActionRequestにあり、ここへ複製しない。
 */
export type McpInvocationRecord = {
  organizationId: OrganizationId;
  invocationId: string;
  owner: McpInvocationOwner;
  invocationKey: string;
  keySource: "client" | "server";
  requestHash: string;
  toolName: string;
  status: "reserved" | "prepared" | "committed" | "completed";
  leaseToken: string;
  leaseExpiresAt: string;
  actionRequestId?: ActionRequestId;
  preparation?: ActionRequestPreparation;
  /** approval requiredの場合に予約したMCP Task ID（logical invocationと1:1）。 */
  taskId?: string;
  taskCreatedAt?: string;
  ttlMs?: number | null;
  cancelRequestedAt?: string;
  response?: McpStoredResponse;
  createdAt: string;
  updatedAt: string;
};

export type McpInvocationPatch = Partial<
  Pick<
    McpInvocationRecord,
    | "status"
    | "leaseExpiresAt"
    | "actionRequestId"
    | "preparation"
    | "taskId"
    | "taskCreatedAt"
    | "ttlMs"
    | "cancelRequestedAt"
    | "response"
  >
> & { updatedAt: string };

export type McpInvocationReserveResult =
  | { type: "acquired"; record: McpInvocationRecord }
  | { type: "existing"; record: McpInvocationRecord };

export interface McpInvocationRepository {
  /** 同じinvocationIdが無ければ原子的に作成する。並行reserveでは1件だけがacquiredになる。 */
  reserve(
    record: McpInvocationRecord,
  ): Result.ResultAsync<McpInvocationReserveResult, McpGatewayError>;

  /**
   * leaseが期限切れのrecordだけをcompare-and-setで引き継ぐ。
   * 引き継げなかった場合（他workerが先に取得 / lease有効）はnull。
   */
  takeOver(input: {
    organizationId: OrganizationId;
    invocationId: string;
    expectedLeaseToken: string;
    leaseToken: string;
    leaseExpiresAt: string;
    now: string;
  }): Result.ResultAsync<McpInvocationRecord | null, McpGatewayError>;

  /** leaseTokenでfenceした更新。lease喪失時は `invocation_lease_lost`。 */
  update(input: {
    organizationId: OrganizationId;
    invocationId: string;
    leaseToken: string;
    patch: McpInvocationPatch;
  }): Result.ResultAsync<McpInvocationRecord, McpGatewayError>;

  /** まだ何もcommitしていない（reserved / prepared）recordを削除し、同じkeyで再実行可能にする。 */
  release(input: {
    organizationId: OrganizationId;
    invocationId: string;
    leaseToken: string;
  }): Result.ResultAsync<void, McpGatewayError>;

  load(input: {
    organizationId: OrganizationId;
    invocationId: string;
  }): Result.ResultAsync<McpInvocationRecord | null, McpGatewayError>;

  loadByTaskId(input: {
    organizationId: OrganizationId;
    taskId: string;
  }): Result.ResultAsync<McpInvocationRecord | null, McpGatewayError>;
}

export function leaseLostError(): McpGatewayError {
  return new McpGatewayError(
    "invocation_lease_lost",
    true,
    "MCP invocationのleaseを失ったため更新できません",
  );
}

/**
 * 承認待ち中にbindingのrouting（downstream target / argument mapping）が変わっても、
 * 承認されたActionと別targetへすり替わらないよう、admission時にActionRequestへbindするsnapshot。
 */
export type McpRouteSnapshot = {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  actionFingerprint: ActionFingerprint;
  actionType: ActionType;
  bindingId: string;
  bindingVersion: number;
  bindingFingerprint: string;
  exposedToolName: string;
  target: McpToolBinding["target"];
  argumentMapping: McpToolBinding["argumentMapping"];
  createdAt: string;
};

export interface McpRouteSnapshotRepository {
  /** INSERT-only。同じActionRequestに別snapshotを上書きしない（同一内容なら成功）。 */
  save(snapshot: McpRouteSnapshot): Result.ResultAsync<void, McpGatewayError>;

  load(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<McpRouteSnapshot | null, McpGatewayError>;
}

export function sameRouteSnapshot(left: McpRouteSnapshot, right: McpRouteSnapshot): boolean {
  return (
    String(left.organizationId) === String(right.organizationId) &&
    String(left.actionRequestId) === String(right.actionRequestId) &&
    String(left.actionFingerprint) === String(right.actionFingerprint) &&
    left.bindingFingerprint === right.bindingFingerprint
  );
}
