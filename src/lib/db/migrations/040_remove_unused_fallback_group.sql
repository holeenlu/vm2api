-- Cross-group fallback is outside the first group-local routing contract.
-- Remove its unused prototype column without rewriting an applied migration.
ALTER TABLE groups DROP COLUMN fallback_group_id;
