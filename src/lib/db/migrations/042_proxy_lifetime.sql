ALTER TABLE proxies ADD COLUMN expires_at TEXT;
ALTER TABLE proxies ADD COLUMN fallback_mode TEXT NOT NULL DEFAULT 'none';
ALTER TABLE proxies ADD COLUMN backup_proxy_id TEXT;
