-- Upstream request_attempts has no send-state ledger; the gateway adopted the
-- upstream write-behind repository and no longer writes or reads this column.
ALTER TABLE request_attempts DROP COLUMN send_state;
