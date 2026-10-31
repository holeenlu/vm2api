-- Supplier platform domain: vendors, members, scoped resources, contracts,
-- usage facts, settlements and auditable commands.

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  external_code TEXT NOT NULL COLLATE NOCASE,
  email TEXT NOT NULL COLLATE NOCASE,
  tier INTEGER NOT NULL CHECK (tier IN (1, 2)),
  parent_id TEXT REFERENCES vendors(id),
  root_id TEXT NOT NULL REFERENCES vendors(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  groups_json TEXT NOT NULL DEFAULT '[]',
  platforms_json TEXT NOT NULL DEFAULT '[]',
  account_limit INTEGER NOT NULL DEFAULT 0 CHECK (account_limit >= 0),
  proxy_limit INTEGER NOT NULL DEFAULT 0 CHECK (proxy_limit >= 0),
  child_limit INTEGER NOT NULL DEFAULT 0 CHECK (child_limit >= 0),
  capability_revision INTEGER NOT NULL DEFAULT 1 CHECK (capability_revision > 0),
  policy_revision INTEGER NOT NULL DEFAULT 1 CHECK (policy_revision > 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_external_code_active
  ON vendors(external_code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_email_active
  ON vendors(email) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vendors_parent ON vendors(parent_id, status);
CREATE INDEX IF NOT EXISTS idx_vendors_root ON vendors(root_id, status);

CREATE TABLE IF NOT EXISTS vendor_members (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  is_primary INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_vendor_members_user ON vendor_members(user_id, status);
CREATE INDEX IF NOT EXISTS idx_vendor_members_vendor ON vendor_members(vendor_id, status);

CREATE TABLE IF NOT EXISTS vendor_capabilities (
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  capability TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (vendor_id, capability)
);

CREATE TABLE IF NOT EXISTS vendor_resources (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('account', 'vm', 'proxy')),
  name TEXT NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('provisioning', 'active', 'paused', 'archived')),
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_json TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_resource_external
  ON vendor_resources(vendor_id, resource_type, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vendor_resources_scope
  ON vendor_resources(vendor_id, resource_type, status);

CREATE TABLE IF NOT EXISTS vendor_resource_grants (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES vendor_resources(id),
  grantor_vendor_id TEXT NOT NULL REFERENCES vendors(id),
  grantee_vendor_id TEXT REFERENCES vendors(id),
  group_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revision INTEGER NOT NULL DEFAULT 1,
  effective_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_vendor_grants_resource ON vendor_resource_grants(resource_id, status);
CREATE INDEX IF NOT EXISTS idx_vendor_grants_grantee ON vendor_resource_grants(grantee_vendor_id, status);

CREATE TABLE IF NOT EXISTS vendor_contracts (
  id TEXT PRIMARY KEY,
  leg TEXT NOT NULL CHECK (leg IN ('platform_to_l1', 'l1_to_l2')),
  payer_vendor_id TEXT REFERENCES vendors(id),
  payee_vendor_id TEXT REFERENCES vendors(id),
  version INTEGER NOT NULL,
  effective_at TEXT NOT NULL,
  price_cny_per_usd REAL NOT NULL CHECK (price_cny_per_usd > 0),
  fx_cny_per_usdt REAL NOT NULL CHECK (fx_cny_per_usdt > 0),
  multiplier REAL NOT NULL CHECK (multiplier > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'expired', 'void')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(leg, payer_vendor_id, payee_vendor_id, version)
);
CREATE INDEX IF NOT EXISTS idx_vendor_contracts_effective
  ON vendor_contracts(leg, payer_vendor_id, payee_vendor_id, status, effective_at);

CREATE TABLE IF NOT EXISTS vendor_usage_facts (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  resource_id TEXT REFERENCES vendor_resources(id),
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  occurred_at TEXT NOT NULL,
  source_request_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vendor_usage_scope ON vendor_usage_facts(vendor_id, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_usage_request ON vendor_usage_facts(source_request_id)
  WHERE source_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS vendor_settlements (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES vendor_contracts(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'confirmed', 'partial', 'paid', 'disputed', 'void')),
  amount_usdt REAL NOT NULL DEFAULT 0 CHECK (amount_usdt >= 0),
  usage_snapshot_json TEXT NOT NULL DEFAULT '{}',
  confirmed_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(contract_id, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS vendor_payments (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES vendor_settlements(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_usdt REAL NOT NULL CHECK (amount_usdt > 0),
  action TEXT NOT NULL CHECK (action IN ('payment', 'reversal', 'adjustment')),
  reason TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vendor_audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  vendor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  idempotency_key TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vendor_audit_scope ON vendor_audit_events(vendor_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_audit_idempotency
  ON vendor_audit_events(vendor_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
