-- #95: normalized candidate index for the approval inbox.
-- The inbox used `json_each(approval_tasks.candidate_user_ids)`, which cannot use an index
-- and scans every task of the organization. The runtime projection keeps this table in sync
-- (same D1 batch as approval_tasks).
CREATE TABLE approval_task_candidates (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id, task_id)
);

CREATE INDEX approval_task_candidates_task_idx
  ON approval_task_candidates (organization_id, task_id);

INSERT OR IGNORE INTO approval_task_candidates (organization_id, user_id, task_id)
SELECT t.organization_id, candidate.value, t.task_id
  FROM approval_tasks AS t, json_each(t.candidate_user_ids) AS candidate
 WHERE candidate.type = 'text';
