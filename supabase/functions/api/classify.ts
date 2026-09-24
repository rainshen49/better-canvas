// Sorting materials into slides, readings, recordings and other, naming
// courses, and working out what can be previewed inside the page.

export type Category = "slides" | "reading" | "video" | "other";

// Match whole words, where only letters count as part of a word. This way
// "ENG4502_Lecture_6.pdf" still matches "lecture".
const W = "(?<![a-z])";
const E = "(?![a-z])";
const re = (source: string, flags = "i") => new RegExp(source, flags);

export const SLIDE_RE = re(
  W + String.raw`(slides?|deck|lecture|lectures|lec\s?\d+|presentation)` + E + String.raw`|\.(pptx?|key)$`,
);
// Numbered course decks: "HCDIx 2.2 Process.pdf", "FDT02-Mechanical.pdf", "TT 1(b).4 Intro.pdf"
const DECK_RE = /^[A-Za-z]{2,6}\s?\d{1,2}(\.\d|\(\w\)|[-_ ])/;
export const HW_RE = re(
  W + String.raw`(hw\s?\d*|homework|problem\s?sets?|ps\s?\d+|assignments?|solutions|answer\s?key|exam|quiz|rubric)` + E,
);
export const READING_RE = re(
  W +
    String
      .raw`(reading|readings|case|article|chapters?|ch\.?\s?\d+|paper|hbr|notes?|textbook|pre-?read|required|optional|packet|coursepack|syllabus)` +
    E,
);
const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv)$/i;
const DOC_EXT_RE = /\.(pdf|docx?|epub|xlsx?|csv|ipynb)$/i;
const JUNK_RE = /\.(conf|json|xml|ds_store|ini|log|tmp)$/i;
const F_SLIDES = re(W + "(slides?|lectures?|decks?)" + E);
const F_READ = re(W + "(readings?|articles?|cases?)" + E);
const F_VIDEO = re(W + "(recordings?|videos?|zoom)" + E);
const F_HW = re(W + String.raw`(assignments?|homeworks?|problem\s?sets?)` + E);

/**
 * Decide what kind of material this is: "slides", "reading", "video" or "other".
 * Returns null for things that shouldn't be shown (settings files, the course image…).
 */
export function classify(title: string, filename = "", contentType = "", folder = ""): Category | null {
  const name = filename || title;
  const text = `${title} ${filename}`;
  contentType ||= "";
  folder ||= "";
  if (JUNK_RE.test(name) || folder.toLowerCase().startsWith("course_image")) return null;
  if (VIDEO_RE.test(name) || contentType.startsWith("video/")) return "video";
  if (HW_RE.test(text) || F_HW.test(folder)) return "other";
  if (SLIDE_RE.test(text) || DECK_RE.test(name) || contentType.includes("presentation")) return "slides";
  if (F_SLIDES.test(folder) && DOC_EXT_RE.test(name)) return "slides";
  if (F_READ.test(folder) || READING_RE.test(text)) return "reading";
  if (F_VIDEO.test(folder) && !DOC_EXT_RE.test(name)) return "video";
  if (DOC_EXT_RE.test(name) || contentType.includes("pdf")) return "reading"; // a document with no other clues is most often a reading
  return "other";
}

const NON_CLASS_RE = /exemption|orientation|tutorials?$|career management|class of 20\d\d|python level/i;

/** Courses in a real term (e.g. "Fall 2026") are classes; "Default Term" sites aren't. */
export function isClass(course: any): boolean {
  const term = (course.term?.name ?? "").toLowerCase();
  return term !== "" && term !== "default term" && !NON_CLASS_RE.test(course.name ?? "");
}

/**
 * Split a course's full name into [course code, short name], e.g.
 * "IEMEE4201_001_2026_3 - Human-Centered Design…" → ["IEMEE4201", "Human-Centered Design…"]
 * "Foundations of Entrepreneurship FA2026"       → [null, "Foundations of Entrepreneurship"]
 */
export function shortNames(course: any): [string | null, string] {
  let name = (course.name ?? "").trim();
  const m = name.match(/^([A-Z]{4,5}\d{4})_\d+_\d{4}_\d\s*-\s*(.+)$/);
  if (m) return [m[1], m[2].trim()];
  name = name.replace(/\s+(FA|SP|SU|FALL|SPRING|SUMMER)\s?\d{4}$/i, "");
  name = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return [null, name];
}

// ─── What can be previewed inside the page ───────────────────────────────────

export type PreviewKind = "pdf" | "office" | "image" | "video" | "audio" | "text";

// [kind, file name ending, file type]. The first match wins.
const PREVIEW_KINDS: [PreviewKind, RegExp, RegExp][] = [
  ["pdf", /\.pdf$/i, /^application\/pdf$/i],
  [
    "office",
    /\.(docx?|pptx?|xlsx?|odt|odp|ods|rtf)$/i,
    /msword|officedocument|powerpoint|ms-excel|opendocument|\/rtf/i,
  ],
  ["image", /\.(png|jpe?g|gif|webp|bmp|svg)$/i, /^image\//i],
  ["video", /\.(mp4|m4v|webm|mov)$/i, /^video\//i],
  ["audio", /\.(mp3|m4a|wav|ogg|aac)$/i, /^audio\//i],
  ["text", /\.(txt|csv|md|py|r|sql|json|tex)$/i, /^text\/(plain|csv|markdown|x-)|^application\/json$/i],
];
const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/;
const VIMEO_RE = /vimeo\.com\/(?:video\/)?(\d+)/;

/** How a file can be previewed ("pdf", "office", "image", "video", "audio", "text"), or null. */
export function previewKind(name?: string | null, mime?: string | null): PreviewKind | null {
  for (const [kind, ending, fileType] of PREVIEW_KINDS) {
    if (ending.test(name ?? "") || fileType.test(mime ?? "")) return kind;
  }
  return null;
}

/** A playable version of a YouTube or Vimeo link, or null. */
export function embedUrl(url?: string | null): string | null {
  let m = (url ?? "").match(YOUTUBE_RE);
  if (m) return `https://www.youtube-nocookie.com/embed/${m[1]}`;
  m = (url ?? "").match(VIMEO_RE);
  if (m) return `https://player.vimeo.com/video/${m[1]}`;
  return null;
}

/** Mark a file, page or link with how it can be previewed (entry.preview). */
export function addPreview(entry: any, fileMeta: Map<number, any>) {
  if (entry.file_id) {
    const meta = fileMeta.get(entry.file_id) ?? {};
    entry.mime = entry.mime || meta["content-type"] || null;
    let kind: string | null = previewKind(meta.display_name || entry.title, entry.mime);
    // Slides and readings without a recognizable name are almost always
    // previewable; the server works out how when it's opened.
    if (!kind && (entry.cat === "slides" || entry.cat === "reading")) kind = "auto";
    entry.preview = kind;
  } else if (entry.type === "Page" && entry.page_url) {
    entry.preview = "page";
  } else {
    const embed = embedUrl(entry.url);
    if (embed) {
      entry.preview = "embed";
      entry.embed_url = embed;
    }
  }
}
