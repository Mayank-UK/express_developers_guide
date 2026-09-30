-- 0005 — full-text search over posts, the production-shaped way: an
-- EXTERNAL-CONTENT FTS5 index (title + body) that stores only the index and
-- reads column values back from posts itself — one source of truth, no
-- duplicated content. FTS5 has no idea when posts changes, so three triggers
-- keep the index in step. The UPDATE and DELETE triggers use FTS5's special
-- 'delete' command: an external-content index cannot be told "remove rowid X"
-- directly — it must be shown the OLD values so it can un-index them.

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE posts_fts USING fts5(
  title,
  body,
  content='posts',
  content_rowid='rowid'
);

CREATE TRIGGER posts_fts_insert AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER posts_fts_delete AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER posts_fts_update AFTER UPDATE OF title, body ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO posts_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
