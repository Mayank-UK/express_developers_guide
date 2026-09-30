-- 0002 — indexes arrive as their OWN ordered step, not as edits to 0001:
-- schema history is append-only. posts_tags's primary key already covers
-- look-ups by post_id; this step covers the other direction (by tag_id) and
-- makes tags.name searches index-driven (the UNIQUE constraint already
-- guards it; the explicit index makes the read path honest).

CREATE INDEX idx_posts_tags_tag_id ON posts_tags(tag_id);
CREATE INDEX idx_tags_name ON tags(name);
