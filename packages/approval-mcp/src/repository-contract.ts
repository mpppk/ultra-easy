import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type { ActionFingerprint, ActionRequestId, OrganizationId } from "@app/approval-core";

import type {
  McpInvocationRecord,
  McpInvocationRepository,
  McpRouteSnapshot,
  McpRouteSnapshotRepository,
} from "./invocation.ts";
import { alice, agent, org, otherOrg, priorityActionType, T0, ticket } from "./test-support.ts";

const LATER = "2026-09-24T00:01:00.000Z";

function record(overrides: Partial<McpInvocationRecord> = {}): McpInvocationRecord {
  return {
    organizationId: org,
    invocationId: "invocation:1",
    owner: {
      organizationId: org,
      actor: { type: "agent", id: agent },
      authorityPrincipal: { type: "user", id: alice },
    },
    invocationKey: "key-1",
    keySource: "client",
    requestHash: "sha256:request",
    toolName: "ticket_set_priority",
    status: "reserved",
    leaseToken: "lease-1",
    leaseExpiresAt: "2026-09-24T00:00:30.000Z",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** McpInvocationRepository実装が満たすべき原子性 / fencing / tenant scopeのcontract。 */
export function describeMcpInvocationRepositoryContract(
  name: string,
  create: () => McpInvocationRepository,
): void {
  describe(`${name}: McpInvocationRepository contract`, () => {
    it("reserveは同じinvocationを1件だけacquiredにし、以降はexistingを返す", async () => {
      const repository = create();

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          repository.reserve(record({ leaseToken: `lease-${index}` })),
        ),
      );

      const types = results.map((result) => (Result.isSuccess(result) ? result.value.type : "x"));
      expect(types.filter((type) => type === "acquired")).toHaveLength(1);
      expect(types.filter((type) => type === "existing")).toHaveLength(4);
      const existing = results.find(
        (result) => Result.isSuccess(result) && result.value.type === "existing",
      );
      assert(existing && Result.isSuccess(existing));
      expect(existing.value.record.leaseToken).toBe("lease-0");
    });

    it("updateはleaseTokenでfenceされ、patchをmergeして永続化する", async () => {
      const repository = create();
      await repository.reserve(record());

      const lost = await repository.update({
        organizationId: org,
        invocationId: "invocation:1",
        leaseToken: "other",
        patch: { status: "prepared", updatedAt: LATER },
      });
      const updated = await repository.update({
        organizationId: org,
        invocationId: "invocation:1",
        leaseToken: "lease-1",
        patch: {
          status: "prepared",
          actionRequestId: "action-request:1" as ActionRequestId,
          taskId: "task_1",
          taskCreatedAt: LATER,
          ttlMs: null,
          updatedAt: LATER,
        },
      });

      assert(Result.isFailure(lost));
      expect(lost.error.code).toBe("invocation_lease_lost");
      assert(Result.isSuccess(updated));
      const loaded = await repository.load({ organizationId: org, invocationId: "invocation:1" });
      assert(Result.isSuccess(loaded));
      expect(loaded.value).toEqual(updated.value);
      expect(loaded.value).toMatchObject({ status: "prepared", taskId: "task_1", ttlMs: null });
    });

    it("takeOverはlease期限切れ + 期待tokenのreserved / preparedだけを引き継ぐ", async () => {
      const repository = create();
      await repository.reserve(record());
      const takeOver = (now: string, expectedLeaseToken = "lease-1") =>
        repository.takeOver({
          organizationId: org,
          invocationId: "invocation:1",
          expectedLeaseToken,
          leaseToken: "lease-2",
          leaseExpiresAt: "2026-09-24T00:02:00.000Z",
          now,
        });

      const early = await takeOver("2026-09-24T00:00:10.000Z");
      const wrongToken = await takeOver(LATER, "stale");
      const taken = await takeOver(LATER);
      const again = await takeOver(LATER);

      assert(Result.isSuccess(early) && Result.isSuccess(wrongToken));
      expect(early.value).toBeNull();
      expect(wrongToken.value).toBeNull();
      assert(Result.isSuccess(taken) && Result.isSuccess(again));
      expect(taken.value).toMatchObject({ leaseToken: "lease-2", status: "reserved" });
      expect(again.value).toBeNull();

      const oldOwner = await repository.update({
        organizationId: org,
        invocationId: "invocation:1",
        leaseToken: "lease-1",
        patch: { status: "completed", updatedAt: LATER },
      });
      expect(Result.isFailure(oldOwner)).toBe(true);
    });

    it("committed / completed recordはtakeOverもreleaseもできない", async () => {
      const repository = create();
      await repository.reserve(record({ status: "committed", taskId: "task_1" }));

      const taken = await repository.takeOver({
        organizationId: org,
        invocationId: "invocation:1",
        expectedLeaseToken: "lease-1",
        leaseToken: "lease-2",
        leaseExpiresAt: LATER,
        now: LATER,
      });
      await repository.release({
        organizationId: org,
        invocationId: "invocation:1",
        leaseToken: "lease-1",
      });

      assert(Result.isSuccess(taken));
      expect(taken.value).toBeNull();
      const loaded = await repository.load({ organizationId: org, invocationId: "invocation:1" });
      assert(Result.isSuccess(loaded));
      expect(loaded.value?.status).toBe("committed");
    });

    it("releaseはtokenでfenceされ、解放後は同じkeyを再予約できる", async () => {
      const repository = create();
      await repository.reserve(record());

      await repository.release({
        organizationId: org,
        invocationId: "invocation:1",
        leaseToken: "x",
      });
      const kept = await repository.load({ organizationId: org, invocationId: "invocation:1" });
      await repository.release({
        organizationId: org,
        invocationId: "invocation:1",
        leaseToken: "lease-1",
      });
      const reserved = await repository.reserve(record({ leaseToken: "lease-3" }));

      assert(Result.isSuccess(kept));
      expect(kept.value).not.toBeNull();
      assert(Result.isSuccess(reserved));
      expect(reserved.value.type).toBe("acquired");
    });

    it("Task IDはorganization内で一意にinvocationへbindされ、付け替えできない", async () => {
      const repository = create();
      await repository.reserve(record());
      await repository.reserve(record({ invocationId: "invocation:2", leaseToken: "lease-b" }));
      const bind = (invocationId: string, leaseToken: string, taskId: string) =>
        repository.update({
          organizationId: org,
          invocationId,
          leaseToken,
          patch: { taskId, updatedAt: LATER },
        });

      const first = await bind("invocation:1", "lease-1", "task_1");
      const duplicate = await bind("invocation:2", "lease-b", "task_1");
      const rebind = await bind("invocation:1", "lease-1", "task_2");

      expect(Result.isSuccess(first)).toBe(true);
      expect(Result.isFailure(duplicate)).toBe(true);
      expect(Result.isFailure(rebind)).toBe(true);
      const byTask = await repository.loadByTaskId({ organizationId: org, taskId: "task_1" });
      const crossTenant = await repository.loadByTaskId({
        organizationId: otherOrg,
        taskId: "task_1",
      });
      assert(Result.isSuccess(byTask) && Result.isSuccess(crossTenant));
      expect(byTask.value?.invocationId).toBe("invocation:1");
      expect(crossTenant.value).toBeNull();
    });

    it("organizationが違えば同じinvocation IDでも別record", async () => {
      const repository = create();
      await repository.reserve(record());

      const other = await repository.reserve(
        record({ organizationId: otherOrg as OrganizationId }),
      );

      assert(Result.isSuccess(other));
      expect(other.value.type).toBe("acquired");
    });
  });
}

