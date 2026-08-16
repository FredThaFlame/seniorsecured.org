-- ════════════════════════════════════════════════════════════════════════
--  seniorsecured.org — author allowlist
--
--  Paste this whole file into the Supabase SQL editor and run it once,
--  AFTER schema.sql. It is idempotent: running it again is harmless.
--
--  Why this exists
--  ───────────────
--  schema.sql answers "may this caller publish?" with
--  `auth.role() = 'authenticated'` — that is, *anyone holding a valid
--  login*. Combined with open signups, any stranger who registers gets
--  author rights: publish, edit, delete, and the analytics dashboard.
--
--  This file replaces that test with membership of an explicit allowlist.
--  Being signed in is no longer enough; you must be named in
--  public.authors. Signups can stay open or closed — an account that is
--  not on the list can do nothing a logged-out reader cannot.
--
--  Trust model, restated: readers may read published posts and approved
--  comments and write only through the four public functions; everything
--  else requires a signed-in account that is ON THE ALLOWLIST.
-- ════════════════════════════════════════════════════════════════════════

-- ── the allowlist ──────────────────────────────────────────────────────
-- Keyed on the auth user's id, not their email. An email is a label that
-- can be changed by whoever controls the mailbox; the uuid cannot.
create table if not exists public.authors (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  email     text,                       -- for humans reading the table
  note      text,                       -- e.g. 'site owner', 'manager'
  added_at  timestamptz not null default now()
);

comment on table public.authors is
  'Allowlist of accounts permitted to publish and view analytics. '
  'Managed from the SQL editor or table editor only — the browser has no '
  'write path to this table.';

-- ── the test every rule below hangs off ────────────────────────────────
-- security definer so it can read public.authors regardless of that
-- table's own RLS. Returns false for anonymous callers, never null.
create or replace function public.is_author()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.authors a where a.user_id = auth.uid()
  );
$$;

comment on function public.is_author() is
  'True when the caller is signed in AND on the author allowlist.';

-- ── locking down the allowlist itself ──────────────────────────────────
-- An author may see their own row, which is what lets the front end ask
-- "am I an author?" without a function call. Nobody can write through
-- PostgREST: there are no insert/update/delete policies, and RLS denies
-- anything a policy does not explicitly permit.
alter table public.authors enable row level security;

drop policy if exists authors_read_self on public.authors;
create policy authors_read_self on public.authors for select
  to authenticated using (user_id = auth.uid());

grant select on public.authors to authenticated;

-- ════════════════════════════════════════════════════════════════════════
--  REPLACED POLICIES  —  same shape as schema.sql, allowlist instead of
--  bare `authenticated`
-- ════════════════════════════════════════════════════════════════════════

-- posts: the world reads published pieces; allowlisted authors do everything.
drop policy if exists posts_read       on public.posts;
drop policy if exists posts_author_ins on public.posts;
drop policy if exists posts_author_upd on public.posts;
drop policy if exists posts_author_del on public.posts;

create policy posts_read on public.posts for select
  using (status = 'published' or public.is_author());
create policy posts_author_ins on public.posts for insert
  to authenticated with check (public.is_author());
create policy posts_author_upd on public.posts for update
  to authenticated using (public.is_author()) with check (public.is_author());
create policy posts_author_del on public.posts for delete
  to authenticated using (public.is_author());

-- comments: approved ones are public; moderation is an author's job.
drop policy if exists comments_read       on public.comments;
drop policy if exists comments_author_upd on public.comments;
drop policy if exists comments_author_del on public.comments;

create policy comments_read on public.comments for select
  using (approved = true or public.is_author());
create policy comments_author_upd on public.comments for update
  to authenticated using (public.is_author()) with check (public.is_author());
create policy comments_author_del on public.comments for delete
  to authenticated using (public.is_author());

-- ════════════════════════════════════════════════════════════════════════
--  REPLACED FUNCTIONS  —  bodies identical to schema.sql except for the
--  authorisation test. Signatures unchanged, so the grants at the bottom
--  of schema.sql still apply.
-- ════════════════════════════════════════════════════════════════════════

-- Drafts are visible only to an allowlisted author.
create or replace function public.list_posts(include_drafts boolean default false)
returns table (
  id int, slug text, title text, subtitle text, body text, author text,
  status text, published_at timestamptz,
  word_count int, read_minutes int,
  reaction_count int, comment_count int, view_count int
)
language sql stable security definer set search_path = public as $$
  select p.id, p.slug, p.title, p.subtitle, p.body, p.author,
         p.status, p.published_at,
         public.word_count(p.body),
         public.read_minutes(p.body),
         (select count(*)::int from public.reactions r where r.post_id = p.id),
         (select count(*)::int from public.comments  c where c.post_id = p.id and c.approved),
         (select count(*)::int from public.events    e where e.post_id = p.id and e.type = 'view')
    from public.posts p
   where p.status = 'published'
      or (include_drafts and public.is_author())
   order by p.published_at desc;
