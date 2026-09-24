#!/usr/bin/env python3
"""
Better Canvas — a small web app for Columbia CourseWorks (Canvas).

It shows:
  1. Everything due in the next 14 days across your current courses, plus
     readings that classmates have given a due date
     (change the number of days with DAYS_AHEAD)
  2. Direct links to lecture slides, readings and recordings, by course and module.
     Files, pages and videos open as a preview right in the page.
  3. Reading due dates added by classmates. Anyone in a course can pick a due
     date (one of the 7 days starting today) for one of its readings; everyone in that
     course then sees it. These are saved in reading_deadlines.db next to this
     file, with the name of the person who set each date.

Run (using the included .venv):
       .venv/bin/python better_canvas.py    → opens http://localhost:8765
       Other devices on the same network can use the address it prints.

About the access token
  * Each person pastes their own CourseWorks access token into the page. Their
    browser saves it and sends it with each request to this server.
  * The server uses the token only while answering that one request, then
    throws it away. It is never saved, shared between requests, or logged.
    (The reading due dates file stores names, never tokens.)
"""

import asyncio
import html as htmllib
import json
import logging
import os
import re
import socket
import sqlite3
import threading
import webbrowser
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import httpx
import nh3
from fastapi import FastAPI, Header, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

BASE = os.environ.get("CANVAS_BASE", "https://courseworks2.columbia.edu").rstrip("/")
PORT = int(os.environ.get("PORT", "8765"))
# 0.0.0.0 lets other devices on your network (phone, other laptops) open the app.
# Set HOST=127.0.0.1 to allow only this computer.
HOST = os.environ.get("HOST", "0.0.0.0")
DAYS_AHEAD = int(os.environ.get("DAYS_AHEAD", "14"))
CONCURRENCY = 8  # how many requests to CourseWorks can run at once for one page load
# Where classmates' reading due dates are saved.
DEADLINES_DB = os.environ.get("DEADLINES_DB") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "reading_deadlines.db")
# Set DATABASE_URL (postgres://...) to save them in Postgres instead, e.g. on
# Heroku or Cloud Run, where files on the server are wiped on every deploy.
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip() or None
PICK_DAYS = 7  # a reading's due date can be one of this many days, starting today
# Courses to hide entirely. Each entry hides any course whose code or name
# contains it (ignoring upper/lower case), so "Exemption" hides every exemption exam.
# Add more here, or set IGNORE_COURSES="CODE1,CODE2" in the environment.
IGNORE_COURSES = [
    "ENGIE4503",
    "Exemption",
    "CBS Python Level 1",
    "SEAS Mandatory Orientation Tutorials",
] + [x for x in os.environ.get("IGNORE_COURSES", "").split(",") if x.strip()]

# The httpx library would otherwise log every address it requests. It never logs the token; this just cuts the noise.
logging.getLogger("httpx").setLevel(logging.WARNING)


# --------------------------------------------------------------------------- #
# Talking to CourseWorks (one client per request to this app)
# --------------------------------------------------------------------------- #
class CanvasError(Exception):
    def __init__(self, status, msg):
        super().__init__(f"{status}: {msg}")
        self.status = status


class CanvasClient:
    """Talks to CourseWorks for a single request to this app (loading the page,
    opening a preview, saving a due date…). The token lives only inside this
    object, which is closed when that request finishes."""

    def __init__(self, token: str):
        self._http = httpx.AsyncClient(
            base_url=BASE,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json",
                     "User-Agent": "better-canvas/2.0"},
            timeout=30,
        )
        self._sem = asyncio.Semaphore(CONCURRENCY)

    async def aclose(self):
        await self._http.aclose()

    async def get_all(self, path, params=None):
        """Fetch something from CourseWorks. Lists that come in several pages are
        fetched page by page (up to 50) and combined."""
        params = dict(params or {})
        params.setdefault("per_page", 100)
        url, out = f"/api/v1{path}", []
        for _ in range(50):  # stop after 50 pages at most
            async with self._sem:
                r = await self._http.get(url, params=params)
            if r.status_code >= 400:
                raise CanvasError(r.status_code, r.text[:200])
            data = r.json()
            if not isinstance(data, list):
                return data
            out.extend(data)
            nxt = r.links.get("next", {}).get("url")
            if not nxt:
                break
            url, params = nxt, None  # the next page's address already includes the options
        return out

    async def safe(self, path, params=None):
        """Like get_all, but returns None instead of failing, e.g. when a course
        hides its Files tab from students."""
        try:
            return await self.get_all(path, params)
        except (CanvasError, httpx.HTTPError, ValueError):
            return None


def abs_url(u):
    if not u:
        return None
    return u if u.startswith("http") else BASE + u


# --------------------------------------------------------------------------- #
# Sorting materials into slides, readings, recordings and other
# --------------------------------------------------------------------------- #
# Match whole words, where only letters count as part of a word. This way
# "ENG4502_Lecture_6.pdf" still matches "lecture".
_W, _E = r"(?<![a-z])", r"(?![a-z])"
SLIDE_RE = re.compile(_W + r"(slides?|deck|lecture|lectures|lec\s?\d+|presentation)" + _E + r"|\.(pptx?|key)$", re.I)
# Numbered course decks: "HCDIx 2.2 Process.pdf", "FDT02-Mechanical.pdf", "TT 1(b).4 Intro.pdf"
DECK_RE = re.compile(r"^[A-Za-z]{2,6}\s?\d{1,2}(\.\d|\(\w\)|[-_ ])")
HW_RE = re.compile(_W + r"(hw\s?\d*|homework|problem\s?sets?|ps\s?\d+|assignments?|solutions|answer\s?key|exam|quiz|rubric)" + _E, re.I)
READING_RE = re.compile(_W + r"(reading|readings|case|article|chapters?|ch\.?\s?\d+|paper|hbr|notes?|textbook|"
                        r"pre-?read|required|optional|packet|coursepack|syllabus)" + _E, re.I)
