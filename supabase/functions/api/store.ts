// Reading due dates added by classmates, and readings they've marked as discussed in class.
//
// `deadlines` holds the latest date for each reading (one row per course and
// reading link) and who set it. Older dates aren't kept.
//
// `discussed_readings` lists readings someone in the course marked as discussed
// in class, so they don't need a due date, and who did it.
// A reading is in at most one of the two tables: giving it a date unmarks
// it, and marking it removes its date. Each switch happens in one transaction.
//
// `user_logins` is for analytics only: the last time each person opened the
// app, by name (nothing else about them is kept). The page never reads it.
//
// Saved in Postgres when DATABASE_URL or SUPABASE_DB_URL is set (on Supabase
// the function connects straight to the project's database with plain SQL).
// When running locally without either, dev.ts plugs in a SQLite file instead
// (see useDatabase), so the Edge Function itself only ever needs Postgres.

import postgres from "postgres";
import { DATABASE_URL } from "./config.ts";

export interface Deadline {
  date: string; // YYYY-MM-DD
  by: string;
  at: string; // when it was set (UTC, ISO 8601)
  title: string;
}
export interface Discussed {
  by: string;
  at: string;
  title: string;
}

// The same statements work in Postgres and SQLite. Tables are also created by
// the migration in supabase/migrations; creating them here too means a fresh
// database (or a local SQLite file) works without that step.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS deadlines (
     course_id   BIGINT  NOT NULL,
     url         TEXT    NOT NULL,  -- the reading's link, the same for everyone in the course
     title       TEXT    NOT NULL,
     due_date    TEXT    NOT NULL,  -- YYYY-MM-DD
     set_by_id   BIGINT,            -- CourseWorks user id
     set_by_name TEXT    NOT NULL,
     set_at      TEXT    NOT NULL,  -- when it was set (UTC)
     PRIMARY KEY (course_id, url)
   )`,
  `CREATE TABLE IF NOT EXISTS discussed_readings (
     course_id   BIGINT  NOT NULL,
     url         TEXT    NOT NULL,
     title       TEXT    NOT NULL,
     set_by_id   BIGINT,
     set_by_name TEXT    NOT NULL,
     set_at      TEXT    NOT NULL,  -- when it was marked (UTC)
     PRIMARY KEY (course_id, url)
   )`,
  `CREATE TABLE IF NOT EXISTS user_logins (
     name          TEXT  PRIMARY KEY,  -- the person's CourseWorks name
     last_login_at TEXT  NOT NULL      -- when they last opened the app (UTC)
   )`,
];
// Postgres only: Supabase's public API (used with the project's public key) can
// see tables in the "public" schema. Row Level Security with no policies
// blocks it completely; this function's direct connection isn't affected.
const POSTGRES_ONLY = [
  "ALTER TABLE deadlines ENABLE ROW LEVEL SECURITY",
  "ALTER TABLE discussed_readings ENABLE ROW LEVEL SECURITY",
  "ALTER TABLE user_logins ENABLE ROW LEVEL SECURITY",
];

export type Row = Record<string, any>;
export type Statement = [sql: string, params?: unknown[]];

/** Runs statements written with ? placeholders. Several statements run as one transaction. */
export interface Database {
  run(statements: Statement[]): Promise<Row[]>; // rows of the last statement
}

async function openPostgres(url: string): Promise<Database> {
  // One connection per running copy of the function. prepare: false works with
  // Supabase's connection pooler as well as a direct connection.
  const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 20, onnotice: () => {} });
  const toDollar = (text: string) => {
    let n = 0;
    return text.replace(/\?/g, () => `$${++n}`);
  };
  const db: Database = {
    async run(statements) {
      if (statements.length === 1) {
        const [text, params = []] = statements[0];
        return [...(await sql.unsafe(toDollar(text), params as any[]))];
      }
      return await sql.begin(async (tx: any) => {
        let rows: Row[] = [];
        for (const [text, params = []] of statements) rows = [...(await tx.unsafe(toDollar(text), params))];
        return rows;
      }) as Row[];
    },
  };
  await db.run([...SCHEMA, ...POSTGRES_ONLY].map((s) => [s] as Statement));
  return db;
}

let openLocal: (() => Promise<Database>) | null = null;
let localKind = "";
/** Used by dev.ts: where to save when no Postgres address is set. */
export function useDatabase(open: () => Promise<Database>, kind: string) {
  openLocal = open;
  localKind = kind;
}

let opening: Promise<Database> | null = null;
/** The database, opened on first use and then shared by every request this copy of the function handles. */
function database(): Promise<Database> {
  const open = DATABASE_URL ? () => openPostgres(DATABASE_URL!) : openLocal;
  if (!open) return Promise.reject(new Error("No database set up (SUPABASE_DB_URL or DATABASE_URL)."));
  opening ??= open().catch((e) => {
    opening = null; // try again on the next request
    throw e;
  });
  return opening;
}

export const storeKind = () => (DATABASE_URL ? "Postgres" : localKind || "nowhere (no database set up)");

const nowUtc = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

function publicDeadline(r: Row): Deadline {
  return { date: r.due_date, by: r.set_by_name, at: r.set_at, title: r.title };
}

/** {reading link: {date, by, at, title}} for one course. */
export async function deadlinesForCourse(courseId: number): Promise<Record<string, Deadline>> {
  const rows = await (await database()).run([["SELECT * FROM deadlines WHERE course_id = ?", [courseId]]]);
  return Object.fromEntries(rows.map((r) => [r.url, publicDeadline(r)]));
}

/** {reading link: {by, at, title}} for the readings marked as discussed in class in one course. */
export async function discussedForCourse(courseId: number): Promise<Record<string, Discussed>> {
  const rows = await (await database()).run([["SELECT * FROM discussed_readings WHERE course_id = ?", [courseId]]]);
  return Object.fromEntries(rows.map((r) => [r.url, { by: r.set_by_name, at: r.set_at, title: r.title }]));
}

/** Readings in these courses that are due from `first` to `last` (YYYY-MM-DD, inclusive). */
export async function deadlinesBetween(courseIds: number[], first: string, last: string) {
  if (!courseIds.length) return [];
  const marks = courseIds.map(() => "?").join(",");
  const rows = await (await database()).run([[
    `SELECT * FROM deadlines WHERE course_id IN (${marks}) AND due_date BETWEEN ? AND ?`,
    [...courseIds, first, last],
  ]]);
  return rows.map((r) => ({ ...publicDeadline(r), course_id: Number(r.course_id), url: r.url as string }));
}

/**
 * Save (or, when dueDate is null, remove) a reading's due date. Giving it a
 * date also unmarks it as discussed. Returns the new value or null.
 */
export async function setDeadline(
  courseId: number,
  url: string,
  title: string,
  dueDate: string | null,
  userId: number | null,
  userName: string,
): Promise<Deadline | null> {
  const db = await database();
  if (dueDate === null) {
    await db.run([["DELETE FROM deadlines WHERE course_id = ? AND url = ?", [courseId, url]]]);
    return null;
  }
  const now = nowUtc();
  await db.run([
    ["DELETE FROM discussed_readings WHERE course_id = ? AND url = ?", [courseId, url]],
    [
      `INSERT INTO deadlines (course_id, url, title, due_date, set_by_id, set_by_name, set_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (course_id, url) DO UPDATE SET
         title = excluded.title, due_date = excluded.due_date, set_by_id = excluded.set_by_id,
         set_by_name = excluded.set_by_name, set_at = excluded.set_at`,
      [courseId, url, title, dueDate, userId, userName, now],
    ],
  ]);
  return { date: dueDate, by: userName, at: now, title };
}

/**
 * Mark a reading as discussed in class for everyone in the course (which also
 * removes its due date), or unmark it. Returns the new value or null.
 */
export async function setDiscussed(
  courseId: number,
  url: string,
  title: string,
  discussed: boolean,
  userId: number | null,
  userName: string,
): Promise<Discussed | null> {
  const db = await database();
  if (!discussed) {
    await db.run([["DELETE FROM discussed_readings WHERE course_id = ? AND url = ?", [courseId, url]]]);
    return null;
  }
  const now = nowUtc();
  await db.run([
    ["DELETE FROM deadlines WHERE course_id = ? AND url = ?", [courseId, url]],
    [
      `INSERT INTO discussed_readings (course_id, url, title, set_by_id, set_by_name, set_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (course_id, url) DO UPDATE SET
         title = excluded.title, set_by_id = excluded.set_by_id,
         set_by_name = excluded.set_by_name, set_at = excluded.set_at`,
      [courseId, url, title, userId, userName, now],
    ],
  ]);
  return { by: userName, at: now, title };
}

/** Analytics: note that this person (by name only) just logged in. */
export async function recordLogin(name: string): Promise<void> {
  await (await database()).run([[
    `INSERT INTO user_logins (name, last_login_at) VALUES (?, ?)
     ON CONFLICT (name) DO UPDATE SET last_login_at = excluded.last_login_at`,
    [name, nowUtc()],
  ]]);
}
