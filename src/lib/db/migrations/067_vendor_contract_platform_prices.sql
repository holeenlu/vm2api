-- Freeze platform purchase prices with each contract version. Existing contracts
-- keep their original single rate; no historical statement is repriced.
ALTER TABLE vendor_contracts ADD COLUMN group_prices_json TEXT NOT NULL DEFAULT '{}';
