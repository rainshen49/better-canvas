-- Reading due dates added by classmates, and readings marked as discussed in class.
-- The Edge Function also creates these tables if they're missing, so this is
-- optional, but it keeps the database set up with `supabase db push`.

CREATE TABLE IF NOT EXISTS deadlines (
  course_id   BIGINT  NOT NULL,
  url         TEXT    NOT NULL,  -- the reading's link, the same for everyone in the course
  title       TEXT    NOT NULL,
  due_date    TEXT    NOT NULL,  -- YYYY-MM-DD
  set_by_id   BIGINT,            -- CourseWorks user id
  set_by_name TEXT    NOT NULL,
  set_at      TEXT    NOT NULL,  -- when it was set (UTC)
  PRIMARY KEY (course_id, url)
);

CREATE TABLE IF NOT EXISTS discussed_readings (
  course_id   BIGINT  NOT NULL,
  url         TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  set_by_id   BIGINT,
  set_by_name TEXT    NOT NULL,
  set_at      TEXT    NOT NULL,  -- when it was marked (UTC)
  PRIMARY KEY (course_id, url)
);

-- Only the Edge Function (which connects to the database directly) may read or
-- change these. Row Level Security with no policies blocks Supabase's public
-- API, which anyone with the project's public key could otherwise use.
ALTER TABLE deadlines ENABLE ROW LEVEL SECURITY;
ALTER TABLE discussed_readings ENABLE ROW LEVEL SECURITY;
