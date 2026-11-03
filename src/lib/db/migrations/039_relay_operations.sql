-- Commercial identity is separate from infrastructure ownership. Historical
-- migrations and legacy scope columns remain immutable migration evidence.
ALTER TABLE groups ADD COLUMN models_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE groups ADD COLUMN subscription_type TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE groups ADD COLUMN daily_limit_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN weekly_limit_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN monthly_limit_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN fallback_group_id INTEGER;
ALTER TABLE groups ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN balance_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN rpm_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN restrict_public_groups INTEGER NOT NULL DEFAULT 1;
UPDATE users SET balance_micros = CAST(ROUND(balance * 1000000) AS INTEGER);
CREATE TABLE group_resources (
  group_id INTEGER NOT NULL REFERENCES groups(id),
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('vm', 'api_endpoint')),
  resource_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  PRIMARY KEY (group_id, resource_kind, resource_id)
);
CREATE INDEX idx_group_resources_resource ON group_resources(resource_kind, resource_id);
CREATE TABLE resource_group_versions (
  resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (resource_kind, resource_id)
);
CREATE TABLE user_groups (
  user_id TEXT NOT NULL REFERENCES users(id), group_id INTEGER NOT NULL REFERENCES groups(id),
  rate_multiplier REAL, created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, group_id)
);
CREATE TABLE wallet_ledger (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL, amount_micros INTEGER NOT NULL, balance_after_micros INTEGER NOT NULL,
  request_id TEXT, idempotency_key TEXT NOT NULL UNIQUE,
  actor TEXT, reason TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX idx_wallet_ledger_user ON wallet_ledger(user_id, created_at);
CREATE TABLE user_subscriptions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), group_id INTEGER NOT NULL REFERENCES groups(id),
  status TEXT NOT NULL DEFAULT 'active', starts_at TEXT NOT NULL, expires_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_subscriptions_user_group ON user_subscriptions(user_id, group_id, status);
CREATE TABLE billing_reservations (
  request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), api_key_id TEXT NOT NULL,
  group_id INTEGER NOT NULL, subscription_id TEXT, rate_multiplier REAL NOT NULL, group_version INTEGER NOT NULL,
  reserved_micros INTEGER NOT NULL, actual_micros INTEGER,
  status TEXT NOT NULL CHECK(status IN ('pending', 'settled', 'released', 'pending_pricing', 'pending_usage')),
  usage_json TEXT, model TEXT, quote_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_billing_reservations_user ON billing_reservations(user_id, status);
CREATE TABLE operation_audit (
  id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
  before_json TEXT, after_json TEXT, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE relay_migrations (
  name TEXT PRIMARY KEY, report_json TEXT NOT NULL, applied_at TEXT NOT NULL
);
ALTER TABLE usage_logs ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'unmetered';
ALTER TABLE usage_logs ADD COLUMN billing_group_id INTEGER;
ALTER TABLE usage_logs ADD COLUMN subscription_id TEXT;
ALTER TABLE usage_logs ADD COLUMN api_key_name TEXT;
ALTER TABLE usage_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'protocol';
INSERT INTO wallet_ledger (id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,actor,reason,created_at)
SELECT 'opening-'||id,id,'opening',balance_micros,balance_micros,'opening-'||id,'migration','既有余额开账，不追扣历史消费',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM users WHERE balance_micros != 0;
