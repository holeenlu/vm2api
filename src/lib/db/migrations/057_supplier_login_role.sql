-- Supplier login role is a single identity role. Supplier tier remains a
-- property of the vendor organization (vendors.tier), not a user role.
UPDATE users
SET role = 'vendor', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE deleted_at IS NULL
  AND role = 'user'
  AND id IN (
    SELECT user_id FROM vendor_members WHERE status = 'active'
  );
