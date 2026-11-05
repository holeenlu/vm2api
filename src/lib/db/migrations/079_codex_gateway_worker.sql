-- Codex Gateway Worker control-plane facts.
-- Secrets stay in the Go worker account store; SQLite only stores projections,
-- dispatch facts and idempotent receipt/settlement metadata.

CREATE TABLE IF NOT EXISTS gateway_worker_instances (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'unix' CHECK (transport IN ('unix','http','https')),
  region TEXT,
  version TEXT,
  boot_id TEXT,
  protocol_version INTEGER NOT NULL DEFAULT 1,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  health_state TEXT NOT NULL DEFAULT 'unknown' CHECK (health_state IN ('unknown','healthy','degraded','offline','error')),
  drain_state TEXT NOT NULL DEFAULT 'accepting' CHECK (drain_state IN ('accepting','draining','drained')),
  active_concurrency INTEGER NOT NULL DEFAULT 0,
  queue_depth INTEGER NOT NULL DEFAULT 0,
  receipt_backlog INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gateway_worker_instances_health
  ON gateway_worker_instances(health_state, drain_state, last_heartbeat_at);

CREATE TABLE IF NOT EXISTS gateway_worker_account_bindings (
  id TEXT PRIMARY KEY,
  account_resource_id TEXT NOT NULL REFERENCES vendor_resources(id),
  gateway_instance_id TEXT NOT NULL REFERENCES gateway_worker_instances(id),
  runtime_account_id TEXT NOT NULL,
  runtime_account_fingerprint TEXT,
  credential_revision INTEGER NOT NULL DEFAULT 0,
  projection_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (projection_status IN ('pending','synced','drifted','blocked','archived')),
  last_runtime_revision INTEGER,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_resource_id, gateway_instance_id),
  UNIQUE(gateway_instance_id, runtime_account_id)
);
CREATE INDEX IF NOT EXISTS idx_gateway_worker_bindings_resource
  ON gateway_worker_account_bindings(account_resource_id, projection_status);

CREATE TABLE IF NOT EXISTS gateway_worker_scopes (
  id TEXT PRIMARY KEY,
  gateway_instance_id TEXT NOT NULL REFERENCES gateway_worker_instances(id),
  vm2api_group_id INTEGER NOT NULL,
  runtime_scope_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','drifted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(gateway_instance_id, vm2api_group_id),
  UNIQUE(gateway_instance_id, runtime_scope_id)
);
CREATE INDEX IF NOT EXISTS idx_gateway_worker_scopes_group
  ON gateway_worker_scopes(vm2api_group_id, status);

CREATE TABLE IF NOT EXISTS gateway_worker_dispatches (
  dispatch_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  attempt_id TEXT,
  gateway_instance_id TEXT NOT NULL REFERENCES gateway_worker_instances(id),
  scope_json TEXT NOT NULL DEFAULT '{}',
  protocol TEXT,
  model TEXT,
  nonce_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','sent','streaming','completed','cancelled','expired','ambiguous','failed')),
  receipt_id TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  completed_at TEXT,
  UNIQUE(gateway_instance_id, nonce_hash)
);
CREATE INDEX IF NOT EXISTS idx_gateway_worker_dispatch_request
  ON gateway_worker_dispatches(request_id, created_at);

CREATE TABLE IF NOT EXISTS gateway_worker_receipts (
  receipt_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  attempt_id TEXT,
  gateway_instance_id TEXT NOT NULL REFERENCES gateway_worker_instances(id),
  sequence INTEGER,
  payload_hash TEXT NOT NULL,
  runtime_account_id TEXT,
  credential_revision INTEGER,
  send_state TEXT,
  terminal_state TEXT,
  upstream_status INTEGER,
  upstream_model TEXT,
  usage_confidence TEXT NOT NULL DEFAULT 'unknown'
    CHECK (usage_confidence IN ('complete','partial','unknown')),
  usage_json TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  first_byte_at TEXT,
  finished_at TEXT,
  applied_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(gateway_instance_id, dispatch_id)
);
CREATE INDEX IF NOT EXISTS idx_gateway_worker_receipts_request
  ON gateway_worker_receipts(request_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gateway_worker_receipts_pending
  ON gateway_worker_receipts(gateway_instance_id, applied_at, sequence);

CREATE TABLE IF NOT EXISTS gateway_worker_receipt_offsets (
  gateway_instance_id TEXT PRIMARY KEY REFERENCES gateway_worker_instances(id),
  stream_name TEXT NOT NULL DEFAULT 'default',
  last_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_worker_oauth_sessions (
  session_id TEXT PRIMARY KEY,
  account_resource_id TEXT REFERENCES vendor_resources(id),
  actor_user_id TEXT,
  gateway_instance_id TEXT NOT NULL REFERENCES gateway_worker_instances(id),
  state_hash TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'openai',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','failed','expired','cancelled')),
  idempotency_key TEXT,
  expires_at TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(gateway_instance_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_gateway_worker_oauth_sessions_expiry
  ON gateway_worker_oauth_sessions(status, expires_at);

CREATE TABLE IF NOT EXISTS vendor_execution_policies (
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  platform TEXT NOT NULL,
  execution_kind TEXT NOT NULL CHECK (execution_kind IN ('vm','gateway_worker')),
  allow_create INTEGER NOT NULL DEFAULT 0,
  allow_runtime INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(vendor_id, platform, execution_kind)
);

ALTER TABLE usage_logs ADD COLUMN execution_kind TEXT;
ALTER TABLE usage_logs ADD COLUMN account_resource_id TEXT;
ALTER TABLE usage_logs ADD COLUMN gateway_instance_id TEXT;
ALTER TABLE usage_logs ADD COLUMN dispatch_id TEXT;
ALTER TABLE usage_logs ADD COLUMN receipt_id TEXT;
ALTER TABLE usage_logs ADD COLUMN usage_confidence TEXT;

ALTER TABLE vendor_usage_facts ADD COLUMN execution_kind TEXT;
ALTER TABLE vendor_usage_facts ADD COLUMN gateway_instance_id TEXT;
ALTER TABLE vendor_usage_facts ADD COLUMN dispatch_id TEXT;
ALTER TABLE vendor_usage_facts ADD COLUMN receipt_id TEXT;
ALTER TABLE vendor_usage_facts ADD COLUMN usage_confidence TEXT;

ALTER TABLE billing_charges ADD COLUMN gateway_receipt_id TEXT;
ALTER TABLE billing_charges ADD COLUMN settlement_source TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_logs_gateway_dispatch
  ON usage_logs(execution_kind, gateway_instance_id, dispatch_id);
CREATE INDEX IF NOT EXISTS idx_vendor_usage_gateway_receipt
  ON vendor_usage_facts(execution_kind, gateway_instance_id, receipt_id);
