/* ══════════════════════════════════════════════════════════════════════
   Tests for the pure rendering functions in app.js.

   These are the functions the prerender in build-static.mjs also calls, so
   a break here is a break in two places at once: what readers see, and what
   a crawler is served. The functions are pulled out of app.js rather than
   copied, so the test cannot drift from the shipped code.

       node tools/test-render.mjs
   ══════════════════════════════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'app.js'), 'utf8');

/* Top-level declarations, so the closing brace is the first one that starts
   a line. Brace counting would trip over the } inside a regex class. */
function grab(name){
  const m = new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}', 'm').exec(src);
  if(!m) throw new Error('app.js no longer defines ' + name + '()');
  return m[0];
}

const NAMES = ['esc', 'linkify', 'postExcerpt', 'navBtn', 'paintPostNav', 'postPath'];

/* navBtn/paintPostNav touch the page, so they get a stub to write into. */
const bars = {
  'post-nav':      { hidden: null, innerHTML: null },
  'post-nav-foot': { hidden: null, innerHTML: null }
};
const sandbox = new Function('document', 'state', `
  let posts = state.posts, current = state.current;
  state.setPosts = p => { posts = p; };
  state.setCurrent = c => { current = c; };
  ${NAMES.map(grab).join('\n')}
  return { ${NAMES.join(',')} };
`);

const state = { posts: [], current: null };
const { esc, linkify, postExcerpt, paintPostNav, postPath } =
  sandbox({ getElementById: id => bars[id] || null }, state);

let fails = 0;
function is(actual, expected, label){
  if(actual !== expected){
    fails++;
    console.log('FAIL ' + label + '\n  got:  ' + actual + '\n  want: ' + expected);
  }else{
    console.log('ok   ' + label);
  }
}

/* ── comment links ─────────────────────────────────────────────────── */
const A = (href, text) =>
  '<a href="' + href + '" target="_blank" rel="nofollow ugc noopener noreferrer">' + text + '</a>';

is(linkify('see https://example.com/a?b=1&c=2 now'),
   'see ' + A('https://example.com/a?b=1&amp;c=2', 'https://example.com/a?b=1&amp;c=2') + ' now',
   'bare https with a query string');
is(linkify('go to www.aarp.org.'),
   'go to ' + A('https://www.aarp.org', 'www.aarp.org') + '.',
   'www. gets a scheme, the sentence keeps its full stop');
is(linkify('javascript:alert(1)'), 'javascript:alert(1)', 'javascript: stays inert text');
is(linkify('data:text/html,<b>x</b>'), 'data:text/html,&lt;b&gt;x&lt;/b&gt;', 'data: stays inert and is escaped');
is(linkify('<script>bad()</script>'), '&lt;script&gt;bad()&lt;/script&gt;', 'markup is escaped');
is(linkify('http://evil.test/"onmouseover="alert(1)'),
   A('http://evil.test/', 'http://evil.test/') + '&quot;onmouseover=&quot;alert(1)',
   'a quote cannot break out of the href');
is(linkify('two https://a.test and https://b.test end'),
   'two ' + A('https://a.test', 'https://a.test') + ' and ' + A('https://b.test', 'https://b.test') + ' end',
   'two links in one comment');
is(linkify(null), '', 'null renders as nothing');
is(linkify('no link here'), 'no link here', 'plain text is untouched');

/* ── per-post descriptions ─────────────────────────────────────────── */
is(postExcerpt('## Heading\n\nThe **body** copy starts here.'),
   'Heading The body copy starts here.',
   'markdown markers come off the excerpt');
is(postExcerpt('See [the FTC](https://ftc.gov) for more.'),
   'See the FTC for more.',
   'link text survives, the address does not');
is(postExcerpt('word '.repeat(60), 40).length <= 41, true, 'excerpt respects the limit');
is(/…$/.test(postExcerpt('word '.repeat(60), 40)), true, 'a cut excerpt is marked as cut');
is(postExcerpt('Short enough.', 40), 'Short enough.', 'a short body is left whole');

/* ── addresses ─────────────────────────────────────────────────────── */
is(postPath('identity-theft'), '/p/identity-theft/', 'a piece address carries a trailing slash');

/* ── the pager ─────────────────────────────────────────────────────── */
const posts = [
  { id: 3, slug: 'newest', title: 'The newest piece' },
  { id: 2, slug: 'middle', title: 'The middle piece' },
  { id: 1, slug: 'oldest', title: 'The oldest piece' }
];
const paint = (list, cur) => { state.setPosts(list); state.setCurrent(cur); paintPostNav(); };

paint(posts, posts[1]);
is(bars['post-nav'].hidden, false, 'middle piece: the pager shows');
is(bars['post-nav'].innerHTML, bars['post-nav-foot'].innerHTML, 'both pagers carry the same markup');
is((bars['post-nav'].innerHTML.match(/<a /g) || []).length, 2, 'middle piece: two links');
is(bars['post-nav'].innerHTML.includes('href="/p/newest/"'), true, 'Newer points at the newest piece');
is(bars['post-nav'].innerHTML.includes('href="/p/oldest/"'), true, 'Older points at the oldest piece');

paint(posts, posts[0]);
is((bars['post-nav'].innerHTML.match(/<a /g) || []).length, 1, 'newest piece: one link');
is(bars['post-nav'].innerHTML.includes('Older'), true, 'newest piece: it is the Older one');
is(bars['post-nav'].innerHTML.includes('<div class="half"></div>'), true, 'the empty half holds its place');

paint(posts, posts[2]);
is(bars['post-nav'].innerHTML.includes('Newer'), true, 'oldest piece: it is the Newer one');

paint([posts[0]], posts[0]);
is(bars['post-nav'].hidden, true, 'one piece: nowhere to page to');
is(bars['post-nav'].innerHTML, '', 'one piece: the pager is emptied');

paint(posts, null);
is(bars['post-nav'].hidden, true, 'no piece open: the pager is hidden');

paint([{ id: 1, slug: 'x', title: '<img src=x onerror=alert(1)>' },
       { id: 2, slug: 'y', title: 'Plain' }],
      { id: 2, slug: 'y', title: 'Plain' });
is(bars['post-nav'].innerHTML.includes('<img'), false, 'a title cannot inject markup');
is(bars['post-nav'].innerHTML.includes('&lt;img'), true, 'the title is escaped, visibly');

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
