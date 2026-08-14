-- ════════════════════════════════════════════════════════════════════════
--  seniorsecured.org — full Supabase schema
--
--  Paste this whole file into the Supabase SQL editor and run it once.
--  It is idempotent: running it again is harmless.
--
--  The browser talks to Postgres directly through PostgREST using the
--  publishable "anon" key. That key is public by design — every rule that
--  matters is enforced here, by row-level security and by the security-
--  definer functions below.
--
--  Trust model, in one line: readers may read published posts and approved
--  comments, and may write only through the four functions at the bottom;
--  everything else requires a signed-in author.
-- ════════════════════════════════════════════════════════════════════════

-- ── tables ─────────────────────────────────────────────────────────────
create table if not exists public.posts (
  id            serial primary key,
  slug          text not null unique,
  title         text not null,
  subtitle      text,
  body          text not null,
  author        text not null default 'Fred Flamer',
  status        text not null default 'published'
                  check (status in ('published','draft')),
  published_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.comments (
  id          serial primary key,
  post_id     integer not null references public.posts(id) on delete cascade,
  name        text not null,
  body        text not null,
  visitor_id  text,
  approved    boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.reactions (
  post_id     integer not null references public.posts(id) on delete cascade,
  visitor_id  text not null,
  kind        text not null check (kind in ('heart','thumb','bulb')),
  created_at  timestamptz not null default now(),
  primary key (post_id, visitor_id, kind)
);

-- One row per tracked interaction. type: view | depth | dwell | share
create table if not exists public.events (
  id          bigserial primary key,
  post_id     integer references public.posts(id) on delete cascade,
  visitor_id  text not null,
  session_id  text,
  type        text not null,
  value       numeric,
  referrer    text,
  device      text,
  created_at  timestamptz not null default now()
);

create index if not exists events_post_created_idx on public.events (post_id, created_at desc);
create index if not exists events_type_created_idx on public.events (type, created_at desc);
create index if not exists comments_post_idx       on public.comments (post_id, created_at desc);

-- One "view" row per session per post — keeps refreshes from inflating counts.
create unique index if not exists events_view_once_idx
  on public.events (post_id, session_id) where type = 'view';
-- One row per depth milestone per session.
create unique index if not exists events_depth_once_idx
  on public.events (post_id, session_id, value) where type = 'depth';
-- One dwell row per session, holding that session's high-water reading time.
create unique index if not exists events_dwell_once_idx
  on public.events (post_id, session_id) where type = 'dwell';

-- ── small helpers ──────────────────────────────────────────────────────
create or replace function public.slugify(txt text)
returns text language sql immutable as $$
  select coalesce(
    nullif(
      left(
        trim(both '-' from
          regexp_replace(
            regexp_replace(lower(coalesce(txt, '')), '[^a-z0-9]+', '-', 'g'),
            '-{2,}', '-', 'g')),
        70),
      ''),
    'post');
$$;

create or replace function public.word_count(body text)
returns int language sql immutable as $$
  select case
    when btrim(coalesce(body, '')) = '' then 0
    else coalesce(array_length(regexp_split_to_array(btrim(body), '\s+'), 1), 0)
  end;
$$;

create or replace function public.read_minutes(body text)
returns int language sql immutable as $$
  select greatest(1, round(public.word_count(body) / 220.0))::int;
$$;

-- Fills in a unique slug on insert, and keeps updated_at honest.
create or replace function public.posts_before_write()
returns trigger language plpgsql as $$
declare
  v_base text;
  v_try  text;
  v_n    int := 2;
begin
  if new.slug is null or btrim(new.slug) = '' then
    v_base := public.slugify(new.title);
    v_try  := v_base;
    while exists (select 1 from public.posts p
                   where p.slug = v_try and p.id is distinct from new.id) loop
      v_try := v_base || '-' || v_n;
      v_n   := v_n + 1;
    end loop;
    new.slug := v_try;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists posts_before_write on public.posts;
create trigger posts_before_write
  before insert or update on public.posts
  for each row execute function public.posts_before_write();

-- ── row-level security ─────────────────────────────────────────────────
alter table public.posts     enable row level security;
alter table public.comments  enable row level security;
alter table public.reactions enable row level security;
alter table public.events    enable row level security;

-- posts: the world reads published pieces; the author does everything.
drop policy if exists posts_read       on public.posts;
drop policy if exists posts_author_ins on public.posts;
drop policy if exists posts_author_upd on public.posts;
drop policy if exists posts_author_del on public.posts;

create policy posts_read on public.posts for select
  using (status = 'published' or auth.role() = 'authenticated');
create policy posts_author_ins on public.posts for insert
  to authenticated with check (true);
create policy posts_author_upd on public.posts for update
  to authenticated using (true) with check (true);
create policy posts_author_del on public.posts for delete
  to authenticated using (true);

-- comments: approved ones are public to read; writes go through add_comment().
drop policy if exists comments_read       on public.comments;
drop policy if exists comments_author_del on public.comments;
drop policy if exists comments_author_upd on public.comments;

create policy comments_read on public.comments for select
  using (approved = true or auth.role() = 'authenticated');
create policy comments_author_upd on public.comments for update
  to authenticated using (true) with check (true);
create policy comments_author_del on public.comments for delete
  to authenticated using (true);

-- reactions and events carry no policies at all, so no direct access is
-- possible from the browser. They are reachable only through the
-- security-definer functions below, which is where the rules live.

-- ════════════════════════════════════════════════════════════════════════
--  READ PATHS
-- ════════════════════════════════════════════════════════════════════════

-- The sidebar + home page. Drafts only for a signed-in author.
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
      or (include_drafts and auth.role() = 'authenticated')
   order by p.published_at desc;
$$;

-- One piece, with its reaction tally and approved comments. Null if missing
-- or if it is a draft and the caller is not the author.
create or replace function public.get_post(p_slug text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_post public.posts;
begin
  select * into v_post from public.posts where slug = p_slug;
  if not found then return null; end if;
  if v_post.status <> 'published' and auth.role() <> 'authenticated' then
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

-- ════════════════════════════════════════════════════════════════════════
--  WRITE PATHS  (the only way a reader may write anything)
-- ════════════════════════════════════════════════════════════════════════

-- Toggle one reaction for one visitor. Returns the fresh tally.
create or replace function public.toggle_reaction(
  p_post_id int, p_visitor_id text, p_kind text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_visitor text := nullif(left(coalesce(p_visitor_id, ''), 64), '');
  v_added   boolean;
begin
  if p_kind not in ('heart','thumb','bulb') then
    raise exception 'Unknown reaction';
  end if;
  if v_visitor is null then
    raise exception 'Missing visitor id';
  end if;
  if not exists (select 1 from public.posts where id = p_post_id) then
    raise exception 'Post not found';
  end if;

  delete from public.reactions
   where post_id = p_post_id and visitor_id = v_visitor and kind = p_kind;

  if found then
    v_added := false;
  else
    insert into public.reactions (post_id, visitor_id, kind)
    values (p_post_id, v_visitor, p_kind)
    on conflict do nothing;
    v_added := true;
  end if;

  return jsonb_build_object(
    'added', v_added,
    'reactions', (
      select jsonb_build_object(
        'heart', count(*) filter (where kind = 'heart'),
        'thumb', count(*) filter (where kind = 'thumb'),
        'bulb',  count(*) filter (where kind = 'bulb'))
        from public.reactions where post_id = p_post_id));
end $$;

-- Post a comment. Rate-limited to three per visitor per post per hour.
create or replace function public.add_comment(
  p_post_id int, p_name text, p_body text, p_visitor_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name    text := left(btrim(coalesce(p_name, '')), 60);
  v_body    text := left(btrim(coalesce(p_body, '')), 2000);
  v_visitor text := nullif(left(coalesce(p_visitor_id, ''), 64), '');
  v_row     public.comments;
begin
  if v_name = '' or v_body = '' then
    raise exception 'Name and comment are required';
  end if;
  if not exists (
    select 1 from public.posts where id = p_post_id and status = 'published'
  ) then
    raise exception 'Post not found';
  end if;

  if v_visitor is not null and (
      select count(*) from public.comments
       where post_id = p_post_id and visitor_id = v_visitor
         and created_at > now() - interval '1 hour') >= 3 then
    raise exception 'Slow down a moment — try again shortly.';
  end if;

  insert into public.comments (post_id, name, body, visitor_id)
  values (p_post_id, v_name, v_body, v_visitor)
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id, 'name', v_row.name,
    'body', v_row.body, 'created_at', v_row.created_at);
end $$;

-- Analytics ingest. Silently ignores anything malformed — measurement must
-- never break reading. Deduplication lives in the partial unique indexes.
create or replace function public.track_event(
  p_post_id    int,
  p_visitor_id text,
  p_session_id text,
  p_type       text,
  p_value      numeric default null,
  p_referrer   text    default null,
  p_device     text    default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_visitor text := nullif(left(coalesce(p_visitor_id, ''), 64), '');
  v_session text := nullif(left(coalesce(p_session_id, ''), 64), '');
  v_ref     text := nullif(left(coalesce(p_referrer, ''), 200), '');
  v_device  text := case when p_device in ('mobile','tablet','desktop')
                         then p_device else 'unknown' end;
  v_step    int;
  v_secs    int;
begin
  if p_type not in ('view','depth','dwell','share') then return; end if;
  if v_visitor is null or p_post_id is null then return; end if;
  if not exists (select 1 from public.posts where id = p_post_id) then return; end if;

  if p_type = 'view' then
    insert into public.events (post_id, visitor_id, session_id, type, referrer, device)
    values (p_post_id, v_visitor, v_session, 'view', v_ref, v_device)
    on conflict (post_id, session_id) where type = 'view' do nothing;

  elsif p_type = 'depth' then
    v_step := round(coalesce(p_value, 0))::int;
    if v_step not in (25, 50, 75, 100) then return; end if;
    insert into public.events (post_id, visitor_id, session_id, type, value, device)
    values (p_post_id, v_visitor, v_session, 'depth', v_step, v_device)
    on conflict (post_id, session_id, value) where type = 'depth' do nothing;

  elsif p_type = 'dwell' then
    -- Capped at 90 minutes so a forgotten open tab cannot skew averages.
    v_secs := least(greatest(round(coalesce(p_value, 0))::int, 0), 5400);
    if v_secs < 3 then return; end if;
    insert into public.events (post_id, visitor_id, session_id, type, value, device)
    values (p_post_id, v_visitor, v_session, 'dwell', v_secs, v_device)
    -- The conflict target is referenced by its bare name here, never
    -- schema-qualified — "public.events.value" is a parse error.
    on conflict (post_id, session_id) where type = 'dwell'
    do update set value = greatest(events.value, excluded.value),
                  created_at = now();

  else
    insert into public.events (post_id, visitor_id, session_id, type, referrer, device)
    values (p_post_id, v_visitor, v_session, 'share', v_ref, v_device);
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════
--  THE DASHBOARD QUERY  (author only)
--  Returns the whole payload in one round trip.
-- ════════════════════════════════════════════════════════════════════════
create or replace function public.analytics(
  p_days int default 30, p_post_id int default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_days         int;
  v_since        timestamptz;
  v_series_since timestamptz;
  v_views        int;
  v_finishers    int;
  v_totals   jsonb;
  v_daily    jsonb;
  v_posts    jsonb;
  v_funnel   jsonb;
  v_refs     jsonb;
  v_devices  jsonb;
  v_recent   jsonb;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'Not authorised' using errcode = '42501';
  end if;

  v_days := case
    when p_days is null then 30
    when p_days <= 0    then 0
    else least(greatest(p_days, 1), 730)
  end;
  v_since := case when v_days = 0
                  then timestamptz '1970-01-01'
                  else now() - make_interval(days => v_days) end;
  -- The daily series is generated day by day, so cap its span even on "all time".
  v_series_since := case when v_days = 0
                         then now() - interval '365 days'
                         else v_since end;

  select jsonb_build_object(
           'views',         count(*) filter (where type = 'view'),
           'readers',       count(distinct visitor_id) filter (where type = 'view'),
           'avg_dwell',     coalesce(round(avg(value) filter (where type = 'dwell')), 0)::int,
           'dwell_samples', count(*) filter (where type = 'dwell'),
           'finishers',     count(*) filter (where type = 'depth' and value = 100),
           'shares',        count(*) filter (where type = 'share')),
         count(*) filter (where type = 'view')::int,
         count(*) filter (where type = 'depth' and value = 100)::int
    into v_totals, v_views, v_finishers
    from public.events
   where created_at >= v_since
     and (p_post_id is null or post_id = p_post_id);

  v_totals := v_totals || jsonb_build_object('completion_rate',
    case when v_views > 0
         then round(v_finishers::numeric / v_views * 100)::int
         else 0 end);

  select coalesce(jsonb_agg(jsonb_build_object(
           'day',     to_char(d.day, 'YYYY-MM-DD'),
           'views',   coalesce(v.views, 0),
           'readers', coalesce(v.readers, 0)) order by d.day), '[]'::jsonb)
    into v_daily
    from generate_series(date_trunc('day', v_series_since),
                         date_trunc('day', now()),
                         interval '1 day') as d(day)
    left join (
      select date_trunc('day', created_at) as day,
             count(*)::int                 as views,
             count(distinct visitor_id)::int as readers
        from public.events
       where type = 'view' and created_at >= v_series_since
         and (p_post_id is null or post_id = p_post_id)
       group by 1) v on v.day = d.day;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'slug', t.slug, 'title', t.title, 'status', t.status,
           'views', t.views, 'readers', t.readers, 'avg_dwell', t.avg_dwell,
           'finishers', t.finishers, 'comments', t.comments, 'reactions', t.reactions)
           order by t.views desc, t.published_at desc), '[]'::jsonb)
    into v_posts
    from (
      select p.id, p.slug, p.title, p.status, p.published_at,
             count(e.*) filter (where e.type = 'view')::int                        as views,
             count(distinct e.visitor_id) filter (where e.type = 'view')::int      as readers,
             coalesce(round(avg(e.value) filter (where e.type = 'dwell')), 0)::int as avg_dwell,
             count(e.*) filter (where e.type = 'depth' and e.value = 100)::int     as finishers,
             (select count(*)::int from public.comments  c where c.post_id = p.id) as comments,
             (select count(*)::int from public.reactions r where r.post_id = p.id) as reactions
        from public.posts p
        left join public.events e
          on e.post_id = p.id and e.created_at >= v_since
       group by p.id) t;

  select coalesce(jsonb_agg(jsonb_build_object(
           'step',     s.step,
           'sessions', coalesce(f.sessions, 0),
           'pct',      case when v_views > 0
                            then round(coalesce(f.sessions, 0)::numeric / v_views * 100)::int
                            else 0 end) order by s.step), '[]'::jsonb)
    into v_funnel
    from (values (25), (50), (75), (100)) as s(step)
    left join (
      select value::int as step, count(*)::int as sessions
        from public.events
       where type = 'depth' and created_at >= v_since
         and (p_post_id is null or post_id = p_post_id)
       group by 1) f on f.step = s.step;

  select coalesce(jsonb_agg(jsonb_build_object('source', r.source, 'views', r.views)
           order by r.views desc), '[]'::jsonb)
    into v_refs
    from (
      select coalesce(nullif(referrer, ''), 'direct') as source, count(*)::int as views
        from public.events
       where type = 'view' and created_at >= v_since
         and (p_post_id is null or post_id = p_post_id)
       group by 1 order by views desc limit 8) r;

  select coalesce(jsonb_agg(jsonb_build_object('device', x.device, 'views', x.views)
           order by x.views desc), '[]'::jsonb)
    into v_devices
    from (
      select coalesce(device, 'unknown') as device, count(*)::int as views
        from public.events
       where type = 'view' and created_at >= v_since
         and (p_post_id is null or post_id = p_post_id)
       group by 1) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'name', c.name, 'body', c.body,
           'created_at', c.created_at, 'title', c.title, 'slug', c.slug)
           order by c.created_at desc), '[]'::jsonb)
    into v_recent
    from (
      select c.id, c.name, c.body, c.created_at, p.title, p.slug
        from public.comments c
        join public.posts p on p.id = c.post_id
       where c.created_at >= v_since
       order by c.created_at desc limit 12) c;

  return jsonb_build_object(
    'range',           jsonb_build_object('days', v_days, 'since', v_since),
    'totals',          v_totals,
    'daily',           v_daily,
    'posts',           v_posts,
    'funnel',          v_funnel,
    'referrers',       v_refs,
    'devices',         v_devices,
    'recent_comments', v_recent);
