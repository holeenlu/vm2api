-- 065_vendor_proxy_pool_metadata — connect supplier proxies to the shared
-- operator pool while keeping supplier ownership and platform scope explicit.
ALTER TABLE proxies ADD COLUMN vendor_id TEXT;
ALTER TABLE proxies ADD COLUMN vendor_resource_id TEXT;
ALTER TABLE proxies ADD COLUMN platforms_json TEXT NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS idx_proxies_vendor ON proxies(vendor_id, vendor_resource_id);
