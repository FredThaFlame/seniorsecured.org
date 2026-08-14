# What's left to do

Status as of 13 Aug 2026. The site is code-complete and the front end is
verified; everything below is setup, unverified SQL, and deliberate gaps.

---

## 1. Blocking — the site will not work until these are done

### 1.1 Run the schema (expect to iterate)

Paste all of `supabase/schema.sql` into the Supabase **SQL Editor** and run it.

> **This SQL has never been executed.** There was no Postgres, Docker, or
> Supabase CLI available on the machine it was written on, so it is reviewed by
> eye, not run. One parse error was already caught that way. Budget time for a
> round or two of fixes on the first run — this is the single most likely place
> to lose an hour.

If it errors, the error names the function; fix in place and re-run the whole
file. It is written to be idempotent.

Sanity check afterwards, in the SQL editor:

```sql
select id, slug, title, status from public.posts;
select proname from pg_proc where pronamespace = 'public'::regnamespace
  and proname in ('list_posts','get_post','toggle_reaction',
                  'add_comment','track_event','analytics');
```

Six functions and one seed post. Note the seed only inserts when `posts` is
empty, so it will not fight you on a re-run.

### 1.2 Fill in `config.js`

Supabase dashboard → **Settings → API**. Copy **Project URL** and the
**anon / public** key into `config.js`:

```js
window.SUPABASE_URL      = 'https://abcdefgh.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJhbGciOi...';
```

Both are safe to commit. **Never** put the `service_role` key here — it is not
used anywhere in this project.

Until this is filled in the page shows a "Not connected yet" notice instead of
failing silently.

### 1.3 Create the author account, then close the door

- **Authentication → Users → Add user** — the client's email, a real password,
  tick **Auto Confirm User**. That one account is the whole CMS login.
- **Authentication → Sign In / Providers → Email** — turn **off**
  *Allow new users to sign up*.

Skipping the second step means anyone can register themselves and gain author
rights, including the analytics dashboard. Do not miss it.

### 1.4 Publish on GitHub Pages

- Push this folder to a repo.
- **Settings → Pages → Source: Deploy from a branch**, branch `main`, folder
  **`/ (root)`**. The files are already laid out for root serving.
- Point the domain's DNS at GitHub Pages, then tick **Enforce HTTPS**.

`CNAME` currently contains `seniorsecured.org`.

**DNS as it stands (checked 13 Aug 2026).** The domain is registered and
resolving, but to a **Namecheap parking page** — apex `A` is `192.64.119.199`
and `www` is a `CNAME` to `parkingpage.namecheap.com`. Nameservers are
`dns1/dns2.registrar-servers.com`, so DNS is managed at **Namecheap → Domain
List → Manage → Advanced DNS**.

Delete the parking records first — the stock Namecheap setup leaves a URL
Redirect / parking `A` record and the `www` CNAME behind, and a leftover apex
record will keep answering ahead of the new ones. Then add:

| Type | Host | Value |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| CNAME | `www` | `FredThaFlame.github.io.` |

Optional IPv6, same `@` host: `2606:50c0:8000::153`, `8001::153`, `8002::153`,
`8003::153` as `AAAA` records.

Then in GitHub → Settings → Pages, set the custom domain to
`seniorsecured.org`. Leave **Enforce HTTPS** until the certificate is issued —
it stays greyed out until DNS has propagated, which is usually minutes but the
TTL on the parking record can stretch it.

> **Decided (13 Aug 2026): custom domain at the root.** The client owns
> `seniorsecured.org` and DNS can be pointed at GitHub Pages, so the absolute
> paths in `index.html` (`/config.js`, `/fred-flamer.jpg`) and the `404.html`
> redirect to `/` all stay as they are — no code change needed.
>
> This holds only while the site is served at the domain root. If the plan ever
> falls back to the project-page URL
> (`FredThaFlame.github.io/seniorsecured.org/`), those paths must be made
> relative or the page loads blank.

### 1.5 Tell Supabase about the live origin

**Authentication → URL Configuration** → set **Site URL** and add to
**Redirect URLs**: `https://seniorsecured.org` (and `http://localhost:3000`
while developing).

---

## 2. Content and details still carrying placeholders

- **Social links.** The four links in the *Elsewhere* panel are still the
  mockup's inventions — `linkedin.com/in/fredflamer`, `github.com/fredflamer`,
  `x.com/fredflamer`, `fredflamer.substack.com`. Real URLs needed, or drop the
  ones that do not exist. They live in `PROFILE_LINKS` near the top of the
  script in `index.html`.
- **Contact address.** `fred@seniorsecured.org` appears in the Elsewhere panel.
  Confirm it exists and is monitored.
- **Bio and role.** "Consumer-safety writer" / "Thirty years explaining how the
  con works — so it stops working on you." Client sign-off?
- **Headshot.** `fred-flamer.jpg` is 512px square. Fine as-is; swap if they
  have a better one.

---

## 3. Smoke test once deployed

Run these against the live URL, signed out first:

- [ ] `/` loads and shows the newest piece
- [ ] Sidebar click navigates to `/p/<slug>` and swaps the article
- [ ] **Hard reload** of a `/p/<slug>` URL lands on the right article
      (this exercises the `404.html` shim — the most fragile part of GitHub
      Pages hosting)
- [ ] Each of the three reactions (heart, thumb, bulb) increments, survives a
      reload, and does not double-count; the sidebar tally is their sum
- [ ] Comment posts and appears; a fourth comment within an hour is refused
- [ ] Copy link produces a working URL
- [ ] Footer → **New post** → sign in works
- [ ] Publish a throwaway post, confirm it appears, then delete it in the
      Supabase table editor
- [ ] Save a draft — visible tagged in the sidebar while signed in, gone after
      sign out
- [ ] `/dashboard` gated when signed out; after sign-in all three charts draw
- [ ] Check `select count(*) from events` climbs as you browse

---

## 4. Deliberate gaps — decide whether they matter before launch

- **No post editing in the UI.** Publish-only. RLS already permits updates and
  the API is there; it needs a form. A client publishing their own writing will
  want this the first time they typo a headline — this is the strongest
  candidate for the next piece of work.
- **No delete in the UI** either. Both are currently table-editor jobs.
- **Comments publish immediately** (`approved` defaults to `true`). Flipping
  that default turns the existing read policy into a moderation queue, but
  there is no approval screen to work it from yet.
- ~~**One reaction only** (the heart).~~ Done — heart, thumb and bulb all ship
  in the reader UI now. No schema change was needed.
- **`supabase-js` loads from jsDelivr**, pinned to `2.58.0`. If a CDN
  dependency is unwanted, download it next to `index.html` and change the one
  `<script src>`.
- **Free tier pauses** after about a week of no activity; the first request
  afterwards is slow. Worth knowing before the client reports "the site is
  broken".

---

## 5. Already done — no action needed

- Accepted mockup layout is now `index.html`; `mockup.html` deleted
- Guide renamed to **Senior Secured: Cyber Safety Plus Handbook**
  (slug `cyber-safety-plus-handbook`), in the seed post
- Vercel serverless functions removed; all logic moved into
  `supabase/schema.sql` as RLS policies + six functions
- Folder restructured for GitHub Pages root serving, with `CNAME`,
  `.nojekyll`, and the `404.html` deep-link shim
- Front end verified in a real browser against a stub of Supabase's REST and
  Auth surface: anonymous read, hearts, comments, sign-in, drafts, publish,
  all three dashboard charts, sign-out, and deep-link restore
- Mobile layout fixed at 430px (the mockup's profile card squeezed name, role
  and bio into three cramped columns)
