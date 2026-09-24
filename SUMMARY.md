# Better Canvas: project summary

A small web app for Columbia CourseWorks (Canvas) that shows:

1. **Due soon:** everything due in the next 14 days across all active classes, plus readings that classmates have given a due date. Each item expands to show its full description, key facts, attached files (with previews) and related course files. Below that, **Readings without a due date** lists, class by class, every reading nobody has dated or marked as discussed in class yet, so they can be dated right there.
2. **Slides & readings:** lecture slides, readings and recordings, organized by course. Clicking a file, page or video opens a preview right in the page.
3. **Reading due dates from classmates:** anyone can pick a due date (one of the 7 days starting today) for a reading, or mark it as **discussed** in class so it no longer needs one. Everyone in that course then sees it, both next to the reading and in "Due soon", along with the name of the person who set it.

---

## How it's put together

- **The page** (`static/`) is plain HTML, CSS and JavaScript. It's published on **GitHub Pages**.
- **The API** is one **Supabase Edge Function** called `api` (`supabase/functions/api/`, TypeScript on Deno). It talks to CourseWorks with each visitor's own token and saves reading due dates.
- **Reading due dates** are saved in the Supabase project's **Postgres** database. The function connects to it directly with plain SQL (the `postgres` driver, using the `SUPABASE_DB_URL` connection string Supabase provides).
- **On your own computer**, `deno task start` runs the same API code and serves the page too, saving dates in a SQLite file.

This replaced the earlier Python (FastAPI) server, which is still in git history.

---

## How to run it on your computer

Install Deno once (`brew install deno`, or see deno.com), then:

```bash
cd ~/Desktop/dev/canvas
deno task start              # opens http://localhost:8765
```

The first run downloads the few libraries it needs. Reading due dates are saved in `reading_deadlines.db` next to `dev.ts`, or in Postgres if `DATABASE_URL` is set.

On first visit the page shows a **Log in with CourseWorks** screen. You create an access token in CourseWorks settings (**+ New Access Token**, any name, **Generate Token**) and paste it in. The browser remembers it, so you stay logged in until you click **Log out** or the token expires.

### Settings (environment variables)

| Variable | Default | Where | Purpose |
|---|---|---|---|
| `DAYS_AHEAD` | `14` | both | How far ahead "Due soon" looks, for both CourseWorks items and classmates' reading dates |
| `IGNORE_COURSES` | *(none)* | both | Extra comma-separated course codes/names to hide. Always hidden: `ENGIE4503` (Analytics in Python), any course with "Exemption" in its name, "CBS Python Level 1" and "SEAS Mandatory Orientation Tutorials" |
| `APP_TIMEZONE` | `America/New_York` | both | The time zone "today" and the 7 pickable days follow. Edge Functions run on UTC, so this keeps the day from switching over at 8 pm New York time |
| `ALLOWED_ORIGINS` | `*` | both | Which sites may call the API from a browser, comma-separated (e.g. `https://rainshen49.github.io`). `*` allows any. Safe either way, because every call needs the visitor's own token, which only the page they logged in on has |
| `CANVAS_BASE` | `https://courseworks2.columbia.edu` | both | Canvas instance, e.g. a fake server for testing |
| `DATABASE_URL` | *(unset)* | both | A Postgres address. On Supabase you don't need it: the function uses `SUPABASE_DB_URL`, which Supabase sets automatically |
| `PORT` | `8765` | local | Port to listen on |
| `HOST` | `0.0.0.0` | local | Other devices on your network can open the app at the address printed on startup. Set to `127.0.0.1` to allow only this computer |
| `NO_BROWSER` | *(unset)* | local | Don't open a browser tab |
| `DEADLINES_DB` | `reading_deadlines.db` next to `dev.ts` | local | The SQLite file used when `DATABASE_URL` isn't set |

On Supabase, set them with `supabase secrets set NAME=value` (all are optional).

---

## Deploying (Supabase + GitHub Pages)

One-time setup:

