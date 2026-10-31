-- 063_admin_data_scope — bind panel users to their parent administrator.
-- NULL is reserved for the bootstrap/master operator and legacy rows.
ALTER TABLE users ADD COLUMN parent_user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_users_parent_user_id ON users(parent_user_id) WHERE deleted_at IS NULL;