VIDEO_RE = re.compile(r"\.(mp4|mov|m4v|webm|mkv)$", re.I)
DOC_EXT_RE = re.compile(r"\.(pdf|docx?|epub|xlsx?|csv|ipynb)$", re.I)
JUNK_RE = re.compile(r"\.(conf|json|xml|ds_store|ini|log|tmp)$", re.I)
F_SLIDES = re.compile(_W + r"(slides?|lectures?|decks?)" + _E, re.I)
F_READ = re.compile(_W + r"(readings?|articles?|cases?)" + _E, re.I)
F_VIDEO = re.compile(_W + r"(recordings?|videos?|zoom)" + _E, re.I)
F_HW = re.compile(_W + r"(assignments?|homeworks?|problem\s?sets?)" + _E, re.I)


def classify(title, filename="", content_type="", folder=""):
    """Decide what kind of material this is: 'slides', 'reading', 'video' or 'other'.
    Returns None for things that shouldn't be shown (settings files, the course image…)."""
    name = filename or title
    t = f"{title} {filename}"
    folder = folder or ""
    if JUNK_RE.search(name) or folder.lower().startswith("course_image"):
        return None
    if VIDEO_RE.search(name) or (content_type or "").startswith("video/"):
        return "video"
    if HW_RE.search(t) or F_HW.search(folder):
        return "other"
    if SLIDE_RE.search(t) or DECK_RE.search(name) or "presentation" in (content_type or ""):
        return "slides"
    if F_SLIDES.search(folder) and DOC_EXT_RE.search(name):
        return "slides"
    if F_READ.search(folder) or READING_RE.search(t):
        return "reading"
    if F_VIDEO.search(folder) and not DOC_EXT_RE.search(name):
        return "video"
    if DOC_EXT_RE.search(name) or "pdf" in (content_type or ""):
        return "reading"  # a document with no other clues is most often a reading
    return "other"


NON_CLASS_RE = re.compile(r"exemption|orientation|tutorials?$|career management|class of 20\d\d|python level", re.I)


def is_class(course):
    term = ((course.get("term") or {}).get("name") or "").lower()
    return term not in ("", "default term") and not NON_CLASS_RE.search(course.get("name") or "")


def short_names(course):
    """Split a course's full name into (course code, short name), e.g.
    "IEMEE4201_001_2026_3 - Human-Centered Design…" → ("IEMEE4201", "Human-Centered Design…")
    "Foundations of Entrepreneurship FA2026"       → (None, "Foundations of Entrepreneurship")"""
    name = (course.get("name") or "").strip()
    m = re.match(r"^([A-Z]{4,5}\d{4})_\d+_\d{4}_\d\s*-\s*(.+)$", name)
    if m:
        return m.group(1), m.group(2).strip()
    name = re.sub(r"\s+(FA|SP|SU|FALL|SPRING|SUMMER)\s?\d{4}$", "", name, flags=re.I)
    name = re.sub(r"\s*\([^)]*\)\s*$", "", name).strip()
    return None, name


# --------------------------------------------------------------------------- #
# What can be previewed inside the page
# --------------------------------------------------------------------------- #
# (kind, file name ending, file type). The first match wins.
PREVIEW_KINDS = [
    ("pdf", r"\.pdf$", r"^application/pdf$"),
    ("office", r"\.(docx?|pptx?|xlsx?|odt|odp|ods|rtf)$",
     r"msword|officedocument|powerpoint|ms-excel|opendocument|/rtf"),
    ("image", r"\.(png|jpe?g|gif|webp|bmp|svg)$", r"^image/"),
    ("video", r"\.(mp4|m4v|webm|mov)$", r"^video/"),
    ("audio", r"\.(mp3|m4a|wav|ogg|aac)$", r"^audio/"),
    ("text", r"\.(txt|csv|md|py|r|sql|json|tex)$", r"^text/(plain|csv|markdown|x-)|^application/json$"),
]
YOUTUBE_RE = re.compile(r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|embed/|shorts/)|youtu\.be/)([\w-]{11})")
VIMEO_RE = re.compile(r"vimeo\.com/(?:video/)?(\d+)")


def preview_kind(name, mime=None):
    """How a file can be previewed ('pdf', 'office', 'image', 'video', 'audio', 'text'), or None."""
    for kind, ending, file_type in PREVIEW_KINDS:
        if re.search(ending, name or "", re.I) or re.search(file_type, mime or "", re.I):
            return kind
    return None


def embed_url(url):
    """A playable version of a YouTube or Vimeo link, or None."""
    if m := YOUTUBE_RE.search(url or ""):
        return f"https://www.youtube-nocookie.com/embed/{m.group(1)}"
    if m := VIMEO_RE.search(url or ""):
        return f"https://player.vimeo.com/video/{m.group(1)}"
    return None


