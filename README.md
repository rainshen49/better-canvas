# Better Canvas

A simpler view of Columbia CourseWorks. CourseWorks spreads a class across modules, pages, files and the syllabus, and never says when readings are due. Better Canvas puts what matters on one page:

- **What's due soon** across all your classes, with each assignment's details and the course files that go with it.
- **Every class's slides, readings and recordings** in one place, searchable and previewable without leaving the page.
- **Reading due dates, shared with classmates.** Professors rarely put readings on the calendar, so anyone in a course can date a reading (or mark it as not needing one) and everyone else sees it.
- **Short notes, shared with classmates.** Open any assignment, quiz, discussion, page or reading on the Due soon tab and add a note of up to 149 characters (a tip, a warning, which pages matter). A small 💬 beside the title shows which items have one. Everyone in the class sees the note when they open that item, and anyone can edit or delete it. The iPhone app doesn't show notes yet.

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
- **Supabase** runs the server (an Edge Function called `api`) that talks to CourseWorks, and stores the shared reading due dates and notes. Deploy changes with `deno task deploy`.
- **Privacy:** the token stays in the person's browser and is only used by the server to talk to CourseWorks; it's never saved or logged. For usage stats, the server records each person's name and when they last opened the app.

## iPhone app

The `ios/` folder holds an iPhone version of the same page. It uses the same server and the same shared reading dates as the website, so what you or a classmate sets in one shows up in the other.

**What you see**

- **Due soon.** Everything due in the next three weeks, grouped by day. Items you've already submitted shrink to a single crossed-out line at the bottom of their day. Tap an item for its description, points, how to submit, open and close dates, attached files, and any course files that look related (for example, "HW2.pdf" for "Homework 2"). Below the list, **Readings without a due date** lists each class's readings that nobody has dated yet.
- **Slides & readings.** Every class, with how many slides and readings it has. Tap a class to see its links, modules and files. Use the search box to search all classes at once, and the filter button to show only slides, readings, recordings or other. Orientation and career sites are tucked into an **Other sites** group.
- **Previews.** Tapping a PDF, document, image, video or page opens it inside the app. Files that can't be previewed open in CourseWorks instead, and the download button on a file's row downloads it.
- **Reading due dates.** Under any reading, tap **+ Due date** and pick one of the next ten weekdays. Everyone in the class sees it, along with who added it. On the Due soon tab you can also hide a reading you don't need a date for (say, one covered in class), and bring it back later. Changes show up straight away and are undone if the server can't save them.

**How loading works**

- When you open the app, it shows the copy it saved last time (up to a day old, and only if that load finished cleanly) while it fetches fresh data. A banner at the top shows progress. Pull down on either tab, or use the person icon, to refresh.
- If part of a load fails, such as one class or a piece of data the app can't read, the banner stays up and says so, and that load isn't saved for next time.

**Logging in and your data**

- Create a token in CourseWorks (**Account → Settings → + New Access Token**), then paste it into the app. The login screen has a link to the right page.
- The token is kept in the iPhone's secure storage (the Keychain), so you stay logged in. The app sends it to the Better Canvas server with each request, only so the server can read CourseWorks for you.
- **Log out** (person icon) removes the token and the saved copy from the phone.

**Setting it up (for whoever builds the app)**

1. Open `ios/BetterCanvas.xcodeproj` in Xcode and press Run. To put it on your own iPhone, choose your team under **Signing & Capabilities**.
2. The app needs the address of the Better Canvas server, which isn't kept in the source. Copy `ios/Config.local.example.xcconfig` to `ios/Config.local.xcconfig` and put your Supabase project's address in it (the same address as `BETTER_CANVAS_API` above). That file stays on your computer and isn't saved to git. Without it, the app shows an error instead of loading.
