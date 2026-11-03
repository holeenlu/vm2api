-- Preserve cache evidence after detailed request logs expire. NULL means unknown.
ALTER TABLE vendor_usage_facts ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE vendor_usage_facts ADD COLUMN cache_creation_tokens INTEGER;

-- Recover only recorded values; never manufacture zeroes for missing history.
UPDATE vendor_usage_facts AS f
SET cache_read_tokens = u.cache_read_tokens,
    cache_creation_tokens = u.cache_creation_tokens
FROM usage_logs AS u
WHERE u.request_id = f.source_request_id;
