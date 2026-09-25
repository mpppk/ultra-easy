-- Knowledge Workspace (#167). Knowledge-owned data only: ultra-easy workflow /
-- approval state lives in ultra-easy, Knowledge keeps correlation IDs.

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, key)
);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces (id),
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  -- bumped by publish / archive / restore only (never by draft saves)
  lifecycle_version INTEGER NOT NULL DEFAULT 0,
  published_revision_id TEXT,
  published_snapshot_id TEXT,
  published_visibility TEXT CHECK (published_visibility IN ('private', 'space', 'organization')),
  published_sensitivity TEXT CHECK (published_sensitivity IN ('normal', 'internal', 'confidential')),
  published_at TEXT,
  published_by TEXT,
  review_state TEXT NOT NULL DEFAULT 'current' CHECK (review_state IN ('current', 'update_needed')),
  last_reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX pages_space_status ON pages (space_id, status);
CREATE INDEX pages_published_at ON pages (status, published_at);

CREATE TABLE drafts (
  page_id TEXT PRIMARY KEY REFERENCES pages (id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'space', 'organization')),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'internal', 'confidential')),
  version INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX drafts_updated_at ON drafts (updated_at);

-- INSERT-only content snapshots.
CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages (id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (page_id, number)
);
CREATE TRIGGER revisions_are_immutable BEFORE UPDATE ON revisions
BEGIN
  SELECT RAISE(ABORT, 'revisions are immutable');
END;
CREATE TRIGGER revisions_are_append_only BEFORE DELETE ON revisions
BEGIN
  SELECT RAISE(ABORT, 'revisions are append-only');
END;

-- INSERT-only business snapshot approved by the publication workflow.
CREATE TABLE publication_snapshots (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages (id),
  revision_id TEXT NOT NULL REFERENCES revisions (id),
  revision_number INTEGER NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces (id),
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'space', 'organization')),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'internal', 'confidential')),
  expected_lifecycle_version INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX publication_snapshots_page ON publication_snapshots (page_id, created_at);
CREATE TRIGGER publication_snapshots_are_immutable BEFORE UPDATE ON publication_snapshots
BEGIN
  SELECT RAISE(ABORT, 'publication snapshots are immutable');
END;
CREATE TRIGGER publication_snapshots_are_append_only BEFORE DELETE ON publication_snapshots
BEGIN
  SELECT RAISE(ABORT, 'publication snapshots are append-only');
END;

-- Correlation to the ultra-easy ActionRequest / WorkflowRun that governs a snapshot.
CREATE TABLE publication_requests (
  publication_snapshot_id TEXT PRIMARY KEY REFERENCES publication_snapshots (id),
  action_request_id TEXT NOT NULL,
  workflow_run_id TEXT,
  created_at TEXT NOT NULL
);

-- Result of the lifecycle CAS performed by knowledge.revision.publish.
CREATE TABLE publication_outcomes (
  publication_snapshot_id TEXT PRIMARY KEY REFERENCES publication_snapshots (id),
  status TEXT NOT NULL CHECK (status IN ('published', 'conflict')),
  reason TEXT,
  expected_lifecycle_version INTEGER NOT NULL,
  actual_lifecycle_version INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);

-- Links of *published* revisions (backlinks never come from drafts).
CREATE TABLE page_links (
  source_revision_id TEXT NOT NULL REFERENCES revisions (id),
  source_page_id TEXT NOT NULL REFERENCES pages (id),
  target_page_id TEXT NOT NULL,
  PRIMARY KEY (source_revision_id, target_page_id)
);
CREATE INDEX page_links_target ON page_links (target_page_id);

CREATE TABLE watchers (
  page_id TEXT NOT NULL REFERENCES pages (id),
  principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (page_id, principal_id)
);

-- Post-publish effect ledger (one row per snapshot and effect).
CREATE TABLE publication_effects (
  publication_snapshot_id TEXT NOT NULL REFERENCES publication_snapshots (id),
  effect TEXT NOT NULL CHECK (effect IN ('search_reindex', 'watcher_notification')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (publication_snapshot_id, effect)
);
CREATE INDEX publication_effects_status ON publication_effects (status, updated_at);

-- In-app notifications, persistently deduplicated per snapshot and watcher.
CREATE TABLE notification_deliveries (
  publication_snapshot_id TEXT NOT NULL REFERENCES publication_snapshots (id),
  watcher_id TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages (id),
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (publication_snapshot_id, watcher_id)
);
CREATE INDEX notification_deliveries_watcher ON notification_deliveries (watcher_id, delivered_at);

-- Persistent downstream dedupe for MCP tools/call (dev.ultra-easy/idempotencyKey).
CREATE TABLE tool_invocations (
  idempotency_key TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Local/demo-only switches (e.g. simulated notifier outage). Unused in production.
CREATE TABLE demo_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Search: published content and authoring content are separate indexes so a
-- viewer query can never touch draft text.
CREATE VIRTUAL TABLE published_page_fts USING fts5 (
  page_id UNINDEXED,
  revision_id UNINDEXED,
  title,
  body,
  tags,
  tokenize = 'unicode61'
);

CREATE VIRTUAL TABLE authoring_page_fts USING fts5 (
  page_id UNINDEXED,
  title,
  body,
  tags,
  tokenize = 'unicode61'
);
