-- Admin-maintained supplier notes, separate from login and billing identity.
ALTER TABLE vendors ADD COLUMN remark TEXT NOT NULL DEFAULT '';