1. **Create a Supabase project** at supabase.com, and install the Supabase CLI (`brew install supabase/tap/supabase`).
2. **Link this folder to it:** `supabase login`, then `supabase link --project-ref <project-ref>` (the ref is in the project's URL, e.g. `abcd1234`).
3. **Create the tables:** `supabase db push` (runs `supabase/migrations/`). Optional: the function also creates them on first use.
4. **Deploy the function:** `supabase functions deploy api` (or `deno task deploy`). `supabase/config.toml` turns off Supabase's own login check for it (`verify_jwt = false`), because visitors sign in with their CourseWorks token instead.
5. **Optionally limit which site can call it:** `supabase secrets set ALLOWED_ORIGINS=https://rainshen49.github.io`.
6. **Set up GitHub Pages:** in the GitHub repo, **Settings → Pages → Source: GitHub Actions**. Then **Settings → Secrets and variables → Actions → Variables** → add `BETTER_CANVAS_API` = `https://<project-ref>.supabase.co/functions/v1` (without `/api`).
7. **Push to `main`.** The "Publish page" workflow (`.github/workflows/pages.yml`) copies `static/` and writes `config.js` pointing at the function. The site appears at `https://rainshen49.github.io/better-canvas/`.

After that: change the page → push to `main` (it republishes automatically). Change the API → `supabase functions deploy api`.

**Edge Function limits that matter here** (free plan): 2 s of CPU time and 150 s per request, and 256 MB of memory. Loading the page is almost all waiting on CourseWorks, which doesn't count as CPU time, so it fits comfortably. PDFs pass through as a stream, so large files don't use much memory.

---

## File layout

```
canvas/
├── dev.ts                              # run locally: serves static/ and the API; SQLite for dates
├── deno.json                           # `deno task start` / `check` / `deploy`
├── reading_deadlines.db                # local reading due dates (created on first local run; not in git)
├── static/                             # the page (published to GitHub Pages)
│   ├── index.html                      # page shell
│   ├── config.js                       # where the API is ("" = same server; set when publishing)
│   ├── style.css                       # styles (light + dark mode)
│   └── app.js                          # login, stream reader, due list, materials, previews, reading due dates, filters
├── supabase/
│   ├── config.toml                     # turns off Supabase's login check for the `api` function
│   ├── migrations/…_reading_dates.sql  # the two tables, with Row Level Security on
│   └── functions/api/                  # the Edge Function
│       ├── index.ts                    # entry point (Deno.serve)
│       ├── app.ts                      # routes, streaming, CORS, reading due dates, previews
│       ├── canvas.ts                   # CourseWorks client (one per request; holds the token)
│       ├── materials.ts                # courses, modules, syllabus links, loose files
│       ├── classify.ts                 # sorting into slides/readings/recordings/other, what can be previewed
│       ├── due.ts                      # "Due soon" list and item details
│       ├── store.ts                    # saving reading due dates and "discussed" marks (Postgres)
│       ├── sanitize.ts                 # cleaning instructors' HTML
│       └── config.ts                   # settings
├── .github/workflows/pages.yml         # publishes static/ to GitHub Pages
└── tests/
    ├── mock.py                         # early fake Canvas server (from the first version)
    └── shot.py                         # early Playwright screenshot script (from the first version)
```

---

## Architecture

### API (`supabase/functions/api/`)
- **Deno + `fetch`.** One handler serves every route. On Supabase the page calls `https://<project-ref>.supabase.co/functions/v1/api/<route>`; locally, `/api/<route>` on the same server:
  - `GET /api/data` streams everything the page shows (below)
  - `POST /api/reading-deadline` sets or removes a reading's due date, or marks / unmarks a reading as discussed in class
  - `GET /api/file-preview`, `GET /api/file-content` and `GET /api/page` power the previews
- **CORS:** because the page (GitHub Pages) and the API (Supabase) are on different sites, every answer carries CORS headers, and the browser's preflight (`OPTIONS`) is answered. `ALLOWED_ORIGINS` can limit it to the Pages site.
- **Streaming response (NDJSON)** from `/api/data`. Events arrive in completion order:
  - `start`: user name plus the course list, which the browser shows as loading placeholders right away
  - `due`: due items for the next `DAYS_AHEAD` days (from `/api/v1/planner/items`, falling back to per-course assignments if the planner can't be read), plus readings classmates have dated
  - `due_detail`: full details for each due item (description, points, attempts, time limit, open/close dates, files)
  - `course`: one per course, with its modules, syllabus links, loose files, quick-link tabs, reading due dates, readings discussed in class, and how each item can be previewed
  - `course_error` / `due_error`: per-item failures that don't stop the rest
  - `done`
- **Token validation happens before streaming**, so a bad or missing token returns `401 {"error", "need_token": true}`.
- Up to 8 CourseWorks requests run at once per page load. If the browser leaves mid-load, the remaining CourseWorks requests are cancelled.
- **Database:** one Postgres connection per running copy of the function, opened on first use and reused (`prepare: false`, so it also works through Supabase's connection pooler). Switching a reading between "dated" and "discussed" runs in one transaction. Row Level Security is on for both tables with no policies, so Supabase's public API (usable by anyone with the project's public key) can't read or change them; only the function's direct connection can.

### Token handling (security)
- Each visitor pastes their own token. It is stored **only in that browser's `localStorage`** (on the GitHub Pages site) and sent in the `X-Canvas-Token` header over HTTPS.
- On the server, the token exists **only inside a per-request `CanvasClient`**, which is dropped when that request finishes. For `/api/data` that's when the stream ends or the browser disconnects.
- The token is never passed on beyond CourseWorks: preview links are resolved on the server, and file downloads that CourseWorks forwards to its separate file-storage server go without the token (redirects are followed by hand, and the token is only sent to CourseWorks itself).
- **No globals, no cache, no logging.** The token is never written anywhere. Errors are logged by route name only. The database holds names and dates, never tokens.
- Supabase's own login check is off for this function (`verify_jwt = false`); the CourseWorks token is the login.
- **Log out** clears the token from localStorage and cancels any load that's still running.

### Materials sorting (slides / readings / recordings / other)
Content is gathered from several places, because professors post materials in different ways:
- **Modules** (Proctorio, Honorlock and Respondus exam-instruction modules are skipped)
- **Syllabus page links**, grouped by the syllabus's own headings. Generic link text like "slides", "pdf" or "python" gets the heading as a prefix, e.g. "Lecture 3 - Linear regression — slides". The Statistics course needs this because it posts everything there.
- **Course files** not linked from any module, grouped by folder
- **Quick links** to course menu tabs: only Echo360, Video Library, Ed (Discussion) and Zoom

Sorting rules, in order:
1. Junk files (`.conf`, `course_image` folder) are hidden. Video files (`.mp4`, etc.) are **recordings**.
2. Homework, exam and quiz names, or an "Assignments" folder, count as **other**.
3. "slides", "lecture", "deck", `.pptx` or `.key`, or a numbered course deck (`HCDIx 2.2…`, `FDT02-…`, `TT 1(a)…`), count as **slides**. So does any document in a "Slides" or "Lectures" folder.
4. A "Readings" folder, or names with "case", "chapter", "HBR", "syllabus" and similar, count as **readings**. Any other document with no clues (PDF, Word, Excel, CSV, EPUB, notebook) defaults to a reading.
- Word matching uses letter-only boundaries so that `ENG4502_Lecture_6.pdf` matches "lecture". Files are matched on their **display name**, because Canvas stores raw filenames URL-encoded.

**Classes vs. other sites:** courses in a real term (e.g. "Fall 2026") are classes. "Default Term" sites (Career Management, Class of 2028, other orientation sites) are in a collapsed "Other sites" section. Exemption exams, CBS Python Level 1 and SEAS Mandatory Orientation Tutorials are hidden entirely (see `IGNORE_COURSES`). Course names are shortened: `IEMEE4201_001_2026_3 - Human-Centered…` becomes the name plus the code `IEMEE4201`.

### Assignment details
- Details are fetched from the assignments, quizzes, discussion topics or pages endpoint, depending on the item type.
- Descriptions are **sanitized with `sanitize-html`** (set up with the same allowed tags as the earlier Python version's `nh3`), which strips scripts, stylesheets, event handlers and `javascript:` links. Links open in a new tab with `rel="noopener noreferrer"`.
- **Attached files:** Canvas file links in the description and discussion attachments get a direct download link (`/files/{id}/download?download_frd=1`, keeping the `verifier` parameter). The server also looks up each one's real name and type, so it can be previewed.
- **Related course files:** matched in the browser by assignment number, leaving out files already attached. "HW02" matches `HW02.pdf` in the Assignments folder. "Homework 1" matches the "Homework 1" syllabus section (its PDF, Python file and data) but not Homework 2.

### Previews
Anything that can be previewed opens underneath its title when clicked, instead of going to CourseWorks. Clicking again closes it (and pauses any video or audio). This applies on the Slides & readings tab, and to attached and related files in an expanded "Due soon" item.

| What | How it's shown |
|---|---|
| PDF | The server fetches it with the person's token (`/api/file-content`) and the browser's built-in PDF viewer shows it. "Open full screen" opens it in a new tab |
| Word, PowerPoint, Excel, OpenDocument, RTF | CourseWorks's own document viewer, in a frame. The server gets the viewer link (`/api/file-preview`), so the token never goes to the viewer |
| Images | Shown directly, using the file's own download link (which carries a file-specific access code, not the token) |
| Video and audio files | A built-in player, using the same kind of download link |
| Plain text (`.txt`, `.csv`, `.py`, `.md`, `.json`…) | Shown as text through `/api/file-content`, cut off after 200,000 characters |
| CourseWorks pages (in modules) | The page's content, cleaned of anything unsafe (`/api/page`) |
| YouTube and Vimeo links | The video player (`youtube-nocookie.com` for YouTube) |

- **How the server decides:** by file name ending or the file type CourseWorks reports. For files in modules, whose titles often have no extension, it looks up the real name and type in the course's file list. For files attached to an assignment, it looks each one up individually, because the link text is often just "notes" or "here". Slides and readings whose type still can't be told get a preview button anyway, and the server works it out when opened.
- Other web links (HBR, Google Docs, library pages…) and other files still open in a new tab. If a file looked previewable but CourseWorks has no viewer for it, the panel says there's no preview and links to CourseWorks.
- `/api/file-content` only ever serves PDFs (as `application/pdf`) and text (as `text/plain`), with `nosniff`, so nothing that could run as a web page is served from the app.
- Each preview is fetched only once per page load. Detail panels on "Due soon" are redrawn when a course finishes loading, which closes any preview open inside them.
- CourseWorks answers 401 both for a bad token and for a file you can't see, so the server checks the token separately before logging anyone out.
- Tested with a fake CourseWorks server: every kind above, a page containing a script (removed), a text file containing HTML (shown as text), a file the user can't see, a bad token, and that the token isn't sent to the file-storage server. **Not yet tested against the real CourseWorks**, in particular whether its document viewer allows being shown inside another site. If Word/PowerPoint previews come up blank, that's the likely reason.
- On iPhone and iPad, a PDF inside the page may only show its first page. Use "Open full screen" there.

### Reading due dates from classmates
- **Three states, shared by the whole course:** every reading either has a due date, is marked **discussed** in class (so it doesn't need a date), or has neither. Giving a discussed reading a date unmarks it, and marking a dated reading as discussed removes its date.
- **Where the controls are.** The same controls appear in three places and stay in sync (changing one updates the others right away):
  - **Due soon → Readings without a due date** (bottom of the tab). One card per class (not "Other sites"), in the same order as the Slides & readings tab, listing its readings that have no date and aren't discussed in class, with the module or folder each is in. Each reading can be previewed and has **+ Due date** and **✓ Discussed** buttons. The first 5 show, with "Show N more" for the rest. Each card also has a collapsed "N discussed" list with an **Undo** button per reading. A reading linked from two places (e.g. two modules) is listed once. Cards appear as each class loads.
  - **Due soon → a dated reading, expanded:** shows who set the date, and **Change** (the day buttons, plus Remove and ✓ Discussed).
  - **Slides & readings:** next to every reading, as before, plus **✓ Discussed** / "✓ Discussed · Name" with **Undo**.
- **Picking a date:** a row of 7 day buttons (Today, Tomorrow, then e.g. "Sat 26"); one click saves. Once set, the reading shows "📅 Due Wed, Sep 30 · Name". Past dates stay visible as "Was due…".
- **Instant (optimistic) updates:** a click shows its result right away (the reading moves into the due list, into "N discussed", etc.) while the change is saved in the background; saving takes a second or two because the server checks the reading with CourseWorks. If the server refuses or can't be reached, the reading goes back to what the server last saved and "Not saved: …" appears next to it. Changes to the same reading are sent one at a time, in the order they were clicked, so the server always ends up with the last one. When the server confirms, the page isn't redrawn, so anything opened in the meantime stays open.
- **Who can change it:** anyone in the course can set, change or remove a date, and mark or unmark a reading as discussed. The page shows who made the current choice (hover for when).
- **Due soon list:** readings with a date in the next `DAYS_AHEAD` days appear as "All day" items marked "Reading · date from Name". They aren't counted as "not yet submitted".
- **Storage:** the Supabase project's Postgres (or any Postgres set with `DATABASE_URL`); when running locally without one, `reading_deadlines.db` (SQLite) next to `dev.ts`. Two tables, each with one row per reading (course id + reading link), created by the migration and also automatically on first use:
  - `deadlines`: title, date, CourseWorks user id and name, time set.
  - `discussed_readings`: title, CourseWorks user id and name, time marked.
  Switching a reading between the two happens in one transaction. Removing a date or unmarking deletes the row. No history of edits is kept.
- **The API (`POST /api/reading-deadline`):** body `{"course_id", "url", "date": "YYYY-MM-DD" or null}` to set or remove a date, or `{"course_id", "url", "discussed": true or false}`. It answers with the reading's new state: `{"deadline": … or null, "discussed": … or null}`. Checks:
  - The person's name comes from CourseWorks using their own token, so nobody can act under someone else's name.
  - Their token must be able to open the course, so they must be enrolled in it.
  - The link must be a reading in that course, found the same way the Slides & readings tab finds it. This also sets the title, so made-up entries can't appear in anyone's "Due soon".
  - The date must be one of the 7 days starting today, by the date in `APP_TIMEZONE` (New York). (The same 7-day limit is also set separately in `app.js`, using the viewer's own date.)
  - A request can't carry both a date and `discussed`, and `discussed` must be true or false.
- **Everyone shares one database.** On the published site, all classmates use the same Supabase database. A copy run locally with SQLite has its own separate dates.
- Tested with a fake CourseWorks server and two users: every rule above, the day buttons, changing, removing, marking and unmarking as discussed from each place, the two users seeing each other's changes, the Due soon list, "Show more", a reading linked twice, a name containing HTML (shown as plain text), and the phone layout in dark mode.

### Frontend (`static/app.js`)
- Reads the stream with `fetch().body.getReader()` and updates the page as each event arrives.
- **Top box (status + note):** one box at the top of both tabs, hidden only on the login screen. While loading it shows "N of M ready" and a progress bar. When everything has loaded, on Due soon it turns into the note about reading due dates; on Slides & readings it shows a quiet ✓ "All N courses loaded". If loading fails it shows ✕ on both tabs. The progress bar and the note are stacked in the same spot (same grid cell, the unused one hidden with `visibility`), so the box is always as tall as the taller of the two and the content below never shifts.
- Placeholder cards with spinners are replaced by the real cards as each course arrives. Before the first results arrive, the status bar is the only loading indicator (there are no separate "Loading due dates…" / "Loading your courses…" blocks).
- `app.js` and `style.css` are organized into commented sections (helpers, tabs, dates, due list, details, materials, previews, reading due dates, filters, login, status bar, updates from the server, loading) and use clear, descriptive names.
- Filters (All / Slides / Readings / Recordings / Other), a title search, and Expand/Collapse all.
- Download links are a small download icon; hovering over it (or tabbing to it) shows a "Download" tip, and screen readers read it as "Download".
- The note (in the top box on Due soon) is one line: "⚠️ Reading due dates come from classmates. Contribute below". "Contribute below" is a link that smoothly scrolls down to "Readings without a due date", stopping just below the sticky header.
- Hidden courses (`IGNORE_COURSES`) never appear. Remaining non-class sites are in a collapsed "Other sites (orientation, career…)" section.
- The selected tab is remembered in localStorage. Dark mode follows the system setting, and the layout works on phones.

---

## Decisions and findings along the way

| Topic | Finding / decision |
|---|---|
| Network access | The cloud sandbox and the Mac's sandboxed shell were first blocked from CourseWorks. The user added `courseworks2.columbia.edu` to the allowed domains, and live tests then ran on the Mac. |
| Hidden Files tabs | Canvas returns **401** for a course whose Files tab is hidden from students. Only a 401 on `/users/self/profile` means the token is bad. |
| Calling the API from the browser | Checked and rejected: CourseWorks sends **no CORS headers** (the preflight returns 404). The user chose to keep a backend rather than build a Chrome extension. |
| Token storage | Went from a token file (`~/.courseworks_token`), to user-supplied tokens in localStorage with a hashed server cache, to **request-scoped only** with no cache. |
| Refresh button | Removed. Reloading the page fetches fresh data. |
| "Change token" | Renamed to **Log out**. |
| Streaming | Added so results show as soon as each part is ready, instead of after everything loads. |
| Page files | HTML, CSS and JS moved out of the Python file into `static/`. |
| Hosting | Supabase can't run a Python server, and its Edge Functions serve HTML as plain text without a custom domain. So the backend was rewritten as a TypeScript Edge Function (replacing the Python server), the page moved to GitHub Pages, and dates moved to the project's Postgres, reached with a direct SQL connection. The TypeScript version was checked against the Python one on the same fake CourseWorks: identical output for every event. |

## Testing done
- Live runs against the real account: 8 due items, 6 classes and 10 other sites, with each class's slides, readings and recordings counted by hand.
- Token flow: no token, a bad token, a good token, and two different tokens at the same time (each handled correctly).
- Browser tests with mock servers: first-visit prompt, bad-token error, reload using the saved token, log out, streaming with placeholders, layout shift (content stayed at the same position on desktop and phone), and expanding items including an XSS test (no script ran and nothing unsafe survived).
- Stopping partway: closing the stream mid-load left the server healthy.
- Reading due dates and "discussed in class", with a fake CourseWorks server and two users: all server checks (no/bad token, dates out of range, date and discussed together, non-readings, made-up links, courses the user isn't in), setting, changing, removing, marking and unmarking as discussed from Due soon and from Slides & readings, the Due soon list, and a name containing HTML.
- Previews, with a fake CourseWorks server: PDF, Word/PowerPoint viewer, image, text, CourseWorks page, YouTube; unsafe page content removed; text containing HTML shown as text; files the user can't see; the token not sent to the file-storage server.
- The TypeScript API (after replacing Python): same fake CourseWorks, run side by side with the Python server, gave identical `/api/data` output (only save times differed) and identical answers from every preview route; all the reading-date rules above; Postgres and SQLite storage; Row Level Security on; CORS preflight and `ALLOWED_ORIGINS`; the page served from one site calling the API on another (as on GitHub Pages + Supabase), including saving and a PDF preview; and the earlier browser tests (instant updates, click order, undo on failure). **Not yet run on Supabase itself**, only on Deno locally.
- Wording, layout and colors were checked in light and dark mode, on desktop and phone widths.

## Known limitations / ideas
- The first "Due soon" load waits on Canvas's planner endpoint, which takes about 2 s.
- Images inside descriptions load from CourseWorks and need a CourseWorks login in the same browser.
- Matching related files relies on numbered names such as "HW02" or "Homework 1", so assignments without numbers get no related files.
- When run locally and opened from another device, the app uses plain `http://`, so tokens travel unencrypted on the local network. That's fine on a trusted home network. On shared Wi-Fi (e.g. campus), use `HOST=127.0.0.1`, or use the published HTTPS site.
- A Chrome extension would avoid CORS and the server entirely, using the CourseWorks login session instead of a token.
- `tests/` still holds the early Python mock and screenshot scripts. They haven't been updated since, and the fake-CourseWorks tests described above aren't in the project.
- Previews and reading due dates haven't been tried against the real CourseWorks yet. In particular, CourseWorks's document viewer may refuse to be shown inside another site.
- The server's "today" is New York's (`APP_TIMEZONE`), while the day buttons use the viewer's own date. Someone in another time zone near midnight may see a button the server refuses.
- The login screen links straight to `courseworks2.columbia.edu/profile/settings`, even if `CANVAS_BASE` points elsewhere.
- Anyone in a course can change any reading's due date or mark any reading as discussed, and no history is kept, so a wrong or malicious change can't be traced back beyond the last person to make it. A discussed reading is still listed (under "N discussed" and on Slides & readings), so it can be undone.
- A course with many readings (e.g. the whole semester's) will list them all under "Readings without a due date" until someone dates them or marks them as discussed. Past weeks' readings need to be marked once per course.
- **Security reminder:** the personal token used during development was pasted into a chat. Revoke it in CourseWorks and create a new one.
