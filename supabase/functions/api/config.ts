// Settings, read from environment variables.
//
// On Supabase, set them with `supabase secrets set NAME=value`. When running
// locally (`deno task start`), set them in your shell.

const env = (name: string) => Deno.env.get(name)?.trim() || undefined;

/** The CourseWorks (Canvas) site. Point it at a fake server for testing. */
export const BASE = (env("CANVAS_BASE") ?? "https://courseworks2.columbia.edu").replace(/\/+$/, "");

/** How many days ahead "Due soon" looks, for both CourseWorks items and classmates' reading dates. */
export const DAYS_AHEAD = Number(env("DAYS_AHEAD") ?? "14");

/** A reading's due date can be one of this many days, starting today. The page has the same limit. */
export const PICK_DAYS = 7;

/**
 * The time zone "today" follows (for reading due dates and the 7 pickable days).
 * Edge Functions run on UTC, so without this "today" would switch over at 8 pm New York time.
 */
export const APP_TIMEZONE = env("APP_TIMEZONE") ?? "America/New_York";

/** How many requests to CourseWorks can run at once for one page load. */
export const CONCURRENCY = 8;

/**
 * Courses to hide entirely. Each entry hides any course whose code or name
 * contains it (ignoring upper/lower case), so "Exemption" hides every exemption exam.
 * Add more with IGNORE_COURSES="CODE1,CODE2".
 */
export const IGNORE_COURSES = [
  "ENGIE4503",
  "Exemption",
  "CBS Python Level 1",
  "SEAS Mandatory Orientation Tutorials",
  ...(env("IGNORE_COURSES") ?? "").split(",").map((x) => x.trim()).filter(Boolean),
];

/**
 * Which web pages may call this API from a browser (CORS), comma-separated.
 * Defaults to the GitHub Pages site only. Add more with
 * ALLOWED_ORIGINS="https://rainshen49.github.io,https://other.example", or "*"
 * to allow any page. Running locally doesn't need this: there the page and API
 * are on the same server.
 */
export const ALLOWED_ORIGINS = (env("ALLOWED_ORIGINS") ?? "https://rainshen49.github.io")
  .split(",").map((x) => x.trim()).filter(Boolean);

/**
 * Where reading due dates are saved. On Supabase, SUPABASE_DB_URL is set
 * automatically. Locally, set DATABASE_URL to use a Postgres database, or leave
 * both unset and dev.ts uses a SQLite file (DEADLINES_DB, default reading_deadlines.db).
 */
export const DATABASE_URL = env("DATABASE_URL") ?? env("SUPABASE_DB_URL");
