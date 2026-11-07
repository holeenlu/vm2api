-- Completed usage receipts only: no admission records, holds or pending lifecycle.
-- Keep the retired reservations table as historical data; runtime no longer reads it.
CREATE TABLE billing_charges (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  group_id INTEGER NOT NULL,
  subscription_id TEXT,
  rate_multiplier REAL NOT NULL,
  actual_micros INTEGER,
  model TEXT,
  usage_json TEXT,
  quote_json TEXT,
  created_at TEXT NOT NULL,
  wallet_domain_id TEXT,
  balance_exempt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_billing_charges_subscription_created ON billing_charges(subscription_id, created_at);
-- Preserve settled subscription history and debit idempotency, without replaying charges.
INSERT INTO billing_charges
SELECT request_id,user_id,api_key_id,group_id,subscription_id,rate_multiplier,actual_micros,
       model,usage_json,quote_json,created_at,wallet_domain_id,balance_exempt
FROM billing_reservations WHERE status='settled';
