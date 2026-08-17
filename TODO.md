# What's left to do

Status **16 Aug 2026**. The site is live at `http://seniorsecured.org`, DNS is
done, and the author allowlist is applied. What remains is the HTTPS
certificate, one Supabase toggle, and content.

**Nothing blocks Fred writing his first post.** He has an account and publish
rights; the remaining items are polish and hardening.

---

## In order

### 1. Point the domain at GitHub Pages — **done, 16 Aug 2026**

Verified against Google DNS: apex answers with all four `185.199.10x.153`
addresses, `www` is a CNAME to `fredthaflame.github.io`, and the parking
records are gone. Email survived — all five `eforward*.registrar-servers.com`
MX records and both TXT records (SPF, Google site verification) are intact.

`http://seniorsecured.org` returns 200 and serves the real page.
`http://www.` 301-redirects to the apex.

Optional IPv6 was never added and is not needed. Same `@` host, as `AAAA`, if
it is ever wanted: `2606:50c0:8000::153`, `2606:50c0:8001::153`,
`2606:50c0:8002::153`, `2606:50c0:8003::153`.

### 2. Tick Enforce HTTPS  ← outstanding

GitHub → repo **Settings → Pages**. As of 16 Aug the site still serves
GitHub's wildcard `CN=*.github.io` certificate, so `https://` fails the trust
check. That is expected: GitHub only requests the custom-domain certificate
after it sees DNS pointing at it, which it now does. Usually minutes to a few
hours. The checkbox stays greyed out until then.

Note for whoever does this: the repo owner is Fred. The account
`AntJohnson-25` has read access only, so it cannot tick the box or push.

### 3. Author accounts and the allowlist — **done, 16 Aug 2026**

`auth.users` was completely empty; the account referred to in earlier notes
had never been created. Two accounts now exist, both with *Auto Confirm User*:

- `FFlamer29@gmail.com` — Fred, site owner
- `Charles2025business@gmail.com` — manager

Publish rights no longer follow from merely holding a login. See
[`supabase/authors.sql`](supabase/authors.sql) — `schema.sql` gated every
author action on `auth.role() = 'authenticated'`, which meant *any* account.
That is now membership of `public.authors`, keyed on the auth uuid.

### 4. Turn signups off  ← outstanding

**Authentication → Sign In / Providers → Email** → *Allow new users to sign
up* is still **on** as of 16 Aug.

Less urgent than it was — the allowlist means a stranger who registers can do
nothing a logged-out reader cannot. The remaining reason is quota: every
signup attempt sends a confirmation email through Supabase's shared, rate-
limited SMTP, and exhausting it takes your transactional mail down with it.

### 5. Supabase URL configuration — not required

Earlier notes listed this as a blocker for author sign-in. It is not.
Sign-in is `signInWithPassword` ([`index.html`](index.html)), and Site URL /
Redirect URLs apply only to magic links and OAuth. Set them anyway if you add
either later.

### 6. Fred writes the first piece  ← outstanding

Footer → **New post** → sign in → write → **Publish**. The database ships
empty on purpose, so until this happens the site shows "No posts yet" rather
than an error.

Doing it this way also smoke-tests sign-in, the editor, and the publish path
in one go. He needs his password from the manager.

---

## Still carrying placeholders

- ~~**Social links.**~~ Removed 17 Aug 2026 at Fred's request. The whole
  *Elsewhere / Contact* panel is gone — LinkedIn link, `PROFILE_LINKS`,
  `paintLinks()` and the `#links` styles with it.
- ~~**Contact address.**~~ Moot for now: `fred@seniorsecured.org` came out with
  that panel, so no address is published. Still worth confirming the mailbox
  before any address goes back on the site. Note this is *not* his login —
  that is `FFlamer29@gmail.com`. The MX records forward the domain address
  somewhere, but nobody has verified where.
- ~~**Bio and role.**~~ Set 17 Aug 2026 from Fred: role is "Certified
  Information Systems Security Professional", bio is "Empowering individuals
  and organizations with the knowledge and tools to navigate an increasingly
  complex cybersecurity landscape with confidence."
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
- [ ] **Allowlist holds.** Register a throwaway account (while signups are
      still on) and confirm sign-in is refused with "not an author on this
      site", `/dashboard` stays gated, and no draft appears in the sidebar
- [ ] **Cover image.** Publish a piece with a picture; confirm it appears
      above the article, as a sidebar thumbnail, and in a link preview
      (paste the URL into a message). Then replace it and remove it from the
      article view
- [ ] **Paste.** Paste a formatted passage from Word or Google Docs and
      confirm headings, bold, bullets and links survive into Preview
- [ ] **Edit.** Change a published piece's title and body, save, and confirm
      the article and sidebar both update **and the URL is unchanged**. Then
      "Move to drafts" and confirm it vanishes for a signed-out reader
- [ ] **Edit does not leak into new posts.** Open an edit, hit Cancel, then
      "New post" — confirm the form is blank and saving creates a new piece
      rather than overwriting the one that was being edited
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

- **No delete in the UI.** Still a table-editor job. Moving a piece to
  drafts from the editor hides it from readers, which covers most of what
  delete would be wanted for.
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

- **Editing published pieces** (16 Aug 2026). "Edit this piece" above any
  article, signed in, loads it back into the same composer — title,
  standfirst, body and cover image. Saving updates in place; **the slug is
  untouched, so shared links keep working** (`posts_before_write` only
  builds a slug when one is blank, so an update leaves it alone). "Move to
  drafts" pulls a published piece back out of view without deleting it.
  Needed no migration: `posts_author_upd` in `authors.sql` already allowed
  it. Verified that an anonymous `PATCH /rest/v1/posts` matches zero rows.
- **Cover images** (16 Aug 2026). One optional picture per piece: shown above
  the article, as a thumbnail in *Latest publishings*, and as the `og:image`
  when the link is shared (with `twitter:card` upgrading to
  `summary_large_image` only when there is a picture). Uploaded from the
  composer, and addable, replaceable or removable from the article itself
  afterwards. The browser downscales to 1600px on the long edge and
  re-encodes as JPEG before upload, so a 5 MB phone photo lands as a few
  hundred KB. Replaced files are deleted from the bucket on a best-effort
  basis — cleanup never blocks the save. Needs
  [`supabase/post-images.sql`](supabase/post-images.sql).
- **Pasted formatting survives** (16 Aug 2026). Pasting from Word or Google
  Docs into the body converts the clipboard's `text/html` into the markdown
  the editor already speaks — headings, bold, italic, lists, quotes and
  links. Plain-text pastes are left to the browser. Storage format, renderer
  and escaping are unchanged, so nothing about the XSS posture moved.
  Covered by 31 assertions including the full clipboard → markdown →
  rendered-HTML round trip.
- **Author allowlist applied** (16 Aug 2026). `public.authors` plus
  `public.is_author()`; the four `posts` policies, two `comments` moderation
  policies, `list_posts`, `get_post` and `analytics` all gate on it. Verified
  live: the table and function exist, and anonymous callers get `[]` and
  `false` respectively. `analytics()` is rewritten in place by a `DO` block
  that rereads `pg_get_functiondef`, so the file stays correct if that
  function is edited later.
- **Front end tells the truth about authorship.** `isAuthor()` in
  `index.html` was `!!session` — merely signed in. It now also requires the
  allowlist row, read through the `authors_read_self` policy, and fails
  closed on any error. A non-author who signs in with a valid password is
  signed straight back out with an explanation rather than being shown an
  editor that the database will refuse.
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
