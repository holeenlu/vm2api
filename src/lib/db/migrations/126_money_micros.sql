-- 126_money_micros — integer micros for every money column (technical-debt batch M6).
--
-- Every REAL money column gets an INTEGER sibling <name>_micros (1 USD / 1 USDT = 1,000,000 micros). The
-- integer column is authoritative from now on: all arithmetic (settlement, wallets, plan windows, rollups,
-- price × tokens, allocation, supplier settlement) runs on it. The REAL column stays as a display mirror,
-- written together with the integer as micros / 1e6, so readers that were not converted (and the previous
-- release, after a rollback) keep reading a correct value.
--
-- Backfill: x_micros = CAST(ROUND(x * 1000000) AS INTEGER); NULL stays NULL. REAL values are left untouched.
-- The integer columns have no DEFAULT on purpose: a row written by a writer that only knows the REAL column (the
-- previous release after a rollback) keeps x_micros NULL, so readers and triggers fall back to ROUND(x * 1e6) for
-- it (src/lib/db/repos/money-sql.mjs) and the audit script can find it.
-- Valid money is |x| < 2^51 micros (about 2.25e9 USD): inside that range the REAL mirror round-trips exactly and
-- node:sqlite can read the integer. Out-of-range history: API-key limits (quota, rate_limit_*) mean "unlimited" and
-- are stored as 0 in both columns (the same rule the code applies to new input); any other out-of-range amount
-- stops this migration with CHECK constraint m6_money_out_of_range__fix_rows_first, so an operator fixes those
-- rows before upgrading (scripts/audit-money-micros.mjs lists them after the upgrade; nothing in production is
-- near the limit: max key quota 1000 USD, max usage row 14.95 USD on 2026-11-06).
-- Already integer and therefore unchanged: users.balance_micros (users.balance is its mirror since 039),
-- admin_domains.balance_micros, billing_charges / billing_reservations *_micros, wallet_ledger *_micros,
-- groups.*_limit_micros, jev_usage_* *_nano_usd*.
-- Ratios stay REAL and are converted to integer ppm where they are applied (core/money.mjs ratePpm):
-- *rate_multiplier, vendors.default_multiplier / default_price_cny_per_usd / fx_cny_per_usdt,
-- vendor_contracts.multiplier / price_cny_per_usd / fx_cny_per_usdt.
--
-- Rollback compatibility (the previous release only knows the REAL columns):
-- * small tables (api_keys, groups, redeem_codes, vendor_*) get legacy-writer triggers: when an UPDATE changes a
--   REAL column but leaves its integer column untouched, or an INSERT leaves the integer column NULL, the integer
--   column is set to ROUND(REAL * 1e6) on the spot. New code always writes both columns with REAL = micros / 1e6,
--   so for it the triggers either do not fire or rewrite the same value. Key limits and usage written by the
--   previous release therefore count immediately after upgrading back, before any request is admitted.
-- * usage_logs gets no such trigger (its rollup triggers would interact with it); instead the partial index
--   idx_usage_logs_money_drift holds exactly the rows whose integer column disagrees with ROUND(REAL * 1e6)
--   (normally none), and startup re-derives them in batches before the server listens
--   (UsageLogsRepo.syncLegacyMoneyRows).
-- The hourly rollups and their triggers move to the integer columns in 127.

CREATE TEMP TABLE m6_money_guard (
  n INTEGER CONSTRAINT m6_money_out_of_range__fix_rows_first CHECK (n = 0)
);
INSERT INTO m6_money_guard SELECT COUNT(*) FROM usage_logs WHERE ABS(input_cost) >= 2251799813.685248 OR ABS(output_cost) >= 2251799813.685248 OR ABS(cache_read_cost) >= 2251799813.685248 OR ABS(cache_creation_cost) >= 2251799813.685248 OR ABS(web_search_cost) >= 2251799813.685248 OR ABS(image_cost) >= 2251799813.685248 OR ABS(total_cost) >= 2251799813.685248 OR ABS(actual_cost) >= 2251799813.685248;
INSERT INTO m6_money_guard SELECT COUNT(*) FROM api_keys WHERE ABS(quota_used) >= 2251799813.685248 OR ABS(usage_5h) >= 2251799813.685248 OR ABS(usage_1d) >= 2251799813.685248 OR ABS(usage_7d) >= 2251799813.685248;
INSERT INTO m6_money_guard SELECT COUNT(*) FROM groups WHERE ABS(image_price_1k) >= 2251799813.685248 OR ABS(image_price_2k) >= 2251799813.685248 OR ABS(image_price_4k) >= 2251799813.685248 OR ABS(web_search_price_per_call) >= 2251799813.685248;
INSERT INTO m6_money_guard SELECT COUNT(*) FROM redeem_codes WHERE ABS(value) >= 2251799813.685248;
INSERT INTO m6_money_guard SELECT COUNT(*) FROM vendor_usage_facts WHERE ABS(cost_usd) >= 2251799813.685248;
INSERT INTO m6_money_guard SELECT COUNT(*) FROM vendor_settlements WHERE ABS(amount_usdt) >= 2251799813.685248;
INSERT INTO m6_money_guard SELECT COUNT(*) FROM vendor_payments WHERE ABS(amount_usdt) >= 2251799813.685248;
DROP TABLE m6_money_guard;

