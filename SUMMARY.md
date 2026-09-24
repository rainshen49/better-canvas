# Better Canvas

A simpler view of Columbia CourseWorks: what's due soon and every class's slides and readings on one page, plus reading due dates shared with classmates.

## Features

**Due soon**
- Everything due in the next 14 days across your classes, grouped by day, with anything due within 2 days flagged.
- Click an item to see its full description, points, attempts and dates, attached files, and related course files (e.g. "HW02" finds `HW02.pdf`).
- Readings that classmates have given a due date show up in the list too, marked "All day".

**Readings without a due date**
- At the bottom of Due soon, each class lists its readings that nobody has dated yet.
- Give one a date with **+ Due date** (any of the next 7 days), or mark it **✓ Discussed** if it was covered in class and doesn't need one.
- Both are shared with everyone in the course, along with the name of whoever set them. Anyone can change them or undo.
- Changes show up instantly. If a change can't be saved, it's undone with a short message.

**Slides & readings**
- Every class's slides, readings and recordings, organized by module, with filters (Slides / Readings / Recordings / Other) and a search box.
- Click a file to preview it right in the page: PDFs, Word and PowerPoint files, images, videos, text files, CourseWorks pages and YouTube links.
- Download any file with the ⬇ icon.
- Shortcuts to each class's Echo360, Video Library, Ed and Zoom.

**Other**
- Log in once with a CourseWorks access token. Your browser remembers it until you log out.
- Works on phones, and follows your system's light or dark mode.

## How to run it on your computer

1. Install Deno once: `brew install deno`
2. Start the app:
   ```bash
   cd ~/Desktop/dev/canvas
   deno task start
   ```
3. It opens http://localhost:8765. To log in, create a token in CourseWorks (**Account → Settings → + New Access Token**) and paste it in.

Stop it with Ctrl+C. When run this way, reading due dates are saved in `reading_deadlines.db` in this folder, separate from the shared online version.

## What it's built on

- **GitHub** holds the code, and **GitHub Pages** hosts the page people open (https://rainshen49.github.io/better-canvas/). Pushing to `main` republishes the page automatically.
- **Supabase** runs the part that talks to CourseWorks (an Edge Function called `api`) and stores everyone's shared reading due dates in its database. After changing that code, update it with `supabase functions deploy api`.
- **CourseWorks** is where all the course information comes from. Each person uses their own token, which is only sent to CourseWorks and never saved.
