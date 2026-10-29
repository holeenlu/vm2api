-- 064_api_key_creator_scope — preserve the administrator that issued a key.
ALTER TABLE api_keys ADD COLUMN created_by_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_api_keys_created_by_user ON api_keys(created_by_user_id) WHERE deleted_at IS NULL;
