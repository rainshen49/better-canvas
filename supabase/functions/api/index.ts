// Supabase Edge Function entry point. Deploy with:
//   supabase functions deploy api
// (supabase/config.toml turns off Supabase's own login check for this function:
// visitors sign in with their CourseWorks token instead.)

import { handler } from "./app.ts";

Deno.serve(handler);
