-- Persisted account error-protection state.
--
-- `protection_state_json` contains the bounded policy/counter/freeze summary;
-- the raw upstream error body is deliberately never stored here.  The
-- monotonic `protection_generation` is a write revision used for compare and
-- swap (CAS), so a late recovery probe cannot overwrite a newer administrator
-- action or failure update.

ALTER TABLE account_runtime ADD COLUMN protection_state_json TEXT;
ALTER TABLE account_runtime ADD COLUMN protection_generation INTEGER NOT NULL DEFAULT 0;
