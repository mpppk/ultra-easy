-- #157: Workflow Engine durable runtime（workflow bounded context）。
-- DBのmigration履歴は1本（DB binding単位）のため同じdirectoryに置くが、approval側のcodeは
-- これらのtableを参照しない（approval -> workflowの依存は禁止）。アクセスは@app/workflow-d1だけが行う。

-- Studioで編集中のdraft。publish済みversionとは別に扱う。
CREATE TABLE workflow_definitions (
  organization_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, definition_id)
);

-- publish済みWorkflow Version。immutable（insert-only）。
CREATE TABLE workflow_versions (
  organization_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  version_json TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, definition_id, version)
);

CREATE TRIGGER workflow_versions_no_update
  BEFORE UPDATE ON workflow_versions
BEGIN
  SELECT RAISE(ABORT, 'workflow_versions is immutable');
END;

CREATE TRIGGER workflow_versions_no_delete
  BEFORE DELETE ON workflow_versions
BEGIN
  SELECT RAISE(ABORT, 'workflow_versions is immutable');
END;

-- WorkflowRunの永続state。revisionでcompare-and-setする（process memoryを持たずに再開する）。
CREATE TABLE workflow_runs (
  organization_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL,
  depth INTEGER NOT NULL,
  parent_action_request_id TEXT,
  parent_run_id TEXT,
  invocation_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  last_writer TEXT NOT NULL,
  wake_at TEXT,
  completion_delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (organization_id, run_id)
);

CREATE INDEX workflow_runs_due_idx ON workflow_runs (status, wake_at);

CREATE UNIQUE INDEX workflow_runs_parent_action_idx
  ON workflow_runs (organization_id, parent_action_request_id)
  WHERE parent_action_request_id IS NOT NULL;

-- WorkflowRunの監査イベント（append-only）。payloadはID / code / 参照だけを持つ。
CREATE TABLE workflow_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  node_run_id TEXT,
  effect_id TEXT,
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL
);

CREATE INDEX workflow_events_run_idx ON workflow_events (organization_id, run_id, sequence);

CREATE TRIGGER workflow_events_no_update
  BEFORE UPDATE ON workflow_events
BEGIN
  SELECT RAISE(ABORT, 'workflow_events is append-only');
END;

CREATE TRIGGER workflow_events_no_delete
  BEFORE DELETE ON workflow_events
BEGIN
  SELECT RAISE(ABORT, 'workflow_events is append-only');
END;