UPDATE api_keys SET quota = 0 WHERE ABS(quota) >= 2251799813.685248;
UPDATE api_keys SET rate_limit_5h = 0 WHERE ABS(rate_limit_5h) >= 2251799813.685248;
UPDATE api_keys SET rate_limit_1d = 0 WHERE ABS(rate_limit_1d) >= 2251799813.685248;
UPDATE api_keys SET rate_limit_7d = 0 WHERE ABS(rate_limit_7d) >= 2251799813.685248;

ALTER TABLE usage_logs ADD COLUMN input_cost_micros INTEGER;
ALTER TABLE usage_logs ADD COLUMN output_cost_micros INTEGER;
ALTER TABLE usage_logs ADD COLUMN cache_read_cost_micros INTEGER;
ALTER TABLE usage_logs ADD COLUMN cache_creation_cost_micros INTEGER;
ALTER TABLE usage_logs ADD COLUMN web_search_cost_micros INTEGER;
ALTER TABLE usage_logs ADD COLUMN image_cost_micros INTEGER;
ALTER TABLE usage_logs ADD COLUMN total_cost_micros INTEGER;
ALTER TABLE usage_logs ADD COLUMN actual_cost_micros INTEGER;
ALTER TABLE api_keys ADD COLUMN quota_micros INTEGER;
ALTER TABLE api_keys ADD COLUMN quota_used_micros INTEGER;
ALTER TABLE api_keys ADD COLUMN rate_limit_5h_micros INTEGER;
ALTER TABLE api_keys ADD COLUMN rate_limit_1d_micros INTEGER;
ALTER TABLE api_keys ADD COLUMN rate_limit_7d_micros INTEGER;
ALTER TABLE api_keys ADD COLUMN usage_5h_micros INTEGER;
ALTER TABLE api_keys ADD COLUMN usage_1d_micros INTEGER;
ALTER TABLE api_keys ADD COLUMN usage_7d_micros INTEGER;
ALTER TABLE groups ADD COLUMN image_price_1k_micros INTEGER;
ALTER TABLE groups ADD COLUMN image_price_2k_micros INTEGER;
ALTER TABLE groups ADD COLUMN image_price_4k_micros INTEGER;
ALTER TABLE groups ADD COLUMN web_search_price_per_call_micros INTEGER;
ALTER TABLE redeem_codes ADD COLUMN value_micros INTEGER;
ALTER TABLE vendor_usage_facts ADD COLUMN cost_usd_micros INTEGER;
ALTER TABLE vendor_settlements ADD COLUMN amount_usdt_micros INTEGER;
ALTER TABLE vendor_payments ADD COLUMN amount_usdt_micros INTEGER;

UPDATE usage_logs SET
  input_cost_micros = CAST(ROUND(input_cost * 1000000) AS INTEGER),
  output_cost_micros = CAST(ROUND(output_cost * 1000000) AS INTEGER),
  cache_read_cost_micros = CAST(ROUND(cache_read_cost * 1000000) AS INTEGER),
  cache_creation_cost_micros = CAST(ROUND(cache_creation_cost * 1000000) AS INTEGER),
  web_search_cost_micros = CAST(ROUND(web_search_cost * 1000000) AS INTEGER),
  image_cost_micros = CAST(ROUND(image_cost * 1000000) AS INTEGER),
  total_cost_micros = CAST(ROUND(total_cost * 1000000) AS INTEGER),
  actual_cost_micros = CAST(ROUND(actual_cost * 1000000) AS INTEGER);

