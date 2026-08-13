/* ─────────────────────────────────────────────────────────────────────
   Supabase connection details.

   Both values are safe to commit and safe to serve publicly — the anon
   key is a *publishable* key. Every rule that matters is enforced in the
   database by row-level security and the security-definer functions in
   supabase/schema.sql, not here.

   Find them in your Supabase project under
   Settings → API → Project URL and Project API keys → anon / public.
   ───────────────────────────────────────────────────────────────────── */
window.SUPABASE_URL      = 'https://YOUR-PROJECT-REF.supabase.co';
window.SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
