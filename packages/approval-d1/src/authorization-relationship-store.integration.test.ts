import { Result } from "@praha/byethrow";
import { assert, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  AUTHORIZATION_ADMIN_RESOURCE,
  AuthorizationRelationshipCoordinator,
  AuthorizationRelationshipExecutor,
  RelationshipGatewayError,
  relationshipTupleKey,
  type ActionExecutionRequest,
  type ActionFingerprint,
  type ActionRequestId,
  type ActionType,
  type OrganizationId,
  type RelationshipGatewayFailureEffect,
  type RelationshipTuple,
  type RelationshipTupleGateway,
  type UserId,
} from "@app/approval-core";

import { D1AuthorizationRelationshipStore } from "./authorization-relationship-store.ts";
import { migratedSqliteD1, type SqliteD1Database } from "./testing/sqlite-d1.ts";

const org = "organization:tenant-a" as OrganizationId;
const editor = { type: "user" as const, id: "user:editor" as UserId };
const tuple: RelationshipTuple = {
  user: "user:alice",
  relation: "can_execute",
  object: "ticket:T-1",
};

type ApplyBehavior =
  | { type: "ok" }
  | {
      type: "fail";
      applied: boolean;
      code: string;
      effect: RelationshipGatewayFailureEffect;
      retriable: boolean;
    }
  | { type: "hook"; before: () => Promise<void> };

/** In-memory provider with scripted failures (response loss, 429/5xx, 4xx, in-flight races). */
class FakeGateway implements RelationshipTupleGateway {
  readonly authorizationModelId = "model-1";
  readonly tuples = new Set<string>();
  readonly applies: Array<{ tuple: RelationshipTuple; present: boolean }> = [];
  readonly applyScript: ApplyBehavior[] = [];
  readFailures = 0;

  private key(organizationId: OrganizationId, value: RelationshipTuple): string {
    return `${String(organizationId)}|${value.user}|${value.relation}|${value.object}`;
  }

  async read(input: { organizationId: OrganizationId; tuple: RelationshipTuple }) {
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      return Result.fail(new RelationshipGatewayError("fga_http_503", "ambiguous", true, "down"));
    }
    return Result.succeed(this.tuples.has(this.key(input.organizationId, input.tuple)));
  }

  async apply(input: {
    organizationId: OrganizationId;
    tuple: RelationshipTuple;
    present: boolean;
  }) {
    this.applies.push({ tuple: input.tuple, present: input.present });
    const behavior = this.applyScript.shift() ?? { type: "ok" };
    if (behavior.type === "hook") await behavior.before();
    const key = this.key(input.organizationId, input.tuple);
    const effect = () => (input.present ? this.tuples.add(key) : this.tuples.delete(key));
    if (behavior.type === "fail") {
      if (behavior.applied) effect();
      return Result.fail(
        new RelationshipGatewayError(
          behavior.code,
          behavior.effect,
          behavior.retriable,
          behavior.code,
        ),
      );
    }
    effect();
    return Result.succeed(undefined);
  }

  has(value: RelationshipTuple): boolean {
    return this.tuples.has(this.key(org, value));
  }
}

let db: SqliteD1Database;
let store: D1AuthorizationRelationshipStore;
let gateway: FakeGateway;
let clock: { value: number; now(): string };
let coordinator: AuthorizationRelationshipCoordinator;

beforeEach(() => {
  db = migratedSqliteD1();
  store = new D1AuthorizationRelationshipStore(db);
  gateway = new FakeGateway();
  clock = {
    value: Date.parse("2026-09-24T00:00:00.000Z"),
    now() {
      this.value += 1000;
      return new Date(this.value).toISOString();
    },
  };
  coordinator = new AuthorizationRelationshipCoordinator({ store, gateway, clock });
});

function submit(mutationKey: string, operation: "write" | "delete", value = tuple) {
  return coordinator.submit({
    organizationId: org,
    actionRequestId: `action:${mutationKey}` as ActionRequestId,
    mutationKey,
    actor: editor,
    update: { operation, tuple: value },
  });
}