UPDATE api_keys SET
  quota_micros = CAST(ROUND(quota * 1000000) AS INTEGER),
  quota_used_micros = CAST(ROUND(quota_used * 1000000) AS INTEGER),
  rate_limit_5h_micros = CAST(ROUND(rate_limit_5h * 1000000) AS INTEGER),
  rate_limit_1d_micros = CAST(ROUND(rate_limit_1d * 1000000) AS INTEGER),
  rate_limit_7d_micros = CAST(ROUND(rate_limit_7d * 1000000) AS INTEGER),
  usage_5h_micros = CAST(ROUND(usage_5h * 1000000) AS INTEGER),
  usage_1d_micros = CAST(ROUND(usage_1d * 1000000) AS INTEGER),
  usage_7d_micros = CAST(ROUND(usage_7d * 1000000) AS INTEGER);

UPDATE groups SET
  image_price_1k_micros = CAST(ROUND(image_price_1k * 1000000) AS INTEGER),
  image_price_2k_micros = CAST(ROUND(image_price_2k * 1000000) AS INTEGER),
  image_price_4k_micros = CAST(ROUND(image_price_4k * 1000000) AS INTEGER),
  web_search_price_per_call_micros = CAST(ROUND(web_search_price_per_call * 1000000) AS INTEGER);

UPDATE redeem_codes SET
  value_micros = CAST(ROUND(value * 1000000) AS INTEGER);

UPDATE vendor_usage_facts SET
  cost_usd_micros = CAST(ROUND(cost_usd * 1000000) AS INTEGER);

UPDATE vendor_settlements SET
  amount_usdt_micros = CAST(ROUND(amount_usdt * 1000000) AS INTEGER);

UPDATE vendor_payments SET
  amount_usdt_micros = CAST(ROUND(amount_usdt * 1000000) AS INTEGER);

CREATE TRIGGER api_keys_money_legacy_update AFTER UPDATE OF quota, quota_used, rate_limit_5h, rate_limit_1d, rate_limit_7d, usage_5h, usage_1d, usage_7d ON api_keys
WHEN (NEW.quota IS NOT OLD.quota AND NEW.quota_micros IS OLD.quota_micros)
  OR (NEW.quota_used IS NOT OLD.quota_used AND NEW.quota_used_micros IS OLD.quota_used_micros)
  OR (NEW.rate_limit_5h IS NOT OLD.rate_limit_5h AND NEW.rate_limit_5h_micros IS OLD.rate_limit_5h_micros)
  OR (NEW.rate_limit_1d IS NOT OLD.rate_limit_1d AND NEW.rate_limit_1d_micros IS OLD.rate_limit_1d_micros)
  OR (NEW.rate_limit_7d IS NOT OLD.rate_limit_7d AND NEW.rate_limit_7d_micros IS OLD.rate_limit_7d_micros)
  OR (NEW.usage_5h IS NOT OLD.usage_5h AND NEW.usage_5h_micros IS OLD.usage_5h_micros)
  OR (NEW.usage_1d IS NOT OLD.usage_1d AND NEW.usage_1d_micros IS OLD.usage_1d_micros)
  OR (NEW.usage_7d IS NOT OLD.usage_7d AND NEW.usage_7d_micros IS OLD.usage_7d_micros)
