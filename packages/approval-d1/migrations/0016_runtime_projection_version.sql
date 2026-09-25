-- #89: optimistic locking for the approval runtime projection.
-- Every write is a compare-and-set on `version` (the Workflow and force-cancel are the
-- two writers). `writer` records who produced the current version so a retried Workflow
-- step can recognise its own, already committed write.
ALTER TABLE approval_runtime_projections ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approval_runtime_projections ADD COLUMN writer TEXT;