function events(mutationKey?: string): string[] {
  const rows = db.db
    .prepare(
      `SELECT event_type, mutation_key FROM authorization_relationship_events
        WHERE organization_id = ? ORDER BY sequence`,
    )
    .all(org) as Array<{ event_type: string; mutation_key: string }>;
  return rows
    .filter((row) => mutationKey === undefined || row.mutation_key === mutationKey)
    .map((row) => row.event_type.replace("authorization.relationship_", ""));
}

async function tupleKey(value = tuple): Promise<string> {
  const key = await relationshipTupleKey({ organizationId: org, tuple: value });
  assert(Result.isSuccess(key));
  return key.value;
}

async function relationship(value = tuple) {
  const loaded = await store.get({ organizationId: org, tupleKey: await tupleKey(value) });
  assert(Result.isSuccess(loaded) && loaded.value);
  return loaded.value;
}

describe("governed relationship mutation protocol (AC-M9-006 / AC-M9-007 / AC-M9-009)", () => {
  it("write → prepared intent + requested audit before FGA → observed → confirmed", async () => {
    const outcome = await submit("m-1", "write");
    assert(Result.isSuccess(outcome));
    expect(outcome.value).toMatchObject({ status: "confirmed", mutation: { revision: 1 } });
    expect(gateway.has(tuple)).toBe(true);
    expect(events()).toEqual(["change_requested", "apply_started", "change_confirmed"]);
    const loaded = await relationship();
    expect(loaded.relationship).toMatchObject({
      desiredPresent: true,
      revision: 1,
      confirmedRevision: 1,
      confirmedPresent: true,
      syncStatus: "confirmed",
      latestActionRequestId: "action:m-1",
    });
  });

  it("same mutation retry reuses mutationKey/revision without duplicate audit or provider calls", async () => {
    assert(Result.isSuccess(await submit("m-1", "write")));
    const appliesBefore = gateway.applies.length;
    const retried = await submit("m-1", "write");
    assert(Result.isSuccess(retried));
    expect(retried.value).toMatchObject({ status: "confirmed", mutation: { revision: 1 } });
    expect(gateway.applies.length).toBe(appliesBefore);
    expect(events()).toEqual(["change_requested", "apply_started", "change_confirmed"]);

    assert(Result.isSuccess(await submit("m-2", "delete")));
    const deleteRetry = await submit("m-2", "delete");
    assert(Result.isSuccess(deleteRetry));
    expect(deleteRetry.value.mutation.revision).toBe(2);
    expect(events("m-2")).toEqual(["change_requested", "apply_started", "change_confirmed"]);
    expect(gateway.has(tuple)).toBe(false);
  });

  it("A grant applied but response lost → B revoke confirmed → A retry superseded; revoke survives", async () => {
    gateway.applyScript.push({
      type: "fail",
      applied: true,
      code: "network_error",
      effect: "ambiguous",
      retriable: true,
    });
    const a = await submit("A", "write");
    assert(Result.isSuccess(a));
    expect(a.value).toMatchObject({ status: "indeterminate", mutation: { revision: 1 } });
    expect(events("A")).toEqual(["change_requested", "apply_started", "change_indeterminate"]);
    expect(gateway.has(tuple)).toBe(true);

    const b = await submit("B", "delete");
    assert(Result.isSuccess(b));
    expect(b.value).toMatchObject({ status: "confirmed", mutation: { revision: 2 } });
    expect(gateway.has(tuple)).toBe(false);

    const writesBefore = gateway.applies.filter((call) => call.present).length;
    const retry = await submit("A", "write");
    assert(Result.isSuccess(retry));
    expect(retry.value).toMatchObject({ status: "superseded", mutation: { revision: 1 } });
    expect(gateway.applies.filter((call) => call.present).length).toBe(writesBefore);
    expect(gateway.has(tuple)).toBe(false);
    expect(events("A")).toContain("change_superseded");
    expect(events("A")).not.toContain("change_confirmed");
    expect((await relationship()).relationship).toMatchObject({
      desiredPresent: false,
      revision: 2,
      confirmedRevision: 2,
      syncStatus: "confirmed",
    });
  });

  it("A's in-flight grant landing after B's revoke is repaired back to the latest desired state", async () => {
    gateway.applyScript.push({
      type: "hook",
      before: async () => {
        // While A's write is in flight, B revokes and confirms.
        const b = await submit("B", "delete");
        assert(Result.isSuccess(b));
        expect(b.value.status).toBe("confirmed");
      },
    });
    const a = await submit("A", "write");
    assert(Result.isSuccess(a));
    expect(a.value.status).toBe("superseded");
    expect(gateway.has(tuple)).toBe(false);
    expect(events("B")).toContain("drift_repaired");
  });

  it("FGA success → crash before D1 confirm keeps a durable intent; reconciliation confirms it", async () => {
    // prepare, markApplying succeed; the confirm batch (3rd) fails like a worker crash.
    db.failNextBatchAt = 3;
    const crashed = await submit("m-1", "write");
    assert(Result.isFailure(crashed));
    expect(gateway.has(tuple)).toBe(true);
    expect(events()).toEqual(["change_requested", "apply_started"]);
    expect((await relationship()).mutations[0]).toMatchObject({ status: "applying" });

    const early = await coordinator.reconcilePending({ organizationId: org, graceMs: 60_000 });
    assert(Result.isSuccess(early));
    expect(early.value.reconciled).toBe(0);

    clock.value += 120_000;
    const reconciled = await coordinator.reconcilePending({ organizationId: org });
    assert(Result.isSuccess(reconciled));
    expect(reconciled.value.outcomes).toEqual([
      { tupleKey: await tupleKey(), status: "confirmed" },
    ]);
    expect(events()).toEqual([
      "change_requested",
      "apply_started",
      "apply_started",
      "change_confirmed",
    ]);
    expect(gateway.applies).toHaveLength(1);
  });

  it("crash before the provider call (prepared only) converges on reconciliation", async () => {
    const key = await tupleKey();
    const prepared = await store.prepare({
      organizationId: org,
      mutationKey: "m-1",
      actionRequestId: "action:m-1" as ActionRequestId,
      tupleKey: key,
      tuple,
      objectType: "ticket",
      operation: "write",
      desiredPresent: true,
      actor: editor,
      authorizationModelId: "model-1",
      requestedAt: clock.now(),
    });
    assert(Result.isSuccess(prepared));
    expect(gateway.applies).toHaveLength(0);
    clock.value += 120_000;
    const reconciled = await coordinator.reconcilePending({ organizationId: org });
    assert(Result.isSuccess(reconciled));
    expect(reconciled.value.outcomes[0]?.status).toBe("confirmed");
    expect(gateway.has(tuple)).toBe(true);
  });

  it("timeout after possible apply → indeterminate → reconcile converges", async () => {
    gateway.applyScript.push({
      type: "fail",
      applied: false,
      code: "fga_http_504",
      effect: "ambiguous",
      retriable: true,
    });
    const first = await submit("m-1", "write");
    assert(Result.isSuccess(first));
    expect(first.value).toMatchObject({ status: "indeterminate", errorCode: "fga_http_504" });
    expect((await relationship()).relationship.syncStatus).toBe("indeterminate");
    const reconciled = await coordinator.reconcilePending({ organizationId: org });
    assert(Result.isSuccess(reconciled));
    expect(reconciled.value.outcomes[0]?.status).toBe("confirmed");
    expect(gateway.has(tuple)).toBe(true);
  });

  it("provider 429 and read outage are retriable/indeterminate, never confirmed", async () => {
    gateway.applyScript.push({
      type: "fail",
      applied: false,
      code: "fga_http_429",
      effect: "rejected",
      retriable: true,
    });
    const limited = await submit("m-1", "write");
    assert(Result.isSuccess(limited));
    expect(limited.value.status).toBe("indeterminate");

    gateway.readFailures = 1;
    const outage = await submit("m-2", "delete");
    assert(Result.isSuccess(outage));
    expect(outage.value.status).toBe("indeterminate");
    expect(events()).not.toContain("change_confirmed");
  });

  it("permanent 4xx → failed without false confirmation", async () => {
    gateway.applyScript.push({
      type: "fail",
      applied: false,
      code: "fga_http_400",
      effect: "rejected",
      retriable: false,
    });
    const outcome = await submit("m-1", "write");
    assert(Result.isSuccess(outcome));
    expect(outcome.value).toMatchObject({ status: "failed", errorCode: "fga_http_400" });
    expect(events()).toEqual(["change_requested", "apply_started", "change_failed"]);
    expect((await relationship()).relationship).toMatchObject({
      syncStatus: "failed",
      confirmedRevision: null,
      lastErrorCode: "fga_http_400",
    });
    const reconciled = await coordinator.reconcilePending({ organizationId: org });
    assert(Result.isSuccess(reconciled));
    expect(reconciled.value.reconciled).toBe(0);
  });

  it("4xx on an already-matching provider state (duplicate write) confirms from observation", async () => {
    gateway.applyScript.push({
      type: "fail",
      applied: true,
      code: "fga_http_400",
      effect: "rejected",
      retriable: false,
    });
    const outcome = await submit("m-1", "write");
    assert(Result.isSuccess(outcome));
    expect(outcome.value.status).toBe("confirmed");
  });

  it("concurrent same-tuple mutations get a total revision order; stale one never reaches FGA", async () => {
    const key = await tupleKey();
    const base = {
      organizationId: org,
      tupleKey: key,
      tuple,
      objectType: "ticket",
      actor: editor,
      authorizationModelId: "model-1",
    };
    const [a, b] = await Promise.all([
      store.prepare({
        ...base,
        mutationKey: "A",
        actionRequestId: "action:A" as ActionRequestId,
        operation: "write",
        desiredPresent: true,
        requestedAt: clock.now(),
      }),
      store.prepare({
        ...base,
        mutationKey: "B",
        actionRequestId: "action:B" as ActionRequestId,
        operation: "delete",
        desiredPresent: false,
        requestedAt: clock.now(),
      }),
    ]);
    assert(Result.isSuccess(a) && Result.isSuccess(b));
    expect([a.value.mutation.revision, b.value.mutation.revision].sort((x, y) => x - y)).toEqual([
      1, 2,
    ]);

    const staleFirst = await coordinator.apply(a.value.mutation);
    assert(Result.isSuccess(staleFirst));
    expect(staleFirst.value.status).toBe("superseded");
    expect(gateway.applies).toHaveLength(0);

    const latest = await coordinator.apply(b.value.mutation);
    assert(Result.isSuccess(latest));
    expect(latest.value.status).toBe("confirmed");
    expect(gateway.has(tuple)).toBe(false);
  });

  it("pre-FGA prepare batch is atomic: a failed batch leaves no intent, state, audit or provider call", async () => {
    db.failNextBatchAt = 1;
    const failed = await submit("m-1", "write");
    assert(Result.isFailure(failed));
    expect(events()).toEqual([]);
    expect(gateway.applies).toHaveLength(0);
    const loaded = await store.get({ organizationId: org, tupleKey: await tupleKey() });
    assert(Result.isSuccess(loaded));
    expect(loaded.value).toBeNull();
  });

  it("drift of a confirmed tuple is repaired to the latest desired state", async () => {
    assert(Result.isSuccess(await submit("m-1", "write")));
    gateway.tuples.clear();
    const repaired = await coordinator.reconcileTuple({
      organizationId: org,
      tupleKey: await tupleKey(),
    });
    assert(Result.isSuccess(repaired));
    expect(gateway.has(tuple)).toBe(true);
    expect(events()).toContain("drift_repaired");
  });
});

