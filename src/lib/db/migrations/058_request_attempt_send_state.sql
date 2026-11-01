ALTER TABLE request_attempts ADD COLUMN send_state TEXT NOT NULL DEFAULT 'not_sent'
  CHECK (send_state IN ('not_sent', 'sent', 'ambiguous'));

UPDATE request_attempts
SET send_state = 'sent'
WHERE downstream_committed = 1;