BEGIN
  UPDATE api_keys SET
    quota_micros = CASE WHEN (NEW.quota IS NOT OLD.quota AND NEW.quota_micros IS OLD.quota_micros) THEN CASE WHEN NEW.quota IS NULL THEN NULL WHEN ABS(NEW.quota) >= 2251799813.685248 THEN 0 ELSE CAST(ROUND(NEW.quota * 1000000) AS INTEGER) END ELSE quota_micros END,
    quota_used_micros = CASE WHEN (NEW.quota_used IS NOT OLD.quota_used AND NEW.quota_used_micros IS OLD.quota_used_micros) THEN CASE WHEN NEW.quota_used IS NULL OR ABS(NEW.quota_used) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.quota_used * 1000000) AS INTEGER) END ELSE quota_used_micros END,
    rate_limit_5h_micros = CASE WHEN (NEW.rate_limit_5h IS NOT OLD.rate_limit_5h AND NEW.rate_limit_5h_micros IS OLD.rate_limit_5h_micros) THEN CASE WHEN NEW.rate_limit_5h IS NULL THEN NULL WHEN ABS(NEW.rate_limit_5h) >= 2251799813.685248 THEN 0 ELSE CAST(ROUND(NEW.rate_limit_5h * 1000000) AS INTEGER) END ELSE rate_limit_5h_micros END,
    rate_limit_1d_micros = CASE WHEN (NEW.rate_limit_1d IS NOT OLD.rate_limit_1d AND NEW.rate_limit_1d_micros IS OLD.rate_limit_1d_micros) THEN CASE WHEN NEW.rate_limit_1d IS NULL THEN NULL WHEN ABS(NEW.rate_limit_1d) >= 2251799813.685248 THEN 0 ELSE CAST(ROUND(NEW.rate_limit_1d * 1000000) AS INTEGER) END ELSE rate_limit_1d_micros END,
    rate_limit_7d_micros = CASE WHEN (NEW.rate_limit_7d IS NOT OLD.rate_limit_7d AND NEW.rate_limit_7d_micros IS OLD.rate_limit_7d_micros) THEN CASE WHEN NEW.rate_limit_7d IS NULL THEN NULL WHEN ABS(NEW.rate_limit_7d) >= 2251799813.685248 THEN 0 ELSE CAST(ROUND(NEW.rate_limit_7d * 1000000) AS INTEGER) END ELSE rate_limit_7d_micros END,
    usage_5h_micros = CASE WHEN (NEW.usage_5h IS NOT OLD.usage_5h AND NEW.usage_5h_micros IS OLD.usage_5h_micros) THEN CASE WHEN NEW.usage_5h IS NULL OR ABS(NEW.usage_5h) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.usage_5h * 1000000) AS INTEGER) END ELSE usage_5h_micros END,
    usage_1d_micros = CASE WHEN (NEW.usage_1d IS NOT OLD.usage_1d AND NEW.usage_1d_micros IS OLD.usage_1d_micros) THEN CASE WHEN NEW.usage_1d IS NULL OR ABS(NEW.usage_1d) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.usage_1d * 1000000) AS INTEGER) END ELSE usage_1d_micros END,
    usage_7d_micros = CASE WHEN (NEW.usage_7d IS NOT OLD.usage_7d AND NEW.usage_7d_micros IS OLD.usage_7d_micros) THEN CASE WHEN NEW.usage_7d IS NULL OR ABS(NEW.usage_7d) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.usage_7d * 1000000) AS INTEGER) END ELSE usage_7d_micros END
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER api_keys_money_legacy_insert AFTER INSERT ON api_keys
WHEN (NEW.quota_micros IS NULL AND NEW.quota IS NOT NULL)
  OR (NEW.quota_used_micros IS NULL AND NEW.quota_used IS NOT NULL)
  OR (NEW.rate_limit_5h_micros IS NULL AND NEW.rate_limit_5h IS NOT NULL)
  OR (NEW.rate_limit_1d_micros IS NULL AND NEW.rate_limit_1d IS NOT NULL)
  OR (NEW.rate_limit_7d_micros IS NULL AND NEW.rate_limit_7d IS NOT NULL)
  OR (NEW.usage_5h_micros IS NULL AND NEW.usage_5h IS NOT NULL)
  OR (NEW.usage_1d_micros IS NULL AND NEW.usage_1d IS NOT NULL)
  OR (NEW.usage_7d_micros IS NULL AND NEW.usage_7d IS NOT NULL)
