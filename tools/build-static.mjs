/* ══════════════════════════════════════════════════════════════════════
   Prerender one static page per published piece.

   GitHub Pages has no rewrite rules, so a hard load of /p/<slug> used to
   land on 404.html: the reader got bounced to the app and saw the right
   article, but the *status code* was 404, and a crawler drops a 404 no
   matter what renders afterwards. Every piece on the site was therefore
   unindexable. This writes a real file at /p/<slug>/index.html so the
   address answers 200 with the writing already in the HTML.

   The generated page is the same app shell as index.html — same stylesheet,
   same script — with the head retagged for that piece and the article,
   sidebar and pager filled in. The app boots on top and replaces the
   prerendered markup with live data, so reactions, comments and drafts
   behave exactly as they do on the home page, and a stale prerender heals
   itself on the next load.

   Run it after publishing, editing or deleting a piece:

       node tools/build-static.mjs

   Nothing is written unless the bytes actually change, so a run with no
   new writing leaves the repository untouched.
   ══════════════════════════════════════════════════════════════════════ */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://seniorsecured.org';

/* ── the app's own renderers ───────────────────────────────────────────
   Pulled out of app.js rather than reimplemented. A second copy of the
   markdown renderer would drift from the one readers see, and the drift
   would show up as prerendered HTML that does not match the page. These
   are top-level declarations, so the closing brace is the first one that
   starts a line — brace counting would trip over the } inside a regex
   character class. */
const appSrc = readFileSync(join(ROOT, 'app.js'), 'utf8');

function grab(name){
  const m = new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}', 'm').exec(appSrc);
  if(!m) throw new Error('app.js no longer defines ' + name + '() — the prerender needs it');
  return m[0];
}

const RENDERERS = ['esc', 'inline', 'renderBody', 'postExcerpt', 'longDate', 'shortDate', 'comma', 'fmt'];
const { esc, renderBody, postExcerpt, longDate, shortDate, comma, fmt } =
  new Function(RENDERERS.map(grab).join('\n') + '\nreturn {' + RENDERERS.join(',') + '};')();

/* ── the shell ─────────────────────────────────────────────────────────
   Every swap below asserts that it matched. If someone edits index.html
   and one of these anchors moves, the build fails loudly rather than
   silently shipping 25 pages with an empty article in them. */
const shell = readFileSync(join(ROOT, 'index.html'), 'utf8');

function swap(html, find, replace, what){
  const i = html.indexOf(find);
  if(i < 0) throw new Error('index.html no longer contains the ' + what + ' anchor:\n  ' + find);
  if(html.indexOf(find, i + find.length) >= 0) throw new Error('ambiguous anchor for ' + what);
  return html.slice(0, i) + replace + html.slice(i + find.length);
}

const SITE_DESC = /<meta name="description" content="([^"]*)"/.exec(shell)[1];

/* ── data ──────────────────────────────────────────────────────────────
   One call: list_posts() carries the body, the cover image and the
   counts, and it is the same function the site itself reads. Drafts are
   excluded — include_drafts is gated on the caller being an author, and
   this runs with the anon key. */
const cfg = readFileSync(join(ROOT, 'config.js'), 'utf8');
const SUPABASE_URL = /SUPABASE_URL\s*=\s*'([^']+)'/.exec(cfg)[1];
const SUPABASE_KEY = /SUPABASE_ANON_KEY\s*=\s*'([^']+)'/.exec(cfg)[1];

async function listPosts(){
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/list_posts', {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ include_drafts: false })
  });
  if(!res.ok) throw new Error('list_posts failed: ' + res.status + ' ' + (await res.text()).slice(0, 300));
  const rows = await res.json();
  return rows.filter(p => p.status === 'published' && p.slug);
}

const postPath = slug => '/p/' + encodeURIComponent(slug) + '/';
const postUrl  = slug => SITE + postPath(slug);
const iso      = d => (d ? new Date(d).toISOString() : null);

function postDesc(p){
  const sub = (p.subtitle || '').trim();
  return sub || postExcerpt(p.body) || SITE_DESC;
}

