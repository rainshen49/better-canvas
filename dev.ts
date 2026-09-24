// Run Better Canvas on this computer: serves the page (static/) and the API
// (the same code as the Supabase Edge Function) together.
//
//   deno task start          → opens http://localhost:8765
//
// Settings (environment variables): PORT (8765), HOST (0.0.0.0, so phones and
// other laptops on your network can open it; 127.0.0.1 allows only this
// computer), NO_BROWSER (don't open a browser tab), plus everything in
// supabase/functions/api/config.ts. Reading due dates are saved in
// reading_deadlines.db here, or in Postgres if DATABASE_URL is set.

import { DatabaseSync } from "node:sqlite";
import { handler } from "./supabase/functions/api/app.ts";
import { DATABASE_URL } from "./supabase/functions/api/config.ts";
import { type Row, SCHEMA, storeKind, useDatabase } from "./supabase/functions/api/store.ts";

const PORT = Number(Deno.env.get("PORT") ?? "8765");
const HOST = Deno.env.get("HOST") ?? "0.0.0.0";

// Without DATABASE_URL, save reading due dates in a SQLite file next to this one.
if (!DATABASE_URL) {
  const path = Deno.env.get("DEADLINES_DB") ?? new URL("./reading_deadlines.db", import.meta.url).pathname;
  useDatabase(() => {
    const file = new DatabaseSync(path);
    for (const statement of SCHEMA) file.exec(statement);
    return Promise.resolve({
      // SQLite calls finish immediately, so nothing else can run in the middle of a transaction.
      run(statements) {
        const many = statements.length > 1;
        if (many) file.exec("BEGIN");
        try {
          let rows: Row[] = [];
          for (const [text, params = []] of statements) {
            const statement = file.prepare(text);
            const values = params as (string | number | null)[];
            if (/^\s*select/i.test(text)) rows = statement.all(...values) as Row[];
            else statement.run(...values);
          }
          if (many) file.exec("COMMIT");
          return Promise.resolve(rows);
        } catch (e) {
          if (many) file.exec("ROLLBACK");
          return Promise.reject(e);
        }
      },
    });
  }, `SQLite (${path})`);
}

// The page's files. Only these are served, so nothing else in this folder is reachable.
const STATIC: Record<string, [file: string, type: string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/config.js": ["config.js", "text/javascript; charset=utf-8"],
};
const staticDir = new URL("./static/", import.meta.url);

async function serve(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname.startsWith("/api/")) return handler(req);
  const file = STATIC[pathname];
  if (!file || req.method !== "GET") return new Response("Not found", { status: 404 });
  let body = await Deno.readFile(new URL(file[0], staticDir));
  if (file[0] === "config.js") {
    // Here the API is on this same server, whatever config.js says for GitHub Pages.
    body = new TextEncoder().encode('window.BETTER_CANVAS_API = "";\n');
  }
  return new Response(body, { headers: { "Content-Type": file[1], "Cache-Control": "no-store" } });
}

/** This computer's address on the local network, if it has one. */
function lanAddress(): string | null {
  try {
    const net = Deno.networkInterfaces().find((n) => n.family === "IPv4" && !n.address.startsWith("127."));
    return net?.address ?? null;
  } catch {
    return null;
  }
}

Deno.serve({ hostname: HOST, port: PORT, onListen() {} }, serve);

const url = `http://localhost:${PORT}`;
console.log(`Better Canvas running at ${url}  (Ctrl+C to stop)`);
console.log(`Reading due dates are saved in ${storeKind()}.`);
const ip = HOST === "0.0.0.0" ? lanAddress() : null;
if (ip) console.log(`On other devices on the same network, open http://${ip}:${PORT}`);

if (!Deno.env.get("NO_BROWSER")) {
  const opener = Deno.build.os === "darwin" ? "open" : Deno.build.os === "windows" ? "explorer" : "xdg-open";
  setTimeout(() => {
    try {
      new Deno.Command(opener, { args: [url], stdout: "null", stderr: "null" }).spawn();
    } catch {
      // No browser to open (e.g. on a server); the address is printed above.
    }
  }, 800);
}
