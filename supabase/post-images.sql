-- ════════════════════════════════════════════════════════════════════════
--  seniorsecured.org — cover images for articles
--
--  Paste this whole file into the Supabase SQL editor and run it once,
--  AFTER schema.sql and authors.sql. It is idempotent: running it again is
--  harmless.
--
--  Adds one optional cover image per post. The file lives in Supabase
--  Storage; the posts row keeps only its public URL and alt text.
--
--  Who may do what, unchanged in spirit from authors.sql: the world may
--  READ every image in the bucket (they appear on a public website, so
--  they are public by definition); only an allowlisted author may upload,
--  replace or delete one.
-- ════════════════════════════════════════════════════════════════════════

-- ── guard ──────────────────────────────────────────────────────────────
-- Everything below leans on the allowlist. Fail early and clearly rather
-- than create storage policies that silently permit nobody.
do $$
begin
  if to_regprocedure('public.is_author()') is null then
    raise exception 'public.is_author() not found — run supabase/authors.sql first';
  end if;
end $$;

-- ── the columns ────────────────────────────────────────────────────────
-- hero_url is the full public URL, not a storage path: it is what the
-- <img> and the og:image tag need, and keeping it whole means the render
-- path never has to know Supabase exists.
alter table public.posts add column if not exists hero_url text;
alter table public.posts add column if not exists hero_alt text;

comment on column public.posts.hero_url is
  'Public URL of the cover image, or null. Written by the composer after '
  'upload to the post-images bucket.';
comment on column public.posts.hero_alt is
  'Alt text for the cover image. Falls back to the post title on render.';

-- ── the bucket ─────────────────────────────────────────────────────────
-- public = true makes objects readable over the CDN URL without a token,
-- which is what a public website wants. Write access is the part that
-- matters, and that is governed by the policies below.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
     values ('post-images', 'post-images', true, 5242880,
             array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update
        set public             = true,
            file_size_limit    = 5242880,
            allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif'];

-- ── who may touch the files ────────────────────────────────────────────
-- The composer downscales before upload, so 5 MB is a backstop against a
-- raw camera file rather than an expected size. The mime allowlist above
-- is enforced by Storage itself, so an author cannot turn the bucket into
-- a file drop by renaming a .zip.
drop policy if exists post_images_public_read on storage.objects;
drop policy if exists post_images_author_ins  on storage.objects;
drop policy if exists post_images_author_upd  on storage.objects;
drop policy if exists post_images_author_del  on storage.objects;

create policy post_images_public_read on storage.objects for select
  using (bucket_id = 'post-images');

create policy post_images_author_ins on storage.objects for insert
  to authenticated with check (bucket_id = 'post-images' and public.is_author());

create policy post_images_author_upd on storage.objects for update
  to authenticated
  using (bucket_id = 'post-images' and public.is_author())
  with check (bucket_id = 'post-images' and public.is_author());

create policy post_images_author_del on storage.objects for delete
  to authenticated using (bucket_id = 'post-images' and public.is_author());

-- ════════════════════════════════════════════════════════════════════════
--  READ PATHS — both must now carry the cover image
-- ════════════════════════════════════════════════════════════════════════

-- list_posts gains two output columns. That changes the function's return
-- type, which `create or replace` cannot do, so it has to be dropped and
-- rebuilt — and dropping takes its grants with it. They are restored at
-- the bottom of this file.
drop function if exists public.list_posts(boolean);

create function public.list_posts(include_drafts boolean default false)
returns table (
  id int, slug text, title text, subtitle text, body text, author text,
  status text, published_at timestamptz,
  hero_url text, hero_alt text,
  word_count int, read_minutes int,
  reaction_count int, comment_count int, view_count int
)
language sql stable security definer set search_path = public as $$
  select p.id, p.slug, p.title, p.subtitle, p.body, p.author,
         p.status, p.published_at,
         p.hero_url, p.hero_alt,
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

-- get_post returns jsonb, so two extra keys need no signature change and
-- its grants survive.
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

-- ── restore the grants dropped with list_posts ─────────────────────────
revoke execute on function public.list_posts(boolean) from public;
grant  execute on function public.list_posts(boolean) to anon, authenticated;

-- ── verify ─────────────────────────────────────────────────────────────
-- Expect: two hero_ columns, the bucket marked public, four storage
-- policies, and list_posts callable by anon and authenticated.
select 'columns' as check, string_agg(column_name, ', ' order by column_name) as result
  from information_schema.columns
 where table_schema = 'public' and table_name = 'posts' and column_name like 'hero%'
union all
select 'bucket', id || ' (public=' || public || ', limit=' || file_size_limit || ')'
  from storage.buckets where id = 'post-images'
union all
select 'storage policies', string_agg(policyname, ', ' order by policyname)
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects' and policyname like 'post_images%'
union all
select 'list_posts grants', string_agg(grantee, ', ' order by grantee)
  from information_schema.routine_privileges
 where routine_schema = 'public' and routine_name = 'list_posts';
