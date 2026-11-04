-- Completion facts for the Node/Go Gateway Worker control plane.
-- Tokens remain in the Go worker; SQLite stores only state, evidence and leases.

ALTER TABLE gateway_worker_instances ADD COLUMN tls_fingerprint TEXT;
ALTER TABLE gateway_worker_instances ADD COLUMN admission_state TEXT NOT NULL DEFAULT 'admitted'
  CHECK (admission_state IN ('admitted','blocked','draining','expired'));
ALTER TABLE gateway_worker_instances ADD COLUMN drain_deadline TEXT;
ALTER TABLE gateway_worker_instances ADD COLUMN last_error TEXT;
ALTER TABLE gateway_worker_instances ADD COLUMN certificate_expires_at TEXT;

ALTER TABLE gateway_worker_account_bindings ADD COLUMN projection_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE gateway_worker_account_bindings ADD COLUMN credential_fingerprint TEXT;
ALTER TABLE gateway_worker_account_bindings ADD COLUMN projection_error TEXT;
ALTER TABLE gateway_worker_account_bindings ADD COLUMN last_projected_at TEXT;
ALTER TABLE gateway_worker_account_bindings ADD COLUMN quota_json TEXT;
ALTER TABLE gateway_worker_account_bindings ADD COLUMN runtime_status TEXT;
ALTER TABLE gateway_worker_account_bindings ADD COLUMN last_error TEXT;

ALTER TABLE gateway_worker_receipts ADD COLUMN quota_json TEXT;
ALTER TABLE gateway_worker_receipts ADD COLUMN quota_confidence TEXT NOT NULL DEFAULT 'unknown'
  CHECK (quota_confidence IN ('complete','partial','unknown','explicit_zero'));
ALTER TABLE gateway_worker_receipts ADD COLUMN projection_revision INTEGER;
ALTER TABLE gateway_worker_receipts ADD COLUMN headers_json TEXT;
ALTER TABLE gateway_worker_receipts ADD COLUMN integrity_state TEXT NOT NULL DEFAULT 'verified'
  CHECK (integrity_state IN ('verified','duplicate','late','rejected'));
ALTER TABLE gateway_worker_receipts ADD COLUMN received_at TEXT;
ALTER TABLE gateway_worker_receipts ADD COLUMN replay_hash TEXT;

ALTER TABLE gateway_worker_receipt_offsets ADD COLUMN last_hash TEXT;
ALTER TABLE gateway_worker_receipt_offsets ADD COLUMN replay_state TEXT NOT NULL DEFAULT 'active'
  CHECK (replay_state IN ('active','paused','error'));

ALTER TABLE codex_response_owners ADD COLUMN execution_kind TEXT;
ALTER TABLE codex_response_owners ADD COLUMN gateway_instance_id TEXT;
ALTER TABLE codex_response_owners ADD COLUMN runtime_account_id TEXT;
ALTER TABLE codex_response_owners ADD COLUMN credential_revision INTEGER;
ALTER TABLE codex_response_owners ADD COLUMN account_resource_id TEXT;

CREATE TABLE IF NOT EXISTS gateway_worker_projection_jobs (
  id TEXT PRIMARY KEY,
  account_resource_id TEXT NOT NULL REFERENCES vendor_resources(id),
  gateway_instance_id TEXT NOT NULL REFERENCES gateway_worker_instances(id),
  projection_revision INTEGER NOT NULL,
  credential_revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','synced','drifted','blocked','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_resource_id, gateway_instance_id)
);
CREATE INDEX IF NOT EXISTS idx_gateway_worker_projection_jobs_due
  ON gateway_worker_projection_jobs(status, next_attempt_at, lease_until);

CREATE TABLE IF NOT EXISTS gateway_worker_reconciliation_jobs (
  id TEXT PRIMARY KEY,
  gateway_instance_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  receipt_id TEXT,
  request_id TEXT NOT NULL,
  model TEXT,
  context_json TEXT,
  usage_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','settled','unmetered','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(gateway_instance_id, dispatch_id)
);
CREATE INDEX IF NOT EXISTS idx_gateway_worker_reconciliation_due
  ON gateway_worker_reconciliation_jobs(status, next_attempt_at, lease_until);

CREATE TABLE IF NOT EXISTS gateway_worker_dead_letters (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_gateway_worker_dead_letters_open
  ON gateway_worker_dead_letters(kind, resolved_at, created_at);
