import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vite-plus/test";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ultra-easy-d1-recovery-"));
  temporaryDirectories.push(directory);
  return directory;
}

function migrationNames(): string[] {
  return readdirSync(new URL("../migrations/", import.meta.url))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
}

function applyAllMigrations(db: DatabaseSync): void {
  for (const name of migrationNames()) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
}

describe("M7 operational D1 recovery", () => {
  it("all forward migrations apply to an empty database", () => {
    const db = new DatabaseSync(":memory:");
    applyAllMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name));

    expect(tables).toEqual(
      expect.arrayContaining([
        "action_events",
        "action_requests",
        "approval_runtime_projections",
        "force_cancel_audit",
        "notification_deliveries",
        "outbox_events",
        "rate_limit_counters",
      ]),
    );
    db.close();
  });

  it("pre-migration backup can restore audit data after a destructive change", () => {
    const directory = createTemporaryDirectory();
    const sourcePath = join(directory, "source.sqlite");
    const backupPath = join(directory, "pre-migration.sqlite");
    const restoredPath = join(directory, "restored.sqlite");

    const source = new DatabaseSync(sourcePath);
    applyAllMigrations(source);
    source
      .prepare(
        `INSERT INTO force_cancel_audit (
           organization_id, source_action_request_id, target_action_request_id,
           actor_json, reason, occurred_at, post_review_required
         ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        "organization:recovery",
        "action:force-cancel",
        "action:stuck",
        JSON.stringify({ type: "user", id: "user:operator" }),
        "recovery drill",
        "2026-09-21T00:00:00.000Z",
      );
    source.close();

    copyFileSync(sourcePath, backupPath);

    const changed = new DatabaseSync(sourcePath);
    changed.exec("DROP TABLE force_cancel_audit");
    changed.close();

    copyFileSync(backupPath, restoredPath);
    const restored = new DatabaseSync(restoredPath);
    const row = restored
      .prepare(
        `SELECT organization_id, source_action_request_id, target_action_request_id,
                reason, occurred_at, post_review_required
           FROM force_cancel_audit
          WHERE organization_id = ? AND source_action_request_id = ?`,
      )
      .get("organization:recovery", "action:force-cancel");

    expect(row).toMatchObject({
      organization_id: "organization:recovery",
      source_action_request_id: "action:force-cancel",
      target_action_request_id: "action:stuck",
      reason: "recovery drill",
      occurred_at: "2026-09-21T00:00:00.000Z",
      post_review_required: 1,
    });
    restored.close();
  });
});
