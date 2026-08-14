# seniorsecured.org — long-form blog + reader analytics

A publishing site for long-form essays with reader interaction (hearts,
comments, sharing) and **per-post analytics stored in Supabase Postgres**.

There is no server and no build step. The page is static HTML; the browser
talks to Postgres directly through Supabase's REST layer. Every rule that
matters — who may read a draft, who may see the numbers, how often a visitor
may comment — is enforced *in the database*, by row-level security and by the
security-definer functions in `supabase/schema.sql`.

```
.
├─ index.html            the whole front end (article, sidebar, editor, dashboard)
├─ config.js             your Supabase URL + anon key  ← the only file you must edit
├─ 404.html              GitHub Pages deep-link shim (see "Routing" below)
├─ fred-flamer.jpg       the headshot in the profile panel
├─ CNAME                 the custom domain
├─ .nojekyll             serve files as-is, no Jekyll pass
└─ supabase/schema.sql   tables, RLS policies, functions, seed post
```

---

## Setup

### 1. Create the Supabase project and run the schema

Create a project at [supabase.com](https://supabase.com). Open **SQL Editor**,
paste the whole of `supabase/schema.sql`, and run it. It builds the four
tables, the indexes that make the analytics dedupe work, the row-level security
policies, the six functions the front end calls, and the first post.

Running it again later is harmless — it is written to be idempotent.

### 2. Point the front end at it

In the Supabase dashboard, **Settings → API** gives you the **Project URL** and
the **anon / public** key. Put both in `config.js`:

```js
window.SUPABASE_URL      = 'https://abcdefgh.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJhbGciOi...';
```

Both are safe to commit. The anon key is a *publishable* key — it identifies
the project, it does not grant anything. Anything it could reach is governed by
the policies in step 1. The key you must never commit is the **service_role**
key, which is not used here at all.

### 3. Create the author account

**Authentication → Users → Add user**. Give it the client's email and a real
password, and tick *Auto Confirm User*. That one account is the entire CMS
login — it is what unlocks the editor and the analytics dashboard.

Then, so nobody can sign themselves up: **Authentication → Sign In / Providers
→ Email**, turn **off** "Allow new users to sign up".

### 4. Publish on GitHub Pages

Push this folder to a repository, then **Settings → Pages → Source: Deploy from
a branch**, branch `main`, folder `/ (root)`. The files are already laid out for
root-level serving.

For the custom domain, `CNAME` already contains `seniorsecured.org`. Point the
domain's DNS at GitHub Pages, then tick **Enforce HTTPS**.

Finally, back in Supabase, add the live origin to **Authentication → URL
Configuration → Site URL / Redirect URLs** (`https://seniorsecured.org`).

### 5. Local development

Any static file server works, since there is no build:

```bash
python -m http.server 3000
# then open http://localhost:3000
```

Add `http://localhost:3000` to the Supabase redirect URLs while you work.

---

## Routing

| Route | What it is |
|---|---|
| `/` | the newest piece, opened in place |
| `/p/<slug>` | that article — shareable, indexable URL |
| `/dashboard` | analytics, author only |

The reader sees one page: profile and links on the left, the piece in the
middle, **Latest publishings** on the right. Clicking a piece in that sidebar
navigates to its own `/p/<slug>` URL, so every article stays shareable.

GitHub Pages has no rewrite rules, so a *hard* load of `/p/<slug>` would
normally 404. `404.html` catches it, stashes the path in `sessionStorage`, and
bounces to `/`, where the app restores the URL with `replaceState`. The reader
sees the right article at the right address; the only cost is one redirect on
cold deep links.

**Writing.** Click **New post** in the site footer, sign in once, then write.
The body understands a small, predictable subset of Markdown:

```
## Heading            ### Subheading
> Pull quote          - bullet list        1. numbered list
**bold**   *italic*   [link text](https://example.com)
```

A blank line starts a new paragraph. **Preview** shows exactly what readers see.
**Save as draft** keeps a piece off the public list until you publish it —
drafts appear in the sidebar, tagged, only while you are signed in.

---

## How the database is protected

The browser holds a public key, so the security cannot live in the front end.
It lives in `supabase/schema.sql`:

| Table | Who can read | Who can write |
|---|---|---|
| `posts` | anyone, `status = 'published'` only; the author sees drafts too | the author |
| `comments` | anyone, `approved` only | nobody directly — only `add_comment()` |
| `reactions` | nobody directly | nobody directly — only `toggle_reaction()` |
| `events` | nobody, ever | nobody directly — only `track_event()` |

`reactions` and `events` carry **no RLS policies at all**, which denies every
direct request. They are reachable only through security-definer functions,
so the rules travel with the data:

- `toggle_reaction()` is keyed on post + visitor + kind, so a reader cannot
  double-react.
- `add_comment()` trims and length-caps the input and rate-limits to three
  comments per visitor per post per hour.
- `track_event()` silently drops anything malformed — measurement must never
  break reading.
- `analytics()` refuses anyone who is not signed in, and is granted to the
  `authenticated` role only.

---

## What gets measured

Every measurement is a row in `events`, written through one client-side
`track()` call, so adding a metric means adding a type — not a new pipeline.

| Event | When it fires | Deduplication |
|---|---|---|
| `view` | article opens | once per browser session per post |
| `depth` | article scrolls past 25 / 50 / 75 / 100% | once per milestone per session |
| `dwell` | every 30s and on tab hide/close | one high-water row per session; only counts time the tab is visible, capped at 90 min |
| `share` | the Copy link / native share button | every time |

Deduplication is enforced by partial unique indexes plus `on conflict`, so it
holds even if the client misbehaves.

A `visitor_id` lives in `localStorage` (stable across visits) and a
`session_id` in `sessionStorage` (per tab session). Both are random UUIDs —
**no cookies, no third-party trackers, no IP or personal data stored.**
Referrer is reduced to a hostname and device to one of mobile / tablet /
desktop.

### The dashboard shows

- **Reads** (hero), unique readers, average attention time, completion rate,
  total engagement
- **Reads per day** — line chart with a crosshair tooltip, plus a table view
- **How far readers get** — the 25/50/75/100% depth funnel
- **Where readers come from** — referring hostnames
- **Every post ranked** by reads, with attention, completion, reactions, comments
- Device split and the newest comments

Filter by time window (7 / 30 / 90 days / all time) and by individual post. The
whole payload arrives from a single `analytics()` call.

### Chart design notes

Every chart is single-series, so no legend is needed — the title names what is
plotted. Colors come from one validated blue: `#2A78D6` for lines and bars, and
an ordinal ramp (`#86B6EF → #5598E7 → #2A78D6 → #1C5CAB`) for the depth funnel,
checked against the white chart surface for monotone lightness, step separation,
and a light-end that clears 2:1 contrast. Bars cap at 20px with a 4px rounded
data-end; the line is 2px over a 10% wash; gridlines are hairline and recessive.

---

## Design

UI type is **MS Sans Serif at 12px** (falling back to Tahoma, then Segoe UI).
Article body uses the same face at **16.5px / 1.78** — the audience skews older
and long-form reading at 12px is punishing. Light-mode only, by choice: the
palette is a printed-page cream, navy and gold.

---

## Notes and limits

- The reader UI offers all three reactions the schema accepts — heart, thumb
  and bulb. They are driven by the `REACTIONS` table near the reaction
  functions in `index.html`; a fourth kind would need the check constraint in
  `schema.sql` widened too.
- Comments publish immediately (`approved` defaults to `true`). Flip that
  default and the approved-only read policy becomes a moderation queue; the
  author can already update and delete any comment.
- Editing an existing post is not wired into the UI yet. RLS already permits
  it, so it is a form away.
- `supabase-js` loads from jsDelivr, pinned to `2.58.0`. Vendor it next to
  `index.html` if you would rather not depend on a CDN.
- Supabase's free tier pauses a project after a week of no activity; the first
  request after that takes a moment to wake it.
