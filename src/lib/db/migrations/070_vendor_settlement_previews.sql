-- Preserve historical statements/payments while allowing late, previously unallocated usage
-- in a second statement for the same calendar period. Allocation rows prevent double billing.
CREATE TEMP TABLE vendor_payments_before_067 AS SELECT * FROM vendor_payments;
DROP TABLE vendor_payments;
CREATE TABLE vendor_settlements_next (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES vendor_contracts(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','confirmed','partial','paid','disputed','void')),
  amount_usdt REAL NOT NULL DEFAULT 0 CHECK (amount_usdt >= 0),
  usage_snapshot_json TEXT NOT NULL DEFAULT '{}',
  confirmed_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  idempotency_key TEXT,
  input_hash TEXT
);
INSERT INTO vendor_settlements_next
  (id,contract_id,period_start,period_end,status,amount_usdt,usage_snapshot_json,confirmed_at,created_by,created_at,updated_at)
SELECT id,contract_id,period_start,period_end,status,amount_usdt,usage_snapshot_json,confirmed_at,created_by,created_at,updated_at
FROM vendor_settlements;
DROP TABLE vendor_settlements;
ALTER TABLE vendor_settlements_next RENAME TO vendor_settlements;
CREATE INDEX idx_vendor_settlement_period ON vendor_settlements(contract_id,period_start,period_end);
CREATE UNIQUE INDEX idx_vendor_settlement_idempotency ON vendor_settlements(created_by,idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE TABLE vendor_payments (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES vendor_settlements(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_usdt REAL NOT NULL CHECK (amount_usdt > 0),
  action TEXT NOT NULL CHECK (action IN ('payment','reversal','adjustment')),
  reason TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO vendor_payments SELECT * FROM vendor_payments_before_067;
DROP TABLE vendor_payments_before_067;
CREATE TABLE vendor_settlement_previews (
  token_hash TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  payer_vendor_id TEXT NOT NULL REFERENCES vendors(id),
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
CREATE INDEX idx_vendor_preview_expiry ON vendor_settlement_previews(expires_at);
CREATE TABLE vendor_settlement_allocations (
  statement_id TEXT NOT NULL REFERENCES vendor_settlements(id),
  usage_log_id TEXT NOT NULL,
  payer_vendor_id TEXT NOT NULL REFERENCES vendors(id),
  payee_vendor_id TEXT NOT NULL REFERENCES vendors(id),
  snapshot_json TEXT NOT NULL,
  released_at TEXT,
  PRIMARY KEY (statement_id,usage_log_id)
);
CREATE UNIQUE INDEX idx_vendor_active_allocation
  ON vendor_settlement_allocations(payer_vendor_id,payee_vendor_id,usage_log_id) WHERE released_at IS NULL;
