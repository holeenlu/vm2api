-- Actual response echo is independent of the Codex outbound/billing model.
-- Leave historical rows unknown; do not infer a response from a request.
ALTER TABLE usage_logs ADD COLUMN response_model TEXT;
