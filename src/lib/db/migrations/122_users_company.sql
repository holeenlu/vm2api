-- 122_users_company — free-text company shown in the panel user list.
-- Per user rather than per admin domain: a domain may serve users from other companies.
ALTER TABLE users ADD COLUMN company TEXT NOT NULL DEFAULT '';