def add_preview(entry, file_meta):
    """Mark a file, page or link with how it can be previewed (entry["preview"])."""
    if entry.get("file_id"):
        meta = file_meta.get(entry["file_id"]) or {}
        entry["mime"] = entry.get("mime") or meta.get("content-type")
        kind = preview_kind(meta.get("display_name") or entry["title"], entry["mime"])
        # Slides and readings without a recognizable name are almost always
        # previewable; the server works out how when it's opened.
        if not kind and entry.get("cat") in ("slides", "reading"):
            kind = "auto"
        entry["preview"] = kind
    elif entry.get("type") == "Page" and entry.get("page_url"):
        entry["preview"] = "page"
    elif embed := embed_url(entry.get("url")):
        entry["preview"], entry["embed_url"] = "embed", embed


# --------------------------------------------------------------------------- #
# Reading due dates added by classmates
# --------------------------------------------------------------------------- #
class DeadlineStore:
    """Reading due dates added by classmates.

    `deadlines` holds the latest date for each reading (one row per course and
    reading link) and who set it. Older dates aren't kept.

    Saved in Postgres when DATABASE_URL is set (needed on hosts like Heroku or
    Cloud Run, whose files are wiped on every deploy), otherwise in a SQLite
    file on this computer (DEADLINES_DB).

    The methods are ordinary (blocking) functions; the web routes call them
    with asyncio.to_thread so a slow database never holds up other requests."""

    SCHEMA = [
        """CREATE TABLE IF NOT EXISTS deadlines (
            course_id   BIGINT  NOT NULL,
            url         TEXT    NOT NULL,  -- the reading's link, the same for everyone in the course
            title       TEXT    NOT NULL,
            due_date    TEXT    NOT NULL,  -- YYYY-MM-DD
            set_by_id   BIGINT,            -- CourseWorks user id
            set_by_name TEXT    NOT NULL,
            set_at      TEXT    NOT NULL,  -- when it was set (UTC)
            PRIMARY KEY (course_id, url)
        )""",
        # Earlier versions kept every change here; only the latest date is kept now.
        "DROP TABLE IF EXISTS deadline_history",
    ]

    def __init__(self, database_url=None, sqlite_path=None):
        if database_url:
            from psycopg.rows import dict_row
            from psycopg_pool import ConnectionPool
            # A small pool that checks each connection before use, because hosted
            # databases close connections that have been idle for a while.
            self._pool = ConnectionPool(database_url, min_size=1, max_size=4, open=True,
                                        kwargs={"row_factory": dict_row},
                                        check=ConnectionPool.check_connection)
            self._mark = "%s"
            self.kind = "Postgres"
        else:
            self._pool = None
            self._db = sqlite3.connect(sqlite_path, check_same_thread=False)
            self._db.row_factory = sqlite3.Row
            self._lock = threading.Lock()
            self._mark = "?"
            self.kind = f"SQLite ({sqlite_path})"
        for stmt in self.SCHEMA:
            self._run(stmt)

    def _run(self, sql, params=(), fetch=False):
        """Run one statement (written with ? placeholders) and commit it."""
        sql = sql.replace("?", self._mark)
        if self._pool is not None:
            with self._pool.connection() as conn:  # commits on success, rolls back on error
                cur = conn.execute(sql, params)
                return cur.fetchall() if fetch else None
        with self._lock, self._db:
            cur = self._db.execute(sql, params)
            return cur.fetchall() if fetch else None

    def close(self):
        if self._pool is not None:
            self._pool.close()
        else:
            self._db.close()

    @staticmethod
    def _public(row):
        return {"date": row["due_date"], "by": row["set_by_name"], "at": row["set_at"], "title": row["title"]}

    def for_course(self, course_id):
        """{reading link: {date, by, at, title}} for one course."""
        rows = self._run("SELECT * FROM deadlines WHERE course_id = ?", (course_id,), fetch=True)
        return {r["url"]: self._public(r) for r in rows}

    def between(self, course_ids, first, last):
        """Readings in these courses that are due from `first` to `last` (inclusive)."""
        if not course_ids:
            return []
        marks = ",".join("?" * len(course_ids))
        rows = self._run(
            f"SELECT * FROM deadlines WHERE course_id IN ({marks}) AND due_date BETWEEN ? AND ?",
            (*course_ids, first.isoformat(), last.isoformat()), fetch=True)
        return [{**self._public(r), "course_id": r["course_id"], "url": r["url"]} for r in rows]

    def set(self, course_id, url, title, due_date, user_id, user_name):
        """Save (or, when due_date is None, remove) a reading's due date. Returns the new value or None."""
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if due_date is None:
            self._run("DELETE FROM deadlines WHERE course_id = ? AND url = ?", (course_id, url))
            return None
        self._run(
            """INSERT INTO deadlines (course_id, url, title, due_date, set_by_id, set_by_name, set_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (course_id, url) DO UPDATE SET
                   title = excluded.title, due_date = excluded.due_date, set_by_id = excluded.set_by_id,
                   set_by_name = excluded.set_by_name, set_at = excluded.set_at""",
            (course_id, url, title, due_date, user_id, user_name, now))
        return {"date": due_date, "by": user_name, "at": now, "title": title}


DEADLINES = DeadlineStore(DATABASE_URL, DEADLINES_DB)


