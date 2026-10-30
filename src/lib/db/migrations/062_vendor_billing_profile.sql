-- Supplier settlement profile and contract defaults.
ALTER TABLE vendors ADD COLUMN contact_name TEXT NOT NULL DEFAULT '';
ALTER TABLE vendors ADD COLUMN settlement_email TEXT NOT NULL DEFAULT '';
ALTER TABLE vendors ADD COLUMN binance_id TEXT NOT NULL DEFAULT '';
ALTER TABLE vendors ADD COLUMN default_price_cny_per_usd REAL NOT NULL DEFAULT 1.6 CHECK (default_price_cny_per_usd > 0);
ALTER TABLE vendors ADD COLUMN group_prices_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE vendors ADD COLUMN fx_cny_per_usdt REAL NOT NULL DEFAULT 6.7 CHECK (fx_cny_per_usdt > 0);
ALTER TABLE vendors ADD COLUMN default_multiplier REAL NOT NULL DEFAULT 1 CHECK (default_multiplier > 0);
ALTER TABLE vendors ADD COLUMN contract_version INTEGER NOT NULL DEFAULT 1 CHECK (contract_version > 0);
