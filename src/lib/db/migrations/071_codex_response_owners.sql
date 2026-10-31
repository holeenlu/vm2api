-- Continuation ownership is client-scoped and independent of session affinity.
-- Only hashes of client identity, response IDs and account identity are stored.
CREATE TABLE codex_response_owners (
  scope_hash TEXT NOT NULL,
  response_hash TEXT NOT NULL,
  vm_id TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  session_id TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope_hash, response_hash)
);
CREATE INDEX idx_codex_response_owners_expiry ON codex_response_owners(expires_at);