/* ── head ──────────────────────────────────────────────────────────── */
function head(html, p){
  const title = p.title + ' · seniorsecured.org';
  const desc  = postDesc(p);
  const url   = postUrl(p.slug);
  const img   = p.hero_url || (SITE + '/fred-flamer-2026.jpg');

  html = swap(html, '<title>seniorsecured.org &middot; Community</title>',
                    '<title>' + esc(title) + '</title>', 'title');
  html = swap(html, '<meta name="description" content="' + SITE_DESC + '"/>',
                    '<meta name="description" content="' + esc(desc) + '"/>', 'description');
  html = swap(html, '<link rel="canonical" href="' + SITE + '/"/>',
                    '<link rel="canonical" href="' + esc(url) + '"/>', 'canonical');
  html = swap(html, '<meta property="og:url" content="' + SITE + '/"/>',
                    '<meta property="og:url" content="' + esc(url) + '"/>', 'og:url');
  html = swap(html, '<meta property="og:title" content="seniorsecured.org &middot; Community"/>',
                    '<meta property="og:title" content="' + esc(title) + '"/>', 'og:title');
  html = swap(html, '<meta property="og:description" content="' + SITE_DESC + '"/>',
                    '<meta property="og:description" content="' + esc(desc) + '"/>', 'og:description');

  /* A piece is an article, and it carries its date with it. */
  html = swap(html, '<meta property="og:type" content="website"/>',
    '<meta property="og:type" content="article"/>\n' +
    '<meta property="article:published_time" content="' + esc(iso(p.published_at)) + '"/>' +
    (p.updated_at ? '\n<meta property="article:modified_time" content="' + esc(iso(p.updated_at)) + '"/>' : '') +
    '\n<meta property="article:author" content="' + esc(p.author || 'Fred Flamer') + '"/>',
    'og:type');

  /* Cover art shares as itself and gets the wide card; the size tags
     describe the headshot, so they come out when it is not in use. */
  if(p.hero_url){
    html = swap(html,
      '<meta property="og:image" content="' + SITE + '/fred-flamer-2026.jpg"/>',
      '<meta property="og:image" content="' + esc(img) + '"/>', 'og:image');
    html = swap(html, '<meta property="og:image:width" content="512"/>\n' +
                      '<meta property="og:image:height" content="512"/>\n' +
                      '<meta property="og:image:alt" content="Fred Flamer, CISSP"/>',
                      '<meta property="og:image:alt" content="' + esc(p.hero_alt || p.title) + '"/>',
                      'og:image dimensions');
    html = swap(html, '<meta name="twitter:card" content="summary"/>',
                      '<meta name="twitter:card" content="summary_large_image"/>', 'twitter:card');
  }

  /* Article schema for this piece, alongside the site-level graph. */
  const article = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    '@id': url + '#article',
    mainEntityOfPage: url,
    headline: p.title,
    description: desc,
    image: img,
    datePublished: iso(p.published_at),
    dateModified: iso(p.updated_at || p.published_at),
    wordCount: p.word_count,
    inLanguage: 'en-US',
    isPartOf: { '@id': SITE + '/#blog' },
    author:    { '@id': SITE + '/#fred' },
    publisher: { '@id': SITE + '/#fred' }
  };
  return swap(html, '<link rel="stylesheet" href="/site.css"/>',
    '<script type="application/ld+json">\n' +
    JSON.stringify(article, null, 2).replace(/</g, '\\u003c') +
    '\n</script>\n<link rel="stylesheet" href="/site.css"/>', 'schema insertion point');
}

/* ── body ──────────────────────────────────────────────────────────── */
function sidebar(posts, current){
  return posts.map(function(p){
    const href = postPath(p.slug);
    return '<li><a class="pub" aria-current="' + (p.id === current.id) + '" href="' + esc(href) +
      '" onclick="nav(event,\'' + esc(href) + '\')">' +
      (p.hero_url ? '<img class="thumb" src="' + esc(p.hero_url) + '" alt="" loading="lazy"/>' : '') +
      '<div class="d">' + esc(shortDate(p.published_at)) + '</div>' +
      '<div class="t">' + esc(p.title) + '</div>' +
      '<div class="m"><span>' + p.read_minutes + ' min read</span>' +
      '<span class="dot">&middot;</span><span>&#10084;&#65039; ' + fmt(p.reaction_count) + '</span>' +
      '<span class="dot">&middot;</span><span>&#128172; ' + fmt(p.comment_count) + '</span>' +
      '</div></a></li>';
  }).join('');
}

function pagerLink(p, older){
  if(!p) return '';
  const dir   = older ? 'Older' : 'Newer';
  const arrow = older ? '&#8594;' : '&#8592;';
  const href  = postPath(p.slug);
  const inner = '<span class="pn"><span class="dir">' + dir + '</span>' +
                '<span class="t">' + esc(p.title) + '</span></span>';
  return '<a class="pnav ' + (older ? 'next' : 'prev') + '" href="' + esc(href) +
    '" onclick="nav(event,\'' + esc(href) + '\')" aria-label="' + dir + ' piece: ' + esc(p.title) + '">' +
    (older ? inner + '<span class="ar" aria-hidden="true">' + arrow + '</span>'
           : '<span class="ar" aria-hidden="true">' + arrow + '</span>' + inner) + '</a>';
}

