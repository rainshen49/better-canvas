// Courses and their materials (modules, syllabus links, loose files, quick links).

import { absUrl, CanvasClient } from "./canvas.ts";
import { addPreview, classify, HW_RE, isClass, READING_RE, shortNames, SLIDE_RE } from "./classify.ts";
import { BASE, IGNORE_COURSES } from "./config.ts";
import { stripTags, unescapeHtml } from "./sanitize.ts";
import { deadlinesForCourse, discussedForCourse } from "./store.ts";

const DAY_MS = 864e5;

/**
 * The person's active courses, leaving out those in IGNORE_COURSES, those not open yet
 * (restricted by date), and those whose term ended over a week ago.
 */
export async function fetchCourses(cv: CanvasClient): Promise<any[]> {
  const courses: any[] = await cv.getAll("/courses", {
    enrollment_state: "active",
    "include[]": ["term"],
    "state[]": ["available"],
  });
  const ignore = IGNORE_COURSES.map((x) => x.toLowerCase());
  const now = Date.now();
  return courses.filter((c) => {
    if (!c.name || c.access_restricted_by_date) return false;
    const code = (c.course_code ?? "").toLowerCase();
    const name = c.name.toLowerCase();
    if (ignore.some((i) => code.includes(i) || name.includes(i))) return false;
    const end = c.term?.end_at || c.end_at;
    if (end) {
      const t = Date.parse(end);
      if (!Number.isNaN(t)) return t > now - 7 * DAY_MS;
    }
    return true;
  });
}

export function courseSummary(c: any) {
  const [code, name] = shortNames(c);
  return { id: c.id, name, code, is_class: isClass(c), url: `${BASE}/courses/${c.id}` };
}

const SKIP_MODULE_RE = /proctorio|honorlock|respondus/i;
const SKIP_LINK_RE = /^mailto:|zoom\.us|forms\.gle|docs\.google\.com\/forms|\.css($|\?)/i;
const GENERIC_LINK = new Set([
  "pdf",
  "python",
  "data",
  "assignment",
  "slides",
  "slide",
  "here",
  "link",
  "notebook",
  "code",
  "excel",
  "file",
]);
// Course menu tabs shown as shortcuts at the top of a course: Echo360, Video Library, Ed and Zoom
const QUICK_TAB_RE = /echo360|video library|\bed\b|zoom/i;

/** Split the syllabus page into sections by its headings, and collect the links under each one. */
export function parseSyllabus(body: string | null | undefined) {
  const sections: { name: string; items: any[] }[] = [];
  let current = { name: "Syllabus", items: [] as any[] };
  const pattern = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>|<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of (body ?? "").matchAll(pattern)) {
    if (m[1] !== undefined) {
      const heading = unescapeHtml(stripTags(m[1])).trim();
      if (heading) {
        if (current.items.length) sections.push(current);
        current = { name: heading, items: [] };
      }
      continue;
    }
    const href = unescapeHtml(m[2]);
    const text = unescapeHtml(stripTags(m[3])).trim();
    if (!text || SKIP_LINK_RE.test(href)) continue;
    if (/^(https?:\/\/|www\.)/.test(text) && !href.includes("/files/")) continue; // links whose text is just a web address (usually policy or resource pages)
    const generic = GENERIC_LINK.has(text.toLowerCase());
    const title = generic && current.name !== "Syllabus" ? `${current.name} — ${text}` : text;
    let cat: string;
    if (href.includes("/external_tools/")) cat = /record|video|echo/i.test(text) ? "video" : "other";
    else if (generic && HW_RE.test(current.name)) cat = "other";
    else cat = classify(text) ?? "other";
    const fileId = href.match(/\/files\/(\d+)/);
    current.items.push({
      kind: "item",
      title,
      type: fileId ? "File" : "Link",
      url: fileId ? absUrl(href.replace("/download?", "?").split("?")[0]) : absUrl(href),
      cat,
      file_id: fileId ? Number(fileId[1]) : null,
    });
  }
  if (current.items.length) sections.push(current);
  return sections;
}

