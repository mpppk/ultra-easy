-- #160: publish済みProgram Node Version（workflow bounded context）。immutable（insert-only）。
CREATE TABLE workflow_programs (
  organization_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  source_digest TEXT NOT NULL,
  version_json TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, program_id, version)
);

CREATE TRIGGER workflow_programs_no_update
  BEFORE UPDATE ON workflow_programs
BEGIN
  SELECT RAISE(ABORT, 'workflow_programs is immutable');
END;

CREATE TRIGGER workflow_programs_no_delete
  BEFORE DELETE ON workflow_programs
BEGIN
  SELECT RAISE(ABORT, 'workflow_programs is immutable');
END;
