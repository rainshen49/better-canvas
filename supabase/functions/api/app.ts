// The web API. One handler serves every route:
//
//   GET  /api/data              streams everything the page shows (below)
//   POST /api/reading-deadline  sets or removes a reading's due date, or marks it as discussed
//   GET  /api/file-preview      how a file can be previewed
//   GET  /api/file-content      a PDF or text file, passed through for the preview
//   GET  /api/page              a CourseWorks page's content, cleaned
//
// On Supabase this runs as the Edge Function "api", so the page calls
// https://<project>.supabase.co/functions/v1/api/data and so on. Locally,
// dev.ts serves it next to the page.
//
// Each visitor sends their own CourseWorks token in the X-Canvas-Token header.
// It is used only while answering that one request and is never saved or logged.

import { absUrl, CanvasClient, CanvasError } from "./canvas.ts";
import { previewKind } from "./classify.ts";
import { ALLOWED_ORIGINS, DAYS_AHEAD, PICK_DAYS } from "./config.ts";
import { addDays, fetchDetail, fetchDue, today } from "./due.ts";
import { allEntries, courseSummary, fetchCourses, fetchMaterials } from "./materials.ts";
import { sanitize } from "./sanitize.ts";
import { setDeadline, setDiscussed } from "./store.ts";

const NO_STORE = { "Cache-Control": "no-store" };
const BAD_TOKEN = "That token didn't work. It may be mistyped, expired or revoked.";

class NeedToken extends Error {}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...NO_STORE, ...headers },
  });
}

const refuse = (error: string, status = 400) => json({ error }, status);

function tokenFrom(req: Request): string {
  const token = (req.headers.get("x-canvas-token") ?? "").trim();
  if (!token) throw new NeedToken("No token provided.");
  return token;
}

const errorName = (e: unknown) => (e instanceof Error ? e.name : "Error");

// ─── CORS: lets the page, hosted on another site (GitHub Pages), call this API ───

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowAll = ALLOWED_ORIGINS.includes("*");
  const allowed = allowAll ? "*" : origin && ALLOWED_ORIGINS.includes(origin) ? origin : null;
  if (!allowed) return {};
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "x-canvas-token, content-type, authorization, apikey, x-client-info",
    "Access-Control-Max-Age": "86400",
    ...(allowAll ? {} : { Vary: "Origin" }),
  };
}

// ─── GET /api/data: everything the page shows, streamed ───────────────────────

/**
 * Send updates to the browser, one JSON object per line, as each piece of data
 * is ready: "start" (the course list) first; then "due" / "due_error", "course" /
 * "course_error" and "due_detail" in whatever order they finish; "done" last.
 */
function streamEvents(cv: CanvasClient, me: any, courses: any[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const send = (event: unknown) => {
        if (!cv.abort.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      const summaries = courses.map(courseSummary)
        .sort((a, b) => Number(!a.is_class) - Number(!b.is_class) || (a.name ?? "").localeCompare(b.name ?? ""));
      send({ type: "start", user: me.name || me.short_name || "", days: DAYS_AHEAD, courses: summaries });

      // Every task sends its own update when it finishes (or fails, without stopping the rest).
      let pending = 0;
      const run = <T>(work: () => Promise<T>, onDone: (result: T) => void, onError: (message: string) => void) => {
        pending++;
        work()
          .then(onDone, (e) => onError(`${errorName(e)}: ${e?.message ?? e}`))
          .finally(() => {
            if (--pending === 0 && !cv.abort.signal.aborted) {
              send({ type: "done", generated: new Date().toISOString() });
              controller.close();
            }
          });
      };

      run(() => fetchDue(cv, courses), (due) => {
        send({ type: "due", due });
        for (const item of due) { // now fetch the full details of each due item
          if (!item.has_detail) continue;
          run(
            () => fetchDetail(cv, item),
            (detail) => send({ type: "due_detail", key: item.key, detail }),
            (error) => send({ type: "due_detail", key: item.key, error }),
          );
        }
      }, (error) => send({ type: "due_error", error }));

      for (const c of courses) {
        run(
          () => fetchMaterials(cv, c),
          (course) => send({ type: "course", course }),
          (error) => send({ type: "course_error", id: c.id, error }),
        );
      }
    },
    cancel() {
      cv.abort.abort(); // the browser left early: stop asking CourseWorks for more
    },
  });
}

