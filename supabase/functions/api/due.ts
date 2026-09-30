// "Due soon": what's due in the next DAYS_AHEAD days, and each item's details.

import { absUrl, CanvasClient } from "./canvas.ts";
import { previewKind, shortNames } from "./classify.ts";
import { APP_TIMEZONE, DAYS_AHEAD } from "./config.ts";
import { sanitize, stripTags, unescapeHtml } from "./sanitize.ts";
import { deadlinesBetween } from "./store.ts";

const DAY_MS = 864e5;

/** Today's date as "YYYY-MM-DD" in APP_TIMEZONE. */
export function today(): string {
  // The en-CA format is already YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE }).format(new Date());
}

/** "YYYY-MM-DD" plus a number of days. */
export function addDays(day: string, days: number): string {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The next `count` weekdays (Mon–Fri) as "YYYY-MM-DD", starting from `first` if it's a weekday. */
export function nextWeekdays(first: string, count: number): string[] {
  const days: string[] = [];
  for (let day = first; days.length < count; day = addDays(day, 1)) {
    const weekday = new Date(day + "T12:00:00Z").getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(day);
  }
  return days;
}

/** Canvas wants times like 2026-09-24T18:00:00Z (no milliseconds). */
const canvasTime = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export const DETAIL_PATHS: Record<string, string> = {
  assignment: "/courses/{cid}/assignments/{pid}",
  quiz: "/courses/{cid}/quizzes/{pid}",
  discussion_topic: "/courses/{cid}/discussion_topics/{pid}",
  wiki_page: "/courses/{cid}/pages/{pid}",
};

export async function fetchDue(cv: CanvasClient, courses: any[]) {
  const now = new Date();
  const end = new Date(now.getTime() + DAYS_AHEAD * DAY_MS);
  const names = new Map<number, string>(courses.map((c) => [c.id, shortNames(c)[1]]));
  const items: any[] = [];

  const planner: any[] | null = await cv.safe("/planner/items", {
    start_date: canvasTime(now),
    end_date: canvasTime(end),
  });
  if (planner !== null) {
    for (const p of planner) {
      const type = p.plannable_type;
      if (type === "announcement" || type === "calendar_event") continue;
      const pl = p.plannable ?? {};
      const due = pl.due_at || pl.todo_date || p.plannable_date;
      if (!due) continue;
      const subs = p.submissions && typeof p.submissions === "object" ? p.submissions : {};
      const cid = p.course_id;
      items.push({
        title: pl.title || pl.name || "(untitled)",
        type,
        due,
        course: names.get(cid) || p.context_name || "",
        course_id: cid,
        url: absUrl(p.html_url),
        points: pl.points_possible ?? null,
        submitted: Boolean(subs.submitted),
        graded: Boolean(subs.graded),
        missing: Boolean(subs.missing),
        pid: p.plannable_id ?? null,
        key: `${type}:${cid}:${p.plannable_id}`,
        has_detail: type in DETAIL_PATHS && Boolean(cid && p.plannable_id),
      });
    }
  } else {
    // The planner couldn't be read, so look at each course's upcoming
    // assignments instead (this finds assignments only)
    const perCourse = await Promise.all(courses.map(async (c) => {
      const res: any[] = (await cv.safe(`/courses/${c.id}/assignments`, {
        bucket: "upcoming",
        "include[]": ["submission"],
      })) ?? [];
      return res
        .filter((a) => {
          if (!a.due_at) return false;
          const t = Date.parse(a.due_at);
          return t >= now.getTime() && t <= end.getTime();
        })
        .map((a) => {
          const sub = a.submission ?? {};
          return {
            title: a.name,
            type: "assignment",
            due: a.due_at,
            course: names.get(c.id),
            course_id: c.id,
            url: a.html_url,
            points: a.points_possible ?? null,
            submitted: sub.workflow_state === "submitted" || sub.workflow_state === "graded",
            graded: sub.workflow_state === "graded",
            missing: Boolean(sub.missing),
            pid: a.id,
            key: `assignment:${c.id}:${a.id}`,
            has_detail: true,
          };
        });
    }));
    items.push(...perCourse.flat());
  }

  // Readings that classmates have given a due date. They have a date but no
  // time, so they're placed at the start of that day (the page shows them as "All day").
  const first = today();
  for (const r of await deadlinesBetween(courses.map((c) => c.id), first, addDays(first, DAYS_AHEAD))) {
    items.push({
      title: r.title,
      type: "reading",
      due: r.date + "T00:00:00",
      date_only: true,
      course: names.get(r.course_id) ?? "",
      course_id: r.course_id,
      url: r.url,
      points: null,
      submitted: false,
      graded: false,
      missing: false,
      pid: null,
      key: `reading:${r.course_id}:${r.url}`,
      has_detail: false,
      added_by: r.by,
      added_at: r.at,
    });
  }

  // The page sorts again in the viewer's own time zone; this is just a sensible starting order.
  items.sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  return items;
}

// ─── Details of one assignment / quiz / discussion / page ────────────────────

const FILE_LINK_RE = /<a\b([^>]*?)href="([^"]*?\/files\/(\d+)[^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi;
const SUBMISSION_LABELS: Record<string, string> = {
  online_upload: "File upload",
  online_text_entry: "Text entry",
  online_url: "Website URL",
  media_recording: "Media recording",
  online_quiz: "Quiz",
  discussion_topic: "Discussion post",
  external_tool: "External tool",
  on_paper: "On paper",
  none: "No submission",
};

/**
 * Turn any link to a CourseWorks file into a direct download link (keeping the
 * access code that some links carry).
 */
function downloadUrl(href: string): string {
  href = unescapeHtml(href);
  const [rawPath, query = ""] = href.split(/\?(.*)/s);
  const path = rawPath.replace(/\/(download|preview)$/, "");
  const verifier = query.match(/(?:^|&)verifier=([^&]+)/);
  return absUrl(path) + "/download?download_frd=1" + (verifier ? `&verifier=${verifier[1]}` : "");
}

function filesInHtml(html: string) {
  const out = [];
  for (const m of html.matchAll(FILE_LINK_RE)) {
    const attrs = m[1] + m[4];
    const title = attrs.match(/title="([^"]+)"/);
    const name = unescapeHtml(stripTags(m[5])).trim() || (title && unescapeHtml(title[1])) || "File";
    out.push({ id: Number(m[3]), name, url: absUrl(unescapeHtml(m[2])), download: downloadUrl(m[2]) } as any);
  }
  return out;
}