end $$;

-- ── who may call what ──────────────────────────────────────────────────
-- Postgres grants EXECUTE to PUBLIC by default, so lock down first.
revoke execute on function public.list_posts(boolean)                              from public;
revoke execute on function public.get_post(text)                                   from public;
revoke execute on function public.toggle_reaction(int, text, text)                 from public;
revoke execute on function public.add_comment(int, text, text, text)               from public;
revoke execute on function public.track_event(int, text, text, text, numeric, text, text) from public;
revoke execute on function public.analytics(int, int)                              from public;

grant execute on function public.list_posts(boolean)                to anon, authenticated;
grant execute on function public.get_post(text)                     to anon, authenticated;
grant execute on function public.toggle_reaction(int, text, text)   to anon, authenticated;
grant execute on function public.add_comment(int, text, text, text) to anon, authenticated;
grant execute on function public.track_event(int, text, text, text, numeric, text, text)
                                                                    to anon, authenticated;
-- The dashboard is the author's alone.
grant execute on function public.analytics(int, int)                to authenticated;

-- ── the first piece ────────────────────────────────────────────────────
insert into public.posts (slug, title, subtitle, body, published_at)
select
  'cyber-safety-plus-handbook',
  'Senior Secured: Cyber Safety Plus Handbook',
  'How to spot the modern con — including the AI-powered ones — before it costs you.',
  concat_ws(E'\n\n',
    'Every year, older Americans lose an estimated $3 billion or more to fraud — and those are only the cases that get reported. If you are over 60, live with someone who is, or simply care about protecting the people you love, this guide is for you.',
    'Scammers are not bumbling criminals operating out of dingy back rooms. They are sophisticated, organized, and increasingly armed with artificial intelligence that makes their tricks nearly indistinguishable from the real thing.',
    '## Phishing Emails and Texts',
    'A phishing email pretends to be from your bank, the IRS, Medicare, or Amazon and tricks you into clicking a link or providing personal information. Watch for urgent language like "Your account closes in 24 hours!", slightly misspelled addresses like amaz0n.com, and requests for your Social Security number or password.',
    'Never click links in suspicious messages. Navigate directly to websites by typing the address yourself. Call the company using a number from their official website — never the number in the suspicious message.',
    '## Tech Support Scams',
    'A terrifying pop-up appears: "VIRUS DETECTED! Call Microsoft immediately." Microsoft, Apple, and your internet provider will never send a pop-up demanding you call them. Close the browser. If you cannot close it, hold the power button to shut down the computer. Then call a trusted family member or local repair shop.',
    '## The Grandparent Scam — Now With AI Voices',
    'You receive a panicked call. The voice sounds exactly like your grandson. Thanks to AI voice-cloning, scammers can now replicate a loved one''s voice from just seconds of audio pulled from social media.',
    '## Create a Family Code Word',
    'Agree on a secret phrase only your family knows. If anyone calls claiming to be a family member in trouble, ask for the code word before taking any action. A real family member will know it. A scammer will not.',
    '> If anyone ever asks you to pay for anything by reading gift card numbers over the phone, it is a scam. No exceptions.',
    '## The Gift Card Rule',
    'No government agency, utility company, or real emergency ever requires gift card payment. Not the IRS. Not your power company. Not a hospital. Anyone who insists is telling you, plainly, that they are stealing from you.',
    '## Protect Yourself',
    'Freeze your credit at all three bureaus — Equifax, Experian, and TransUnion. It is free and the single strongest protection against identity theft. Enable two-factor authentication on your email and bank accounts.',
    'Report every scam attempt to the FTC at ReportFraud.ftc.gov or the AARP Fraud Helpline at 1-877-908-3360. Your report protects the next person.',
    'Stay curious. Stay skeptical. Stay safe. — Fred Flamer'),
  timestamptz '2026-08-07 09:00:00+00'
where not exists (select 1 from public.posts);
