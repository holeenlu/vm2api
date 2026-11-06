-- foreign-keys: rebuild
-- Platform statements (payer_vendor_id NULL) reuse server-side previews and per-request
-- allocations, so one request is billed at most once per payer/payee edge. SQLite treats
-- NULLs as distinct in UNIQUE indexes, hence the COALESCE expression on the payer.
CREATE TABLE vendor_settlement_allocations_next (
  statement_id TEXT NOT NULL REFERENCES vendor_settlements(id),
  usage_log_id TEXT NOT NULL,
  payer_vendor_id TEXT REFERENCES vendors(id),
  payee_vendor_id TEXT NOT NULL REFERENCES vendors(id),
  snapshot_json TEXT NOT NULL,
  released_at TEXT,
  PRIMARY KEY (statement_id,usage_log_id)
);
INSERT INTO vendor_settlement_allocations_next
  (statement_id,usage_log_id,payer_vendor_id,payee_vendor_id,snapshot_json,released_at)
SELECT statement_id,usage_log_id,payer_vendor_id,payee_vendor_id,snapshot_json,released_at
FROM vendor_settlement_allocations;
DROP TABLE vendor_settlement_allocations;
ALTER TABLE vendor_settlement_allocations_next RENAME TO vendor_settlement_allocations;
CREATE UNIQUE INDEX idx_vendor_active_allocation
  ON vendor_settlement_allocations(COALESCE(payer_vendor_id,''),payee_vendor_id,usage_log_id) WHERE released_at IS NULL;
CREATE TABLE vendor_settlement_previews_next (
  token_hash TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  payer_vendor_id TEXT REFERENCES vendors(id),
  payee_vendor_id TEXT NOT NULL REFERENCES vendors(id),
  contract_id TEXT NOT NULL REFERENCES vendor_contracts(id),
  input_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  data_hash TEXT NOT NULL,
  watermark INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  statement_id TEXT REFERENCES vendor_settlements(id)
);
INSERT INTO vendor_settlement_previews_next
  (token_hash,actor_user_id,payer_vendor_id,payee_vendor_id,contract_id,input_json,snapshot_json,data_hash,watermark,expires_at,created_at,statement_id)
SELECT token_hash,actor_user_id,payer_vendor_id,payee_vendor_id,contract_id,input_json,snapshot_json,data_hash,watermark,expires_at,created_at,statement_id
FROM vendor_settlement_previews;
DROP TABLE vendor_settlement_previews;
ALTER TABLE vendor_settlement_previews_next RENAME TO vendor_settlement_previews;
CREATE INDEX idx_vendor_preview_expiry ON vendor_settlement_previews(expires_at);