BEGIN
  UPDATE api_keys SET
    quota_micros = CASE WHEN NEW.quota_micros IS NULL THEN CASE WHEN NEW.quota IS NULL THEN NULL WHEN ABS(NEW.quota) >= 2251799813.685248 THEN 0 ELSE CAST(ROUND(NEW.quota * 1000000) AS INTEGER) END ELSE quota_micros END,
    quota_used_micros = CASE WHEN NEW.quota_used_micros IS NULL THEN CASE WHEN NEW.quota_used IS NULL OR ABS(NEW.quota_used) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.quota_used * 1000000) AS INTEGER) END ELSE quota_used_micros END,
    rate_limit_5h_micros = CASE WHEN NEW.rate_limit_5h_micros IS NULL THEN CASE WHEN NEW.rate_limit_5h IS NULL THEN NULL WHEN ABS(NEW.rate_limit_5h) >= 2251799813.685248 THEN 0 ELSE CAST(ROUND(NEW.rate_limit_5h * 1000000) AS INTEGER) END ELSE rate_limit_5h_micros END,
    rate_limit_1d_micros = CASE WHEN NEW.rate_limit_1d_micros IS NULL THEN CASE WHEN NEW.rate_limit_1d IS NULL THEN NULL WHEN ABS(NEW.rate_limit_1d) >= 2251799813.685248 THEN 0 ELSE CAST(ROUND(NEW.rate_limit_1d * 1000000) AS INTEGER) END ELSE rate_limit_1d_micros END,
    rate_limit_7d_micros = CASE WHEN NEW.rate_limit_7d_micros IS NULL THEN CASE WHEN NEW.rate_limit_7d IS NULL THEN NULL WHEN ABS(NEW.rate_limit_7d) >= 2251799813.685248 THEN 0 ELSE CAST(ROUND(NEW.rate_limit_7d * 1000000) AS INTEGER) END ELSE rate_limit_7d_micros END,
    usage_5h_micros = CASE WHEN NEW.usage_5h_micros IS NULL THEN CASE WHEN NEW.usage_5h IS NULL OR ABS(NEW.usage_5h) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.usage_5h * 1000000) AS INTEGER) END ELSE usage_5h_micros END,
    usage_1d_micros = CASE WHEN NEW.usage_1d_micros IS NULL THEN CASE WHEN NEW.usage_1d IS NULL OR ABS(NEW.usage_1d) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.usage_1d * 1000000) AS INTEGER) END ELSE usage_1d_micros END,
    usage_7d_micros = CASE WHEN NEW.usage_7d_micros IS NULL THEN CASE WHEN NEW.usage_7d IS NULL OR ABS(NEW.usage_7d) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.usage_7d * 1000000) AS INTEGER) END ELSE usage_7d_micros END
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER groups_money_legacy_update AFTER UPDATE OF image_price_1k, image_price_2k, image_price_4k, web_search_price_per_call ON groups
WHEN (NEW.image_price_1k IS NOT OLD.image_price_1k AND NEW.image_price_1k_micros IS OLD.image_price_1k_micros)
  OR (NEW.image_price_2k IS NOT OLD.image_price_2k AND NEW.image_price_2k_micros IS OLD.image_price_2k_micros)
  OR (NEW.image_price_4k IS NOT OLD.image_price_4k AND NEW.image_price_4k_micros IS OLD.image_price_4k_micros)
  OR (NEW.web_search_price_per_call IS NOT OLD.web_search_price_per_call AND NEW.web_search_price_per_call_micros IS OLD.web_search_price_per_call_micros)
BEGIN
  UPDATE groups SET
    image_price_1k_micros = CASE WHEN (NEW.image_price_1k IS NOT OLD.image_price_1k AND NEW.image_price_1k_micros IS OLD.image_price_1k_micros) THEN CASE WHEN NEW.image_price_1k IS NULL OR ABS(NEW.image_price_1k) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.image_price_1k * 1000000) AS INTEGER) END ELSE image_price_1k_micros END,
    image_price_2k_micros = CASE WHEN (NEW.image_price_2k IS NOT OLD.image_price_2k AND NEW.image_price_2k_micros IS OLD.image_price_2k_micros) THEN CASE WHEN NEW.image_price_2k IS NULL OR ABS(NEW.image_price_2k) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.image_price_2k * 1000000) AS INTEGER) END ELSE image_price_2k_micros END,
    image_price_4k_micros = CASE WHEN (NEW.image_price_4k IS NOT OLD.image_price_4k AND NEW.image_price_4k_micros IS OLD.image_price_4k_micros) THEN CASE WHEN NEW.image_price_4k IS NULL OR ABS(NEW.image_price_4k) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.image_price_4k * 1000000) AS INTEGER) END ELSE image_price_4k_micros END,
    web_search_price_per_call_micros = CASE WHEN (NEW.web_search_price_per_call IS NOT OLD.web_search_price_per_call AND NEW.web_search_price_per_call_micros IS OLD.web_search_price_per_call_micros) THEN CASE WHEN NEW.web_search_price_per_call IS NULL OR ABS(NEW.web_search_price_per_call) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.web_search_price_per_call * 1000000) AS INTEGER) END ELSE web_search_price_per_call_micros END
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER groups_money_legacy_insert AFTER INSERT ON groups
WHEN (NEW.image_price_1k_micros IS NULL AND NEW.image_price_1k IS NOT NULL)
  OR (NEW.image_price_2k_micros IS NULL AND NEW.image_price_2k IS NOT NULL)
  OR (NEW.image_price_4k_micros IS NULL AND NEW.image_price_4k IS NOT NULL)
  OR (NEW.web_search_price_per_call_micros IS NULL AND NEW.web_search_price_per_call IS NOT NULL)
