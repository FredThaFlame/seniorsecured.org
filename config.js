/* ─────────────────────────────────────────────────────────────────────
   Supabase connection details.

   Both values are safe to commit and safe to serve publicly — the anon
   key is a *publishable* key. Every rule that matters is enforced in the
   database by row-level security and the security-definer functions in
   supabase/schema.sql, not here.

   Find them in your Supabase project under
   Settings → API → Project URL and Project API keys → anon / public.

   Note on key format: this project uses the legacy JWT-style anon key,
   which is what supabase-js 2.58.0 (pinned in index.html) expects and
   what the keepalive fetch in track() sends as a bearer token. The newer
   `sb_publishable_…` key was tested against this project and also works;
   swapping to it is a one-line change if the legacy key is ever retired.
   ───────────────────────────────────────────────────────────────────── */
window.SUPABASE_URL      = 'https://vhpjbdkdliqgvsjmebos.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZocGpiZGtkbGlxZ3Zzam1lYm9zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2NDk2MjcsImV4cCI6MjEwMjIyNTYyN30.wnMD0e2I-Bv-WaSqWIMAGEfDjfi5LYNd7IEevMgqhrs';