function pager(posts, i){
  if(posts.length < 2) return '';
  return '<div class="half">'       + pagerLink(posts[i - 1], false) + '</div>' +
         '<div class="half right">' + pagerLink(posts[i + 1], true)  + '</div>';
}

function body(html, p, posts, i){
  if(p.hero_url){
    html = swap(html, '<figure id="p-hero" hidden><img id="p-hero-img" alt=""/></figure>',
      '<figure id="p-hero"><img id="p-hero-img" src="' + esc(p.hero_url) +
      '" alt="' + esc(p.hero_alt || '') + '"/></figure>', 'hero');
  }
  html = swap(html, '<h1 class="post-title" id="p-title"></h1>',
                    '<h1 class="post-title" id="p-title">' + esc(p.title) + '</h1>', 'headline');
  html = swap(html, '<p class="post-sub" id="p-sub"></p>',
    p.subtitle ? '<p class="post-sub" id="p-sub">' + esc(p.subtitle) + '</p>'
               : '<p class="post-sub" id="p-sub" hidden></p>', 'standfirst');
  html = swap(html, '<b id="p-author">Fred Flamer</b>',
                    '<b id="p-author">' + esc(p.author || 'Fred Flamer') + '</b>', 'author');
  html = swap(html, '<span id="p-date"></span>',
    '<time id="p-date" datetime="' + esc(iso(p.published_at)) + '">' +
    esc(longDate(p.published_at)) + '</time>', 'date');
  html = swap(html, '<span id="p-read"></span>',
                    '<span id="p-read">' + p.read_minutes + ' min read</span>', 'read time');
  html = swap(html, '<article class="article" id="p-body"></article>',
                    '<article class="article" id="p-body">' + renderBody(p.body) + '</article>', 'body');
  html = swap(html, '<span class="left" id="p-foot"></span>',
                    '<span class="left" id="p-foot">' + comma(p.word_count) + ' words</span>', 'word count');
  html = swap(html, '<ol id="pub-list"></ol>',
                    '<ol id="pub-list">' + sidebar(posts, p) + '</ol>', 'sidebar');

  const bars = pager(posts, i);
  if(bars){
    html = swap(html, '<nav class="post-nav" id="post-nav" aria-label="Move between pieces" hidden></nav>',
      '<nav class="post-nav" id="post-nav" aria-label="Move between pieces">' + bars + '</nav>', 'top pager');
    html = swap(html, '<nav class="post-nav foot" id="post-nav-foot" aria-label="Move between pieces" hidden></nav>',
      '<nav class="post-nav foot" id="post-nav-foot" aria-label="Move between pieces">' + bars + '</nav>', 'foot pager');
  }
  return html;
}

/* ── writing ───────────────────────────────────────────────────────── */
let written = 0, unchanged = 0, removed = 0;

function put(relPath, content){
  const full = join(ROOT, relPath);
  if(existsSync(full) && readFileSync(full, 'utf8') === content){ unchanged++; return; }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  written++;
  console.log('  wrote ' + relPath);
}

/* A piece pulled back to draft or deleted must stop answering 200, or its
   URL outlives the decision to unpublish it. */
function prune(slugs){
  const dir = join(ROOT, 'p');
  if(!existsSync(dir)) return;
  for(const name of readdirSync(dir)){
    if(slugs.has(name)) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
    removed++;
    console.log('  removed p/' + name + ' (no longer published)');
  }
}

function sitemap(posts){
  const url = (loc, lastmod) =>
    '  <url>\n    <loc>' + loc + '</loc>\n' +
    (lastmod ? '    <lastmod>' + lastmod.slice(0, 10) + '</lastmod>\n' : '') +
    '  </url>';
  const newest = posts.length ? iso(posts[0].published_at) : null;
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    [url(SITE + '/', newest)]
      .concat(posts.map(p => url(postUrl(p.slug), iso(p.updated_at || p.published_at))))
      .join('\n') +
    '\n</urlset>\n';
}

const ROBOTS =
`User-agent: *
Allow: /

# The analytics view is author-only and holds nothing a search engine wants.
Disallow: /dashboard

Sitemap: ${SITE}/sitemap.xml
`;

/* ── go ────────────────────────────────────────────────────────────── */
const posts = await listPosts();
if(!posts.length) throw new Error('list_posts returned nothing — refusing to wipe the prerendered pages');

console.log(posts.length + ' published pieces');
posts.forEach(function(p, i){
  put('p/' + p.slug + '/index.html', body(head(shell, p), p, posts, i));
});
prune(new Set(posts.map(p => p.slug)));
put('sitemap.xml', sitemap(posts));
put('robots.txt', ROBOTS);

console.log(written + ' written, ' + unchanged + ' unchanged, ' + removed + ' removed');