BEGIN
  UPDATE groups SET
    image_price_1k_micros = CASE WHEN NEW.image_price_1k_micros IS NULL THEN CASE WHEN NEW.image_price_1k IS NULL OR ABS(NEW.image_price_1k) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.image_price_1k * 1000000) AS INTEGER) END ELSE image_price_1k_micros END,
    image_price_2k_micros = CASE WHEN NEW.image_price_2k_micros IS NULL THEN CASE WHEN NEW.image_price_2k IS NULL OR ABS(NEW.image_price_2k) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.image_price_2k * 1000000) AS INTEGER) END ELSE image_price_2k_micros END,
    image_price_4k_micros = CASE WHEN NEW.image_price_4k_micros IS NULL THEN CASE WHEN NEW.image_price_4k IS NULL OR ABS(NEW.image_price_4k) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.image_price_4k * 1000000) AS INTEGER) END ELSE image_price_4k_micros END,
    web_search_price_per_call_micros = CASE WHEN NEW.web_search_price_per_call_micros IS NULL THEN CASE WHEN NEW.web_search_price_per_call IS NULL OR ABS(NEW.web_search_price_per_call) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.web_search_price_per_call * 1000000) AS INTEGER) END ELSE web_search_price_per_call_micros END
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER redeem_codes_money_legacy_update AFTER UPDATE OF value ON redeem_codes
WHEN (NEW.value IS NOT OLD.value AND NEW.value_micros IS OLD.value_micros)
BEGIN
  UPDATE redeem_codes SET
    value_micros = CASE WHEN (NEW.value IS NOT OLD.value AND NEW.value_micros IS OLD.value_micros) THEN CASE WHEN NEW.value IS NULL OR ABS(NEW.value) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.value * 1000000) AS INTEGER) END ELSE value_micros END
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER redeem_codes_money_legacy_insert AFTER INSERT ON redeem_codes
WHEN (NEW.value_micros IS NULL AND NEW.value IS NOT NULL)
BEGIN
  UPDATE redeem_codes SET
    value_micros = CASE WHEN NEW.value_micros IS NULL THEN CASE WHEN NEW.value IS NULL OR ABS(NEW.value) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.value * 1000000) AS INTEGER) END ELSE value_micros END
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER vendor_usage_facts_money_legacy_update AFTER UPDATE OF cost_usd ON vendor_usage_facts
WHEN (NEW.cost_usd IS NOT OLD.cost_usd AND NEW.cost_usd_micros IS OLD.cost_usd_micros)
BEGIN
  UPDATE vendor_usage_facts SET
    cost_usd_micros = CASE WHEN (NEW.cost_usd IS NOT OLD.cost_usd AND NEW.cost_usd_micros IS OLD.cost_usd_micros) THEN CASE WHEN NEW.cost_usd IS NULL OR ABS(NEW.cost_usd) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER) END ELSE cost_usd_micros END
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER vendor_usage_facts_money_legacy_insert AFTER INSERT ON vendor_usage_facts
WHEN (NEW.cost_usd_micros IS NULL AND NEW.cost_usd IS NOT NULL)
BEGIN
  UPDATE vendor_usage_facts SET
    cost_usd_micros = CASE WHEN NEW.cost_usd_micros IS NULL THEN CASE WHEN NEW.cost_usd IS NULL OR ABS(NEW.cost_usd) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER) END ELSE cost_usd_micros END
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER vendor_settlements_money_legacy_update AFTER UPDATE OF amount_usdt ON vendor_settlements
WHEN (NEW.amount_usdt IS NOT OLD.amount_usdt AND NEW.amount_usdt_micros IS OLD.amount_usdt_micros)
BEGIN
  UPDATE vendor_settlements SET
    amount_usdt_micros = CASE WHEN (NEW.amount_usdt IS NOT OLD.amount_usdt AND NEW.amount_usdt_micros IS OLD.amount_usdt_micros) THEN CASE WHEN NEW.amount_usdt IS NULL OR ABS(NEW.amount_usdt) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.amount_usdt * 1000000) AS INTEGER) END ELSE amount_usdt_micros END
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER vendor_settlements_money_legacy_insert AFTER INSERT ON vendor_settlements
WHEN (NEW.amount_usdt_micros IS NULL AND NEW.amount_usdt IS NOT NULL)
BEGIN
  UPDATE vendor_settlements SET
    amount_usdt_micros = CASE WHEN NEW.amount_usdt_micros IS NULL THEN CASE WHEN NEW.amount_usdt IS NULL OR ABS(NEW.amount_usdt) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.amount_usdt * 1000000) AS INTEGER) END ELSE amount_usdt_micros END
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER vendor_payments_money_legacy_update AFTER UPDATE OF amount_usdt ON vendor_payments
WHEN (NEW.amount_usdt IS NOT OLD.amount_usdt AND NEW.amount_usdt_micros IS OLD.amount_usdt_micros)
BEGIN
  UPDATE vendor_payments SET
    amount_usdt_micros = CASE WHEN (NEW.amount_usdt IS NOT OLD.amount_usdt AND NEW.amount_usdt_micros IS OLD.amount_usdt_micros) THEN CASE WHEN NEW.amount_usdt IS NULL OR ABS(NEW.amount_usdt) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.amount_usdt * 1000000) AS INTEGER) END ELSE amount_usdt_micros END
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER vendor_payments_money_legacy_insert AFTER INSERT ON vendor_payments
WHEN (NEW.amount_usdt_micros IS NULL AND NEW.amount_usdt IS NOT NULL)
BEGIN
  UPDATE vendor_payments SET
    amount_usdt_micros = CASE WHEN NEW.amount_usdt_micros IS NULL THEN CASE WHEN NEW.amount_usdt IS NULL OR ABS(NEW.amount_usdt) >= 2251799813.685248 THEN NULL ELSE CAST(ROUND(NEW.amount_usdt * 1000000) AS INTEGER) END ELSE amount_usdt_micros END
  WHERE rowid = NEW.rowid;
