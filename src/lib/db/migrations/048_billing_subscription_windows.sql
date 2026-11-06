-- Bound subscription admission queries to one subscription and its time window.
-- Keep existing reservation/ledger data and applied migrations unchanged.
CREATE INDEX idx_billing_reservations_subscription_created
ON billing_reservations(subscription_id, created_at);
