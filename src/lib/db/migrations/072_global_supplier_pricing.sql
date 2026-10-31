-- Price rules are global; statement ownership is independent of the price version.
-- Existing contracts and frozen statements remain unchanged.
ALTER TABLE vendor_contracts ADD COLUMN idempotency_key TEXT;
ALTER TABLE vendor_contracts ADD COLUMN input_hash TEXT;
CREATE UNIQUE INDEX idx_vendor_global_pricing_version ON vendor_contracts(version)
  WHERE payer_vendor_id IS NULL AND payee_vendor_id IS NULL;
CREATE UNIQUE INDEX idx_vendor_global_pricing_request ON vendor_contracts(created_by,idempotency_key)
  WHERE payer_vendor_id IS NULL AND payee_vendor_id IS NULL AND idempotency_key IS NOT NULL;
ALTER TABLE vendor_settlements ADD COLUMN payer_vendor_id TEXT REFERENCES vendors(id);
ALTER TABLE vendor_settlements ADD COLUMN payee_vendor_id TEXT REFERENCES vendors(id);
UPDATE vendor_settlements SET
  payer_vendor_id=(SELECT c.payer_vendor_id FROM vendor_contracts c WHERE c.id=vendor_settlements.contract_id),
  payee_vendor_id=(SELECT c.payee_vendor_id FROM vendor_contracts c WHERE c.id=vendor_settlements.contract_id);
CREATE INDEX idx_vendor_statement_edge ON vendor_settlements(payer_vendor_id,payee_vendor_id,period_start,period_end);
