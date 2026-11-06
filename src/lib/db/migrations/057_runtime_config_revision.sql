CREATE TABLE IF NOT EXISTS runtime_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO runtime_config (id, revision, updated_at)
VALUES (1, 1, datetime('now'));
