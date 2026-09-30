-- #196: application-supplied lookup keys are immutable ActionRequest metadata.
ALTER TABLE action_requests
  ADD COLUMN correlation_json TEXT CHECK (correlation_json IS NULL OR json_valid(correlation_json));

CREATE INDEX action_requests_correlation_space_idx
  ON action_requests (organization_id, json_extract(correlation_json, '$.spaceId'), created_at DESC)
  WHERE correlation_json IS NOT NULL;