END;

-- Rows of usage_logs whose integer columns disagree with their REAL mirror (written by the previous release).
CREATE INDEX idx_usage_logs_money_drift ON usage_logs(created_at)
WHERE (input_cost_micros IS NOT CAST(ROUND(input_cost * 1000000) AS INTEGER) AND (input_cost IS NULL OR ABS(input_cost) < 2251799813.685248))
   OR (output_cost_micros IS NOT CAST(ROUND(output_cost * 1000000) AS INTEGER) AND (output_cost IS NULL OR ABS(output_cost) < 2251799813.685248))
   OR (cache_read_cost_micros IS NOT CAST(ROUND(cache_read_cost * 1000000) AS INTEGER) AND (cache_read_cost IS NULL OR ABS(cache_read_cost) < 2251799813.685248))
   OR (cache_creation_cost_micros IS NOT CAST(ROUND(cache_creation_cost * 1000000) AS INTEGER) AND (cache_creation_cost IS NULL OR ABS(cache_creation_cost) < 2251799813.685248))
   OR (web_search_cost_micros IS NOT CAST(ROUND(web_search_cost * 1000000) AS INTEGER) AND (web_search_cost IS NULL OR ABS(web_search_cost) < 2251799813.685248))
   OR (image_cost_micros IS NOT CAST(ROUND(image_cost * 1000000) AS INTEGER) AND (image_cost IS NULL OR ABS(image_cost) < 2251799813.685248))
   OR (total_cost_micros IS NOT CAST(ROUND(total_cost * 1000000) AS INTEGER) AND (total_cost IS NULL OR ABS(total_cost) < 2251799813.685248))
   OR (actual_cost_micros IS NOT CAST(ROUND(actual_cost * 1000000) AS INTEGER) AND (actual_cost IS NULL OR ABS(actual_cost) < 2251799813.685248));
