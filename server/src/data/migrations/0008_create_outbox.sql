-- 0008 — the transactional outbox: rows describing messages a relay must
-- ship to the message stream, written in the SAME transaction as the business
-- change they describe (a row exists if and only if its change committed).
-- published_at NULL = still to ship; attempts + next_attempt_at carry the
-- relay's own retry state (backoff pushes next_attempt_at into the future).
-- Timestamps are UTC ISO-8601 TEXT, like every timestamp in this guide, and
-- the PARTIAL index serves the relay's one hot query — "what is due?" — over
-- only the still-unpublished rows, never the growing archive of shipped ones.

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL
);

CREATE INDEX idx_outbox_due ON outbox(next_attempt_at) WHERE published_at IS NULL;
