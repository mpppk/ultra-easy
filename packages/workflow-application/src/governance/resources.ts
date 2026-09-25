import { Result } from "@praha/byethrow";

import type { OrganizationId } from "@app/approval-core";
import type { NodeRunId, WorkflowDefinitionId, WorkflowRunId } from "@app/workflow-core";

import { EffectHandlerError } from "../ports.ts";
import type { WorkflowAdmissionController, WorkflowRepositoryError } from "../ports.ts";
import type { SandboxAdmission } from "../program.ts";

/**
 * 同時実行枠（lease）と累積量（counter）のquota ledger。scope keyは
 * `tenant:<org>:...` / `system:...` / `run:<runId>:...` / `node:<nodeRunId>:...`。
 * acquire / incrementは上限を超えない場合だけ原子的に記録し、IDで冪等である。
 */
export interface QuotaLedger {
  acquire(input: {
    leaseId: string;
    scopeKey: string;
    amount: number;
    limit: number;
    now: string;
    expiresAt: string;
  }): Result.ResultAsync<
    { type: "acquired" } | { type: "exhausted"; current: number },
    WorkflowRepositoryError
  >;
  release(input: { leaseId: string }): Result.ResultAsync<void, WorkflowRepositoryError>;
  increment(input: {
    scopeKey: string;
    idempotencyKey: string;
    amount: number;
    limit: number;
    now: string;
  }): Result.ResultAsync<
    { type: "incremented" | "existing" } | { type: "exhausted"; current: number },
    WorkflowRepositoryError
  >;
}

export type ResourceLimits = {
  tenant: {
    /** 同時に非終端でいられるWorkflowRun数。 */
    maxActiveRuns: number;
    /** 同時に動くsandbox数。 */
    maxConcurrentSandboxes: number;
    /** 1 runで発行できるchild ActionRequest数。 */
    maxActionsPerRun: number;
  };
  system: {
    maxActiveRuns: number;
    maxConcurrentSandboxes: number;
  };
  /** leaseの自動失効（process異常終了時のleak防止）。 */
  runLeaseSeconds: number;
  sandboxLeaseSeconds: number;
};

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  tenant: { maxActiveRuns: 100, maxConcurrentSandboxes: 4, maxActionsPerRun: 200 },
  system: { maxActiveRuns: 1000, maxConcurrentSandboxes: 16 },
  runLeaseSeconds: 7 * 24 * 60 * 60,
  sandboxLeaseSeconds: 60,
};

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString();
}

function ledgerError(error: {
  code: string;
  retriable: boolean;
  message: string;
}): EffectHandlerError {
  return new EffectHandlerError(error.code, error.retriable, error.message);
}

/**
 * Resource Governor / Admission Controller（#161）。
 *
 * - tenantごとの上限（active runs / 同時sandbox / run内Action数）と、system全体の上限を分けて強制する。
 *   tenant上限 < system上限なので、noisy tenantがsystem capacityを占有しきれない
 * - 上限超過は`quota_exceeded`としてfail-closedに扱う（Run開始は拒否、sandboxは枠が空くまで待機、
 *   Action数はNodeの失敗としてdurableに記録される）
 */
export class ResourceGovernor implements WorkflowAdmissionController, SandboxAdmission {
  constructor(
    private readonly deps: {
      ledger: QuotaLedger;
      limits?: ResourceLimits;
      clock: { now(): string };
    },
  ) {}

  private get limits(): ResourceLimits {
    return this.deps.limits ?? DEFAULT_RESOURCE_LIMITS;
  }

  /** 複数scopeのleaseを順に取得し、途中で上限に達したら取得済みを戻す。 */
  private async acquireAll(
    leases: { leaseId: string; scopeKey: string; limit: number }[],
    expiresAt: string,
  ): Result.ResultAsync<
    { type: "acquired" } | { type: "denied"; scopeKey: string },
    EffectHandlerError
  > {
    const acquired: string[] = [];
    for (const lease of leases) {
      const result = await this.deps.ledger.acquire({
        ...lease,
        amount: 1,
        now: this.deps.clock.now(),
        expiresAt,
      });
      if (Result.isFailure(result)) {
        for (const leaseId of acquired) await this.deps.ledger.release({ leaseId });
        return Result.fail(ledgerError(result.error));
      }
      if (result.value.type === "exhausted") {
        for (const leaseId of acquired) await this.deps.ledger.release({ leaseId });
        return Result.succeed({ type: "denied", scopeKey: lease.scopeKey });
      }
      acquired.push(lease.leaseId);
    }
    return Result.succeed({ type: "acquired" });
  }

