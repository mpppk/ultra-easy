-- M9 Authorization Administration Console.
-- D1 is the source of truth for console-managed relationships:
--   authorization_relationships          latest desired state per tuple + revision
--   authorization_relationship_mutations durable mutation intent / outcome journal
--   authorization_relationship_events    append-only audit (requested ≠ confirmed)
-- OpenFGA is the authorization projection; reconciliation converges it to the
-- latest desired revision. Shared-store FGA scans are never used for listing.

CREATE TABLE authorization_relationships (
  organization_id TEXT NOT NULL,
  tuple_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  relation TEXT NOT NULL,
  logical_object TEXT NOT NULL,
  object_type TEXT NOT NULL,
  desired_present INTEGER NOT NULL CHECK (desired_present IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  latest_mutation_key TEXT NOT NULL,
  latest_action_request_id TEXT NOT NULL,
  confirmed_revision INTEGER,
  confirmed_present INTEGER CHECK (confirmed_present IS NULL OR confirmed_present IN (0, 1)),
  sync_status TEXT NOT NULL
    CHECK (sync_status IN ('prepared', 'applying', 'confirmed', 'indeterminate', 'failed')),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, tuple_key)
);

CREATE INDEX authorization_relationships_recent_idx
  ON authorization_relationships (organization_id, updated_at DESC, tuple_key DESC);
CREATE INDEX authorization_relationships_subject_idx
  ON authorization_relationships (organization_id, subject);
CREATE INDEX authorization_relationships_object_idx
  ON authorization_relationships (organization_id, logical_object);
CREATE INDEX authorization_relationships_sync_idx
  ON authorization_relationships (organization_id, sync_status);

CREATE TABLE authorization_relationship_mutations (
  organization_id TEXT NOT NULL,
  mutation_key TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  tuple_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  operation TEXT NOT NULL CHECK (operation IN ('write', 'delete')),
  desired_present INTEGER NOT NULL CHECK (desired_present IN (0, 1)),
  subject TEXT NOT NULL,
  relation TEXT NOT NULL,
  logical_object TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('prepared', 'applying', 'confirmed', 'indeterminate', 'superseded', 'failed')),
  authorization_model_id TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT NOT NULL,
  apply_started_at TEXT,
  confirmed_at TEXT,
  completed_at TEXT,
  last_error_code TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, mutation_key),
  -- total revision order per tuple: concurrent prepares cannot share a revision
  UNIQUE (organization_id, tuple_key, revision)
);

CREATE INDEX authorization_relationship_mutations_open_idx
  ON authorization_relationship_mutations (organization_id, status, requested_at);
CREATE INDEX authorization_relationship_mutations_action_idx
  ON authorization_relationship_mutations (organization_id, action_request_id);

CREATE TABLE authorization_relationship_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  source_action_request_id TEXT NOT NULL,
  mutation_key TEXT NOT NULL,
  tuple_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  operation TEXT NOT NULL,
  desired_present INTEGER NOT NULL,
  subject TEXT NOT NULL,
  relation TEXT NOT NULL,
  logical_object TEXT NOT NULL,
  authorization_model_id TEXT NOT NULL,
  error_code TEXT,
  UNIQUE (organization_id, event_key)
);

CREATE INDEX authorization_relationship_events_org_idx
  ON authorization_relationship_events (organization_id, sequence DESC);
CREATE INDEX authorization_relationship_events_action_idx
  ON authorization_relationship_events (organization_id, source_action_request_id);
CREATE INDEX authorization_relationship_events_mutation_idx
  ON authorization_relationship_events (organization_id, mutation_key);

-- Append-only enforced by the database, not only by application code.
CREATE TRIGGER authorization_relationship_events_no_update
  BEFORE UPDATE ON authorization_relationship_events
BEGIN
  SELECT RAISE(ABORT, 'authorization_relationship_events is append-only');
END;

CREATE TRIGGER authorization_relationship_events_no_delete
  BEFORE DELETE ON authorization_relationship_events
BEGIN
  SELECT RAISE(ABORT, 'authorization_relationship_events is append-only');
END;
