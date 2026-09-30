-- 0007 — the audit trail: who changed what, row-shaped. old_values/new_values
-- are JSON TEXT snapshots ({title, body}) taken inside the SAME transaction as
-- the change they describe, so a trail row exists if and only if its change
-- committed. created_at is a UTC ISO-8601 TEXT stamp, like every timestamp in
-- this guide. The (entity, entity_id) index serves the "show me this row's
-- history" read.

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  old_values TEXT NOT NULL,
  new_values TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
