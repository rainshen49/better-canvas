// Where the page finds its API.
//   ""  → the same server that serves this page (running locally with `deno task start`).
//   On GitHub Pages this file is replaced when the site is published, with the
//   Edge Function's address, e.g. "https://abcd1234.supabase.co/functions/v1"
//   (set as the BETTER_CANVAS_API repository variable; see .github/workflows/pages.yml).
window.BETTER_CANVAS_API = "";