/** Everything the "Slides & readings" tab shows for one course, plus its reading due dates. */
export async function fetchMaterials(cv: CanvasClient, course: any) {
  const cid = course.id;
  const modulesOut: { name: string; items: any[] }[] = [];
  const seenFileIds = new Set<number>();

  const modules: any[] = (await cv.safe(`/courses/${cid}/modules`, { "include[]": ["items"] })) ?? [];
  for (const m of modules) {
    if (SKIP_MODULE_RE.test(m.name ?? "")) continue;
    const entries: any[] = [];
    // CourseWorks leaves out the item list for big modules, so fetch it separately
    const items: any[] = m.items ?? (await cv.safe(`/courses/${cid}/modules/${m.id}/items`)) ?? [];
    for (const it of items) {
      const type = it.type;
      if (type === "SubHeader") {
        entries.push({ kind: "header", title: it.title });
        continue;
      }
      if (!["File", "ExternalUrl", "Page", "ExternalTool"].includes(type)) continue;
      const title = it.title ?? "";
      const url = absUrl(type === "ExternalUrl" ? it.external_url : it.html_url);
      let cat;
      if (type === "Page") cat = SLIDE_RE.test(title) || READING_RE.test(title) ? classify(title) : "other";
      else if (type === "ExternalUrl") cat = classify(title, it.external_url ?? "");
      else cat = classify(title, title);
      if (cat === null) continue;
      entries.push({
        kind: "item",
        title,
        type,
        url,
        cat,
        file_id: type === "File" ? it.content_id ?? null : null,
        page_url: type === "Page" ? it.page_url ?? null : null,
      });
      if (type === "File" && it.content_id) seenFileIds.add(it.content_id);
    }
    if (entries.some((e) => e.kind === "item")) modulesOut.push({ name: m.name, items: entries });
  }

  // Links posted on the Syllabus page (some professors put everything there)
  const syllabus: { name: string; items: any[] }[] = [];
  const info = (await cv.safe(`/courses/${cid}`, { "include[]": ["syllabus_body"] })) ?? {};
  for (const section of parseSyllabus(info.syllabus_body)) {
    for (const it of section.items) if (it.file_id) seenFileIds.add(it.file_id);
    syllabus.push({ name: "📋 " + section.name, items: section.items });
  }

  // Shortcut tabs from the course menu (Echo360, Video Library, Ed, Zoom)
  const tabs: any[] = (await cv.safe(`/courses/${cid}/tabs`)) ?? [];
  const quick = tabs
    .filter((t) => t.type === "external" && !t.hidden && QUICK_TAB_RE.test(t.label ?? ""))
    .map((t) => ({ label: t.label, url: absUrl(t.html_url) }));

  // Files not already linked from a module or the syllabus (e.g. a "Slides" folder).
  // Hidden and locked files are skipped.
  const loose: any[] = [];
  const files: any[] | null = await cv.safe(`/courses/${cid}/files`, { sort: "updated_at", order: "desc" });
  if (files) {
    const folderList: any[] = (await cv.safe(`/courses/${cid}/folders`)) ?? [];
    const folders = new Map<number, string>(folderList.map((f) => [
      f.id,
      (f.full_name ?? "").replace("course files/", "").replace("course files", ""),
    ]));
    for (const f of files) {
      if (seenFileIds.has(f.id) || f.hidden || f.locked_for_user) continue;
      const name = f.display_name || f.filename || "";
      const folder = folders.get(f.folder_id) ?? "";
      // Use the display name; the raw filename has characters like spaces encoded (%20)
      const cat = classify(name, name, f["content-type"] ?? "", folder);
      if (cat === null) continue;
      loose.push({
        kind: "item",
        title: name,
        type: "File",
        file_id: f.id,
        url: `${BASE}/courses/${cid}/files/${f.id}`,
        download: f.url ?? null,
        cat,
        folder,
        updated: f.updated_at ?? null,
        mime: f["content-type"] ?? null,
      });
    }
  }

  // Mark everything that can be previewed. The course's file list (when
  // students can see it) gives the real name and type of files in modules.
  const fileMeta = new Map<number, any>((files ?? []).map((f) => [f.id, f]));
  for (const entry of [...modulesOut, ...syllabus].flatMap((m) => m.items).filter((e) => e.kind === "item")) {
    addPreview(entry, fileMeta);
  }
  for (const entry of loose) addPreview(entry, fileMeta);

  const [deadlines, discussed] = await Promise.all([deadlinesForCourse(cid), discussedForCourse(cid)]);
  const [code, name] = shortNames(course);
  return {
    id: cid,
    name,
    code,
    is_class: isClass(course),
    url: `${BASE}/courses/${cid}`,
    modules: [...modulesOut, ...syllabus],
    quick,
    files: loose,
    files_accessible: files !== null,
    deadlines,
    discussed,
  };
}

/** Every file and link in a course's materials (modules, syllabus sections and loose files). */
export function allEntries(materials: { modules: { items: any[] }[]; files: any[] }): any[] {
  return [...materials.modules.flatMap((m) => m.items.filter((e) => e.kind === "item")), ...materials.files];
}
