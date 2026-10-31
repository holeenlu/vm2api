-- Consumption remains available in billing_charges and usage_logs, not in recharge records.
-- Wallet balances are persisted separately, so removing these legacy rows does not change balances.
DELETE FROM wallet_ledger WHERE kind = 'usage';
