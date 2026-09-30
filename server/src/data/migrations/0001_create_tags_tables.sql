-- 0001 — the demo database's first schema: a many-to-many between demo posts
-- and tags. Migration files are numbered so the runner can order them, named
-- so a human can read the schema's history at a glance, and append-only so an
-- applied file NEVER changes again (a changed file is a new file).

CREATE TABLE demo_posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 40)
);

CREATE TABLE posts_tags (
  post_id TEXT NOT NULL REFERENCES demo_posts(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);