export async function fetchDetail(cv: CanvasClient, item: any) {
  const path = DETAIL_PATHS[item.type].replace("{cid}", item.course_id).replace("{pid}", item.pid);
  const d = await cv.getAll(path);
  const raw: string = d.description || d.message || d.body || "";
  const files = filesInHtml(raw);
  for (const a of d.attachments ?? []) { // files attached to a discussion post
    files.push({ id: a.id, name: a.display_name || a.filename || "Attachment", url: a.url, download: a.url });
  }
  const seen = new Set();
  const unique = files.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));

  // Link text is often just "notes" or "here", so look up each file's real name
  // and type. The page uses these to decide whether it can show a preview.
  await Promise.all(unique.map(async (f) => {
    const meta = f.id ? await cv.safe(`/files/${f.id}`) : null;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      f.filename = meta.display_name ?? null;
      f.mime = meta["content-type"] ?? null;
    }
    f.preview = previewKind(f.filename || f.name, f.mime);
  }));

  const submission: string[] = d.submission_types ?? [];
  return {
    html: sanitize(raw),
    files: unique,
    points: d.points_possible ?? null,
    submission: submission.filter((x) => x !== "none").map((x) => SUBMISSION_LABELS[x] ?? x.replaceAll("_", " ")),
    attempts: d.allowed_attempts ?? null,
    time_limit: d.time_limit ?? null,
    questions: d.question_count ?? null,
    unlock_at: d.unlock_at ?? null,
    lock_at: d.lock_at ?? null,
    url: d.html_url || item.url,
  };
}
