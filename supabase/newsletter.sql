-- ════════════════════════════════════════════════════════════════════════
--  seniorsecured.org — newsletter signups
--
--  Paste this whole file into the Supabase SQL editor and run it once,
--  AFTER schema.sql and authors.sql. It is idempotent: running it again
--  is harmless.
--
--  What this adds
--  ───────────────
--  A name + email capture, reachable from the "Newsletter" control in the
--  masthead. Like reactions and events, public.subscribers carries no RLS
--  policies for anon — the only way in is subscribe_newsletter(), which
--  validates and de-duplicates. The author alone may read the list, for
--  when Fred is ready to actually send something with it; there is no
--  send pipeline here, just the capture.
-- ════════════════════════════════════════════════════════════════════════

create table if not exists public.subscribers (
  id          bigserial primary key,
  name        text not null,
  email       text not null unique,
  created_at  timestamptz not null default now()
);

comment on table public.subscribers is
  'Newsletter signups from the masthead dropdown. Write path is '
  'subscribe_newsletter() only; read is the allowlisted author only.';

alter table public.subscribers enable row level security;

-- No direct write policy exists for anyone — every insert goes through
-- subscribe_newsletter() below. Only an allowlisted author may read the list.
drop policy if exists subscribers_read_author on public.subscribers;
create policy subscribers_read_author on public.subscribers for select
  to authenticated using (public.is_author());

-- Sign up. De-duplicates on email (case-insensitive, since the column is
-- always stored lowercased here) and reports back whether this was a new
-- signup or an existing one, so the front end can still thank the visitor
-- either way without leaking who else is on the list.
create or replace function public.subscribe_newsletter(p_name text, p_email text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name    text := left(btrim(coalesce(p_name, '')), 100);
  v_email   text := lower(left(btrim(coalesce(p_email, '')), 200));
  v_inserted boolean;
begin
  if v_name = '' then
    raise exception 'Name is required';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address';
  end if;

  insert into public.subscribers (name, email)
  values (v_name, v_email)
  on conflict (email) do nothing;

  v_inserted := found;

  return jsonb_build_object('subscribed', true, 'is_new', v_inserted);
end $$;

revoke execute on function public.subscribe_newsletter(text, text) from public;
grant execute on function public.subscribe_newsletter(text, text) to anon, authenticated;

-- ── verify ─────────────────────────────────────────────────────────────
select count(*) as subscriber_count from public.subscribers;