async function apiData(req: Request): Promise<Response> {
  const cv = new CanvasClient(tokenFrom(req));
  let me, courses;
  try {
    me = await cv.getAll("/users/self/profile"); // checks the token works before sending anything
    courses = await fetchCourses(cv);
  } catch (e) {
    if (e instanceof CanvasError && e.status === 401) throw new NeedToken(BAD_TOKEN);
    return json({ error: String((e as Error)?.message ?? e) });
  }
  return new Response(streamEvents(cv, me, courses), {
    headers: { "Content-Type": "application/x-ndjson", ...NO_STORE, "X-Accel-Buffering": "no" },
  });
}

// ─── POST /api/reading-deadline ──────────────────────────────────────────────

/**
 * Set or remove a reading's due date, or mark it as discussed in class for everyone in the course.
 * Body: {"course_id", "url", "date": "YYYY-MM-DD" or null} to set or remove the date,
 * or {"course_id", "url", "discussed": true or false} to mark or unmark it as discussed in class.
 * Answers with the reading's new state: {"deadline": … or null, "discussed": … or null}.
 *
 * The person's name comes from CourseWorks (not from the page), and the
 * reading must really be a reading in a course they're in, so nobody can
 * act under someone else's name or for courses they aren't taking.
 */
async function setReading(req: Request): Promise<Response> {
  const token = tokenFrom(req);
  let body: any;
  try {
    body = await req.json();
  } catch {
    return refuse("The request wasn't readable.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return refuse("The request wasn't readable.");
  const { course_id: courseId, url } = body;
  const day = body.date ?? null;
  const discuss = body.discussed ?? null;
  if (!Number.isInteger(courseId) || typeof url !== "string" || !url) return refuse("Missing course or reading.");
  if (discuss !== null && (typeof discuss !== "boolean" || day !== null)) {
    return refuse("Can't set a date and hide a reading at the same time.");
  }
  if (day !== null) {
    if (
      typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day + "T00:00:00Z")) ||
      new Date(day + "T00:00:00Z").toISOString().slice(0, 10) !== day
    ) {
      return refuse("That isn't a valid date.");
    }
    const first = today();
    if (!(day >= first && day <= addDays(first, PICK_DAYS - 1))) {
      return refuse(`Pick a date within the next ${PICK_DAYS} days.`);
    }
  }

  const cv = new CanvasClient(token);
  let me, materials;
  try {
    me = await cv.getAll("/users/self/profile");
    const course = await cv.safe(`/courses/${courseId}`, { "include[]": ["term"] });
    if (!course) return refuse("You don't seem to be in this course.", 403);
    materials = await fetchMaterials(cv, course);
  } catch (e) {
    if (e instanceof CanvasError) {
      if (e.status === 401) throw new NeedToken(BAD_TOKEN);
      return refuse(`Couldn't check with CourseWorks (${e.message}).`, 502);
    }
    return refuse(`Couldn't reach CourseWorks (${errorName(e)}).`, 502);
  }

  const reading = allEntries(materials).find((e) => e.url === url && e.cat === "reading");
  if (!reading) return refuse("That reading wasn't found in this course.", 404);

  const name = me.name || me.short_name || "A classmate";
  const userId = me.id ?? null;
  let deadline = null, discussed = null;
  if (discuss === null) {
    // Setting a date unmarks the reading as discussed; removing one leaves it unmarked.
    deadline = await setDeadline(courseId, url, reading.title, day, userId, name);
  } else {
    // Marking it as discussed removes the date; unmarking leaves the reading without one.
    discussed = await setDiscussed(courseId, url, reading.title, discuss, userId, name);
  }
  return json({ deadline, discussed });
}

// ─── Previews ────────────────────────────────────────────────────────────────

/**
 * A file's details from CourseWorks. CourseWorks itself checks that this
 * person is allowed to see the file. Returns [info, null] or [null, error response].
 */
async function fileInfo(cv: CanvasClient, fileId: number): Promise<[any, Response | null]> {
  try {
    return [await cv.getAll(`/files/${fileId}`, { "include[]": ["preview_url"] }), null];
  } catch (e) {
    if (e instanceof CanvasError) {
      // CourseWorks also answers 401 for files you aren't allowed to see,
      // so only log the person out if the token itself no longer works.
      if (e.status === 401 && (await cv.safe("/users/self/profile")) === null) throw new NeedToken(BAD_TOKEN);
      return [null, refuse("This file isn't available to you.", 404)];
    }
    return [null, refuse(`Couldn't reach CourseWorks (${errorName(e)}).`, 502)];
  }
}

