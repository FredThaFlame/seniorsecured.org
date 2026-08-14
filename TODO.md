# What's left to do

Status at end of day **13 Aug 2026**. The code is done, pushed, and connected
to the live database. What remains is DNS, two Supabase settings, and content.

**One thing blocks launch: the DNS change at Namecheap.** Everything else can
happen before or after it. Fred's walkthrough for that is in
[`NAMECHEAP-DNS.md`](NAMECHEAP-DNS.md).

---

## Tomorrow, in order

### 1. Point the domain at GitHub Pages  ← the blocker

Hand [`NAMECHEAP-DNS.md`](NAMECHEAP-DNS.md) to Fred, or drive it yourself if
you have the Namecheap login. Summary of the change:

| Type | Host | Value |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| CNAME | `www` | `FredThaFlame.github.io.` |

**Delete the two parking records first** — the apex `A` at `192.64.119.199`
and the `www` CNAME to `parkingpage.namecheap.com`. A leftover apex record
keeps answering ahead of the new ones, which looks exactly like "the change
didn't work."

Optional IPv6, same `@` host, as `AAAA`: `2606:50c0:8000::153`,
`2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`.

### 2. Tick Enforce HTTPS

GitHub → repo **Settings → Pages**. The checkbox stays greyed out until the
certificate is issued, which needs DNS to have propagated first. Usually
minutes; the TTL on the old parking record can stretch it. Come back to it.

### 3. Confirm the author account is locked down

Status unknown as of tonight — **verify both halves**:

- **Authentication → Users** — one account exists, with Fred's email and
  *Auto Confirm User* ticked. That account is the entire CMS login.
- **Authentication → Sign In / Providers → Email** — *Allow new users to sign
  up* is **off**.

The second half is the one that matters. Leave signups on and anyone can
register themselves into author rights, which includes the analytics
dashboard and the ability to publish.

### 4. Tell Supabase about the live origin

**Authentication → URL Configuration** → set **Site URL** and add to
**Redirect URLs**: `https://seniorsecured.org`. Add `http://localhost:3000`
too if you will develop locally.

Skip this and everything works except author sign-in on the live site — a
confusing failure, because readers see a perfectly healthy page.

### 5. Fred writes the first piece

Footer → **New post** → sign in → write → **Publish**. The database ships
empty on purpose, so until this happens the site shows "No posts yet" rather
than an error.

Doing it this way also smoke-tests sign-in, the editor, and the publish path
in one go.

---

## Still carrying placeholders

- **Social links.** All four in the *Elsewhere* panel are the mockup's
  inventions — `linkedin.com/in/fredflamer`, `github.com/fredflamer`,
  `x.com/fredflamer`, `fredflamer.substack.com`. Real URLs, or delete the ones
  that do not exist. They live in `PROFILE_LINKS` near the top of the script in
  `index.html`.
- **Contact address.** `fred@seniorsecured.org` shows in the same panel.
  Confirm it exists and is monitored before it goes in front of readers.
- **Bio and role.** "Consumer-safety writer" / "Thirty years explaining how the
  con works — so it stops working on you." Needs Fred's sign-off.
- **Headshot.** `fred-flamer.jpg`, 512px square. Fine as-is; swap if there is a
  better one.

---

## Smoke test, once the domain resolves

Signed out first:

- [ ] `/` loads and shows the newest piece
- [ ] Sidebar click navigates to `/p/<slug>` and swaps the article
- [ ] **Hard reload** of a `/p/<slug>` URL lands on the right article
      (exercises the `404.html` shim — the most fragile part of Pages hosting)
- [ ] Each of the three reactions (heart, thumb, bulb) increments, survives a
      reload, and does not double-count; the sidebar tally is their sum
- [ ] Comment posts and appears; a fourth comment within an hour is refused
- [ ] Copy link produces a working URL
- [ ] Footer → **New post** → sign in works
- [ ] Save a draft — tagged in the sidebar while signed in, gone after sign out
- [ ] `/dashboard` gated when signed out; after sign-in all three charts draw
- [ ] `select count(*) from events` climbs as you browse
- [ ] **Re-test the RLS lockdown once real rows exist.** Anonymous
      `GET /rest/v1/events` and `/rest/v1/reactions` returned an empty array on
      13 Aug 2026, but both tables were empty then, so that proved nothing.
      With rows present they must *still* come back empty — that is what
      confirms the no-policy deny-all is doing the work.

---

## Deliberate gaps — decide whether they matter

- **No post editing in the UI.** Publish-only. RLS already permits updates and
  the API is there; it needs a form. Fred will want this the first time he
  typos a headline — the strongest candidate for the next piece of work.
- **No delete in the UI** either. Both are table-editor jobs today.
- **Comments publish immediately** (`approved` defaults to `true`). Flipping
  that default turns the existing read policy into a moderation queue, but
  there is no approval screen to work it from yet.
- **`supabase-js` loads from jsDelivr**, pinned to `2.58.0`. Vendor it next to
  `index.html` if a CDN dependency is unwanted.
- **Supabase free tier pauses** after about a week of no activity; the first
  request afterwards is slow. Worth knowing before Fred reports "the site is
  broken."
- **Legacy vs new API key.** `config.js` ships the JWT-style anon key because
  that is what supabase-js 2.58.0 and the keepalive fetch in `track()` expect.
  The newer `sb_publishable_…` key was tested against this project and also
  works, so the swap is one line if the legacy format is ever retired.

---

## Done — no action needed

- **Schema is live.** `supabase/schema.sql` ran successfully against the
  project. Four tables, six functions. It parses under Postgres's own grammar
  (checked with `libpg-query`), so the "never been executed" risk is retired.
- **Seed post removed.** It was template prose signed off as Fred; shipping it
  would have published placeholder content under his byline.
- **Front end connected.** `config.js` holds the real project URL and anon key.
  Verified live: `list_posts` returns `[]` over REST, and the app's own
  `CONFIGURED` guard passes.
- **Security spot-checked against the live database.** Anonymous
  `rpc/analytics` → 401. Direct `INSERT` into `events` → 401. Both keys
  (legacy JWT and `sb_publishable_`) authenticate correctly.
- **Three reactions ship** — heart, thumb, bulb, driven by the `REACTIONS`
  table in `index.html`. No schema change was needed. Covered by a 15-assertion
  jsdom test: independent counts, correct `p_kind`, pressed state surviving a
  repaint, no double-counting. Also fixed a latent bug where the sidebar tally
  used the heart count alone while `list_posts()` counts every kind.
- **Repo is current.** All work pushed to `FredThaFlame/seniorsecured.org`,
  branch `main`.
- **GitHub Pages is enabled** with the custom domain set — confirmed by
  `fredthaflame.github.io/seniorsecured.org/` redirecting to
  `seniorsecured.org`. It serves the parking page only because DNS has not
  moved yet.
- Vercel serverless functions removed; all logic lives in `supabase/schema.sql`
  as RLS policies plus six security-definer functions.
- Folder laid out for Pages root serving, with `CNAME`, `.nojekyll`, and the
  `404.html` deep-link shim.
- Mobile layout fixed at 430px.

> **Decided: custom domain at the root.** The absolute paths in `index.html`
> (`/config.js`, `/fred-flamer.jpg`) and the `404.html` redirect to `/` depend
> on it. If the plan ever falls back to the project-page URL
> (`FredThaFlame.github.io/seniorsecured.org/`), those paths must be made
> relative or the page loads blank.
