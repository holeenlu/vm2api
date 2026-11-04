-- foreign-keys: rebuild
-- Preserve existing resource IDs and references. Only Gateway accounts may
-- omit a supplier; these accounts are owned by the platform itself.
CREATE TABLE vendor_resources_next (
  id TEXT PRIMARY KEY,
  vendor_id TEXT REFERENCES vendors(id),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('account', 'vm', 'proxy')),
  name TEXT NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('provisioning', 'active', 'paused', 'archived')),
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_json TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  CHECK (vendor_id IS NOT NULL OR (resource_type='account'
    AND COALESCE(json_extract(config_json,'$.execution_kind'),'')='gateway_worker'
    AND COALESCE(json_extract(config_json,'$.platform'),'')='openai'))
);
INSERT INTO vendor_resources_next SELECT * FROM vendor_resources;
DROP TABLE vendor_resources;
ALTER TABLE vendor_resources_next RENAME TO vendor_resources;
CREATE UNIQUE INDEX idx_vendor_resource_external
  ON vendor_resources(vendor_id, resource_type, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX idx_platform_account_external
  ON vendor_resources(external_id) WHERE vendor_id IS NULL AND external_id IS NOT NULL;
CREATE INDEX idx_vendor_resources_scope ON vendor_resources(vendor_id, resource_type, status);

-- 077 added the Gateway resource kind in Node; the existing SQLite CHECK also
-- needs extending. Preserve memberships and priorities from the VM/API paths.
CREATE TABLE group_resources_next (
  group_id INTEGER NOT NULL REFERENCES groups(id),
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('vm', 'api_endpoint', 'gateway_worker_account')),
  resource_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  PRIMARY KEY (group_id, resource_kind, resource_id)
);
INSERT INTO group_resources_next SELECT * FROM group_resources;
DROP TABLE group_resources;
ALTER TABLE group_resources_next RENAME TO group_resources;
CREATE INDEX idx_group_resources_resource ON group_resources(resource_kind, resource_id);
