// Better Canvas — the part that runs in the browser.
//
// When the page opens, it asks this app's server for /api/data. The server
// sends back a series of updates, one per line, as each piece is ready: first
// the course list ("start"), then the due list, each course's materials and
// each due item's details in whatever order they finish, and finally "done".
// The page changes as each update arrives, so results show up before
// everything has loaded.
//
// The last complete set of updates is also saved in the browser. When the page
// opens again within a day, that saved copy is shown straight away (marked as
// saved data) while the fresh one loads, and is swapped out once it's ready.

// ─────────────────────────────────────────────────────────────────────────────
// Helpers and constants
// ─────────────────────────────────────────────────────────────────────────────

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

/** Make text safe to put on the page (so characters like < and & show up as text). */
function esc(value) {
  const replacements = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return String(value ?? "").replace(/[&<>"]/g, (char) => replacements[char]);
}

/** A link that opens in a new tab. */
function externalLink(url, text, className = "") {
  const cls = className ? ` class="${className}"` : "";
  return `<a${cls} href="${esc(url)}" target="_blank" rel="noopener">${text}</a>`;
}

const CATEGORY_ICONS = { slides: "📊", reading: "📄", video: "🎬", other: "🔗" };

const ITEM_TYPE_LABELS = {
  assignment: "Assignment",
  quiz: "Quiz",
  discussion_topic: "Discussion",
  wiki_page: "Page",
  planner_note: "To-do",
  assessment_request: "Peer review",
  reading: "Reading",
};

const MS_PER_HOUR = 36e5;
const MS_PER_DAY = 864e5;

// A reading's due date can be one of the next this-many weekdays, counting today
// if it's a weekday (the server checks this too).
const PICK_WEEKDAYS = 10;

// Where the API is: "" for the same server (running locally), or the Supabase
// Edge Function's address when the page is on GitHub Pages. Set in config.js.
const API = String(window.BETTER_CANVAS_API || "").replace(/\/+$/, "");

// Everything the server has sent so far for this page load (null until the course list arrives).
let DATA = null;
// Which material category is shown on the "Slides & readings" tab.
let activeFilter = "all";
// Lets a new load, or logging out, stop a load that is still in progress.
let currentRequest = null;

// Each course gets its own color (a hue), in the order the courses are listed.
const COURSE_HUES = [212, 150, 28, 282, 350, 184, 48, 250, 100, 322];

/** Attributes that color an element by its course: use the --cc and --ccbg colors from style.css. */
function courseColor(courseId) {
  const index = DATA?.courses?.findIndex((course) => course.id === courseId) ?? -1;
  if (index < 0) return "";
  return `style="--h:${COURSE_HUES[index % COURSE_HUES.length]}"`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tabs
// ─────────────────────────────────────────────────────────────────────────────

const TAB_STORAGE_KEY = "cw-tab";

let currentTab = "due";

function showTab(which) {
  currentTab = which;
  updateTopSlot();
  for (const tab of ["due", "mat"]) {
    $("#" + tab).classList.toggle("hidden", tab !== which);
    $("#tab-" + tab).classList.toggle("on", tab === which);
  }
  try {
    localStorage.setItem(TAB_STORAGE_KEY, which);
  } catch (e) {}
}

$("#tab-due").onclick = () => showTab("due");
$("#tab-mat").onclick = () => showTab("mat");

// ─────────────────────────────────────────────────────────────────────────────
// Dates
// ─────────────────────────────────────────────────────────────────────────────

/** "Today", "Tomorrow" or "in N days". */
function relativeDay(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((day - today) / MS_PER_DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `in ${days} days`;
}

const formatDayHeading = (date) =>
  date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

const formatTime = (date) =>
  date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "YYYY-MM-DD" → a Date at the start of that day, in this computer's time. */
function parseDay(day) {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  return new Date(year, month - 1, dayOfMonth);
}

/** A Date → "YYYY-MM-DD" (this computer's time). */
function dayString(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Today plus `days`, as "YYYY-MM-DD". */
function dayFromToday(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return dayString(date);
}

/** The days a reading's due date can be: the next PICK_WEEKDAYS weekdays (Mon–Fri), from today. */
function pickableDays() {
  const days = [];
  for (let offset = 0; days.length < PICK_WEEKDAYS; offset++) {
    const day = dayFromToday(offset);
    const weekday = parseDay(day).getDay();
    if (weekday !== 0 && weekday !== 6) days.push(day);
  }
  return days;
}

const formatShortDay = (day) =>
  parseDay(day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

const formatDateTime = (iso) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

// ─────────────────────────────────────────────────────────────────────────────
// "Due soon" tab
// ─────────────────────────────────────────────────────────────────────────────

function statusTag(item) {
  const hoursLeft = (new Date(item.due) - new Date()) / MS_PER_HOUR;
  if (item.submitted) {
    return `<span class="tag t-ok">✓ ${item.graded ? "Graded" : "Submitted"}</span>`;
  }
  if (item.missing) return `<span class="tag t-miss">Missing</span>`;
  if (hoursLeft < 48) return `<span class="tag t-soon">Due soon</span>`;
  return "";
}

/** One row in the due list. Clicking it opens a panel that fillDetail() fills in. */
function dueItemHtml(item) {
  const typeLabel = ITEM_TYPE_LABELS[item.type] || esc(item.type);
  const points = item.points != null ? ` · ${item.points} pts` : "";
  // Who added a reading's date is shown only when the row is expanded (see fillDetail).
  // Readings only have a day, not a time.
  const time = item.date_only ? "All day" : formatTime(new Date(item.due));
  return `
    <details class="ditem" data-key="${esc(item.key)}">
      <summary class="row ${item.submitted ? "done" : ""}">
        <div class="time">${time}</div>
        <div>
          <span class="dtitle">${esc(item.title)}</span>
          <div class="meta"><span class="tag t-course cc" ${courseColor(item.course_id)}>${esc(item.course)}</span> ${typeLabel}${points}</div>
        </div>
        <div class="rstat">${statusTag(item)}<span class="chev" aria-hidden="true">▸</span></div>
      </summary>
      <div class="dbody"></div>
    </details>`;
}

function dayGroupHtml(items) {
  const date = new Date(items[0].due);
  return `
    <div class="day">
      <h2>${formatDayHeading(date)} <span class="rel">· ${relativeDay(date)}</span></h2>
      ${items.map(dueItemHtml).join("")}
    </div>`;
}

/** Scroll smoothly to "Readings without a due date", stopping just below the sticky header. */
function scrollToUndated() {
  const heading = $(".undated-h:not(.hidden)") || $("#undated");
  const headerHeight = $("header").offsetHeight;
  const top = heading.getBoundingClientRect().top + window.scrollY - headerHeight - 12;
  window.scrollTo({ top, behavior: "smooth" });
}

// The "Add due dates" button in the callout at the top. The callout is in index.html.
$("#readnote").addEventListener("click", (event) => {
  if (!event.target.closest(".jump-undated")) return;
  event.preventDefault();
  scrollToUndated();
});

function renderDue() {
  const container = $("#due-list");
  const items = DATA.due;
  if (!items.length) {
    container.innerHTML = `<div class="empty">Nothing due in the next ${DATA.days} days 🎉</div>`;
    return;
  }

  // Sort by due date (readings added on this page may be out of order), then group by day.
  items.sort((a, b) => new Date(a.due) - new Date(b.due));
  const byDay = {};
  for (const item of items) {
    const day = new Date(item.due).toDateString();
    (byDay[day] ??= []).push(item);
  }
  // Readings can't be submitted, so they don't count here.
  const notSubmitted = items.filter((item) => !item.submitted && item.type !== "reading").length;

  container.innerHTML = `
    <p class="sub due-summary">
      ${items.length} items due in the next ${DATA.days} days ·
      <b>${notSubmitted}</b> not yet submitted
    </p>
    ${Object.values(byDay).map(dayGroupHtml).join("")}`;

  for (const details of $$("details.ditem")) {
    details.addEventListener("toggle", () => {
      if (details.open) fillDetail(details.dataset.key);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Due item details (shown when a row is expanded)
// ─────────────────────────────────────────────────────────────────────────────

/** For a link to a CourseWorks file, the link that downloads it directly. Anything else gets null. */
function downloadUrl(url) {
  return /\/files\/\d+$/.test(url || "") ? url + "/download?download_frd=1" : null;
}

// Finds course files that go with a numbered assignment, e.g. "HW02" ↔ HW02.pdf,
// or "Homework 1" ↔ the files under a "Homework 1" heading on the syllabus.
const ASSIGNMENT_NUMBER_RE =
  /(?<![a-z])(hw|homework|assignment|problem set|ps|lab|project)\s*#?\s*0*(\d+)(?!\d)/gi;

const ASSIGNMENT_KIND = {
  homework: "hw",
  hw: "hw",
  "problem set": "ps",
  ps: "ps",
  assignment: "assignment",
  lab: "lab",
  project: "project",
};

/** Assignment numbers mentioned in some text, written the same way: "Homework 2" and "HW02" both become "hw2". */
function assignmentIds(text) {
  return [...String(text || "").matchAll(ASSIGNMENT_NUMBER_RE)].map(
    (match) => ASSIGNMENT_KIND[match[1].toLowerCase()] + match[2],
  );
}

/**
 * Course files (and syllabus links) whose name, or the module or folder they
 * sit in, mentions the same assignment number as `item`. Files already
 * attached to the assignment are left out. Returns null if the course hasn't
 * loaded yet.
 */
function relatedFiles(item, excludeUrls) {
  const wanted = assignmentIds(item.title);
  if (!wanted.length) return [];

  const course = DATA.mats[item.course_id];
  if (!course) return null;

  return courseEntries(course).filter(
    (entry) =>
      (entry.type === "File" || entry.type === "Link") &&
      !excludeUrls.has(entry.url) &&
      assignmentIds(entry.title + " " + entry.ctx).some((id) => wanted.includes(id)),
  );
}

/** Short facts (points, attempts, dates…) shown as small labels at the top of the panel. */
function detailChips(detail) {
  let attempts = null;
  if (detail.attempts === -1) attempts = "Unlimited attempts";
  else if (detail.attempts != null) {
    attempts = `${detail.attempts} attempt${detail.attempts === 1 ? "" : "s"}`;
  }

  return [
    detail.points != null && `${detail.points} pts`,
    detail.submission?.length && `Submit: ${detail.submission.join(", ")}`,
    attempts,
    detail.questions && `${detail.questions} questions`,
    detail.time_limit && `${detail.time_limit} min limit`,
    detail.unlock_at && `Opens ${formatDateTime(detail.unlock_at)}`,
    detail.lock_at && `Closes ${formatDateTime(detail.lock_at)}`,
  ].filter(Boolean);
}

// A download arrow, drawn in the text color.
const DOWNLOAD_ICON = `
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor"
    stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
  </svg>`;

/** A download icon that says "Download" on hover (and to screen readers). Nothing if there's no link. */
const downloadButton = (url) =>
  url ? `<a class="dl" href="${esc(url)}" aria-label="Download" data-tip="Download">${DOWNLOAD_ICON}</a>` : "";

function attachedFileHtml(file) {
  const entry = { file_id: file.id, title: file.name, url: file.url, preview: file.preview };
  return `
    <li>
      <span class="ic">📎</span>${fileTitleHtml(entry)}${downloadButton(file.download)}${previewPanelHtml(entry)}
    </li>`;
}

function relatedFileHtml(entry, courseId) {
  const icon = entry.cat === "slides" ? "📊" : "📎";
  return `
    <li>
      <span class="ic">${icon}</span>${fileTitleHtml(entry)}<span class="ctx">${esc(entry.ctx || "")}</span>${downloadButton(downloadUrl(entry.url))}${previewPanelHtml(entry, courseId)}
    </li>`;
}

function fileListHtml(heading, rows) {
  return `<h4>${heading}</h4><ul class="files">${rows.join("")}</ul>`;
}

/** "⬇ Download" for a dated reading that's a file, or "Open reading ↗" for a web link or page. */
function readingLinkHtml(item) {
  const course = DATA.mats[item.course_id];
  const entry = course && courseEntries(course).find((e) => e.url === item.url);
  const download = entry ? readingDownloadUrl(entry, item.course_id) : downloadUrl(item.url);
  return download
    ? externalLink(download, "⬇ Download", "openlink")
    : externalLink(item.url, "Open reading ↗", "openlink");
}

function fillDetail(key) {
  const body = document.querySelector(`details.ditem[data-key="${CSS.escape(key)}"] .dbody`);
  if (!body) return;

  const item = DATA.due.find((i) => i.key === key);
  const detail = DATA.details[key];
  const openLink = externalLink(item.url, "Open in CourseWorks ↗");

  if (item.type === "reading") {
    body.innerHTML = `
      <div class="rdue-line">${readingDueBoxHtml(item.course_id, item.url, true)}</div>
      ${readingLinkHtml(item)}`;
    return;
  }
  if (!detail) {
    body.innerHTML = item.has_detail
      ? `<div class="dload"><span class="spin"></span>Loading details…</div>`
      : `<p class="sub">No further details. ${openLink}</p>`;
    return;
  }
  if (detail.error) {
    body.innerHTML = `<p class="sub">Couldn't load details (${esc(detail.error)}). ${openLink}</p>`;
    return;
  }

  const chips = detailChips(detail);
  const attachedUrls = new Set(detail.files.map((file) => file.url));
  const related = relatedFiles(item, attachedUrls);

  const parts = [];
  if (chips.length) {
    parts.push(`<div class="chips">${chips.map((c) => `<span>${esc(c)}</span>`).join("")}</div>`);
  }
  // The server has already removed anything unsafe from this description.
  parts.push(
    detail.html ? `<div class="desc">${detail.html}</div>` : `<p class="sub">No description provided.</p>`,
  );
  if (detail.files.length) {
    parts.push(fileListHtml("Attached files", detail.files.map(attachedFileHtml)));
  }
  if (related === null) {
    parts.push(`<p class="sub"><span class="spin"></span> Looking for related course files…</p>`);
  } else if (related.length) {
    parts.push(fileListHtml("Related course files", related.map((entry) => relatedFileHtml(entry, item.course_id))));
  }
  parts.push(externalLink(detail.url, "Open in CourseWorks ↗", "openlink"));

  body.innerHTML = parts.join("");
}

/**
 * Redraw any open detail panels, e.g. so they can list related files once a
 * course has loaded. This also closes any preview open inside them.
 */
function refreshOpenDetails() {
  for (const details of $$("details.ditem[open]")) fillDetail(details.dataset.key);
}

// ─────────────────────────────────────────────────────────────────────────────
// "Slides & readings" tab
// ─────────────────────────────────────────────────────────────────────────────

/** One file or link in a course. data-t holds the text the search box looks through (title and folder). */
function materialHtml(entry, courseId) {
  const searchText = (entry.title + " " + (entry.folder || "")).toLowerCase();
  const dueDate = entry.cat === "reading" ? readingDueBoxHtml(courseId, entry.url) : "";
  return `
    <li data-cat="${entry.cat}" data-t="${esc(searchText)}">
      <span class="ic">${CATEGORY_ICONS[entry.cat]}</span>
      ${fileTitleHtml(entry)}${dueDate}${downloadButton(entry.download)}${previewPanelHtml(entry, courseId)}
    </li>`;
}

function moduleHtml(module, courseId) {
  const rows = module.items.map((entry) =>
    entry.kind === "header"
      ? `<li class="sh">${esc(entry.title)}</li>`
      : materialHtml(entry, courseId),
  );
  return `<div class="mod"><h3>${esc(module.name)}</h3><ul class="mat">${rows.join("")}</ul></div>`;
}

/**
 * Files not linked from a module or the syllabus. In a course with modules
 * they're listed after the modules as they are; otherwise they're grouped by folder.
 */
function looseFilesHtml(course) {
  if (course.modules.length) {
    const rows = course.files.map((file) => materialHtml(file, course.id)).join("");
    return `<div class="mod"><ul class="mat">${rows}</ul></div>`;
  }
  const byFolder = {};
  for (const file of course.files) {
    (byFolder[file.folder || "Files"] ??= []).push(file);
  }
  return Object.entries(byFolder)
    .map(
      ([folder, files]) => `
        <div class="mod">
          <h3>📁 ${esc(folder)}</h3>
          <ul class="mat">${files.map((file) => materialHtml(file, course.id)).join("")}</ul>
        </div>`,
    )
    .join("");
}

/** Shortcut links shown at the top of a course (Echo360, Video Library, Ed, Zoom). */
function quickLinksHtml(links) {
  const buttons = links.map((link) => {
    const icon = /echo|video|zoom/i.test(link.label) ? "🎬" : "🔗";
    return externalLink(link.url, `${icon} ${esc(link.label)}`);
  });
  return `<div class="quick">${buttons.join("")}</div>`;
}

function courseTitleHtml(course) {
  const code = course.code ? ` <span class="code">${esc(course.code)}</span>` : "";
  return esc(course.name) + code;
}

/** Every file and link in a course, each with `ctx`: the module or folder it's in. */
function courseEntries(course) {
  return [
    ...course.modules.flatMap((module) =>
      module.items
        .filter((entry) => entry.kind === "item")
        .map((entry) => ({ ...entry, ctx: module.name })),
    ),
    ...course.files.map((file) => ({ ...file, ctx: file.folder })),
  ];
}

function courseCardHtml(course, open) {
  const allItems = courseEntries(course);
  const count = (category) => allItems.filter((entry) => entry.cat === category).length;

  let body = course.modules.map((module) => moduleHtml(module, course.id)).join("");
  if (course.files.length) body += looseFilesHtml(course);
  if (course.quick?.length) body = quickLinksHtml(course.quick) + body;
  if (!body) {
    body = `
      <div class="sub no-materials">
        No modules or files are visible for this course.
        <a href="${esc(course.url)}" target="_blank">Open in CourseWorks →</a>
      </div>`;
  }

  return `
    <details class="course cc" data-cid="${course.id}" ${courseColor(course.id)} ${open ? "open" : ""}>
      <summary>
        ${courseTitleHtml(course)}
        <span class="counts">
          <span class="tag t-course">📊 ${count("slides")}</span>
          <span class="tag t-course">📄 ${count("reading")}</span>
          <a class="tag course-open" href="${esc(course.url)}" target="_blank" onclick="event.stopPropagation()">open ↗</a>
        </span>
      </summary>
      <div class="cbody">${body}</div>
    </details>`;
}

/** Placeholder shown for a course until its materials arrive. */
function coursePlaceholderHtml(course) {
  return `
    <div class="skel" data-cid="${course.id}">
      <span class="spin"></span>${courseTitleHtml(course)} <span class="sub">loading…</span>
    </div>`;
}

/** Lay out one placeholder per course as soon as the course list arrives. */
function renderCoursePlaceholders() {
  const classes = DATA.courses.filter((course) => course.is_class);
  const otherSites = DATA.courses.filter((course) => !course.is_class);

  let html = classes.length
    ? `<div class="group">Classes · ${classes.length}</div>` +
      classes.map(coursePlaceholderHtml).join("")
    : `<div class="empty">No active classes found.</div>`;

  if (otherSites.length) {
    html += `
      <details class="others">
        <summary>Other sites (orientation, career…) · ${otherSites.length}</summary>
        ${otherSites.map(coursePlaceholderHtml).join("")}
      </details>`;
  }
  $("#courses").innerHTML = html;
}

/** Swap a placeholder for the real card when that course's materials arrive. */
function placeCourse(course) {
  const placeholder = document.querySelector(`.skel[data-cid="${course.id}"]`);
  if (!placeholder) return;
  const listing = DATA.courses.find((c) => c.id === course.id) || {};
  DATA.mats[course.id] = course;
  placeholder.outerHTML = courseCardHtml({ ...listing, ...course }, false);
  applyFilter();
  refreshOpenDetails();
  renderUndatedCourse(course.id);
}

function markCourseFailed(id, message) {
  const placeholder = document.querySelector(`.skel[data-cid="${id}"]`);
  if (!placeholder) return;
  placeholder.classList.add("failed");
  placeholder.querySelector(".spin")?.remove();
  placeholder.querySelector(".sub").textContent = "couldn't load: " + message;
}

// ─────────────────────────────────────────────────────────────────────────────
// Previews
// ─────────────────────────────────────────────────────────────────────────────

// Everything that can be previewed is marked by the server with entry.preview:
//   "pdf", "office" (Word, PowerPoint, Excel…), "image", "video", "audio", "text",
//   "auto" (a slide or reading whose type isn't known until it's opened),
//   "page" (a CourseWorks page) or "embed" (a YouTube or Vimeo link).

// What each preview needs, so reopening one doesn't download it again.
const previewCache = {};

const canPreview = (entry) => Boolean(entry.preview);

/** An item's title: a button that opens its preview, or a normal link. */
function fileTitleHtml(entry) {
  if (!canPreview(entry)) return externalLink(entry.url, esc(entry.title));
  return `<button class="plink" aria-expanded="false">${esc(entry.title)} <span class="pchev" aria-hidden="true">▸</span></button>`;
}

/** The (initially closed) space under an item where its preview appears. */
function previewPanelHtml(entry, courseId) {
  if (!canPreview(entry)) return "";
  const data = {
    kind: entry.preview,
    file: entry.file_id,
    url: entry.url,
    embed: entry.embed_url,
    page: entry.page_url,
    cid: courseId,
  };
  const attributes = Object.entries(data)
    .filter(([, value]) => value != null)
    .map(([name, value]) => `data-${name}="${esc(value)}"`)
    .join(" ");
  return `<div class="preview hidden" ${attributes}></div>`;
}

/** Ask this app's server for something, sending the token. Logs out if the token stopped working. */
async function fetchWithToken(path) {
  let response;
  try {
    response = await fetch(API + path, { headers: { "X-Canvas-Token": getToken() } });
  } catch (e) {
    throw new Error("couldn't reach the server");
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({ error: "HTTP " + response.status }));
    if (result.need_token) {
      setToken("");
      showAuth(result.error);
    }
    throw new Error(result.error);
  }
  return response;
}

// Long text files are cut off after this many characters.
const MAX_TEXT_PREVIEW = 200000;

/** Gather what a preview needs: a link to show, some text, or a page's content. */
async function loadPreview(panel) {
  const { kind, file, embed, page, cid } = panel.dataset;
  const cacheKey = file || embed || `${cid}/${page}`;
  if (previewCache[cacheKey]) return previewCache[cacheKey];

  let preview;
  if (kind === "embed") {
    preview = { kind, src: embed };
  } else if (kind === "page") {
    const params = new URLSearchParams({ course_id: cid, page_url: page });
    const result = await (await fetchWithToken(`/api/page?${params}`)).json();
    preview = { kind, html: result.html, name: result.title };
  } else {
    // A file: ask the server how it can be shown.
    const info = await (await fetchWithToken(`/api/file-preview?file_id=${file}`)).json();
    preview = { kind: info.kind, name: info.name, src: info.src || info.viewer_url || null };
    if (info.kind === "pdf") {
      const response = await fetchWithToken(`/api/file-content?file_id=${file}`);
      const pdf = new Blob([await response.arrayBuffer()], { type: "application/pdf" });
      preview.src = URL.createObjectURL(pdf);
    } else if (info.kind === "text") {
      const text = await (await fetchWithToken(`/api/file-content?file_id=${file}`)).text();
      preview.text = text.slice(0, MAX_TEXT_PREVIEW);
      preview.cut = text.length > MAX_TEXT_PREVIEW;
    }
  }
  previewCache[cacheKey] = preview;
  return preview;
}

function previewHtml(preview, url) {
  const name = esc(preview.name || "");
  let content;
  switch (preview.kind) {
    case "pdf":
    case "viewer":
      content = `<iframe class="pframe" src="${esc(preview.src)}" title="Preview of ${name}"
                   referrerpolicy="no-referrer" allowfullscreen></iframe>`;
      break;
    case "embed":
      content = `<iframe class="pframe pvideo-frame" src="${esc(preview.src)}" title="Video"
                   referrerpolicy="strict-origin-when-cross-origin"
                   allow="fullscreen; picture-in-picture; encrypted-media" allowfullscreen></iframe>`;
      break;
    case "image":
      content = `<img class="pimg" src="${esc(preview.src)}" alt="${name}">`;
      break;
    case "video":
      content = `<video class="pvideo" src="${esc(preview.src)}" controls preload="metadata"></video>`;
      break;
    case "audio":
      content = `<audio src="${esc(preview.src)}" controls preload="metadata"></audio>`;
      break;
    case "text":
      content = `<pre class="ptext">${esc(preview.text)}</pre>` +
        (preview.cut ? `<p class="sub">Only the beginning of this file is shown.</p>` : "");
      break;
    case "page":
      // The server has already removed anything unsafe from the page.
      content = `<div class="desc ppage">${preview.html || `<p class="sub">This page is empty.</p>`}</div>`;
      break;
    default:
      content = `<p class="sub">There's no preview for this file.</p>`;
  }

  const links = [];
  if (preview.kind === "pdf") links.push(externalLink(preview.src, "Open full screen ↗"));
  links.push(externalLink(url, preview.kind === "embed" ? "Open original ↗" : "Open in CourseWorks ↗"));
  return `${content}<div class="plinks">${links.join("")}</div>`;
}

/** Open or close the preview under an item. Its content is only fetched the first time. */
async function togglePreview(button) {
  const panel = button.closest("li").querySelector(".preview");
  const open = panel.classList.toggle("hidden") === false;
  button.setAttribute("aria-expanded", open);
  if (!open) {
    for (const media of panel.querySelectorAll("video, audio")) media.pause();
    return;
  }
  if (panel.dataset.state) return;

  panel.dataset.state = "loading";
  panel.innerHTML = `<div class="dload"><span class="spin"></span>Loading preview…</div>`;
  try {
    panel.innerHTML = previewHtml(await loadPreview(panel), panel.dataset.url);
    panel.dataset.state = "loaded";
  } catch (e) {
    delete panel.dataset.state; // try again next time it's opened
    panel.innerHTML = `
      <p class="sub">Couldn't load the preview (${esc(e.message)}).
        ${externalLink(panel.dataset.url, "Open original ↗")}</p>`;
  }
}

// Previews can be opened on both tabs.
for (const tab of ["#courses", "#due"]) {
  $(tab).addEventListener("click", (event) => {
    const button = event.target.closest(".plink");
    if (button) togglePreview(button);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading due dates and readings discussed in class (shared by everyone in a course)
// ─────────────────────────────────────────────────────────────────────────────

// A reading is in one of three states, shared by everyone in its course:
//   - it has a due date (DATA.mats[course].deadlines[url]),
//   - it's been discussed in class, so it needs no date (DATA.mats[course].discussed[url]),
//   - or neither, so it's listed under "Readings without a due date" on the Due soon tab.
// Giving a discussed reading a date unmarks it, and marking a reading as discussed removes its date.

const readingDeadline = (courseId, url) => DATA.mats[courseId]?.deadlines?.[url];
const readingDiscussed = (courseId, url) => DATA.mats[courseId]?.discussed?.[url];

/**
 * The box holding a reading's due date and its buttons. The same reading can
 * have a box on both tabs. Hiding a reading only matters on the "Due soon" tab,
 * so only boxes there (canHide) offer it.
 */
function readingDueBoxHtml(courseId, url, canHide = false) {
  const hide = canHide ? ` data-hide="1"` : "";
  return `<span class="rdue" data-cid="${courseId}" data-url="${esc(url)}"${hide}>${readingDueHtml(courseId, url, canHide)}</span>`;
}

/** What's inside the box: the due date (or "Hidden") and buttons to change it. */
function readingDueHtml(courseId, url, canHide) {
  const errorSlot = `<span class="rdue-err" role="alert"></span>`;

  // Where hiding isn't offered, a hidden reading just shows "+ Due date".
  const discussed = readingDiscussed(courseId, url);
  if (discussed && canHide) {
    return `
      <span class="rdue-val discussed" title="Hidden by ${esc(discussed.by)} on ${formatDateTime(discussed.at)}">
        Hidden · ${esc(discussed.by)}
      </span>
      <button class="rdue-btn" data-act="undiscuss" title="List it again as needing a due date, for everyone in the course">Unhide</button>
      ${errorSlot}`;
  }

  const deadline = readingDeadline(courseId, url);
  if (!deadline) {
    return `
      <button class="rdue-btn" data-act="edit">+ Due date</button>
      ${canHide ? `<button class="rdue-btn" data-act="discuss" title="It doesn't need a due date (e.g. already covered in class): stop listing it, for everyone in the course">Hide</button>` : ""}
      ${errorSlot}`;
  }

  const past = deadline.date < dayFromToday(0);
  return `
    <span class="rdue-val ${past ? "past" : ""}" title="Added by ${esc(deadline.by)} on ${formatDateTime(deadline.at)}">
      📅 ${past ? "Was due" : "Due"} ${formatShortDay(deadline.date)}
    </span>
    <button class="rdue-btn" data-act="edit">Change</button>
    ${errorSlot}`;
}

/** Label for a day button: "Today", "Tomorrow", then e.g. "Sat 26". */
function dayButtonLabel(day) {
  if (day === dayFromToday(0)) return "Today";
  if (day === dayFromToday(1)) return "Tomorrow";
  const date = parseDay(day);
  return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${date.getDate()}`;
}

/** Swap the due date for a row of buttons, one per day. One click saves. */
function openDueEditor(box) {
  const deadline = readingDeadline(box.dataset.cid, box.dataset.url);
  const dayButtons = [];
  for (const day of pickableDays()) {
    const isCurrent = deadline?.date === day;
    dayButtons.push(
      `<button class="rdue-btn rdue-day ${isCurrent ? "primary" : ""}" data-act="pick" data-day="${day}"
         title="${formatShortDay(day)}" aria-pressed="${isCurrent}">${dayButtonLabel(day)}</button>`,
    );
  }
  box.innerHTML = `
    <span class="rdue-days" role="group" aria-label="Pick a due date">${dayButtons.join("")}</span>
    ${deadline ? `<button class="rdue-btn danger" data-act="remove">Remove</button>` : ""}
    ${deadline && box.dataset.hide ? `<button class="rdue-btn" data-act="discuss" title="Remove the date and hide it, for everyone in the course">Hide</button>` : ""}
    <button class="rdue-btn icon" data-act="cancel" aria-label="Cancel" title="Cancel">✕</button>
    <span class="rdue-err" role="alert"></span>`;
  box.querySelector(".rdue-day").focus();
}

function closeDueEditor(box) {
  box.innerHTML = readingDueHtml(Number(box.dataset.cid), box.dataset.url, !!box.dataset.hide);
}

/** Put a reading's state ({deadline, discussed}, each null if not set) into DATA and redraw it everywhere. */
function applyReadingState(courseId, url, state) {
  const course = DATA.mats[courseId];
  course.deadlines ??= {};
  course.discussed ??= {};
  if (state.deadline) course.deadlines[url] = state.deadline;
  else delete course.deadlines[url];
  if (state.discussed) course.discussed[url] = state.discussed;
  else delete course.discussed[url];

  for (const box of readingBoxes(courseId, url)) closeDueEditor(box);
  updateDueListReading(courseId, url, state.deadline);
  renderUndatedCourse(courseId);
}

/** Every box on the page (on either tab) showing this reading's due date. */
function readingBoxes(courseId, url) {
  return $$(".rdue").filter((box) => Number(box.dataset.cid) === courseId && box.dataset.url === url);
}

/** A reading's title, from the course's files and links. */
function readingTitle(courseId, url) {
  const course = DATA.mats[courseId];
  return (
    course.deadlines?.[url]?.title ||
    course.discussed?.[url]?.title ||
    courseEntries(course).find((entry) => entry.url === url)?.title ||
    ""
  );
}

// Per reading (keyed by course id and link):
//   saveQueue:  the save in progress. Saves for the same reading are sent one at a
//               time, in the order they were clicked, so the server ends up with the last one.
//   latestSave: a number for the most recent click, so only that one updates the page.
//   savedState: the reading's state as the server last confirmed it, to go back to if a save fails.
const saveQueue = {};
const latestSave = {};
const savedState = {};

/** Send one change to the server. Always returns an object: the saved state, or {error}. */
async function sendReadingChange(courseId, url, change) {
  try {
    const response = await fetch(`${API}/api/reading-deadline`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Canvas-Token": getToken() },
      body: JSON.stringify({ course_id: courseId, url, ...change }),
    });
    return await response.json().catch(() => ({ error: "HTTP " + response.status }));
  } catch (e) {
    return { error: "Couldn't reach the server." };
  }
}

/**
 * Change a reading's state. The page updates right away (an "optimistic
 * update"), and the change is saved in the background. If the server refuses
 * it, the reading goes back to what the server last saved, and the error shows next to it.
 * `change` is one of {date: "YYYY-MM-DD"}, {date: null} (remove the date),
 * {discussed: true} or {discussed: false}.
 */
async function saveReading(box, change) {
  const courseId = Number(box.dataset.cid);
  const url = box.dataset.url;

  const day = change.date;
  if (day && !pickableDays().includes(day)) {
    const slot = box.querySelector(".rdue-err");
    if (slot) slot.textContent = `Pick one of the next ${PICK_WEEKDAYS} weekdays.`;
    return;
  }

  // Remember what the server has (unless a save is already under way), then
  // show the change straight away.
  const key = `${courseId} ${url}`;
  savedState[key] ??= {
    deadline: readingDeadline(courseId, url) || null,
    discussed: readingDiscussed(courseId, url) || null,
  };
  const me = { by: DATA.user || "You", at: new Date().toISOString(), title: readingTitle(courseId, url) };
  let expected;
  if ("discussed" in change) {
    expected = { deadline: null, discussed: change.discussed ? me : null };
  } else {
    // Removing a date leaves the reading not discussed; setting one un-marks it.
    expected = { deadline: day ? { ...me, date: day } : null, discussed: null };
  }
  applyReadingState(courseId, url, expected);

  const thisSave = (latestSave[key] = (latestSave[key] || 0) + 1);
  const request = (saveQueue[key] || Promise.resolve()).then(() => sendReadingChange(courseId, url, change));
  saveQueue[key] = request;
  const result = await request;

  if (result.need_token) {
    setToken("");
    return showAuth(result.error);
  }
  if (!result.error) {
    savedState[key] = { deadline: result.deadline || null, discussed: result.discussed || null };
  }
  if (thisSave !== latestSave[key]) return; // a newer click on this reading will update the page
  delete saveQueue[key];
  const serverState = savedState[key];
  delete savedState[key];

  if (result.error) {
    applyReadingState(courseId, url, serverState);
    for (const other of readingBoxes(courseId, url)) {
      const slot = other.querySelector(".rdue-err");
      if (slot) slot.textContent = `Not saved: ${result.error}`;
    }
    return;
  }
  const saved = serverState;
  const sameAsShown =
    saved.deadline?.date === expected.deadline?.date && !!saved.discussed === !!expected.discussed;
  if (!sameAsShown) return applyReadingState(courseId, url, saved);

  // Saved as shown. Keep the server's copy (it differs only in the exact time)
  // without redrawing, so anything opened since the click stays open.
  const course = DATA.mats[courseId];
  if (saved.deadline) course.deadlines[url] = saved.deadline;
  if (saved.discussed) course.discussed[url] = saved.discussed;
  const dueItem = DATA.due?.find((item) => item.key === `reading:${courseId}:${url}`);
  if (dueItem && saved.deadline) {
    dueItem.added_by = saved.deadline.by;
    dueItem.added_at = saved.deadline.at;
  }
}

/** Add, move or remove a reading in the "Due soon" list after its date changes. */
function updateDueListReading(courseId, url, deadline) {
  if (!DATA.due) return; // the due list couldn't be loaded
  const key = `reading:${courseId}:${url}`;
  DATA.due = DATA.due.filter((item) => item.key !== key);
  if (deadline && deadline.date >= dayFromToday(0) && deadline.date <= dayFromToday(DATA.days)) {
    const course = DATA.courses.find((c) => c.id === courseId) || {};
    DATA.due.push({
      title: deadline.title,
      type: "reading",
      due: deadline.date + "T00:00:00",
      date_only: true,
      course: course.name || "",
      course_id: courseId,
      url,
      points: null,
      submitted: false,
      key,
      has_detail: false,
      added_by: deadline.by,
      added_at: deadline.at,
    });
  }
  renderDue();
}

// One click handler for every due date control, on both tabs.
for (const tab of ["#courses", "#due"]) {
  $(tab).addEventListener("click", (event) => {
    const button = event.target.closest(".rdue-btn");
    if (!button || button.disabled) return;
    const box = button.closest(".rdue");
    // Saved data is about to be replaced, which would undo the change on screen.
    if (showingSaved) {
      const slot = box.querySelector(".rdue-err");
      if (slot) slot.textContent = "Still refreshing. Try again in a moment.";
      return;
    }
    const action = button.dataset.act;
    if (action === "edit") openDueEditor(box);
    else if (action === "cancel") closeDueEditor(box);
    else if (action === "remove") saveReading(box, { date: null });
    else if (action === "pick") saveReading(box, { date: button.dataset.day });
    else if (action === "discuss") saveReading(box, { discussed: true });
    else if (action === "undiscuss") saveReading(box, { discussed: false });
  });

  // While picking a day, Escape cancels.
  $(tab).addEventListener("keydown", (event) => {
    const box = event.target.closest(".rdue");
    if (box?.querySelector(".rdue-days") && event.key === "Escape") closeDueEditor(box);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// "Readings without a due date" (bottom of the "Due soon" tab)
// ─────────────────────────────────────────────────────────────────────────────

// Each class gets a card listing its readings that have no date and aren't
// marked as discussed in class. Only the first few are shown until "Show all" is clicked.
const UNDATED_SHOWN = 5;
// Cards where "Show all" was clicked, and cards whose "discussed in class" list is open, so
// they stay that way when the card is redrawn.
const undatedShowAll = new Set();
const undatedDiscussedOpen = new Set();

/** A class's readings, split into those still needing a date and those discussed in class. Each link counts once. */
function undatedReadings(course) {
  const seen = new Set();
  const needDate = [];
  const discussed = [];
  for (const entry of courseEntries(course)) {
    if (entry.cat !== "reading" || seen.has(entry.url)) continue;
    seen.add(entry.url);
    if (course.discussed?.[entry.url]) discussed.push(entry);
    else if (!course.deadlines?.[entry.url]) needDate.push(entry);
  }
  return { needDate, discussed };
}

/**
 * A direct download link for a reading that's a CourseWorks file, or null for
 * web links and pages. Uses the file's own link when known (it carries an access
 * code); otherwise builds one from the course and file number.
 */
function readingDownloadUrl(entry, courseId) {
  if (entry.download) return entry.download;
  const courseUrl = DATA.mats[courseId]?.url;
  if (entry.file_id && courseUrl) return `${courseUrl}/files/${entry.file_id}/download?download_frd=1`;
  return downloadUrl(entry.url);
}

/**
 * A reading in "Readings without a due date": its title opens a preview (like
 * on the Slides & readings tab), and files also get a download icon.
 */
function undatedRowHtml(entry, courseId, extra) {
  const where = entry.ctx ? `<span class="ctx">${esc(entry.ctx)}</span>` : "";
  const download = readingDownloadUrl(entry, courseId);
  return `
    <li class="${extra ? "extra" : ""}">
      <span class="ic">📄</span>
      ${fileTitleHtml(entry)}${where}${readingDueBoxHtml(courseId, entry.url, true)}${downloadButton(download)}${previewPanelHtml(entry, courseId)}
    </li>`;
}

/** One empty slot per class, in the same order as the Slides & readings tab, filled as each class loads. */
function renderUndatedPlaceholders() {
  undatedShowAll.clear();
  undatedDiscussedOpen.clear();
  const classes = DATA.courses.filter((course) => course.is_class);
  $("#undated").innerHTML = `
    <h2 class="undated-h hidden">Readings without a due date</h2>
    ${classes.map((course) => `<div class="ucourse cc hidden" data-cid="${course.id}" ${courseColor(course.id)}></div>`).join("")}`;
}

/** Fill in (or redraw) one class's card. */
function renderUndatedCourse(courseId) {
  const card = document.querySelector(`.ucourse[data-cid="${courseId}"]`);
  const course = DATA.mats[courseId];
  if (!card || !course) return; // not a class, or not loaded yet

  const { needDate, discussed } = undatedReadings(course);
  const listing = DATA.courses.find((c) => c.id === courseId) || course;
  const showAll = undatedShowAll.has(courseId);
  card.classList.toggle("show-all", showAll);
  card.classList.toggle("hidden", !needDate.length && !discussed.length);

  const hiddenCount = needDate.length - UNDATED_SHOWN;
  const more =
    hiddenCount > 0
      ? `<button class="umore" data-act="more">${showAll ? "Fewer" : `${hiddenCount} more`}</button>`
      : "";
  const list = needDate.length
    ? `<ul class="ulist">${needDate.map((entry, i) => undatedRowHtml(entry, courseId, i >= UNDATED_SHOWN)).join("")}</ul>${more}`
    : `<p class="sub uall">All caught up.</p>`;
  const discussedList = discussed.length
    ? `
      <details class="udiscussed" ${undatedDiscussedOpen.has(courseId) ? "open" : ""}>
        <summary>${discussed.length} hidden</summary>
        <ul class="ulist">${discussed.map((entry) => undatedRowHtml(entry, courseId, false)).join("")}</ul>
      </details>`
    : "";

  card.innerHTML = `
    <div class="uhead">${courseTitleHtml(listing)}</div>
    ${list}${discussedList}`;

  const discussedDetails = card.querySelector("details.udiscussed");
  discussedDetails?.addEventListener("toggle", () => {
    if (discussedDetails.open) undatedDiscussedOpen.add(courseId);
    else undatedDiscussedOpen.delete(courseId);
  });

  // The heading shows once any class has something to list.
  $(".undated-h").classList.toggle("hidden", !$$(".ucourse:not(.hidden)").length);
}

$("#undated").addEventListener("click", (event) => {
  const button = event.target.closest(".umore");
  if (!button) return;
  const courseId = Number(button.closest(".ucourse").dataset.cid);
  if (undatedShowAll.has(courseId)) undatedShowAll.delete(courseId);
  else undatedShowAll.add(courseId);
  renderUndatedCourse(courseId);
});

// ─────────────────────────────────────────────────────────────────────────────
// Filter, search and expand/collapse on the "Slides & readings" tab
// ─────────────────────────────────────────────────────────────────────────────

function applyFilter() {
  const query = $("#q").value.trim().toLowerCase();

  for (const row of $$("ul.mat li[data-cat]")) {
    const categoryMatches = activeFilter === "all" || row.dataset.cat === activeFilter;
    const searchMatches = !query || row.dataset.t.includes(query);
    row.classList.toggle("hidden", !(categoryMatches && searchMatches));
  }

  // Hide modules and folders with nothing left to show.
  for (const module of $$(".mod")) {
    module.classList.toggle("hidden", !module.querySelector("li[data-cat]:not(.hidden)"));
  }

  // Hide subheadings whose section has nothing left to show.
  for (const subheading of $$("li.sh")) {
    let hasVisibleRow = false;
    for (let row = subheading.nextElementSibling; row && !row.classList.contains("sh"); row = row.nextElementSibling) {
      if (!row.classList.contains("hidden")) hasVisibleRow = true;
    }
    subheading.classList.toggle("hidden", !hasVisibleRow);
  }
}

$("#q").oninput = applyFilter;

for (const chip of $$(".chip[data-f]")) {
  chip.onclick = () => {
    activeFilter = chip.dataset.f;
    for (const other of $$(".chip[data-f]")) other.classList.toggle("on", other === chip);
    applyFilter();
  };
}

$("#toggleAll").onclick = (event) => {
  const cards = $$("details.course");
  const expand = !cards.every((card) => card.open);
  for (const card of cards) card.open = expand;
  event.target.textContent = expand ? "Collapse all" : "Expand all";
};

// ─────────────────────────────────────────────────────────────────────────────
// Access token and login screen
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_STORAGE_KEY = "cw-token";

// The token is saved in the browser so you stay logged in. If the browser
// doesn't allow saving, it's kept only until the page is closed or reloaded.
function getToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
  } catch (e) {
    return window.__tok || "";
  }
}

function setToken(token) {
  window.__tok = token;
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch (e) {}
}

function showAuth(message) {
  for (const id of ["due", "mat"]) $("#" + id).classList.add("hidden");
  $("nav").classList.add("hidden");
  $("#signout").classList.add("hidden");
  setLoading("off");
  $("#auth").classList.remove("hidden");
  $("#err").innerHTML = "";
  $("#sub").textContent = "Not logged in";
  $("#autherr").innerHTML = message ? `<div class="err">${esc(message)}</div>` : "";
  $("#tokeninput").value = "";
  $("#tokeninput").focus();
}

function showApp() {
  $("#auth").classList.add("hidden");
  $("nav").classList.remove("hidden");
  $("#signout").classList.remove("hidden");
  let tab = "due";
  try {
    if (localStorage.getItem(TAB_STORAGE_KEY) === "mat") tab = "mat";
  } catch (e) {}
  showTab(tab);
}

$("#authform").onsubmit = (event) => {
  event.preventDefault();
  const token = $("#tokeninput").value.trim();
  if (!token) return;
  setToken(token);
  load();
};

$("#signout").onclick = () => {
  currentRequest?.abort();
  setToken("");
  clearSavedData();
  setShowingSaved(false);
  DATA = null;
  showAuth();
};

// ─────────────────────────────────────────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update the status bar.
 * state:    "loading", "done", "failed", or "off" (hidden; used only on the login screen)
 * message:  text to show (left as is if not given)
 * fraction: how full the progress bar is, from 0 to 1 (left as is if not given)
 */
let loadState = "off";

function setLoading(state, message, fraction) {
  loadState = state;
  const bar = $("#loadbar");
  $("#topslot").classList.toggle("hidden", state === "off");
  updateTopSlot();
  bar.classList.toggle("done", state === "done" || state === "failed");
  bar.classList.toggle("failed", state === "failed");
  $("#loadicon").textContent = state === "failed" ? "✕" : "✓";
  if (message) $("#loadtxt").textContent = message;
  if (fraction != null) $("#progfill").style.width = Math.round(fraction * 100) + "%";
}

/** Once everything has loaded, the top box on "Due soon" swaps the progress bar for the note. */
function updateTopSlot() {
  $("#topslot").classList.toggle("show-note", loadState === "done" && currentTab === "due");
}

function fail(message) {
  setLoading("failed", "Stopped loading.");
  $("#err").innerHTML = `<div class="err">Couldn't load data: ${esc(message)}</div>`;
  $("#sub").textContent = "Error";
}

function headerSubtitle(extra = "") {
  const user = DATA.user ? DATA.user + " · " : "";
  return `${user}${DATA.courses.length} courses${extra}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Updates from the server
// ─────────────────────────────────────────────────────────────────────────────

function onEvent(event) {
  switch (event.type) {
    case "start":
      DATA = {
        user: event.user,
        days: event.days,
        courses: event.courses,
        due: null,
        details: {}, // due item → its details (or an error)
        mats: {}, // course id → its files and links
        got: 0, // updates received so far
        // Updates expected: the due list + one per course. One per due item
        // with details is added when the due list arrives.
        total: event.courses.length + 1,
        finished: false,
      };
      $("#sub").textContent = headerSubtitle();
      renderCoursePlaceholders();
      renderUndatedPlaceholders();
      break;

    case "due":
      DATA.due = event.due;
      DATA.total += event.due.filter((item) => item.has_detail).length;
      renderDue();
      DATA.got++;
      break;

    case "due_detail":
      DATA.details[event.key] = event.error ? { error: event.error } : event.detail;
      fillDetail(event.key);
      DATA.got++;
      break;

    case "due_error":
      $("#due-list").innerHTML = `<div class="err">Couldn't load due dates: ${esc(event.error)}</div>`;
      DATA.got++;
      break;

    case "course":
      placeCourse(event.course);
      DATA.got++;
      break;

    case "course_error":
      markCourseFailed(event.id, event.error);
      DATA.got++;
      break;

    case "done": {
      DATA.finished = true;
      const total = DATA.courses.length;
      const failed = $$(".skel.failed").length;
      setLoading(
        "done",
        failed ? `${total - failed} of ${total} courses loaded` : `All ${total} courses loaded`,
        1,
      );
      const updated = new Date(event.generated).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
      $("#sub").textContent = headerSubtitle(` · updated ${updated}`);
      return;
    }
  }

  if (DATA && !DATA.finished) {
    const remaining = DATA.total - DATA.got;
    setLoading(
      "loading",
      remaining > 0
        ? `Loading from CourseWorks… ${DATA.got} of ${DATA.total} ready`
        : "Finishing up…",
      DATA.got / DATA.total,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved copy of the last load
// ─────────────────────────────────────────────────────────────────────────────

// Every update from the last complete load is saved in the browser, so the
// page can show it right away next time while fresh data loads. It's only
// used if it's less than a day old and was loaded with the same token.
const SAVED_STORAGE_KEY = "cw-saved";
const SAVED_MAX_AGE = MS_PER_DAY;

// True while the page is showing the saved copy and the fresh data is still loading.
let showingSaved = false;

function setShowingSaved(value) {
  showingSaved = value;
  document.body.classList.toggle("showing-saved", value);
}

/** A short fingerprint of the token, so one person's saved data isn't shown to another. */
function tokenFingerprint(token) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16) + ":" + token.length;
}

/** The saved copy for this token, or null if there isn't a usable one. */
function readSavedData(token) {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(SAVED_STORAGE_KEY) || "null");
  } catch (e) {
    return null;
  }
  if (!saved) return null;
  const age = Date.now() - saved.savedAt;
  const usable =
    saved.version === 1 &&
    saved.token === tokenFingerprint(token) &&
    Array.isArray(saved.events) &&
    age >= 0 &&
    age < SAVED_MAX_AGE;
  if (!usable) {
    clearSavedData();
    return null;
  }
  return saved;
}

function writeSavedData(token, events) {
  try {
    localStorage.setItem(
      SAVED_STORAGE_KEY,
      JSON.stringify({ version: 1, token: tokenFingerprint(token), savedAt: Date.now(), events }),
    );
  } catch (e) {
    // Not allowed, or too big for the browser's storage: don't keep an older copy around either.
    clearSavedData();
  }
}

function clearSavedData() {
  try {
    localStorage.removeItem(SAVED_STORAGE_KEY);
  } catch (e) {}
}

/** "just now", "12 min ago" or "5 h ago". */
function timeAgo(time) {
  const minutes = Math.floor((Date.now() - time) / 6e4);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/** Empty every part of the page that the updates fill in. */
function clearView() {
  DATA = null;
  $("#err").innerHTML = "";
  $("#due-list").innerHTML = "";
  $("#undated").innerHTML = "";
  $("#courses").innerHTML = "";
}

/**
 * Replace what's on screen with a complete set of updates. What was open
 * (due items, course cards) and the scroll position are kept where possible.
 */
function redrawFrom(events) {
  const scroll = window.scrollY;
  const openItems = $$("details.ditem[open]").map((d) => d.dataset.key);
  const openCourses = $$("details.course[open]").map((d) => d.dataset.cid);
  const othersOpen = $("details.others")?.open;

  clearView();
  for (const event of events) onEvent(event);

  for (const key of openItems) {
    const details = document.querySelector(`details.ditem[data-key="${CSS.escape(key)}"]`);
    if (details) details.open = true;
  }
  for (const id of openCourses) {
    const card = document.querySelector(`details.course[data-cid="${CSS.escape(id)}"]`);
    if (card) card.open = true;
  }
  if (othersOpen && $("details.others")) $("details.others").open = true;
  window.scrollTo(0, scroll);
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

async function load() {
  const token = getToken();
  if (!token) return showAuth();

  currentRequest?.abort();
  const request = new AbortController();
  currentRequest = request;

  showApp();
  clearView();
  setShowingSaved(false);

  // Show the saved copy, if there's a recent one, while the fresh data loads.
  const saved = readSavedData(token);
  if (saved) {
    try {
      for (const event of saved.events) onEvent(event);
      setShowingSaved(true);
    } catch (e) {
      clearSavedData();
      clearView();
    }
  }
  const savedNote = () => `saved ${timeAgo(saved.savedAt)}`;
  if (showingSaved) {
    $("#sub").textContent = headerSubtitle(` · ${savedNote()}, refreshing…`);
    setLoading("loading", `Showing data ${savedNote()}. Refreshing from CourseWorks…`, 0.03);
  } else {
    $("#sub").textContent = "Connecting…";
    setLoading("loading", "Connecting to CourseWorks…", 0.03);
  }

  // If loading fails while the saved copy is on screen, keep it and say it's out of date.
  const failLoad = (message) => {
    if (request !== currentRequest) return;
    if (!showingSaved) return fail(message);
    setShowingSaved(false);
    setLoading("failed", `Couldn't refresh. Showing data ${savedNote()}.`);
    $("#err").innerHTML = `<div class="err">Couldn't refresh: ${esc(message)}</div>`;
    $("#sub").textContent = headerSubtitle(` · ${savedNote()}`);
  };

  let response;
  try {
    response = await fetch(`${API}/api/data`, {
      headers: { "X-Canvas-Token": token },
      signal: request.signal,
    });
  } catch (e) {
    if (e.name !== "AbortError") failLoad(e.message);
    return;
  }

  // If something went wrong, the server sends one error message instead of a series of updates.
  const isStream = (response.headers.get("content-type") || "").includes("ndjson");
  if (!isStream) {
    const result = await response.json().catch(() => ({ error: "HTTP " + response.status }));
    if (request !== currentRequest) return;
    if (result.need_token) {
      setToken("");
      clearSavedData();
      setShowingSaved(false);
      return showAuth(result.error);
    }
    return failLoad(result.error);
  }

  // Every update in this load, to save once it's complete and, if the saved
  // copy is on screen, to draw all at once in its place.
  const events = [];
  let finished = false;
  // Progress while the saved copy is on screen (otherwise onEvent keeps count in DATA).
  let got = 0;
  let total = 0;

  const handle = (event) => {
    events.push(event);
    if (event.type === "done") {
      finished = true;
      // Only a load where everything arrived is worth saving.
      const complete = !events.some((e) => e.type === "due_error" || e.type === "course_error");
      if (complete) writeSavedData(token, events);
      if (showingSaved) {
        setShowingSaved(false);
        redrawFrom(events);
      } else {
        onEvent(event);
      }
      return;
    }
    if (!showingSaved) return onEvent(event);

    if (event.type === "start") total = event.courses.length + 1;
    else got++;
    if (event.type === "due") total += event.due.filter((item) => item.has_detail).length;
    setLoading(
      "loading",
      `Showing data ${savedNote()}. Refreshing… ${got} of ${total || "?"} ready`,
      total ? Math.max(0.03, got / total) : 0.03,
    );
  };

  // Read the updates as they arrive. Each complete line is one update.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) handle(JSON.parse(line));
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") failLoad("connection lost (" + e.message + ")");
    return;
  }

  if (!finished) failLoad("the response ended early. Reload the page to try again.");
}

load();