function snapshot(overrides: Partial<McpRouteSnapshot> = {}): McpRouteSnapshot {
  return {
    organizationId: org,
    actionRequestId: "action-request:1" as ActionRequestId,
    actionFingerprint: "sha256:fingerprint" as ActionFingerprint,
    actionType: priorityActionType,
    bindingId: "binding:ticket-priority",
    bindingVersion: 1,
    bindingFingerprint: "sha256:binding-v1",
    exposedToolName: "ticket_set_priority",
    target: { mcpServerId: "ticket-server", toolName: "set_priority" },
    argumentMapping: { resourceType: ticket, resourceIdArgument: "ticketId" },
    createdAt: T0,
    ...overrides,
  };
}

/** McpRouteSnapshotRepository実装のINSERT-only / tenant scope contract。 */
export function describeMcpRouteSnapshotRepositoryContract(
  name: string,
  create: () => McpRouteSnapshotRepository,
): void {
  describe(`${name}: McpRouteSnapshotRepository contract`, () => {
    it("保存したsnapshotを読み、同一内容の再保存は成功し別bindingへの上書きは拒否する", async () => {
      const repository = create();

      const saved = await repository.save(snapshot());
      const same = await repository.save(snapshot({ createdAt: LATER }));
      const rerouted = await repository.save(
        snapshot({
          bindingVersion: 2,
          bindingFingerprint: "sha256:binding-v2",
          target: { mcpServerId: "other", toolName: "set_priority" },
        }),
      );
      const loaded = await repository.load({
        organizationId: org,
        actionRequestId: "action-request:1" as ActionRequestId,
      });
      const crossTenant = await repository.load({
        organizationId: otherOrg,
        actionRequestId: "action-request:1" as ActionRequestId,
      });

      expect(Result.isSuccess(saved) && Result.isSuccess(same)).toBe(true);
      assert(Result.isFailure(rerouted));
      expect(rerouted.error.code).toBe("route_snapshot_conflict");
      assert(Result.isSuccess(loaded) && Result.isSuccess(crossTenant));
      expect(loaded.value).toEqual(snapshot());
      expect(crossTenant.value).toBeNull();
    });
  });
}
