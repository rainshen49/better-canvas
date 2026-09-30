-- Analytics: the last time each person opened the app, by name only.
-- Only the Edge Function reads or writes it; the page never shows it.
-- The Edge Function also creates this table if it's missing.

CREATE TABLE IF NOT EXISTS user_logins (
  name          TEXT  PRIMARY KEY,  -- the person's CourseWorks name
  last_login_at TEXT  NOT NULL      -- when they last opened the app (UTC)
);

ALTER TABLE user_logins ENABLE ROW LEVEL SECURITY;