  async admitRun(input: {
    organizationId: OrganizationId;
    definitionId: WorkflowDefinitionId;
    runId: WorkflowRunId;
    depth: number;
  }): Result.ResultAsync<
    { type: "admitted" } | { type: "denied"; code: string; message: string },
    EffectHandlerError
  > {
    const org = String(input.organizationId);
    const run = String(input.runId);
    const acquired = await this.acquireAll(
      [
        {
          leaseId: `run:${org}:${run}:tenant`,
          scopeKey: `tenant:${org}:active_runs`,
          limit: this.limits.tenant.maxActiveRuns,
        },
        {
          leaseId: `run:${org}:${run}:system`,
          scopeKey: "system:active_runs",
          limit: this.limits.system.maxActiveRuns,
        },
      ],
      addSeconds(this.deps.clock.now(), this.limits.runLeaseSeconds),
    );
    if (Result.isFailure(acquired)) return acquired;
    if (acquired.value.type === "denied") {
      return Result.succeed({
        type: "denied",
        code: "quota_exceeded",
        message: `WorkflowRunの同時実行数が上限に達しています（${acquired.value.scopeKey}）`,
      });
    }
    return Result.succeed({ type: "admitted" });
  }

  async releaseRun(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
  }): Result.ResultAsync<void, EffectHandlerError> {
    const prefix = `run:${String(input.organizationId)}:${String(input.runId)}`;
    for (const leaseId of [`${prefix}:tenant`, `${prefix}:system`]) {
      const released = await this.deps.ledger.release({ leaseId });
      if (Result.isFailure(released)) return Result.fail(ledgerError(released.error));
    }
    return Result.succeed(undefined);
  }

  async acquire(input: {
    organizationId: OrganizationId;
    runId?: WorkflowRunId;
    nodeRunId?: NodeRunId;
  }): Result.ResultAsync<
    | { type: "admitted"; release: () => Promise<void> }
    | { type: "denied"; code: string; message: string },
    EffectHandlerError
  > {
    const org = String(input.organizationId);
    const id = `sandbox:${org}:${globalThis.crypto.randomUUID()}`;
    const leases = [
      {
        leaseId: `${id}:tenant`,
        scopeKey: `tenant:${org}:sandboxes`,
        limit: this.limits.tenant.maxConcurrentSandboxes,
      },
      {
        leaseId: `${id}:system`,
        scopeKey: "system:sandboxes",
        limit: this.limits.system.maxConcurrentSandboxes,
      },
    ];
    const acquired = await this.acquireAll(
      leases,
      addSeconds(this.deps.clock.now(), this.limits.sandboxLeaseSeconds),
    );
    if (Result.isFailure(acquired)) return acquired;
    if (acquired.value.type === "denied") {
      return Result.succeed({
        type: "denied",
        code: "quota_exceeded",
        message: `sandboxの同時実行数が上限に達しています（${acquired.value.scopeKey}）`,
      });
    }
    return Result.succeed({
      type: "admitted",
      release: async () => {
        for (const lease of leases) await this.deps.ledger.release({ leaseId: lease.leaseId });
      },
    });
  }

  /** runが発行するchild Actionを数える（effect IDで冪等）。 */
  async chargeAction(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
    effectId: string;
  }): Result.ResultAsync<
    { type: "charged" } | { type: "denied"; code: string; message: string },
    EffectHandlerError
  > {
    const charged = await this.deps.ledger.increment({
      scopeKey: `run:${String(input.organizationId)}:${String(input.runId)}:actions`,
      idempotencyKey: input.effectId,
      amount: 1,
      limit: this.limits.tenant.maxActionsPerRun,
      now: this.deps.clock.now(),
    });
    if (Result.isFailure(charged)) return Result.fail(ledgerError(charged.error));
    if (charged.value.type === "exhausted") {
      return Result.succeed({
        type: "denied",
        code: "quota_exceeded",
        message: `1 runで発行できるAction数の上限（${this.limits.tenant.maxActionsPerRun}）に達しました`,
      });
    }
    return Result.succeed({ type: "charged" });
  }
}
