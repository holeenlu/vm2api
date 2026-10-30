-- Freeze the routing/config revision used to plan each request.
-- NULL is retained for historical rows created before request snapshots.
ALTER TABLE usage_logs ADD COLUMN config_revision INTEGER;