describe("AuthorizationRelationshipExecutor (AC-M9-004 / AC-M9-005)", () => {
  function request(
    input: unknown,
    resource = AUTHORIZATION_ADMIN_RESOURCE,
  ): ActionExecutionRequest {
    return {
      organizationId: org,
      actionRequestId: "action:exec-1" as ActionRequestId,
      actionFingerprint: "sha256:fp" as ActionFingerprint,
      idempotencyKey: "ue:v1:org:action:exec-1",
      action: {
        definition: {
          key: "authorization:relationship-update" as never,
          version: 1,
          actionType: "authorization.relationship.update" as ActionType,
          inputSchema: { key: "authorization:relationship-update" as never, version: 1 },
          executorKey: "authorization" as never,
        },
        type: "authorization.relationship.update" as ActionType,
        resource,
        input: input as never,
      },
      authorizationEvidence: {
        evaluatedAt: "2026-09-24T00:00:00.000Z",
        consistency: "higher_consistency",
      },
      actor: editor,
    };
  }

  it("executes a catalog tuple and reports effectConfirmed separately from executed", async () => {
    const executor = new AuthorizationRelationshipExecutor(coordinator);
    const executed = await executor.execute(request({ operation: "write", tuple }));
    assert(Result.isSuccess(executed));
    expect(executed.value.output).toMatchObject({
      relationship: {
        mutationKey: "ue:v1:org:action:exec-1",
        revision: 1,
        status: "confirmed",
        effectConfirmed: true,
      },
    });
    const retried = await executor.execute(request({ operation: "write", tuple }));
    assert(Result.isSuccess(retried));
    expect(retried.value.output).toMatchObject({ relationship: { revision: 1 } });
    expect(events()).toEqual(["change_requested", "apply_started", "change_confirmed"]);
  });

  it("indeterminate is executed but not effectConfirmed; failed is an execution error", async () => {
    const executor = new AuthorizationRelationshipExecutor(coordinator);
    gateway.applyScript.push({
      type: "fail",
      applied: false,
      code: "network_error",
      effect: "ambiguous",
      retriable: true,
    });
    const ambiguous = await executor.execute(request({ operation: "write", tuple }));
    assert(Result.isSuccess(ambiguous));
    expect(ambiguous.value.output).toMatchObject({
      relationship: { status: "indeterminate", effectConfirmed: false },
    });

    gateway.applyScript.push({
      type: "fail",
      applied: false,
      code: "fga_http_400",
      effect: "rejected",
      retriable: false,
    });
    const other = { ...tuple, object: "ticket:T-2" };
    const rejected = await executor.execute({
      ...request({ operation: "write", tuple: other }),
      idempotencyKey: "ue:v1:org:action:exec-2",
    });
    assert(Result.isFailure(rejected));
    expect(rejected.error).toMatchObject({
      code: "relationship_mutation_failed",
      retriable: false,
    });
  });

  it("rejects admin membership, non-catalog relations and foreign resources before any write", async () => {
    const executor = new AuthorizationRelationshipExecutor(coordinator);
    for (const input of [
      {
        operation: "write",
        tuple: { user: "user:mallory", relation: "editor", object: "authorization_admin:root" },
      },
      {
        operation: "write",
        tuple: { user: "user:mallory", relation: "viewer", object: "authorization_admin:root" },
      },
      {
        operation: "write",
        tuple: { user: "user:mallory", relation: "owner", object: "ticket:T-1" },
      },
      {
        operation: "write",
        tuple: {
          user: "user:mallory",
          relation: "can_execute",
          object: "ticket:organization%3Atenant-b/T-1",
        },
      },
    ]) {
      const rejected = await executor.execute(request(input));
      assert(Result.isFailure(rejected));
      expect(rejected.error.code).toBe("invalid_relationship_update");
    }
    const foreign = await executor.execute(
      request({ operation: "write", tuple }, { type: "ticket" as never, id: "T-1" as never }),
    );
    assert(Result.isFailure(foreign));
    expect(foreign.error.code).toBe("invalid_relationship_resource");
    expect(gateway.applies).toHaveLength(0);
    expect(events()).toEqual([]);
  });
});
