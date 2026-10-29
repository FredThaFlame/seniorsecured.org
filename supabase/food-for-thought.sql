-- ════════════════════════════════════════════════════════════════════════
--  seniorsecured.org — Food for Thought
--
--  Paste this whole file into the Supabase SQL editor and run it once,
--  AFTER schema.sql and authors.sql. It is idempotent: running it again
--  is harmless.
--
--  What this adds
--  ───────────────
--  Short opinion notes for the /food-for-thought/ page. They live in their
--  own table instead of public.posts on purpose: they stay out of "Latest
--  publishings", the pager, the analytics and the prerender, and nothing
--  that already works (list_posts, get_post) is touched.
--
--  Anyone may read. Only an allowlisted author (public.authors, see
--  authors.sql) may add, edit or delete — the same test the blog uses.
-- ════════════════════════════════════════════════════════════════════════

create table if not exists public.thoughts (
  id          serial primary key,
  body        text not null
                check (length(btrim(body)) > 0 and length(body) <= 4000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.thoughts is
  'Food for Thought notes. Public read; allowlisted authors write.';

alter table public.thoughts enable row level security;

drop policy if exists thoughts_read       on public.thoughts;
drop policy if exists thoughts_author_ins on public.thoughts;
drop policy if exists thoughts_author_upd on public.thoughts;
drop policy if exists thoughts_author_del on public.thoughts;

create policy thoughts_read on public.thoughts for select
  using (true);
create policy thoughts_author_ins on public.thoughts for insert
  to authenticated with check (public.is_author());
create policy thoughts_author_upd on public.thoughts for update
  to authenticated using (public.is_author()) with check (public.is_author());
create policy thoughts_author_del on public.thoughts for delete
  to authenticated using (public.is_author());

grant select on public.thoughts to anon, authenticated;
grant insert, update, delete on public.thoughts to authenticated;
grant usage, select on sequence public.thoughts_id_seq to authenticated;

-- Keep updated_at honest when a note is edited.
create or replace function public.thoughts_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists thoughts_touch on public.thoughts;
create trigger thoughts_touch before update on public.thoughts
  for each row execute function public.thoughts_touch();

-- The first note, Fred's, dated the day he wrote it. Only seeds an empty table.
insert into public.thoughts (body, created_at)
select
  'Food For Thought…..' || E'\n\n\n' ||
  'This is an opinion on the oversharing of personal information. With different A.I platforms such as ChatGPT, CoPilot, Gemini, and others, know that these platforms and other LLMs are engineered to be personable, supportive and engaging. That being said, be extra cautious about the personal information you share with them. Information you share regarding health, financial details, and other personal and sensitive topics has the possibility and probability of coming back to bite you at some point. Remember, for many services where you pay nothing or very little, generally you are the product. Understand that there is a high probability that profiles associated with you from the information you share will at some point be traded and or sold, and that information can be used against your interests.' || E'\n\n\n\n' || '-F-',
  '2026-10-16 23:28:00-07'
where not exists (select 1 from public.thoughts);
