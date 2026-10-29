-- ════════════════════════════════════════════════════════════════════════
--  seniorsecured.org — a featured piece for the home page
--
--  Paste this whole file into the Supabase SQL editor and run it once,
--  AFTER post-images.sql. It is idempotent: running it again is harmless.
--
--  The home page opens the featured piece when there is one, and the
--  newest piece otherwise. The "Latest publishings" list stays newest
--  first either way. At most one piece is featured at a time, and only an
--  allowlisted author may change which.
-- ════════════════════════════════════════════════════════════════════════

-- ── guard ──────────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.is_author()') is null then
    raise exception 'public.is_author() not found — run supabase/authors.sql first';
  end if;
end $$;

-- ── the column ─────────────────────────────────────────────────────────
alter table public.posts add column if not exists featured boolean not null default false;

comment on column public.posts.featured is
  'True for the one piece the home page opens instead of the newest. '
  'Set only through set_featured().';

-- The database, not the page, keeps it to one.
create unique index if not exists posts_one_featured on public.posts (featured) where featured;

-- ── changing it ────────────────────────────────────────────────────────
-- One call clears the old feature and sets the new one, so the home page
-- never sees two or a gap. p_id null = stop featuring; the home page goes
-- back to the newest piece. Only a published piece can be featured.
create or replace function public.set_featured(p_id int)
returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_author() then
    raise exception 'Only an author can choose the featured piece';
  end if;
  if p_id is not null and not exists
       (select 1 from public.posts where id = p_id and status = 'published') then
    raise exception 'Only a published piece can be featured';
  end if;
  update public.posts set featured = false where featured and id is distinct from p_id;
  if p_id is not null then
    update public.posts set featured = true where id = p_id and not featured;
  end if;
end $$;

revoke execute on function public.set_featured(int) from public;
grant  execute on function public.set_featured(int) to authenticated;

-- ════════════════════════════════════════════════════════════════════════
--  READ PATHS — both now say which piece is featured
-- ════════════════════════════════════════════════════════════════════════

-- A new output column changes list_posts' return type, so it is dropped
-- and rebuilt, and its grants restored below. Same as post-images.sql
-- plus `featured`.
drop function if exists public.list_posts(boolean);

create function public.list_posts(include_drafts boolean default false)
returns table (
  id int, slug text, title text, subtitle text, body text, author text,
  status text, published_at timestamptz,
  hero_url text, hero_alt text, featured boolean,
  word_count int, read_minutes int,
  reaction_count int, comment_count int, view_count int
)
language sql stable security definer set search_path = public as $$
  select p.id, p.slug, p.title, p.subtitle, p.body, p.author,
         p.status, p.published_at,
         p.hero_url, p.hero_alt, p.featured,
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

revoke execute on function public.list_posts(boolean) from public;
grant  execute on function public.list_posts(boolean) to anon, authenticated;

-- get_post returns jsonb, so one extra key needs no signature change.
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
      'hero_url',     v_post.hero_url,
      'hero_alt',     v_post.hero_alt,
      'featured',     v_post.featured,
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

-- ── verify ─────────────────────────────────────────────────────────────
-- Expect: the featured column, set_featured callable by authenticated,
-- list_posts callable by anon and authenticated, and 0 featured pieces.
select 'column' as check, column_name || ' ' || data_type as result
  from information_schema.columns
 where table_schema = 'public' and table_name = 'posts' and column_name = 'featured'
union all
select 'set_featured grants', string_agg(grantee, ', ' order by grantee)
  from information_schema.routine_privileges
 where routine_schema = 'public' and routine_name = 'set_featured'
union all
select 'list_posts grants', string_agg(grantee, ', ' order by grantee)
  from information_schema.routine_privileges
 where routine_schema = 'public' and routine_name = 'list_posts'
union all
select 'featured pieces', count(*)::text from public.posts where featured;
