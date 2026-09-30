// Talking to CourseWorks (one client per request to this app).

import { BASE, CONCURRENCY } from "./config.ts";

export class CanvasError extends Error {
  constructor(public status: number, message: string) {
    super(`${status}: ${message}`);
  }
}

/** A full CourseWorks address for a link that may be relative ("/courses/1/…"). */
export function absUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith("http") ? url : BASE + url;
}

/**
 * Lets at most `limit` tasks run at once. Waiting tasks marked `urgent` start
 * before the others, so "Due soon" isn't stuck behind every course's files.
 */
function limiter(limit: number) {
  let running = 0;
  const urgentQueue: (() => void)[] = [];
  const queue: (() => void)[] = [];
  return async <T>(task: () => Promise<T>, urgent = false): Promise<T> => {
    if (running < limit) running++;
    else await new Promise<void>((resolve) => (urgent ? urgentQueue : queue).push(resolve));
    try {
      return await task();
    } finally {
      // Hand this slot straight to the next task, so nothing can sneak in between.
      const next = urgentQueue.shift() ?? queue.shift();
      if (next) next();
      else running--;
    }
  };
}

type Params = Record<string, string | number | (string | number)[]>;

function withParams(url: string, params: Params): string {
  const u = new URL(url);
  for (const [name, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : [value]) u.searchParams.append(name, String(v));
  }
  return u.toString();
}

/** The "next page" address from a Link header, if there is one. */
function nextLink(header: string | null): string | null {
  for (const part of (header ?? "").split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Talks to CourseWorks for a single request to this app (loading the page,
 * opening a preview, saving a due date…). The token lives only inside this
 * object, which is dropped when that request finishes. It is never saved,
 * shared between requests, or logged.
 */
export class CanvasClient {
  #token: string;
  #limit = limiter(CONCURRENCY);
  /** Aborts every request still running, e.g. when the browser closes the page mid-load. */
  readonly abort = new AbortController();

  constructor(token: string) {
    this.#token = token;
  }

  #headers() {
    return {
      Authorization: `Bearer ${this.#token}`,
      Accept: "application/json",
      "User-Agent": "better-canvas/3.0",
    };
  }

  /**
   * Fetch something from CourseWorks. Lists that come in several pages are
   * fetched page by page (up to 50) and combined. `urgent` requests skip ahead
   * of the others waiting their turn.
   */
  async getAll(path: string, params: Params = {}, urgent = false): Promise<any> {
    let url: string | null = withParams(`${BASE}/api/v1${path}`, { per_page: 100, ...params });
    const out: unknown[] = [];
    for (let page = 0; page < 50 && url; page++) {
      const response: Response = await this.#limit(
        () => fetch(url!, { headers: this.#headers(), signal: this.abort.signal }),
        urgent,
      );
      if (response.status >= 400) {
        throw new CanvasError(response.status, (await response.text()).slice(0, 200));
      }
      const data = await response.json();
      if (!Array.isArray(data)) return data;
      out.push(...data);
      url = nextLink(response.headers.get("link")); // the next page's address already includes the options
    }
    return out;
  }

  /** Like getAll, but returns null instead of failing, e.g. when a course hides its Files tab from students. */
  async safe(path: string, params: Params = {}, urgent = false): Promise<any> {
    try {
      return await this.getAll(path, params, urgent);
    } catch (e) {
      if (this.abort.signal.aborted) throw e;
      return null;
    }
  }

  /**
   * Where a CourseWorks link that needs the token forwards to (e.g. a file's
   * preview link forwards to a document viewer link that doesn't need it).
   * Followed here so the token never leaves this server.
   */
  async redirectTarget(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, { headers: this.#headers(), redirect: "manual" });
      await response.body?.cancel();
      return response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    } catch {
      return null;
    }
  }

  /**
   * Download a file from CourseWorks. The token is sent only to CourseWorks
   * itself, never to the separate file-storage server its download links forward to.
   */
  async download(url: string): Promise<Response> {
    const home = new URL(BASE).origin;
    for (let hop = 0; hop < 6; hop++) {
      const sameSite = new URL(url).origin === home;
      const response = await fetch(url, {
        headers: sameSite ? this.#headers() : { "User-Agent": "better-canvas/3.0" },
        redirect: "manual",
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        url = new URL(location, url).toString();
        continue;
      }
      return response;
    }
    throw new Error("too many redirects");
  }
}