$$;

-- A draft returns null unless the caller is an allowlisted author.
create or replace function public.get_post(p_slug text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_post public.posts;
begin
  select * into v_post from public.posts where slug = p_slug;
  if not found then return null; end if;
  if v_post.status <> 'published' and not public.is_author() then
    return null;
  end if;

  return jsonb_build_object(
    'post', jsonb_build_object(
      'id',           v_post.id,
      'slug',         v_post.slug,
      'title',        v_post.title,
      'subtitle',     v_post.subtitle,
      'body',         v_post.body,
      'author',       v_post.author,
      'status',       v_post.status,
      'published_at', v_post.published_at,
      'word_count',   public.word_count(v_post.body),
      'read_minutes', public.read_minutes(v_post.body)),
    'reactions', (
      select jsonb_build_object(
        'heart', count(*) filter (where kind = 'heart'),
        'thumb', count(*) filter (where kind = 'thumb'),
        'bulb',  count(*) filter (where kind = 'bulb'))
        from public.reactions where post_id = v_post.id),
    'comments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'body', c.body, 'created_at', c.created_at)
        order by c.created_at)
        from public.comments c
       where c.post_id = v_post.id and c.approved), '[]'::jsonb));
end $$;

-- ── the dashboard gate ─────────────────────────────────────────────────
-- analytics() is long and its body is untouched, so rather than restate
-- it we swap only the guard clause. This re-reads the function's current
-- source and rewrites the single authorisation line, then executes it —
-- which keeps this file correct even if analytics() is edited later.
do $$
declare v_src text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'analytics';

  if v_src is null then
    raise exception 'public.analytics() not found — run schema.sql first';
  end if;

  if position('auth.role() <> ''authenticated''' in v_src) = 0 then
    if position('not public.is_author()' in v_src) > 0 then
      raise notice 'analytics() already gated on the allowlist — leaving it alone';
      return;
    end if;
    raise exception
      'analytics() guard clause not recognised; gate it on public.is_author() by hand';
  end if;

  v_src := replace(v_src,
                   'auth.role() <> ''authenticated''',
                   'not public.is_author()');
  execute v_src;
  raise notice 'analytics() now gated on public.is_author()';
end $$;

-- ════════════════════════════════════════════════════════════════════════
--  SEED THE ALLOWLIST
--
--  ► EDIT THE TWO ADDRESSES BELOW, then run.
--
--  Each account must already exist under Authentication → Users. This
--  block does not create logins; it grants author rights to logins that
--  are already there. An address with no matching user is reported and
--  skipped, so a typo fails loudly instead of silently locking you out.
-- ════════════════════════════════════════════════════════════════════════
do $$
declare
  v_wanted constant text[] := array[
    'FFlamer29@gmail.com',             -- ← Fred, site owner
    'Charles2025business@gmail.com'    -- ← manager
  ];
  v_email    text;
  v_id       uuid;
  v_found    int := 0;
  v_missing  text[] := '{}';
  v_existing text;
begin
  foreach v_email in array v_wanted loop
    select id into v_id
      from auth.users
     where lower(email) = lower(trim(v_email))
     limit 1;

    if v_id is null then
      v_missing := v_missing || v_email;
    else
      insert into public.authors (user_id, email, note)
           values (v_id, lower(trim(v_email)), 'seeded by authors.sql')
      on conflict (user_id) do update set email = excluded.email;
      v_found := v_found + 1;
    end if;
  end loop;

  -- The Supabase SQL editor does not surface NOTICE or WARNING output, so
  -- everything worth reading has to travel in the exception message.
  if v_found = 0 then
    select coalesce(string_agg(email, ', ' order by created_at), '(none — auth.users is empty)')
      into v_existing from auth.users;

    raise exception
      'allowlist is empty — nobody can publish, so nothing was applied.'
      using detail  = format('wanted: %s | accounts that actually exist: %s',
                             array_to_string(v_wanted, ', '), v_existing),
            hint    = 'Create the accounts under Authentication → Users with '
                      '"Auto Confirm User" ticked, then re-run this file.';
  end if;

  if array_length(v_missing, 1) > 0 then
    raise exception
      'partial allowlist — refusing to apply, or the missing person is locked out.'
      using detail = format('granted: %s of %s | no account for: %s',
                            v_found, array_length(v_wanted, 1),
                            array_to_string(v_missing, ', ')),
            hint   = 'Create the missing account, then re-run. To proceed with '
                     'fewer authors, remove that address from v_wanted above.';
  end if;
end $$;

-- ── verify ─────────────────────────────────────────────────────────────
-- Should return exactly the two people. Anything else, stop and read it.
select a.email, a.note, a.added_at, u.last_sign_in_at
  from public.authors a
  join auth.users u on u.id = a.user_id
 order by a.added_at;
