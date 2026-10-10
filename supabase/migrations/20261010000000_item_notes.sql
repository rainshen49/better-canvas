-- Short notes that classmates leave on assignments, readings and other due items.
-- One note per item; anyone in the course can replace or delete it.
-- The Edge Function also creates this table if it's missing.

CREATE TABLE IF NOT EXISTS item_notes (
  course_id   BIGINT  NOT NULL,
  item_key    TEXT    NOT NULL,  -- the due item's key, e.g. assignment:123:456
  note        TEXT    NOT NULL,
  set_by_id   BIGINT,            -- CourseWorks user id
  set_by_name TEXT    NOT NULL,
  set_at      TEXT    NOT NULL,  -- when it was written (UTC)
  PRIMARY KEY (course_id, item_key)
);

-- Only the Edge Function (which connects to the database directly) may read or change it.
ALTER TABLE item_notes ENABLE ROW LEVEL SECURITY;