function fileIdFrom(url: URL): number | null {
  const id = Number(url.searchParams.get("file_id"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * How to preview a file inside the page:
 *   "pdf", "text":             the page gets the file from /api/file-content
 *   "image", "video", "audio": `src` is the file's own download link
 *   "viewer":                  `viewer_url` is CourseWorks's document viewer (Word, PowerPoint, Excel…)
 *   "none":                    no preview is available
 */
async function filePreview(req: Request, url: URL): Promise<Response> {
  const cv = new CanvasClient(tokenFrom(req));
  const fileId = fileIdFrom(url);
  if (!fileId) return refuse("Missing file.");
  const [info, error] = await fileInfo(cv, fileId);
  if (error) return error;
  const result: Record<string, unknown> = { name: info.display_name ?? null, size: info.size ?? null, kind: "none" };
  const kind = previewKind(info.display_name, info["content-type"]);
  if (kind === "pdf" || kind === "text") {
    result.kind = kind;
  } else if ((kind === "image" || kind === "video" || kind === "audio") && info.url) {
    // The download link carries its own access code (not the token).
    Object.assign(result, { kind, src: absUrl(info.url) });
  } else if (info.preview_url) {
    // This link needs the token, and it forwards to a viewer link that doesn't.
    // Follow it here so the token never leaves this server.
    const viewer = await cv.redirectTarget(absUrl(info.preview_url)!);
    if (viewer && /^https?:\/\//.test(viewer)) Object.assign(result, { kind: "viewer", viewer_url: viewer });
  }
  return json(result);
}

/**
 * Pass a PDF or plain-text file from CourseWorks through to the page so it can be
 * shown inline. Nothing else is allowed, so nothing that could run as a web page
 * is ever served from this app.
 */
async function fileContent(req: Request, url: URL): Promise<Response> {
  const cv = new CanvasClient(tokenFrom(req));
  const fileId = fileIdFrom(url);
  if (!fileId) return refuse("Missing file.");
  const [info, error] = await fileInfo(cv, fileId);
  if (error) return error;
  const kind = previewKind(info.display_name, info["content-type"]);
  if ((kind !== "pdf" && kind !== "text") || !info.url) return refuse("This file can't be previewed this way.", 415);

  let upstream: Response;
  try {
    upstream = await cv.download(info.url);
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
  } catch (e) {
    return refuse(`Couldn't download the file (${errorName(e)}).`, 502);
  }
  const headers: Record<string, string> = {
    ...NO_STORE,
    "Content-Type": kind === "pdf" ? "application/pdf" : "text/plain; charset=utf-8",
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
  };
  const length = upstream.headers.get("content-length");
  if (length) headers["Content-Length"] = length;
  return new Response(upstream.body, { headers });
}

/** A CourseWorks page's content, with anything unsafe removed. */
async function pagePreview(req: Request, url: URL): Promise<Response> {
  const courseId = Number(url.searchParams.get("course_id"));
  const pageUrl = url.searchParams.get("page_url") ?? "";
  if (!Number.isInteger(courseId) || !/^[\w.%~-]{1,300}$/.test(pageUrl)) return refuse("That isn't a valid page.");
  const cv = new CanvasClient(tokenFrom(req));
  let page;
  try {
    page = await cv.getAll(`/courses/${courseId}/pages/${pageUrl}`);
  } catch (e) {
    if (e instanceof CanvasError) {
      if (e.status === 401 && (await cv.safe("/users/self/profile")) === null) throw new NeedToken(BAD_TOKEN);
      return refuse("This page isn't available to you.", 404);
    }
    return refuse(`Couldn't reach CourseWorks (${errorName(e)}).`, 502);
  }
  return json({ title: page.title, html: sanitize(page.body) });
}

// ─── Routing ─────────────────────────────────────────────────────────────────

const ROUTES: Record<string, (req: Request, url: URL) => Promise<Response>> = {
  "GET data": apiData,
  "POST reading-deadline": setReading,
  "GET file-preview": filePreview,
  "GET file-content": fileContent,
  "GET page": pagePreview,
};

/** Handles one request. On Supabase the path looks like /api/data; locally too. */
export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const name = url.pathname.match(/\/api\/([\w-]+)\/?$/)?.[1] ?? "";
  const route = ROUTES[`${req.method} ${name}`];
  let response: Response;
  try {
    response = route ? await route(req, url) : refuse("Not found.", 404);
  } catch (e) {
    if (e instanceof NeedToken) response = json({ error: e.message, need_token: true }, 401);
    else {
      console.error(`${req.method} /api/${name} failed: ${errorName(e)}`); // never logs the token
      response = refuse("Something went wrong on the server.", 500);
    }
  }
  for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
  return response;
}
