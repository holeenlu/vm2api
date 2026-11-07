-- Canonical panel role names: super_admin / admin / user.
-- The old values were admin=SA and super=AD; update in this order so the
-- renamed super_admin value is not touched by the second statement.
UPDATE users SET role = 'super_admin' WHERE role = 'admin';
UPDATE users SET role = 'admin' WHERE role = 'super';
