-- #161: Workflow Engineのresource governance（workflow bounded context）。

-- 同時実行枠（WorkflowRun / sandbox）。expires_atで異常終了時のleakを回収する。
CREATE TABLE workflow_quota_leases (
  lease_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  amount INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX workflow_quota_leases_scope_idx ON workflow_quota_leases (scope_key, expires_at);

-- 累積量（run内のAction数等）。idempotency_keyで冪等。
CREATE TABLE workflow_quota_counters (
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, idempotency_key)
);

-- LLM Gatewayの使用量ledger（promptは保存しない）。budget exhaustionもdeniedとして残す。
CREATE TABLE workflow_llm_usage (
  organization_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_run_id TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'denied')),
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_micro_usd INTEGER NOT NULL,
  code TEXT,
  output_json TEXT,
  created_at TEXT NOT NULL,
  -- effect IDはrun内でだけ一意なため、runを含めてkeyにする。
  PRIMARY KEY (organization_id, run_id, effect_id)
);

CREATE INDEX workflow_llm_usage_node_idx ON workflow_llm_usage (organization_id, run_id, node_run_id);
