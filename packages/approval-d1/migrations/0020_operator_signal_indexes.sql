-- #109: alert用signalのrange scan。
-- workflow_failures: 直近windowのworkflow.failed eventを組織単位で数える。
CREATE INDEX IF NOT EXISTS action_events_type_time_idx
  ON action_events (organization_id, event_type, occurred_at);

-- stuck_action_requests: 更新の止まった非終端projectionを古い順に取る。
CREATE INDEX IF NOT EXISTS approval_runtime_projections_status_idx
  ON approval_runtime_projections (organization_id, status, updated_at);