# --------------------------------------------------------------------------- #
# Fetching data from CourseWorks
# --------------------------------------------------------------------------- #
async def fetch_courses(cv):
    courses = await cv.get_all("/courses", {
        "enrollment_state": "active",
        "include[]": ["term"],
        "state[]": ["available"],
    })
    ignore = [x.strip().lower() for x in IGNORE_COURSES]
    good = [c for c in courses if c.get("name") and not c.get("access_restricted_by_date")
            and not any(i in (c.get("course_code") or "").lower() or i in c["name"].lower() for i in ignore)]
    now = datetime.now(timezone.utc)
    # Drop courses whose term ended more than a week ago
    def active(c):
        end = (c.get("term") or {}).get("end_at") or c.get("end_at")
        if end:
            try:
                return datetime.fromisoformat(end.replace("Z", "+00:00")) > now - timedelta(days=7)
            except ValueError:
                pass
        return True
    return [c for c in good if active(c)]


async def fetch_due(cv, courses):
    now = datetime.now(timezone.utc)
    end = now + timedelta(days=DAYS_AHEAD)
    names = {c["id"]: short_names(c)[1] for c in courses}
    items = []

    planner = await cv.safe("/planner/items", {
        "start_date": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end_date": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    if planner is not None:
        for p in planner:
            ptype = p.get("plannable_type")
            if ptype in ("announcement", "calendar_event"):
                continue
            pl = p.get("plannable") or {}
            date = pl.get("due_at") or pl.get("todo_date") or p.get("plannable_date")
            if not date:
                continue
            subs = p.get("submissions") or {}
            cid = p.get("course_id")
            items.append({
                "title": pl.get("title") or pl.get("name") or "(untitled)",
                "type": ptype,
                "due": date,
                "course": names.get(cid) or p.get("context_name") or "",
                "course_id": cid,
                "url": abs_url(p.get("html_url")),
                "points": pl.get("points_possible"),
                "submitted": bool(subs.get("submitted")) if isinstance(subs, dict) else False,
                "graded": bool(subs.get("graded")) if isinstance(subs, dict) else False,
                "missing": bool(subs.get("missing")) if isinstance(subs, dict) else False,
                "pid": p.get("plannable_id"),
                "key": f"{ptype}:{cid}:{p.get('plannable_id')}",
                "has_detail": ptype in DETAIL_PATHS and bool(cid and p.get("plannable_id")),
            })
    else:
        # The planner couldn't be read, so look at each course's upcoming
        # assignments instead (this finds assignments only)
        async def per_course(c):
            res = await cv.safe(f"/courses/{c['id']}/assignments",
                       {"bucket": "upcoming", "include[]": ["submission"]}) or []
            out = []
            for a in res:
                d = a.get("due_at")
                if not d:
                    continue
                dt = datetime.fromisoformat(d.replace("Z", "+00:00"))
                if now <= dt <= end:
                    sub = a.get("submission") or {}
                    out.append({
                        "title": a.get("name"), "type": "assignment", "due": d,
                        "course": names[c["id"]], "course_id": c["id"],
                        "url": a.get("html_url"), "points": a.get("points_possible"),
                        "submitted": sub.get("workflow_state") in ("submitted", "graded"),
                        "graded": sub.get("workflow_state") == "graded",
                        "missing": bool(sub.get("missing")),
                        "pid": a["id"], "key": f"assignment:{c['id']}:{a['id']}", "has_detail": True,
                    })
            return out
        for r in await asyncio.gather(*(per_course(c) for c in courses)):
            items.extend(r)

    # Readings that classmates have given a due date. They have a date but no
    # time, so they're placed at the start of that day (this computer's time).
    today = datetime.now().date()
    for r in await asyncio.to_thread(
            DEADLINES.between, [c["id"] for c in courses], today, today + timedelta(days=DAYS_AHEAD)):
        items.append({
            "title": r["title"], "type": "reading", "due": r["date"] + "T00:00:00", "date_only": True,
            "course": names.get(r["course_id"], ""), "course_id": r["course_id"], "url": r["url"],
            "points": None, "submitted": False, "graded": False, "missing": False, "pid": None,
            "key": f"reading:{r['course_id']}:{r['url']}", "has_detail": False,
            "added_by": r["by"], "added_at": r["at"],
        })

    def when(item):
        if item.get("date_only"):
            return datetime.fromisoformat(item["due"]).astimezone()  # local midnight
        return datetime.fromisoformat(item["due"].replace("Z", "+00:00"))
    items.sort(key=when)
    return items


SKIP_MODULE_RE = re.compile(r"proctorio|honorlock|respondus", re.I)
SKIP_LINK_RE = re.compile(r"^mailto:|zoom\.us|forms\.gle|docs\.google\.com/forms|\.css($|\?)", re.I)
GENERIC_LINK = {"pdf", "python", "data", "assignment", "slides", "slide", "here", "link", "notebook", "code", "excel", "file"}
# Course menu tabs shown as shortcuts at the top of a course: Echo360, Video Library, Ed and Zoom
QUICK_TAB_RE = re.compile(r"echo360|video library|\bed\b|zoom", re.I)


def parse_syllabus(body, base):
    """Split the syllabus page into sections by its headings, and collect the links under each one."""
    sections, cur = [], {"name": "Syllabus", "items": []}
    for m in re.finditer(r"<h[1-4][^>]*>(.*?)</h[1-4]>|<a\b[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>", body or "", re.S | re.I):
        if m.group(1) is not None:
            head = htmllib.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()
            if head:
                if cur["items"]:
                    sections.append(cur)
                cur = {"name": head, "items": []}
            continue
        href = htmllib.unescape(m.group(2))
        text = htmllib.unescape(re.sub(r"<[^>]+>", "", m.group(3))).strip()
        if not text or SKIP_LINK_RE.search(href):
            continue
        if re.match(r"^(https?://|www\.)", text) and "/files/" not in href:
            continue  # skip links whose text is just a web address (usually policy or resource pages)
        generic = text.lower() in GENERIC_LINK
        title = f"{cur['name']} — {text}" if generic and cur["name"] != "Syllabus" else text
        if "/external_tools/" in href:
            cat = "video" if re.search(r"record|video|echo", text, re.I) else "other"
        elif generic and HW_RE.search(cur["name"]):
            cat = "other"
        else:
            cat = classify(text) or "other"
        fid = re.search(r"/files/(\d+)", href)
        cur["items"].append({"kind": "item", "title": title, "type": "File" if fid else "Link",
                             "url": abs_url(href.replace("/download?", "?").split("?")[0]) if fid else abs_url(href),
                             "cat": cat, "file_id": int(fid.group(1)) if fid else None})
    if cur["items"]:
        sections.append(cur)
    return sections


async def fetch_materials(cv, course):
    cid = course["id"]
    modules_out, seen_file_ids = [], set()

    modules = await cv.safe(f"/courses/{cid}/modules", {"include[]": ["items"]}) or []
    for m in modules:
        if SKIP_MODULE_RE.search(m.get("name") or ""):
            continue
        entries = []
        items = m.get("items")
        if items is None:  # CourseWorks leaves out the item list for big modules, so fetch it separately
            items = await cv.safe(f"/courses/{cid}/modules/{m['id']}/items") or []
        for it in items:
            typ = it.get("type")
            if typ in ("SubHeader",):
                entries.append({"kind": "header", "title": it.get("title")})
                continue
            if typ not in ("File", "ExternalUrl", "Page", "ExternalTool"):
                continue
            title = it.get("title") or ""
            url = it.get("external_url") if typ == "ExternalUrl" else it.get("html_url")
            url = abs_url(url)
            if typ == "Page":
                cat = classify(title) if (SLIDE_RE.search(title) or READING_RE.search(title)) else "other"
            elif typ == "ExternalUrl":
                cat = classify(title, it.get("external_url") or "")
            else:
                cat = classify(title, title)
            if cat is None:
                continue
            entries.append({"kind": "item", "title": title, "type": typ, "url": url, "cat": cat,
                            "file_id": it.get("content_id") if typ == "File" else None,
                            "page_url": it.get("page_url") if typ == "Page" else None})
            if typ == "File" and it.get("content_id"):
                seen_file_ids.add(it["content_id"])
        if any(e["kind"] == "item" for e in entries):
            modules_out.append({"name": m.get("name"), "items": entries})

    # Links posted on the Syllabus page (some professors put everything there)
    syllabus = []
    info = await cv.safe(f"/courses/{cid}", {"include[]": ["syllabus_body"]}) or {}
    for sec in parse_syllabus(info.get("syllabus_body"), BASE):
        for it in sec["items"]:
            if it.get("file_id"):
                seen_file_ids.add(it["file_id"])
        syllabus.append({"name": "📋 " + sec["name"], "items": sec["items"]})

    # Shortcut tabs from the course menu (Echo360, Video Library, Ed, Zoom)
    tabs = await cv.safe(f"/courses/{cid}/tabs") or []
    quick = [{"label": t["label"], "url": abs_url(t.get("html_url"))} for t in tabs
             if t.get("type") == "external" and not t.get("hidden") and QUICK_TAB_RE.search(t.get("label") or "")]

    # Files not already linked from a module or the syllabus (e.g. a "Slides" folder).
    # Hidden and locked files are skipped.
    loose = []
    files = await cv.safe(f"/courses/{cid}/files", {"sort": "updated_at", "order": "desc"})
    folders = {}
    if files:
        fl = await cv.safe(f"/courses/{cid}/folders") or []
        folders = {f["id"]: f.get("full_name", "").replace("course files/", "").replace("course files", "") for f in fl}
        for f in files:
            if f["id"] in seen_file_ids or f.get("hidden") or f.get("locked_for_user"):
                continue
            name = f.get("display_name") or f.get("filename") or ""
            folder = folders.get(f.get("folder_id"), "")
            cat = classify(name, name, f.get("content-type") or "", folder)  # use the display name; the raw filename has characters like spaces encoded (%20)
            if cat is None:
                continue
            loose.append({
                "kind": "item", "title": name, "type": "File", "file_id": f["id"],
                "url": f"{BASE}/courses/{cid}/files/{f['id']}",
                "download": f.get("url"),
                "cat": cat, "folder": folder, "updated": f.get("updated_at"),
                "mime": f.get("content-type"),
            })
    # Mark everything that can be previewed. The course's file list (when
    # students can see it) gives the real name and type of files in modules.
    file_meta = {f["id"]: f for f in files or []}
    for entry in [e for m in modules_out + syllabus for e in m["items"] if e["kind"] == "item"] + loose:
        add_preview(entry, file_meta)

    deadlines = await asyncio.to_thread(DEADLINES.for_course, cid)
    return {
        "id": cid,
        "name": short_names(course)[1],
        "code": short_names(course)[0],
        "is_class": is_class(course),
        "url": f"{BASE}/courses/{cid}",
        "modules": modules_out + syllabus,
        "quick": quick,
        "files": loose,
        "files_accessible": files is not None,
        "deadlines": deadlines,
    }


# --------------------------------------------------------------------------- #
# Assignment / quiz / discussion details
# --------------------------------------------------------------------------- #
DETAIL_PATHS = {
    "assignment": "/courses/{cid}/assignments/{pid}",
    "quiz": "/courses/{cid}/quizzes/{pid}",
    "discussion_topic": "/courses/{cid}/discussion_topics/{pid}",
    "wiki_page": "/courses/{cid}/pages/{pid}",
}
FILE_LINK_RE = re.compile(r'<a\b([^>]*?)href="([^"]*?/files/(\d+)[^"]*)"([^>]*)>(.*?)</a>', re.S | re.I)
SUBMISSION_LABELS = {"online_upload": "File upload", "online_text_entry": "Text entry", "online_url": "Website URL",
                     "media_recording": "Media recording", "online_quiz": "Quiz", "discussion_topic": "Discussion post",
                     "external_tool": "External tool", "on_paper": "On paper", "none": "No submission"}


def sanitize(html):
    """Remove anything unsafe (scripts, styles, code that runs on click…) from an instructor's
    description, and make its links open in a new tab."""
    return nh3.clean(html or "", url_schemes={"http", "https", "mailto"}, link_rel="noopener noreferrer",
                     set_tag_attribute_values={"a": {"target": "_blank"}}).strip()


def download_url(href):
    """Turn any link to a CourseWorks file into a direct download link (keeping the
    access code that some links carry)."""
    href = htmllib.unescape(href)
    path, _, query = href.partition("?")
    path = re.sub(r"/(download|preview)$", "", path)
    verifier = re.search(r"(?:^|&)verifier=([^&]+)", query)
    return abs_url(path) + "/download?download_frd=1" + (f"&verifier={verifier.group(1)}" if verifier else "")


def files_in_html(html):
    out = []
    for m in FILE_LINK_RE.finditer(html or ""):
        attrs = m.group(1) + m.group(4)
        title = re.search(r'title="([^"]+)"', attrs)
        name = htmllib.unescape(re.sub(r"<[^>]+>", "", m.group(5))).strip() or (title and htmllib.unescape(title.group(1))) or "File"
        out.append({"id": int(m.group(3)), "name": name, "url": abs_url(htmllib.unescape(m.group(2))),
                    "download": download_url(m.group(2))})
    return out


async def fetch_detail(cv, item):
    cid, pid, typ = item["course_id"], item["pid"], item["type"]
    d = await cv.get_all(DETAIL_PATHS[typ].format(cid=cid, pid=pid))
    raw = d.get("description") or d.get("message") or d.get("body") or ""
    files = files_in_html(raw)
    for a in d.get("attachments") or []:  # files attached to a discussion post
        files.append({"id": a.get("id"), "name": a.get("display_name") or a.get("filename") or "Attachment",
                      "url": a.get("url"), "download": a.get("url")})
    seen, uniq = set(), []
    for f in files:
        if f["id"] not in seen:
            seen.add(f["id"]); uniq.append(f)

    # Link text is often just "notes" or "here", so look up each file's real name
    # and type. The page uses these to decide whether it can show a preview.
    async def add_type(f):
        meta = await cv.safe(f"/files/{f['id']}") if f.get("id") else None
        if isinstance(meta, dict):
            f["filename"] = meta.get("display_name")
            f["mime"] = meta.get("content-type")
        f["preview"] = preview_kind(f.get("filename") or f["name"], f.get("mime"))
    await asyncio.gather(*(add_type(f) for f in uniq))

    sub = d.get("submission_types") or []
    return {
        "html": sanitize(raw),
        "files": uniq,
        "points": d.get("points_possible"),
        "submission": [SUBMISSION_LABELS.get(x, x.replace("_", " ")) for x in sub if x != "none"],
        "attempts": d.get("allowed_attempts"),
        "time_limit": d.get("time_limit"),
        "questions": d.get("question_count"),
        "unlock_at": d.get("unlock_at"),
        "lock_at": d.get("lock_at"),
        "url": d.get("html_url") or item.get("url"),
    }


def course_summary(c):
    code, name = short_names(c)
    return {"id": c["id"], "name": name, "code": code, "is_class": is_class(c), "url": f"{BASE}/courses/{c['id']}"}


def ndjson(obj):
    return (json.dumps(obj) + "\n").encode()


async def _run(kind, key, coro):
    """Wait for one task to finish and label its result. An error is returned as
    text instead of stopping everything else."""
    try:
        return kind, key, await coro, None
    except Exception as e:
        return kind, key, None, f"{type(e).__name__}: {e}"


async def stream_events(cv: "CanvasClient", me, courses):
    """Send updates to the browser, one line each, as each piece of data is ready:
    "start" (the course list) first; then "due" / "due_error", "course" /
    "course_error" and "due_detail" in whatever order they finish; "done" last.
    Closes the CourseWorks client at the end, including when the browser leaves early."""
    tasks = []
    try:
        summaries = sorted((course_summary(c) for c in courses), key=lambda c: (not c["is_class"], c["name"] or ""))
        yield ndjson({"type": "start", "user": me.get("name") or me.get("short_name") or "",
                      "days": DAYS_AHEAD, "courses": summaries})
        tasks = [asyncio.create_task(_run("due", None, fetch_due(cv, courses)))]
        tasks += [asyncio.create_task(_run("course", c["id"], fetch_materials(cv, c))) for c in courses]
        pending = set(tasks)
        while pending:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for t in done:
                kind, key, result, err = t.result()
                if kind == "due":
                    yield ndjson({"type": "due", "due": result} if err is None else {"type": "due_error", "error": err})
                    for it in result or []:  # now fetch the full details of each due item
                        if it.get("has_detail"):
                            nt = asyncio.create_task(_run("detail", it["key"], fetch_detail(cv, it)))
                            tasks.append(nt); pending.add(nt)
                elif kind == "detail":
                    yield ndjson({"type": "due_detail", "key": key, "detail": result} if err is None
                                 else {"type": "due_detail", "key": key, "error": err})
                else:
                    yield ndjson({"type": "course", "course": result} if err is None
                                 else {"type": "course_error", "id": key, "error": err})
        yield ndjson({"type": "done", "generated": datetime.now(timezone.utc).isoformat()})
    finally:
        for t in tasks:
            t.cancel()
        await cv.aclose()


# --------------------------------------------------------------------------- #
# Web server
# --------------------------------------------------------------------------- #
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
NO_STORE = {"Cache-Control": "no-store"}


class NeedToken(Exception):
    def __init__(self, msg):
        self.msg = msg


@app.exception_handler(NeedToken)
async def _need_token(_: Request, exc: NeedToken):
    return JSONResponse({"error": exc.msg, "need_token": True}, status_code=401, headers=NO_STORE)


STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"), headers=NO_STORE)


@app.get("/api/data")
async def api_data(x_canvas_token: Optional[str] = Header(default=None)):
    token = (x_canvas_token or "").strip()
    if not token:
        raise NeedToken("No token provided.")
    cv = CanvasClient(token)  # the token goes only into this client, which lasts only as long as this request
    del token
    try:
        me = await cv.get_all("/users/self/profile")  # checks the token works before sending anything
        courses = await fetch_courses(cv)
    except Exception as e:
        await cv.aclose()
        if isinstance(e, CanvasError) and e.status == 401:
            raise NeedToken("That token didn't work. It may be mistyped, expired or revoked.")
        return JSONResponse({"error": str(e)}, headers=NO_STORE)
    return StreamingResponse(stream_events(cv, me, courses), media_type="application/x-ndjson",
                             headers={**NO_STORE, "X-Accel-Buffering": "no"})


def _all_entries(materials):
    """Every file and link in a course's materials (modules, syllabus sections and loose files)."""
    for m in materials["modules"]:
        yield from (e for e in m["items"] if e.get("kind") == "item")
    yield from materials["files"]


@app.post("/api/reading-deadline")
async def set_reading_deadline(request: Request, x_canvas_token: Optional[str] = Header(default=None)):
    """Set or remove a reading's due date. Body: {"course_id", "url", "date": "YYYY-MM-DD" or null}.

    The person's name comes from CourseWorks (not from the page), and the
    reading must really be a reading in a course they're in, so nobody can
    add dates under someone else's name or for courses they aren't taking."""
    token = (x_canvas_token or "").strip()
    if not token:
        raise NeedToken("No token provided.")

    def refuse(msg, status=400):
        return JSONResponse({"error": msg}, status_code=status, headers=NO_STORE)

    try:
        body = await request.json()
    except ValueError:
        return refuse("The request wasn't readable.")
    course_id, url, day = body.get("course_id"), body.get("url"), body.get("date")
    if not isinstance(course_id, int) or not isinstance(url, str) or not url:
        return refuse("Missing course or reading.")
    if day is not None:
        try:
            due = date.fromisoformat(day)
        except (TypeError, ValueError):
            return refuse("That isn't a valid date.")
        today = datetime.now().date()
        if not today <= due < today + timedelta(days=PICK_DAYS):
            return refuse(f"Pick a date within the next {PICK_DAYS} days.")
        day = due.isoformat()

    cv = CanvasClient(token)
    del token
    try:
        me = await cv.get_all("/users/self/profile")
        course = await cv.safe(f"/courses/{course_id}", {"include[]": ["term"]})
        if not course:
            return refuse("You don't seem to be in this course.", 403)
        materials = await fetch_materials(cv, course)
    except CanvasError as e:
        if e.status == 401:
            raise NeedToken("That token didn't work. It may be mistyped, expired or revoked.")
        return refuse(f"Couldn't check with CourseWorks ({e}).", 502)
    except httpx.HTTPError as e:
        return refuse(f"Couldn't reach CourseWorks ({type(e).__name__}).", 502)
    finally:
        await cv.aclose()

    reading = next((e for e in _all_entries(materials) if e["url"] == url and e["cat"] == "reading"), None)
    if not reading:
        return refuse("That reading wasn't found in this course.", 404)

    saved = await asyncio.to_thread(DEADLINES.set, course_id, url, reading["title"], day,
                                    me.get("id"), me.get("name") or me.get("short_name") or "A classmate")
    return JSONResponse({"deadline": saved}, headers=NO_STORE)


# --------------------------------------------------------------------------- #
# Previews
# --------------------------------------------------------------------------- #
async def _file_info(cv, file_id):
    """A file's details from CourseWorks. CourseWorks itself checks that this
    person is allowed to see the file. Returns (info, None) or (None, error response)."""
    try:
        return await cv.get_all(f"/files/{file_id}", {"include[]": ["preview_url"]}), None
    except CanvasError as e:
        # CourseWorks also answers 401 for files you aren't allowed to see,
        # so only log the person out if the token itself no longer works.
        if e.status == 401 and await cv.safe("/users/self/profile") is None:
            raise NeedToken("That token didn't work. It may be mistyped, expired or revoked.")
        return None, JSONResponse({"error": "This file isn't available to you."}, status_code=404, headers=NO_STORE)
    except httpx.HTTPError as e:
        return None, JSONResponse({"error": f"Couldn't reach CourseWorks ({type(e).__name__})."},
                                  status_code=502, headers=NO_STORE)


def _token_from(header):
    token = (header or "").strip()
    if not token:
        raise NeedToken("No token provided.")
    return token


@app.get("/api/file-preview")
async def file_preview(file_id: int = Query(...), x_canvas_token: Optional[str] = Header(default=None)):
    """How to preview a file inside the page:

    "pdf", "text":            the page gets the file from /api/file-content
    "image", "video", "audio": `src` is the file's own download link
    "viewer":                 `viewer_url` is CourseWorks's document viewer (Word, PowerPoint, Excel…)
    "none":                   no preview is available"""
    cv = CanvasClient(_token_from(x_canvas_token))
    try:
        info, error = await _file_info(cv, file_id)
        if error:
            return error
        result = {"name": info.get("display_name"), "size": info.get("size"), "kind": "none"}
        kind = preview_kind(info.get("display_name"), info.get("content-type"))
        if kind in ("pdf", "text"):
            result["kind"] = kind
        elif kind in ("image", "video", "audio") and info.get("url"):
            # The download link carries its own access code (not the token).
            result.update(kind=kind, src=abs_url(info["url"]))
        elif info.get("preview_url"):
            # This link needs the token, and it forwards to a viewer link that doesn't.
            # Follow it here so the token never leaves this server.
            try:
                r = await cv._http.get(abs_url(info["preview_url"]), follow_redirects=False)
                viewer = r.headers.get("location") if r.is_redirect else None
            except httpx.HTTPError:
                viewer = None
            if viewer and viewer.startswith(("https://", "http://")):
                result.update(kind="viewer", viewer_url=viewer)
        return JSONResponse(result, headers=NO_STORE)
    finally:
        await cv.aclose()


@app.get("/api/file-content")
async def file_content(file_id: int = Query(...), x_canvas_token: Optional[str] = Header(default=None)):
    """Pass a PDF or plain-text file from CourseWorks through to the page so it can be
    shown inline. Nothing else is allowed, so nothing that could run as a web page
    is ever served from this app."""
    cv = CanvasClient(_token_from(x_canvas_token))
    try:
        info, error = await _file_info(cv, file_id)
    except NeedToken:
        await cv.aclose()
        raise
    kind = preview_kind(info.get("display_name"), info.get("content-type")) if info else None
    if error or kind not in ("pdf", "text") or not info.get("url"):
        await cv.aclose()
        return error or JSONResponse({"error": "This file can't be previewed this way."},
                                     status_code=415, headers=NO_STORE)
    try:
        # The download link carries its own access code. httpx drops the token if the
        # link forwards to another site (CourseWorks stores files on a separate server).
        upstream = await cv._http.send(cv._http.build_request("GET", info["url"]),
                                       stream=True, follow_redirects=True)
        upstream.raise_for_status()
    except httpx.HTTPError as e:
        await cv.aclose()
        return JSONResponse({"error": f"Couldn't download the file ({type(e).__name__})."},
                            status_code=502, headers=NO_STORE)

    async def body():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await cv.aclose()

    headers = {**NO_STORE, "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff"}
    if upstream.headers.get("content-length"):
        headers["Content-Length"] = upstream.headers["content-length"]
    media_type = "application/pdf" if kind == "pdf" else "text/plain; charset=utf-8"
    return StreamingResponse(body(), media_type=media_type, headers=headers)


@app.get("/api/page")
async def page_preview(course_id: int = Query(...), page_url: str = Query(..., max_length=300),
                       x_canvas_token: Optional[str] = Header(default=None)):
    """A CourseWorks page's content, with anything unsafe removed."""
    if not re.fullmatch(r"[\w.%~-]+", page_url):
        return JSONResponse({"error": "That isn't a valid page."}, status_code=400, headers=NO_STORE)
    cv = CanvasClient(_token_from(x_canvas_token))
    try:
        page = await cv.get_all(f"/courses/{course_id}/pages/{page_url}")
    except CanvasError as e:
        if e.status == 401 and await cv.safe("/users/self/profile") is None:
            raise NeedToken("That token didn't work. It may be mistyped, expired or revoked.")
        return JSONResponse({"error": "This page isn't available to you."}, status_code=404, headers=NO_STORE)
    except httpx.HTTPError as e:
        return JSONResponse({"error": f"Couldn't reach CourseWorks ({type(e).__name__})."},
                            status_code=502, headers=NO_STORE)
    finally:
        await cv.aclose()
    return JSONResponse({"title": page.get("title"), "html": sanitize(page.get("body"))}, headers=NO_STORE)


def lan_address():
    """This computer's address on the local network, or None if it can't be found."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # picks the network card to use; nothing is sent
            return s.getsockname()[0]
    except OSError:
        return None


def main():
    import uvicorn
    url = f"http://localhost:{PORT}"
    print(f"Better Canvas running at {url}  (Ctrl+C to stop)")
    if HOST == "0.0.0.0" and (ip := lan_address()) and not ip.startswith("127."):
        print(f"On other devices on the same network, open http://{ip}:{PORT}")
    if not os.environ.get("NO_BROWSER"):
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    # access_log off: requests aren't logged at all (the token would never be logged anyway)
    uvicorn.run(app, host=HOST, port=PORT, access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
