-- Stable domains survive deletion of their founding administrator.
CREATE TABLE admin_domains (
  id TEXT PRIMARY KEY,
  created_by_user_id TEXT REFERENCES users(id),
  balance_micros INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE users ADD COLUMN admin_domain_id TEXT REFERENCES admin_domains(id);
CREATE INDEX idx_users_admin_domain ON users(admin_domain_id);

CREATE TEMP TABLE admin_domain_members AS
WITH RECURSIVE ancestry(user_id, id, parent_id, role, depth) AS (
  SELECT id, id, parent_user_id, role, 0 FROM users WHERE role IN ('admin', 'user')
  UNION ALL
  SELECT a.user_id, u.id, u.parent_user_id, u.role, a.depth + 1
  FROM ancestry a JOIN users u ON u.id = a.parent_id
  WHERE u.role IN ('admin', 'user')
)
SELECT u.id AS user_id, (
  SELECT a.id FROM ancestry a WHERE a.user_id = u.id AND a.role = 'admin' ORDER BY a.depth DESC LIMIT 1
) AS domain_id FROM users u WHERE u.role IN ('admin', 'user');

INSERT INTO admin_domains(id, created_by_user_id, balance_micros)
SELECT m.domain_id, (SELECT parent_user_id FROM users WHERE id = m.domain_id),
       SUM(CASE WHEN u.role = 'admin' THEN u.balance_micros ELSE 0 END)
FROM admin_domain_members m JOIN users u ON u.id = m.user_id
WHERE m.domain_id IS NOT NULL GROUP BY m.domain_id;
UPDATE users SET admin_domain_id = (SELECT domain_id FROM admin_domain_members m WHERE m.user_id = users.id);
-- The domain is now the sole source of administrator funds; never duplicate them.
UPDATE users SET balance_micros = 0, balance = 0 WHERE role = 'admin' AND admin_domain_id IS NOT NULL;
DROP TABLE admin_domain_members;

ALTER TABLE wallet_ledger ADD COLUMN wallet_domain_id TEXT REFERENCES admin_domains(id);
ALTER TABLE billing_reservations ADD COLUMN wallet_domain_id TEXT REFERENCES admin_domains(id);
ALTER TABLE billing_reservations ADD COLUMN balance_exempt INTEGER NOT NULL DEFAULT 0;
UPDATE wallet_ledger SET wallet_domain_id = (
  SELECT admin_domain_id FROM users WHERE id = wallet_ledger.user_id AND role = 'admin'
);
UPDATE billing_reservations SET wallet_domain_id = (
  SELECT admin_domain_id FROM users WHERE id = billing_reservations.user_id AND role = 'admin'
);
-- Existing reservations retain their original charge/exemption decision.
CREATE INDEX idx_wallet_ledger_domain ON wallet_ledger(wallet_domain_id, created_at);
CREATE INDEX idx_billing_reservations_domain ON billing_reservations(wallet_domain_id, status);
