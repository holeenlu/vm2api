-- Durable receipts for VM configuration commands, including incomplete file writes.
CREATE TABLE vm_bulk_edits (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  report_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
