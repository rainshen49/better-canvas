# Better Canvas

A simpler view of Columbia CourseWorks. CourseWorks spreads a class across modules, pages, files and the syllabus, and never says when readings are due. Better Canvas puts what matters on one page:

- **What's due soon** across all your classes, with each assignment's details and the course files that go with it.
- **Every class's slides, readings and recordings** in one place, searchable and previewable without leaving the page.
- **Reading due dates, shared with classmates.** Professors rarely put readings on the calendar, so anyone in a course can date a reading (or mark it as not needing one) and everyone else sees it.

Each person logs in with their own CourseWorks access token.

## Run it on your computer

```bash
brew install deno        # once
cd ~/Desktop/dev/canvas
deno task start          # opens http://localhost:8765
```

To log in, create a token in CourseWorks (**Account → Settings → + New Access Token**) and paste it in. Locally, reading due dates are saved in `reading_deadlines.db`, separate from the shared online version. Settings are listed at the top of `dev.ts` and in `supabase/functions/api/config.ts`.

## How it's hosted

- **GitHub Pages** serves the page (https://rainshen49.github.io/better-canvas/). Pushing changes to `static/` on `main` republishes it.
- **Supabase** runs the server (an Edge Function called `api`) that talks to CourseWorks, and stores the shared reading due dates. Deploy changes with `deno task deploy`.
- **Privacy:** the token stays in the person's browser and is only used by the server to talk to CourseWorks; it's never saved or logged. For usage stats, the server records each person's name and when they last opened the app.

## iPhone app

`ios/` has a native SwiftUI version of the page: the same "Due soon" and "Slides & readings" tabs, previews for files and pages, and shared reading due dates. It talks to the same hosted server as the web page.

1. Open `ios/BetterCanvas.xcodeproj` in Xcode and run it. To put it on your own iPhone, pick your team under **Signing & Capabilities**.
2. The server address isn't in the source. Copy `ios/Config.local.example.xcconfig` to `ios/Config.local.xcconfig` (ignored by git) and put your Supabase project's address in it (the same address as `BETTER_CANVAS_API` above). Without that file the app shows an error instead of loading.
3. Log in with a CourseWorks access token, as on the web. It's kept in the iPhone's Keychain.

