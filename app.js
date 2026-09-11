/* ═══════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════ */
let session     = null;    // Supabase auth session — the author, when signed in
let onAllowlist = false;   // …and named in public.authors. Signed in is not enough.
let posts       = [];
let postsLoaded = false;
let current     = null;    // the open post
let dashRange   = 30;
let dashPost    = '';      // '' = all posts
let lastDash    = null;    // cached payload, for resize redraws

const visitorId = idFor('ff_visitor', localStorage);
const sessionId = idFor('ff_session', sessionStorage);
const DEVICE    = deviceType();

function deviceType(){
  const ua = navigator.userAgent || '';
  if(/tablet|ipad/i.test(ua)) return 'tablet';
  if(/mobi|android|iphone/i.test(ua)) return 'mobile';
  return 'desktop';
}

function idFor(key, store){
  let v = store.getItem(key);
  if(!v){
    v = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    store.setItem(key, v);
  }
  return v;
}

/* ═══════════════════════════════════════════════════════════════
   SUPABASE
   The browser talks to Postgres directly. Reads go through RLS;
   every write goes through a security-definer function, so the
   rules live in the database rather than out here.
   ═══════════════════════════════════════════════════════════════ */
const CONFIGURED =
  typeof SUPABASE_URL === 'string' && /^https?:\/\//.test(SUPABASE_URL) &&
  !/YOUR-PROJECT-REF/.test(SUPABASE_URL) &&
  typeof SUPABASE_ANON_KEY === 'string' &&
  SUPABASE_ANON_KEY.length > 20 && !/^YOUR-ANON/.test(SUPABASE_ANON_KEY);

const db = CONFIGURED
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    })
  : null;

/* Authorship is the database's call, not ours. supabase/authors.sql gates
   every author action on membership of public.authors, so a session alone
   grants nothing — this only keeps the UI honest about it. */
const isAuthor = () => !!session && onAllowlist;

/* Re-reads the caller's own allowlist row. The authors_read_self policy
   returns exactly one row for an author and none for anyone else, so the
   count is the answer. Fails closed: any error leaves onAllowlist false. */
async function refreshAllowlist(){
  if(!session){ onAllowlist = false; return false; }
  try{
    const { data, error } = await db.from('authors').select('user_id').limit(1);
    onAllowlist = !error && Array.isArray(data) && data.length > 0;
  }catch(e){
    onAllowlist = false;
  }
  return onAllowlist;
}

/* Postgres RAISE messages arrive as error.message, so they reach the
   reader as written in schema.sql. */
async function rpc(name, args){
  const { data, error } = await db.rpc(name, args || {});
  if(error){
    const err = new Error(error.message || 'Request failed');
    err.code = error.code;
    throw err;
  }
  return data;
}

async function initAuth(){
  const { data } = await db.auth.getSession();
  session = data.session || null;
  await refreshAllowlist();
  db.auth.onAuthStateChange(function(_event, next){
    const had = isAuthor();          // measured before the session swaps
    session = next || null;
    /* supabase-js runs this callback while holding its internal auth lock,
       and every PostgREST call needs that lock to attach a token. Awaiting
       one in here deadlocks the whole client — the symptom is a Publish
       button that spins forever with no error. So the async half is pushed
       into a fresh task, which runs after the lock is released. */
    setTimeout(async function(){
      await refreshAllowlist();
      /* Drafts enter and leave list_posts() with authorship, not with the
         session, so the cache turns on the stronger test. */
      if(had !== isAuthor()){ postsLoaded = false; }
      paintAuthorBar();
    }, 0);
  });
}

async function signIn(email, password){
  const { data, error } = await db.auth.signInWithPassword({ email, password });
  if(error) throw new Error(error.message);
  session = data.session;
  postsLoaded = false;
  await refreshAllowlist();
  /* A valid password on a non-author account is a dead end: the database
     refuses every author action. Drop the session rather than leave one
     stranded — "Sign out" hangs off isAuthor(), so it would not be shown. */
  if(!onAllowlist){
    await db.auth.signOut();
    session = null;
    paintAuthorBar();
    throw new Error('That account is not an author on this site.');
  }
  paintAuthorBar();
  return session;
}

async function signOut(){
  await db.auth.signOut();
  session = null;
  onAllowlist = false;
  postsLoaded = false;
  paintAuthorBar();
  toast('Signed out.');
  go('/');
}

function paintAuthorBar(){
  document.getElementById('author-bar').innerHTML =
    '<button class="linkish" onclick="newPost()">New post</button>' +
    '<span class="dot">&middot;</span>' +
    '<button class="linkish" onclick="go(\'/dashboard\')">Analytics</button>' +
    (isAuthor()
      ? '<span class="dot">&middot;</span><button class="linkish" onclick="signOut()">Sign out</button>'
      : '');
  /* Signing in or out while a piece is open should reveal or hide the
     cover-image controls and the per-comment Delete buttons without
     needing a reload. */
  paintCoverEdit();
  if(current) paintComments(commentList);
}

/* ═══════════════════════════════════════════════════════════════
   NEWSLETTER — masthead dropdown, capture only (no send pipeline).
   Storage and de-duplication live in subscribe_newsletter(); see
   supabase/newsletter.sql.
   ═══════════════════════════════════════════════════════════════ */
function toggleNewsletter(){
  const panel = document.getElementById('nl-panel');
  const open  = panel.hidden;
  panel.hidden = !open;
  document.getElementById('nl-toggle').setAttribute('aria-expanded', String(open));
  if(open) document.getElementById('nl-name').focus();
}

function closeNewsletter(){
  document.getElementById('nl-panel').hidden = true;
  document.getElementById('nl-toggle').setAttribute('aria-expanded', 'false');
}

addEventListener('click', function(e){
  const box = document.getElementById('newsletter');
  if(box && !document.getElementById('nl-panel').hidden && !box.contains(e.target)){
    closeNewsletter();
  }
});

async function subscribeNewsletter(){
  const nameEl  = document.getElementById('nl-name');
  const emailEl = document.getElementById('nl-email');
  const name    = nameEl.value.trim();
  const email   = emailEl.value.trim();
  if(!name || !email){ toast('Enter your name and email.'); return; }
  if(!db){ toast('Not connected yet.'); return; }

  const btn = document.getElementById('nl-submit');
  btn.disabled = true;
  try{
    await rpc('subscribe_newsletter', { p_name: name, p_email: email });
    nameEl.value = ''; emailEl.value = '';
    closeNewsletter();
    toast('Subscribed — thanks!');
  }catch(e){
    toast(e.message);
  }finally{
    btn.disabled = false;
  }
}

/* ═══════════════════════════════════════════════════════════════
   ANALYTICS CLIENT
   Every measurement goes through track(). One post open at a time.
   ═══════════════════════════════════════════════════════════════ */
const tracker = {
  postId:null, seen:new Set(), active:0, mark:0, timer:null, onScroll:null,

  start(postId){
    this.stop();
    this.postId = postId; this.seen = new Set(); this.active = 0; this.mark = Date.now();
    track({ type:'view', postId, referrer: refSource() });

    this.onScroll = () => { this.depth(); this.progress(); };
    addEventListener('scroll', this.onScroll, { passive:true });
    addEventListener('resize', this.onScroll, { passive:true });
    this.onScroll();

    // Heartbeat keeps dwell alive for long reads; only counts visible time.
    this.timer = setInterval(() => { this.tick(); this.flush(false); }, 30000);
  },

  tick(){
    if(document.visibilityState === 'visible'){
      this.active += (Date.now() - this.mark) / 1000;
    }
    this.mark = Date.now();
  },

  depth(){
    const el = document.getElementById('p-body');
    if(!el) return;
    const box  = el.getBoundingClientRect();
    const seen = Math.min(Math.max(innerHeight - box.top, 0), box.height);
    const pct  = box.height ? (seen / box.height) * 100 : 0;
    for(const step of [25,50,75,100]){
      if(pct >= step && !this.seen.has(step)){
        this.seen.add(step);
        track({ type:'depth', postId:this.postId, value:step });
      }
    }
  },

  progress(){
    const bar = document.getElementById('progress');
    const el  = document.getElementById('p-body');
    if(!bar) return;
    if(!el || document.getElementById('site').hidden){ bar.style.width = '0'; return; }
    const box = el.getBoundingClientRect();
    const done = Math.min(Math.max((innerHeight - box.top) / (box.height || 1), 0), 1);
    bar.style.width = (done * 100).toFixed(1) + '%';
  },

  flush(useBeacon){
    if(!this.postId) return;
    const secs = Math.round(this.active);
    if(secs < 3) return;
    track({ type:'dwell', postId:this.postId, value:secs }, useBeacon);
  },

  stop(){
    if(this.timer) clearInterval(this.timer);
    if(this.onScroll){
      removeEventListener('scroll', this.onScroll);
      removeEventListener('resize', this.onScroll);
    }
    if(this.postId){ this.tick(); this.flush(false); }
    this.timer = null; this.onScroll = null; this.postId = null;
    const bar = document.getElementById('progress');
    if(bar) bar.style.width = '0';
  }
};

function track(ev, useBeacon){
  if(!db) return;
  const args = {
    p_post_id:    ev.postId,
    p_visitor_id: visitorId,
    p_session_id: sessionId,
    p_type:       ev.type,
    p_value:      ev.value == null ? null : ev.value,
    p_referrer:   refSource(),
    p_device:     DEVICE
  };
  if(useBeacon){
    // The page is going away and supabase-js will not outlive it, so post
    // to PostgREST directly with keepalive.
    try{
      fetch(SUPABASE_URL + '/rest/v1/rpc/track_event', {
        method:'POST', keepalive:true,
        headers:{
          'Content-Type':'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: 'Bearer ' + ((session && session.access_token) || SUPABASE_ANON_KEY)
        },
        body: JSON.stringify(args)
      }).catch(function(){});
    }catch(e){}
    return;
  }
  db.rpc('track_event', args).then(function(){}, function(){});
}

function refSource(){
  try{
    if(!document.referrer) return 'direct';
    const h = new URL(document.referrer).hostname.replace(/^www\./,'');
    return h === location.hostname ? 'internal' : h;
  }catch(e){ return 'direct'; }
}

addEventListener('visibilitychange', () => {
  tracker.tick();
  if(document.visibilityState === 'hidden') tracker.flush(true);
});
addEventListener('pagehide', () => { tracker.tick(); tracker.flush(true); });

/* ═══════════════════════════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════════════════════════ */
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* Comment text: escaped first, then bare web addresses turned into links.
   The regex is the whole allowlist — only http, https and www. become a
   link, so a "javascript:" or "data:" address stays inert text. Comments
   are reader-written, so the links carry nofollow and ugc, and the author
   can delete any comment from the discussion itself. */
function linkify(raw){
  const s  = String(raw == null ? '' : raw);
  const re = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
  let out = '', last = 0, m;
  while((m = re.exec(s)) !== null){
    let url = m[0];
    /* A URL at the end of a sentence swallows the punctuation; give it back. */
    const trail = url.match(/[.,!?;:)\]}'"]+$/);
    if(trail) url = url.slice(0, -trail[0].length);
    if(!url){ continue; }
    const href = /^www\./i.test(url) ? 'https://' + url : url;
    out += esc(s.slice(last, m.index)) +
      '<a href="' + esc(href) + '" target="_blank" rel="nofollow ugc noopener noreferrer">' +
      esc(url) + '</a>';
    last = m.index + url.length;
  }
  return out + esc(s.slice(last));
}

function inline(s){
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');
}

/* A description for one piece. Its own standfirst if it has one, else the
   opening of the piece with the markdown taken off. Every piece getting
   its own sentence is the point — a shared site blurb on 25 URLs tells a
   search engine nothing about any of them. Search results show roughly
   155 characters, so that is where it cuts, at a word boundary. */
function postExcerpt(body, limit){
  const max = limit || 155;
  const flat = String(body || '')
    .replace(/^\s*(#{1,3}|>|[-*]|\d+[.)])\s+/gm, '')   // block markers
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1') // link text only
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if(flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 0)).replace(/[,;:.\s]+$/, '') + '…';
}

function postDesc(p){
  if(!p) return SITE_DESC;
  const sub = (p.subtitle || '').trim();
  return sub || postExcerpt(p.body) || SITE_DESC;
}

/* Minimal, predictable markdown: headings, quote, lists, paragraphs. */
function renderBody(raw){
  return String(raw || '').split(/\n{2,}/).map(function(block){
    const t = block.trim();
    if(!t) return '';
    if(t.startsWith('### ')) return '<h3>' + inline(t.slice(4)) + '</h3>';
    if(t.startsWith('## '))  return '<h2>' + inline(t.slice(3)) + '</h2>';
    if(t.startsWith('# '))   return '<h2>' + inline(t.slice(2)) + '</h2>';
    if(t.startsWith('> '))
      return '<blockquote>' + inline(t.replace(/^> ?/gm,'')) + '</blockquote>';
    if(/^[-*] /.test(t))
      return '<ul>' + t.split('\n').map(l => '<li>' + inline(l.replace(/^[-*] /,'')) + '</li>').join('') + '</ul>';
    if(/^\d+[.)] /.test(t))
      return '<ol>' + t.split('\n').map(l => '<li>' + inline(l.replace(/^\d+[.)] /,'')) + '</li>').join('') + '</ol>';
    return '<p>' + inline(t).replace(/\n/g,'<br/>') + '</p>';
  }).join('');
}

/* ═══════════════════════════════════════════════════════════════
   PASTED FORMATTING → MARKDOWN

   Fred drafts in Word and Google Docs. The clipboard carries a
   text/html flavour alongside the plain text, and taking the plain
   one throws away every heading, list, link and bold run. This walks
   the HTML and emits the same minimal markdown renderBody() already
   speaks — so the stored format, the renderer and the escaping are
   all untouched, and what he sees pasted is what publishes.
   ═══════════════════════════════════════════════════════════════ */
const MD_BLOCK = /^(P|DIV|SECTION|ARTICLE|MAIN|H[1-6]|UL|OL|LI|BLOCKQUOTE|TABLE|THEAD|TBODY|TR|TD|TH|PRE|FIGURE|HR)$/;

function mdIsBold(el){
  if(/^(B|STRONG)$/.test(el.nodeName)) return true;
  const w = el.style && el.style.fontWeight;
  return !!w && /^(bold|bolder|[6-9]00)$/.test(String(w).trim());
}
function mdIsItalic(el){
  if(/^(I|EM)$/.test(el.nodeName)) return true;
  return !!(el.style && String(el.style.fontStyle).trim() === 'italic');
}

/* Inline run of a single block: text with **bold**, *italic* and links. */
function mdInline(node){
  let out = '';
  node.childNodes.forEach(function(n){
    if(n.nodeType === 3){ out += n.nodeValue.replace(/\s+/g, ' '); return; }
    if(n.nodeType !== 1) return;
    const tag = n.nodeName;
    if(tag === 'BR'){ out += '\n'; return; }
    if(tag === 'IMG'){ return; }        // cover art has its own control
    const inner = mdInline(n);
    if(!inner.trim()){ out += inner; return; }
    if(tag === 'A'){
      const href = n.getAttribute('href') || '';
      out += /^https?:/i.test(href) ? '[' + inner.trim() + '](' + href + ')' : inner;
      return;
    }
    let s = inner;
    if(mdIsItalic(n)) s = '*'  + s.trim() + '*';
    if(mdIsBold(n))   s = '**' + s.trim() + '**';
    out += s;
  });
  return out;
}

/* Block structure. Anything not recognised is descended into rather
   than dropped, so an unfamiliar wrapper costs formatting, never text. */
function mdBlocks(root){
  const out = [];
  (function walk(node){
    node.childNodes.forEach(function(n){
      if(n.nodeType === 3){
        const t = n.nodeValue.replace(/\s+/g, ' ').trim();
        if(t) out.push(t);
        return;
      }
      if(n.nodeType !== 1) return;
      const tag = n.nodeName;

      if(/^H[1-6]$/.test(tag)){
        const t = mdInline(n).trim();
        /* renderBody only has two heading levels, so h1/h2 become ##
           and everything deeper becomes ###. */
        if(t) out.push((tag === 'H1' || tag === 'H2' ? '## ' : '### ') + t);
        return;
      }
      if(tag === 'BLOCKQUOTE'){
        const t = mdInline(n).trim();
        if(t) out.push(t.split('\n').map(l => '> ' + l).join('\n'));
        return;
      }
      if(tag === 'UL' || tag === 'OL'){
        const items = [];
        let i = 1;
        Array.prototype.forEach.call(n.children, function(li){
          if(li.nodeName !== 'LI') return;
          const t = mdInline(li).trim();
          if(t) items.push(tag === 'OL' ? (i++) + '. ' + t : '- ' + t);
        });
        if(items.length) out.push(items.join('\n'));
        return;
      }
      if(tag === 'HR' || tag === 'IMG' || tag === 'BR') return;

      /* A wrapper holding other blocks is scaffolding — descend. One
         holding only inline content is a paragraph in disguise, which
         is how Word and Docs emit most body text. */
      const hasBlockChild = Array.prototype.some.call(
        n.children, c => MD_BLOCK.test(c.nodeName));
      if(MD_BLOCK.test(tag) && !hasBlockChild){
        const t = mdInline(n).trim();
        if(t) out.push(t);
        return;
      }
      walk(n);
    });
  })(root);
  return out;
}

function htmlToMarkdown(html){
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('style,script,meta,link,title,noscript').forEach(n => n.remove());

  /* Google Docs wraps the entire clipboard in <b style="font-weight:normal">.
     Left alone it turns a whole document into one bold run. */
  doc.querySelectorAll('b[style*="font-weight"]').forEach(function(b){
    if(!/font-weight\s*:\s*normal/i.test(b.getAttribute('style') || '')) return;
    while(b.firstChild) b.parentNode.insertBefore(b.firstChild, b);
    b.remove();
  });

  return mdBlocks(doc.body)
    .join('\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* execCommand keeps the browser's own undo stack alive, so Ctrl+Z after a
   paste behaves normally. setRangeText is the fallback where it is gone. */
function insertAtCursor(el, text){
  el.focus();
  let ok = false;
  try{ ok = document.execCommand('insertText', false, text); }catch(e){ ok = false; }
  if(!ok){
    const s = el.selectionStart, t = el.selectionEnd;
    el.setRangeText(text, s, t, 'end');
  }
  el.dispatchEvent(new Event('input', { bubbles:true }));
}

function fmt(n){
  n = Number(n) || 0;
  if(n >= 1000000) return (n/1000000).toFixed(1).replace(/\.0$/,'') + 'M';
  if(n >= 1000)    return (n/1000).toFixed(1).replace(/\.0$/,'') + 'K';
  return String(n);
}
function comma(n){ return (Number(n)||0).toLocaleString('en-US'); }

function mmss(seconds){
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  return m + 'm ' + String(s % 60).padStart(2,'0') + 's';
}

function longDate(d){
  return new Date(d).toLocaleDateString('en-US',{ month:'long', day:'numeric', year:'numeric' });
}
function shortDate(d){
  return new Date(d).toLocaleDateString('en-US',{ month:'short', day:'numeric', year:'numeric' });
}
function dayLabel(iso){
  const [y,m,d] = iso.split('-');
  return new Date(Date.UTC(+y, +m-1, +d)).toLocaleDateString('en-US',{ month:'short', day:'numeric' });
}

function initials(name){
  return String(name||'?').trim().split(/\s+/).map(w => w[0] || '').join('').slice(0,2).toUpperCase();
}

let toastTimer;
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

const view = () => document.getElementById('view');
function loading(msg){ view().innerHTML = '<p class="empty">' + esc(msg || 'Loading…') + '</p>'; }
function errorBox(e){
  view().innerHTML = '<div class="panel"><h4>Something went wrong</h4><p style="color:var(--muted)">' +
    esc(e.message || e) + '</p></div>';
}

/* Writes a message into the blog panel — used for empty / error states. */
function blogNotice(heading, detail){
  /* No post is open, so neither the cover art nor its editing controls
     belong on screen. */
  document.getElementById('p-hero').hidden = true;
  document.getElementById('post-tools').hidden = true;
  document.getElementById('p-flag').hidden = true;
  document.getElementById('p-title').textContent = heading;
  document.getElementById('p-sub').hidden = true;
  document.getElementById('p-byline').hidden = true;
  document.getElementById('p-actions').hidden = true;
  document.getElementById('p-body').innerHTML = '<p style="color:var(--muted)">' + esc(detail) + '</p>';
  document.getElementById('comments').innerHTML = '';
  ['post-nav','post-nav-foot'].forEach(function(id){
    const bar = document.getElementById(id);
    if(bar){ bar.hidden = true; bar.innerHTML = ''; }
  });
}

/* ═══════════════════════════════════════════════════════════════
   ROUTER  —  "/" newest piece · "/p/<slug>" a piece · "/dashboard"
   ═══════════════════════════════════════════════════════════════ */
function go(path, replace){
  if(location.pathname !== path){
    history[replace ? 'replaceState' : 'pushState']({}, '', path);
  }
  route();
}
addEventListener('popstate', route);

/* One spelling of a piece's address, used by every link, the canonical
   tag and the share button. The trailing slash is the form GitHub Pages
   serves the prerendered file at, so the two agree and no link earns a
   redirect. */
function postPath(slug){ return '/p/' + encodeURIComponent(slug) + '/'; }

/* Every navigation is a real <a href>, so a crawler can follow it and a
   reader can middle-click it. This only intercepts the plain left click
   and hands it to the router; everything else is left to the browser. */
function nav(ev, path){
  if(!ev) return;
  if(ev.defaultPrevented) return;
  if(ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button) return;
  ev.preventDefault();
  go(path);
}

/* Canonical origin. Falls back to wherever the page is actually served
   from, so `vercel dev` and preview deploys stay self-consistent. */
const SITE_URL   = 'https://seniorsecured.org';
const SITE_TITLE = 'seniorsecured.org · Community';
/* Kept identical to the description in index.html's head — routing back to
   the home page has to restore what was served, not a second wording. */
const SITE_DESC  = 'Plain-spoken cybersecurity and fraud-prevention writing for seniors: phone scams, phishing, identity theft and more. By Fred Flamer, CISSP.';

function canonicalOrigin(){
  return /^https?:\/\/(localhost|127\.|\[::1\])/.test(location.origin) ? location.origin : SITE_URL;
}
/* Keeps <title>, canonical and the og:* tags pointing at the same URL. */
const SITE_IMAGE = 'https://seniorsecured.org/fred-flamer-2026.jpg';

/* The headshot's real size, so a scraper can lay out the card before it
   has fetched the file. A cover image's size is not known here. */
const SITE_IMAGE_W = 512, SITE_IMAGE_H = 512;

/* Creates, updates or removes one meta tag. Removal matters: article:* on
   the home page would describe a piece that is not open. */
function metaTag(prop, val, attr){
  const key = attr || 'property';
  const sel = 'meta[' + key + '="' + prop + '"]';
  let el = document.head.querySelector(sel);
  if(val == null){ if(el) el.remove(); return; }
  if(!el){
    el = document.createElement('meta');
    el.setAttribute(key, prop);
    document.head.appendChild(el);
  }
  el.setAttribute('content', val);
}

function setMeta(path, title, desc, image, post){
  const url = canonicalOrigin() + path;
  document.title = title;
  const set = (sel, attr, val) => {
    const el = document.querySelector(sel);
    if(el && val != null) el.setAttribute(attr, val);
  };
  set('link[rel="canonical"]', 'href', url);
  set('meta[property="og:url"]', 'content', url);
  set('meta[property="og:title"]', 'content', title);
  if(desc){
    set('meta[name="description"]', 'content', desc);
    set('meta[property="og:description"]', 'content', desc);
  }
  /* A piece is an article; the home page is the site itself. The
     distinction is what lets a crawler and a share card treat the two
     differently, and it carries the publication date with it. */
  set('meta[property="og:type"]', 'content', post ? 'article' : 'website');
  metaTag('article:published_time', post && post.published_at
    ? new Date(post.published_at).toISOString() : null);
  metaTag('article:modified_time', post && post.updated_at
    ? new Date(post.updated_at).toISOString() : null);
  metaTag('article:author', post ? (post.author || 'Fred Flamer') : null);

  /* A piece with cover art shares as that picture; everything else falls
     back to Fred's headshot. summary_large_image only earns its keep when
     there is a wide picture to show. */
  set('meta[property="og:image"]', 'content', image || SITE_IMAGE);
  metaTag('og:image:alt', image
    ? ((post && post.hero_alt) || title)
    : 'Fred Flamer, CISSP');
  /* Only the headshot's dimensions are known, so the size tags come and
     go with it rather than lying about a cover image. */
  metaTag('og:image:width',  image ? null : String(SITE_IMAGE_W));
  metaTag('og:image:height', image ? null : String(SITE_IMAGE_H));
  set('meta[name="twitter:card"]', 'content', image ? 'summary_large_image' : 'summary');
}

async function route(){
  tracker.stop();
  scrollTo(0,0);
  const path = location.pathname;

  if(path === '/dashboard'){
    document.getElementById('site').hidden = true;
    document.getElementById('dash').hidden = false;
    return showDashboard();
  }

  document.getElementById('dash').hidden = true;
  document.getElementById('site').hidden = false;

  try{ await ensurePosts(); }
  catch(e){ return blogNotice('Something went wrong', e.message || String(e)); }

  if(!posts.length){
    paintList();
    return blogNotice('No posts yet', 'Use “New post” at the foot of the page to publish the first piece.');
  }

  const m = path.match(/^\/p\/([^/]+)\/?$/);
  return showPost(m ? decodeURIComponent(m[1]) : posts[0].slug, !m);
}

/* One list fetch per page load; the sidebar and the home post both use it. */
async function ensurePosts(force){
  if(postsLoaded && !force) return posts;
  posts = (await rpc('list_posts', { include_drafts: isAuthor() })) || [];
  postsLoaded = true;
  return posts;
}

/* ═══════════════════════════════════════════════════════════════
   ④ LATEST PUBLISHINGS — newest first; click swaps ③
   ═══════════════════════════════════════════════════════════════ */
function paintList(){
  document.getElementById('pub-list').innerHTML = posts.map(function(p){
    const on = current && p.id === current.id;
    const href = postPath(p.slug);
    return '<li><a class="pub" aria-current="' + on + '" href="' + esc(href) +
      '" onclick="nav(event,\'' + esc(href) + '\')">' +
      (p.hero_url ? '<img class="thumb" src="' + esc(p.hero_url) + '" alt="" loading="lazy"/>' : '') +
      '<div class="d">' + esc(shortDate(p.published_at)) + '</div>' +
      '<div class="t">' + (p.status !== 'published' ? '<span class="tag draft">Draft</span> ' : '') +
        esc(p.title) + '</div>' +
      '<div class="m"><span>' + p.read_minutes + ' min read</span>' +
      '<span class="dot">&middot;</span><span>&#10084;&#65039; ' + fmt(p.reaction_count) + '</span>' +
      '<span class="dot">&middot;</span><span>&#128172; ' + fmt(p.comment_count) + '</span>' +
      '</div></a></li>';
  }).join('');
}

/* ── the article pager ─────────────────────────────────────────────
   posts[] is newest first, so the piece before the current one in the
   array is the newer read and the one after it is the older. Drafts are
   in that array only while an author is signed in, which is the same
   rule the sidebar follows — the two stay in step by construction. */
function navBtn(p, older){
  if(!p) return '';
  const dir   = older ? 'Older' : 'Newer';
  const arrow = older ? '&#8594;' : '&#8592;';
  const inner = '<span class="pn"><span class="dir">' + dir + '</span>' +
                '<span class="t">' + esc(p.title) + '</span></span>';
  const href = postPath(p.slug);
  return '<a class="pnav ' + (older ? 'next' : 'prev') + '"' +
    ' href="' + esc(href) + '" onclick="nav(event,\'' + esc(href) + '\')"' +
    ' aria-label="' + dir + ' piece: ' + esc(p.title) + '">' +
    (older ? inner + '<span class="ar" aria-hidden="true">' + arrow + '</span>'
           : '<span class="ar" aria-hidden="true">' + arrow + '</span>' + inner) +
    '</a>';
}

function paintPostNav(){
  const i = current ? posts.findIndex(p => p.id === current.id) : -1;
  const html = i < 0 ? '' :
    '<div class="half">'       + navBtn(posts[i - 1], false) + '</div>' +
    '<div class="half right">' + navBtn(posts[i + 1], true)  + '</div>';
  /* One piece on the site means nothing to page to. */
  const show = i >= 0 && posts.length > 1;
  ['post-nav','post-nav-foot'].forEach(function(id){
    const bar = document.getElementById(id);
    if(!bar) return;
    bar.hidden = !show;
    bar.innerHTML = show ? html : '';
  });
}

/* ═══════════════════════════════════════════════════════════════
   ③ THE BLOG BODY
   ═══════════════════════════════════════════════════════════════ */
function paintHero(){
  const hero = document.getElementById('p-hero');
  const img  = document.getElementById('p-hero-img');
  if(current && current.hero_url){
    img.src = current.hero_url;
    /* Empty alt marks it decorative, which is the honest label when no
       description was written — better than a screen reader announcing
       the filename or reading the headline twice. */
    img.alt = current.hero_alt || '';
    hero.hidden = false;
  }else{
    img.removeAttribute('src');
    hero.hidden = true;
  }
}

async function showPost(slug, isHome){
  let data;
  try{ data = await rpc('get_post', { p_slug: slug }); }
  catch(e){ return blogNotice('Something went wrong', e.message || String(e)); }

  if(!data){
    current = null;
    paintList();
    return blogNotice('Not found', 'That piece isn’t here. Pick another from “Latest publishings”.');
  }

  current = data.post;
  setMeta(isHome ? '/' : postPath(current.slug),
          isHome ? SITE_TITLE : current.title + ' · seniorsecured.org',
          isHome ? SITE_DESC : postDesc(current),
          current.hero_url,
          isHome ? null : current);

  paintHero();
  paintCoverEdit();

  document.getElementById('p-flag').hidden = current.status === 'published';
  document.getElementById('p-title').textContent = current.title;

  const sub = document.getElementById('p-sub');
  sub.textContent = current.subtitle || '';
  sub.hidden = !current.subtitle;

  document.getElementById('p-byline').hidden = false;
  document.getElementById('p-author').textContent = current.author;
  document.getElementById('p-date').textContent = longDate(current.published_at);
  document.getElementById('p-read').textContent = current.read_minutes + ' min read';
  document.getElementById('p-body').innerHTML = renderBody(current.body);
  document.getElementById('p-actions').hidden = false;
  document.getElementById('p-foot').textContent = comma(current.word_count) + ' words';

  paintReacts(data.reactions);
  paintList();
  paintPostNav();
  paintComments(data.comments || []);
  tracker.start(current.id);
}

/* ── the reactions ─────────────────────────────────────────── */
/* The three kinds the schema accepts. Adding a fourth means a check
   constraint change in schema.sql as well as a row here.            */
const REACTIONS = [
  { kind:'heart', emoji:'&#10084;&#65039;',
    off:'Heart this read',      on:'You hearted this',
    thanks:'❤️  Thanks for the love.' },
  { kind:'thumb', emoji:'&#128077;',
    off:'Give this a thumbs up', on:'You gave this a thumbs up',
    thanks:'👍  Glad it landed.' },
  { kind:'bulb',  emoji:'&#128161;',
    off:'Mark this as useful',   on:'You marked this useful',
    thanks:'💡  Good — that is the whole point.' }
];

function reactKey(kind){ return 'ff_r_' + current.id + '_' + kind; }

/* list_posts() counts every kind, so the sidebar tally must too. */
function reactTotal(counts){
  return REACTIONS.reduce((s, r) => s + ((counts && counts[r.kind]) || 0), 0);
}

function paintReacts(counts){
  document.getElementById('reacts').innerHTML = REACTIONS.map(function(r){
    const on  = localStorage.getItem(reactKey(r.kind)) === '1';
    const lab = on ? r.on : r.off;
    return '<button class="react" type="button" data-kind="' + r.kind + '"' +
      ' aria-pressed="' + on + '" title="' + lab + '" aria-label="' + lab + '"' +
      ' onclick="toggleReact(\'' + r.kind + '\')">' +
      '<span class="em" aria-hidden="true">' + r.emoji + '</span>' +
      '<span class="n">' + fmt((counts && counts[r.kind]) || 0) + '</span></button>';
  }).join('');
}

async function toggleReact(kind){
  const meta = REACTIONS.find(r => r.kind === kind);
  const btn  = document.querySelector('.react[data-kind="' + kind + '"]');
  if(btn) btn.disabled = true;
  try{
    const res = await rpc('toggle_reaction', {
      p_post_id: current.id, p_visitor_id: visitorId, p_kind: kind
    });
    if(res.added) localStorage.setItem(reactKey(kind), '1');
    else localStorage.removeItem(reactKey(kind));

    // Keep the sidebar's count in step with the post we just changed.
    const row = posts.find(p => p.id === current.id);
    if(row) row.reaction_count = reactTotal(res.reactions);

    paintReacts(res.reactions);   // re-renders, so the disabled state clears
    paintList();
    if(res.added && meta) toast(meta.thanks);
  }catch(e){
    toast(e.message);
    if(btn) btn.disabled = false;
  }
}

async function sharePost(){
  const url = location.origin + postPath(current.slug);
  try{
    if(navigator.share) await navigator.share({ title: current.title, url });
    else { await navigator.clipboard.writeText(url); toast('Link copied.'); }
    track({ type:'share', postId: current.id });
  }catch(e){ /* user dismissed */ }
}

/* ── comments ──────────────────────────────────────────────── */
/* The list last painted. Signing in or out has to repaint it — the
   author's Delete buttons appear and vanish with authorship. */
let commentList = [];

function paintComments(list){
  const box = document.getElementById('comments');
  if(!box) return;
  list = list || [];
  commentList = list;
  box.innerHTML =
    '<h3>Discussion (' + list.length + ' comment' + (list.length !== 1 ? 's' : '') + ')</h3>' +
    '<div id="c-list">' +
      (list.length
        ? list.map(function(c){
            return '<div class="c-card" id="c-' + c.id + '"><div class="c-top">' +
              '<span class="c-init" aria-hidden="true">' + initials(c.name) + '</span>' +
              '<span class="c-name">' + esc(c.name) + '</span>' +
              '<span class="c-date">' + esc(shortDate(c.created_at)) + '</span>' +
              /* Moderation lives where the comment is, not in a separate
                 screen. comments_author_del in authors.sql is what actually
                 permits it; this button only offers it. */
              (isAuthor()
                ? '<button type="button" class="linkish c-del" onclick="deleteComment(' + c.id + ')"' +
                  ' aria-label="Delete the comment by ' + esc(c.name) + '">Delete</button>'
                : '') +
              '</div>' +
              '<div class="c-text">' + linkify(c.body) + '</div></div>';
          }).join('')
        : '<p class="empty">No comments yet. Be the first.</p>') +
    '</div>' +
    '<div class="panel" style="margin-top:12px"><h4>Join the discussion</h4>' +
      '<div class="fg"><label for="c-name">Your name</label>' +
        '<input type="text" id="c-name" maxlength="60" placeholder="First name or nickname" value="' +
        esc(localStorage.getItem('ff_name') || '') + '"/></div>' +
      '<div class="fg"><label for="c-text">Comment</label>' +
        '<textarea id="c-text" maxlength="2000" placeholder="Share your thoughts…"></textarea></div>' +
      '<button class="btn" id="c-btn" onclick="postComment()">Post comment</button></div>';
}

/* Re-reads the discussion and repaints it, keeping the sidebar tally in
   step. The comments_read policy returns approved rows to anyone, so this
   is the same view a signed-out reader gets. */
async function refreshComments(){
  const { data, error } = await db.from('comments')
    .select('id,name,body,created_at')
    .eq('post_id', current.id).eq('approved', true)
    .order('created_at', { ascending: true });
  if(error) throw new Error(error.message);
  const fresh = data || [];
  paintComments(fresh);
  const row = posts.find(p => p.id === current.id);
  if(row){ row.comment_count = fresh.length; paintList(); }
  return fresh;
}

async function postComment(){
  const name = (document.getElementById('c-name').value || '').trim();
  const body = (document.getElementById('c-text').value || '').trim();
  if(!name || !body){ toast('Please add your name and a comment.'); return; }
  const btn = document.getElementById('c-btn');
  btn.disabled = true; btn.textContent = 'Posting…';
  try{
    await rpc('add_comment', {
      p_post_id: current.id, p_name: name, p_body: body, p_visitor_id: visitorId
    });
    localStorage.setItem('ff_name', name);
    await refreshComments();
    toast('Comment posted.');
  }catch(e){
    toast(e.message);
    btn.disabled = false; btn.textContent = 'Post comment';
  }
}

/* Author-only, and the database says so too: comments_author_del in
   authors.sql permits a delete only for a row in public.authors, so a
   forged call from a reader's console deletes nothing. */
async function deleteComment(id){
  if(!isAuthor() || !current) return;
  if(!confirm('Delete this comment? This cannot be undone.')) return;
  try{
    const { error } = await db.from('comments').delete().eq('id', id);
    if(error) throw new Error(error.message);
    await refreshComments();
    toast('Comment deleted.');
  }catch(e){
    toast(e.message || 'Could not delete that comment.');
  }
}

/* ═══════════════════════════════════════════════════════════════
   EDITOR
   ═══════════════════════════════════════════════════════════════ */
/* null while writing something new; a post id while revising one. The
   composer is the same form either way — only where it saves changes. */
let editingId = null;

function paintComposerMode(){
  const editing = editingId !== null;
  document.getElementById('btn-publish').textContent =
    editing ? 'Save changes' : 'Publish';
  document.getElementById('btn-draft').textContent =
    editing ? 'Move to drafts' : 'Save as draft';
  document.getElementById('btn-cancel-edit').hidden = !editing;
  document.getElementById('btn-delete-post').hidden = !editing;
  document.getElementById('composer-mode').textContent =
    editing ? 'Editing a published piece — the web address stays the same.' : '';
}

/* Blank form, ready for something new. */
function newPost(){
  editingId = null;
  document.getElementById('in-title').value = '';
  document.getElementById('in-sub').value   = '';
  document.getElementById('in-body').value  = '';
  document.getElementById('wordcount').textContent = '';
  clearHero();
  setTab('write');
  openEditor();
}

/* The piece on screen, loaded into the same form. */
function editPost(){
  if(!isAuthor() || !current) return;
  editingId = current.id;
  document.getElementById('in-title').value = current.title || '';
  document.getElementById('in-sub').value   = current.subtitle || '';
  document.getElementById('in-body').value  = current.body || '';
  document.getElementById('in-body').dispatchEvent(new Event('input', { bubbles:true }));

  heroUrl = current.hero_url || null;
  document.getElementById('in-hero').value = '';
  document.getElementById('in-hero-alt').value = current.hero_alt || '';
  document.getElementById('hero-preview').hidden = !heroUrl;
  if(heroUrl) document.getElementById('hero-thumb').src = heroUrl;
  heroStatus('');

  setTab('write');
  openEditor();
}

function openEditor(){
  document.getElementById('overlay').classList.add('open');
  const locked = !isAuthor();
  document.getElementById('gate').hidden = !locked;
  document.getElementById('composer').hidden = locked;
  paintComposerMode();
  setTimeout(function(){
    const el = document.getElementById(locked ? 'pw-email' : 'in-title');
    if(el) el.focus();
  }, 60);
}
/* Always drop out of edit mode on close. Otherwise a cancelled edit would
   leave editingId set, and the next thing written from this form would
   overwrite that piece instead of becoming a new one. */
function closeEditor(){
  document.getElementById('overlay').classList.remove('open');
  editingId = null;
  paintComposerMode();
}
function overlayClick(e){ if(e.target.id === 'overlay') closeEditor(); }
addEventListener('keydown', function(e){ if(e.key === 'Escape') closeEditor(); });
document.getElementById('pw').addEventListener('keydown', function(e){ if(e.key === 'Enter') unlock(); });
document.getElementById('pw-email').addEventListener('keydown', function(e){ if(e.key === 'Enter') document.getElementById('pw').focus(); });

async function unlock(){
  const email = (document.getElementById('pw-email').value || '').trim();
  const pass  = document.getElementById('pw').value;
  if(!email || !pass) return;
  try{
    await signIn(email, pass);
    document.getElementById('gate').hidden = true;
    document.getElementById('composer').hidden = false;
    document.getElementById('in-title').focus();
    await ensurePosts(true);                       // drafts become visible
    paintList();
    toast('Signed in.');
  }catch(e){
    document.getElementById('pw').value = '';
    toast(e.message || 'Sign-in failed.');
  }
}

function setTab(which){
  const tabs = document.querySelectorAll('.tabs button');
  tabs[0].setAttribute('aria-selected', String(which === 'write'));
  tabs[1].setAttribute('aria-selected', String(which === 'preview'));
  document.getElementById('write-pane').hidden = which !== 'write';
  const pv = document.getElementById('preview');
  pv.hidden = which === 'write';
  if(which === 'preview'){
    const body = document.getElementById('in-body').value;
    pv.innerHTML = body.trim() ? renderBody(body)
                               : '<p style="color:var(--muted)">Nothing to preview yet.</p>';
  }
}

document.getElementById('in-body').addEventListener('input', function(e){
  const words = e.target.value.trim().split(/\s+/).filter(Boolean).length;
  document.getElementById('wordcount').textContent =
    comma(words) + ' words · ~' + Math.max(1, Math.round(words / 220)) + ' min read';
});

document.getElementById('in-body').addEventListener('paste', function(e){
  const cd = e.clipboardData || window.clipboardData;
  if(!cd) return;
  const html = cd.getData('text/html');
  if(!html) return;                    // plain text: the browser's default is right
  let md;
  try{ md = htmlToMarkdown(html); }
  catch(err){ return; }                // anything unexpected falls back to plain text
  if(!md) return;
  e.preventDefault();
  insertAtCursor(this, md);
});

/* ═══════════════════════════════════════════════════════════════
   COVER IMAGE

   Uploaded the moment it is chosen, not at publish time, so a slow
   connection blocks the picture rather than the piece — and Fred
   sees whether it worked while he still has the editor open.
   ═══════════════════════════════════════════════════════════════ */
let heroUrl = null;

const HERO_MAX_DIM = 1600;   // px on the long edge — plenty for a full-width cover
const HERO_QUALITY = 0.82;

function heroStatus(msg){ document.getElementById('hero-status').textContent = msg || ''; }

function clearHero(){
  heroUrl = null;
  document.getElementById('in-hero').value = '';
  document.getElementById('in-hero-alt').value = '';
  document.getElementById('hero-preview').hidden = true;
  document.getElementById('hero-thumb').removeAttribute('src');
  heroStatus('');
}

/* A phone photo is 4-6 MB and far larger than it will ever be shown.
   Shrinking in the browser keeps the article quick to load and the
   storage bucket inside the free tier. */
function downscaleImage(file){
  return new Promise(function(resolve, reject){
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function(){
      URL.revokeObjectURL(url);
      const scale = Math.min(1, HERO_MAX_DIM / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width  * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      /* JPEG has no alpha, so a transparent PNG would flatten to black
         without this. */
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      c.toBlob(function(blob){
        blob ? resolve(blob) : reject(new Error('This browser could not process that image.'));
      }, 'image/jpeg', HERO_QUALITY);
    };
    img.onerror = function(){
      URL.revokeObjectURL(url);
      reject(new Error('That file does not look like an image.'));
    };
    img.src = url;
  });
}

/* Shrink, upload, hand back the public URL. Shared by the composer and by
   the on-article control, so both behave identically. */
async function uploadCover(file){
  const blob = await downscaleImage(file);
  const name = 'covers/' + Date.now() + '-' +
               Math.random().toString(36).slice(2, 8) + '.jpg';
  const { error } = await db.storage.from('post-images')
    .upload(name, blob, { contentType:'image/jpeg', cacheControl:'31536000', upsert:false });
  if(error) throw new Error(error.message);
  return { url: db.storage.from('post-images').getPublicUrl(name).data.publicUrl,
           bytes: blob.size };
}

/* Public URLs look like …/object/public/post-images/covers/xyz.jpg — the
   bucket-relative path is whatever follows the bucket name. Returns null
   for anything not in our bucket, so a hand-edited URL is never a delete
   instruction. */
function coverPathFromUrl(url){
  const m = String(url || '').match(/\/object\/public\/post-images\/(.+)$/);
  return m ? decodeURIComponent(m[1].split('?')[0]) : null;
}

/* Best effort: an orphaned file costs a little storage, a failed publish
   costs Fred his work. Never let cleanup break the operation. */
async function deleteCover(url){
  const path = coverPathFromUrl(url);
  if(!path) return;
  try{ await db.storage.from('post-images').remove([path]); }catch(e){}
}

document.getElementById('in-hero').addEventListener('change', async function(){
  const file = this.files && this.files[0];
  if(!file) return;
  if(!isAuthor()){ heroStatus('Sign in before adding a picture.'); this.value = ''; return; }

  heroStatus('Preparing…');
  try{
    const previous = heroUrl;
    heroStatus('Uploading…');
    const { url, bytes } = await uploadCover(file);
    /* Swapping the picture before publishing leaves the first upload
       unreferenced — bin it now rather than let it linger. */
    if(previous && previous !== url) deleteCover(previous);
    heroUrl = url;
    document.getElementById('hero-thumb').src = heroUrl;
    document.getElementById('hero-preview').hidden = false;
    heroStatus(Math.round(bytes / 1024) + ' KB · ready');
  }catch(e){
    heroUrl = null;
    this.value = '';
    document.getElementById('hero-preview').hidden = true;
    heroStatus(e.message || 'Upload failed.');
  }
});

/* ── changing the cover after publication ──────────────────────────
   The posts_author_upd policy in authors.sql already permits an
   allowlisted author to update any post, so this needs no new grant. */
function paintCoverEdit(){
  const bar = document.getElementById('post-tools');
  if(!bar) return;
  const show = isAuthor() && !!current;
  bar.hidden = !show;
  if(!show) return;
  document.getElementById('hero-edit-label').textContent =
    current.hero_url ? 'Replace cover image' : 'Add a cover image';
  document.getElementById('hero-remove').hidden = !current.hero_url;
  document.getElementById('hero-edit-status').textContent = '';
}

function coverEditStatus(msg){
  const el = document.getElementById('hero-edit-status');
  if(el) el.textContent = msg || '';
}

async function saveCover(url, alt){
  const { error } = await db.from('posts')
    .update({ hero_url: url, hero_alt: alt })
    .eq('id', current.id);
  if(error) throw new Error(error.message);
  current.hero_url = url;
  current.hero_alt = alt;
  /* The sidebar carries thumbnails, so its copy of the row is stale now. */
  const row = posts.find(p => p.id === current.id);
  if(row){ row.hero_url = url; row.hero_alt = alt; }
  paintHero();
  paintList();
  paintCoverEdit();
}

document.getElementById('p-hero-file').addEventListener('change', async function(){
  const file = this.files && this.files[0];
  if(!file) return;
  this.value = '';
  if(!isAuthor() || !current) return;

  coverEditStatus('Preparing…');
  try{
    const previous = current.hero_url;
    coverEditStatus('Uploading…');
    const { url } = await uploadCover(file);
    const alt = prompt('Describe the picture for people using a screen reader (optional):',
                       current.hero_alt || '');
    await saveCover(url, (alt || '').trim() || null);
    if(previous && previous !== url) deleteCover(previous);
    toast('Cover image updated.');
  }catch(e){
    coverEditStatus(e.message || 'Could not update the cover image.');
  }
});

async function removeCover(){
  if(!isAuthor() || !current || !current.hero_url) return;
  if(!confirm('Remove the cover image from this piece?')) return;
  const previous = current.hero_url;
  coverEditStatus('Removing…');
  try{
    await saveCover(null, null);
    deleteCover(previous);
    toast('Cover image removed.');
  }catch(e){
    coverEditStatus(e.message || 'Could not remove the cover image.');
  }
}

async function publish(status){
  const title = (document.getElementById('in-title').value || '').trim();
  const body  = (document.getElementById('in-body').value  || '').trim();
  const subtitle = (document.getElementById('in-sub').value || '').trim();
  if(!title || !body){ toast('A title and some body text are required.'); return; }

  const editing = editingId !== null;
  const btn = document.getElementById('btn-publish');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…';
  try{
    /* RLS lets only an allowlisted author write. On insert the slug trigger
       builds a unique slug from the title; on update it leaves the existing
       slug alone, so revising a headline never breaks a shared link. */
    const row = { title, subtitle: subtitle || null, body, status };
    /* Hero columns are named only when there is an image, so a database
       without supabase/post-images.sql can still take a new post. On an
       edit they are always sent — clearing the picture has to be able to
       write null. */
    const alt = (document.getElementById('in-hero-alt').value || '').trim() || null;
    if(heroUrl){ row.hero_url = heroUrl; row.hero_alt = alt; }
    else if(editing){ row.hero_url = null; row.hero_alt = null; }

    let slug;
    if(editing){
      const { data, error } = await db.from('posts')
        .update(row).eq('id', editingId).select('slug').single();
      if(error) throw new Error(error.message);
      slug = data.slug;
    }else{
      const { data, error } = await db.from('posts')
        .insert(row).select('slug').single();
      if(error) throw new Error(error.message);
      slug = data.slug;
    }

    editingId = null;
    document.getElementById('in-title').value = '';
    document.getElementById('in-sub').value = '';
    document.getElementById('in-body').value = '';
    document.getElementById('wordcount').textContent = '';
    clearHero();
    closeEditor();
    toast(editing ? (status === 'draft' ? 'Moved to drafts.' : 'Changes saved.')
                  : (status === 'draft' ? 'Draft saved.'     : 'Published.'));
    /* Force a refetch: the sidebar, the word count and the body all just
       changed underneath the cached copy. go() routes unconditionally, so
       the article itself is re-read even when the URL has not moved. */
    await ensurePosts(true);
    go('/p/' + slug);
  }catch(e){ toast(e.message); }
  finally{ btn.disabled = false; btn.textContent = label; }
}

/* Gone for good — RLS lets only an allowlisted author do this. Confirmed
   because there is no undo, matching the cover-image removal prompt above. */
async function deletePost(){
  if(!isAuthor() || editingId === null) return;
  const title = (document.getElementById('in-title').value || '').trim();
  if(!confirm('Delete "' + (title || 'this post') + '"? This cannot be undone.')) return;

  const id = editingId;
  const heroToDelete = heroUrl;
  const btn = document.getElementById('btn-delete-post');
  btn.disabled = true; btn.textContent = 'Deleting…';
  try{
    const { error } = await db.from('posts').delete().eq('id', id);
    if(error) throw new Error(error.message);
    if(heroToDelete) deleteCover(heroToDelete);

    editingId = null;
    document.getElementById('in-title').value = '';
    document.getElementById('in-sub').value = '';
    document.getElementById('in-body').value = '';
    document.getElementById('wordcount').textContent = '';
    clearHero();
    closeEditor();
    toast('Post deleted.');
    await ensurePosts(true);
    go('/');
  }catch(e){ toast(e.message); }
  finally{ btn.disabled = false; btn.textContent = 'Delete post'; }
}

/* ═══════════════════════════════════════════════════════════════
   VIEW: DASHBOARD
   ═══════════════════════════════════════════════════════════════ */
const RANGES = [ {d:7,l:'7 days'}, {d:30,l:'30 days'}, {d:90,l:'90 days'}, {d:0,l:'All time'} ];

async function showDashboard(){
  setMeta('/dashboard', 'Analytics · seniorsecured.org');

  if(!isAuthor()){
    view().innerHTML = '<div class="panel" style="max-width:360px">' +
      '<h4>Author access</h4>' +
      '<div class="fg"><label for="dash-email">Email</label>' +
        '<input type="email" id="dash-email" autocomplete="username"/></div>' +
      '<div class="fg"><label for="dash-pw">Password</label>' +
        '<input type="password" id="dash-pw" autocomplete="current-password"/></div>' +
      '<button class="btn" onclick="dashUnlock()">View analytics</button></div>';
    const el = document.getElementById('dash-email');
    el.focus();
    document.getElementById('dash-pw')
      .addEventListener('keydown', function(e){ if(e.key === 'Enter') dashUnlock(); });
    return;
  }

  loading('Crunching numbers…');
  let data;
  try{
    data = await rpc('analytics', {
      p_days:    dashRange,
      p_post_id: dashPost ? Number(dashPost) : null
    });
  }catch(e){
    // A stale or expired session shows up here as a permission error.
    if(e.code === '42501'){ session = null; paintAuthorBar(); return showDashboard(); }
    return errorBox(e);
  }
  lastDash = data;
  paintDashboard(data);
}

async function dashUnlock(){
  const email = (document.getElementById('dash-email').value || '').trim();
  const pass  = document.getElementById('dash-pw').value;
  if(!email || !pass) return;
  try{
    await signIn(email, pass);          // also reloads the sidebar with drafts
    showDashboard();
  }catch(e){
    document.getElementById('dash-pw').value = '';
    toast(e.message || 'Sign-in failed.');
  }
}

function paintDashboard(d){
  const t = d.totals;
  const scoped = dashPost ? d.posts.filter(p => String(p.id) === String(dashPost)) : d.posts;
  const scopeName = dashPost ? ((scoped[0] || {}).title || 'this post') : 'all posts';
  const reacts = scoped.reduce((s,p) => s + (p.reactions || 0), 0);
  const comms  = scoped.reduce((s,p) => s + (p.comments  || 0), 0);

  view().innerHTML =
    '<div class="filters">' +
      RANGES.map(r => '<button class="chip" aria-pressed="' + (r.d === dashRange) +
        '" onclick="setRange(' + r.d + ')">' + r.l + '</button>').join('') +
      '<select id="post-filter" onchange="setDashPost(this.value)" aria-label="Filter by post">' +
        '<option value="">All posts</option>' +
        d.posts.map(p => '<option value="' + p.id + '"' +
          (String(p.id) === String(dashPost) ? ' selected' : '') + '>' +
          esc(p.title.length > 46 ? p.title.slice(0,46) + '…' : p.title) + '</option>').join('') +
      '</select>' +
    '</div>' +

    '<div class="hero"><div class="n">' + comma(t.views) + '</div>' +
      '<div class="lbl">reads of ' + esc(scopeName) + ' · ' +
      (dashRange ? 'last ' + dashRange + ' days' : 'all time') + '</div></div>' +

    '<div class="tiles">' +
      tile('Unique readers', comma(t.readers), 'distinct visitors') +
      tile('Average attention', mmss(t.avg_dwell), comma(t.dwell_samples) + ' timed sessions') +
      tile('Finished the piece', t.completion_rate + '%', comma(t.finishers) + ' reached the end') +
      tile('Engagement', comma(reacts + comms),
           comma(reacts) + ' reactions · ' + comma(comms) + ' comments') +
    '</div>' +

    '<div class="chart-card">' +
      '<h3>Reads per day</h3><div class="cap">Daily read count' +
        (dashRange ? ' over the last ' + dashRange + ' days' : ' over the last year') + '</div>' +
      '<div class="plot" id="plot-daily"><div class="tt" id="tt-daily"></div></div>' +
      tableView('Reads per day (table)',
        ['Day','Reads','Readers'],
        d.daily.map(r => [dayLabel(r.day), comma(r.views), comma(r.readers)])) +
    '</div>' +

    '<div class="grid2">' +
      '<div class="chart-card">' +
        '<h3>How far readers get</h3>' +
        '<div class="cap">Share of reading sessions reaching each point of the article</div>' +
        '<div class="plot" id="plot-funnel"><div class="tt" id="tt-funnel"></div></div>' +
      '</div>' +
      '<div class="chart-card">' +
        '<h3>Where readers come from</h3><div class="cap">Referring source, by read</div>' +
        '<div class="plot" id="plot-refs"><div class="tt" id="tt-refs"></div></div>' +
      '</div>' +
    '</div>' +

    '<div class="chart-card">' +
      '<h3>Posts</h3><div class="cap">Every piece, ranked by reads in this window</div>' +
      '<table class="data"><thead><tr>' +
        '<th>Post</th><th>Reads</th><th>Readers</th><th>Attention</th>' +
        '<th>Finished</th><th>Reactions</th><th>Comments</th></tr></thead><tbody>' +
      (d.posts.length
        ? d.posts.map(function(p){
            const pct = p.views ? Math.round((p.finishers / p.views) * 100) : 0;
            return '<tr><td><button class="linkish" onclick="go(\'/p/' +
              encodeURIComponent(p.slug) + '\')">' + esc(p.title) + '</button>' +
              (p.status !== 'published' ? ' <span class="tag draft">Draft</span>' : '') + '</td>' +
              '<td>' + comma(p.views) + '</td><td>' + comma(p.readers) + '</td>' +
              '<td>' + mmss(p.avg_dwell) + '</td><td>' + pct + '%</td>' +
              '<td>' + comma(p.reactions) + '</td><td>' + comma(p.comments) + '</td></tr>';
          }).join('')
        : '<tr><td colspan="7" class="empty">No posts yet.</td></tr>') +
      '</tbody></table>' +
    '</div>' +

    '<div class="grid2">' +
      '<div class="chart-card"><h3>Devices</h3><div class="cap">Reads by device type</div>' +
        '<table class="data"><thead><tr><th>Device</th><th>Reads</th><th>Share</th></tr></thead><tbody>' +
        (d.devices.length
          ? d.devices.map(r => '<tr><td>' + esc(r.device) + '</td><td>' + comma(r.views) + '</td><td>' +
              (t.views ? Math.round(r.views / t.views * 100) : 0) + '%</td></tr>').join('')
          : '<tr><td colspan="3" class="empty">No reads yet.</td></tr>') +
        '</tbody></table></div>' +
      '<div class="chart-card"><h3>Latest comments</h3><div class="cap">Newest first</div>' +
        (d.recent_comments.length
          ? d.recent_comments.map(c =>
              '<div class="c-card"><div class="c-top"><span class="c-init">' + initials(c.name) +
              '</span><span class="c-name">' + esc(c.name) + '</span>' +
              '<span class="c-date">' + esc(shortDate(c.created_at)) + '</span></div>' +
              '<div class="c-text">' + esc(c.body.length > 180 ? c.body.slice(0,180) + '…' : c.body) +
              '</div><div style="margin-top:6px"><button class="linkish" onclick="go(\'/p/' +
              encodeURIComponent(c.slug) + '\')">on “' + esc(c.title) + '”</button></div></div>').join('')
          : '<p class="empty">No comments in this window.</p>') +
      '</div>' +
    '</div>';

  drawCharts(d);
}

function tile(label, value, sub){
  return '<div class="tile"><div class="lbl">' + esc(label) + '</div>' +
    '<div class="n">' + esc(value) + '</div>' +
    '<div class="sub">' + esc(sub) + '</div></div>';
}

function tableView(caption, headers, rows){
  return '<details class="tableview"><summary>' + esc(caption) + '</summary>' +
    '<table class="data"><thead><tr>' + headers.map(h => '<th>' + esc(h) + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + r.map(c => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></details>';
}

function setRange(days){ dashRange = days; showDashboard(); }
function setDashPost(id){ dashPost = id; showDashboard(); }

/* ═══════════════════════════════════════════════════════════════
   CHARTS — inline SVG. Single series throughout, so no legend is
   needed; each chart's title names what is plotted.
   ═══════════════════════════════════════════════════════════════ */
const SVG_NS = 'http://www.w3.org/2000/svg';
function el(name, attrs){
  const node = document.createElementNS(SVG_NS, name);
  for(const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

/* Bar with a 4px rounded data-end and a square baseline end. */
function barPath(x, y, w, h, r){
  r = Math.min(r, w, h / 2);
  if(w <= 0) return '';
  return 'M' + x + ',' + y + 'H' + (x + w - r) +
         'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
         'V' + (y + h - r) +
         'a' + r + ',' + r + ' 0 0 1 ' + (-r) + ',' + r +
         'H' + x + 'Z';
}

function niceMax(v){
  if(v <= 5) return 5;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / mag * 2) / 2 * mag;
}

function drawCharts(d){
  drawDaily(d.daily);
  drawFunnel(d.funnel);
  drawRefs(d.referrers);
}

/* ── reads per day: 2px line + 10% wash, crosshair tooltip ───── */
function drawDaily(rows){
  const host = document.getElementById('plot-daily');
  if(!host || !rows.length) return;
  const tt = document.getElementById('tt-daily');
  host.querySelectorAll('svg').forEach(n => n.remove());

  const W = host.clientWidth || 640, H = 200;
  const pad = { t:12, r:14, b:24, l:38 };
  const iw = Math.max(10, W - pad.l - pad.r), ih = H - pad.t - pad.b;
  const max = niceMax(Math.max.apply(null, rows.map(r => r.views)) || 1);
  const X = i => pad.l + (rows.length === 1 ? iw/2 : (i / (rows.length - 1)) * iw);
  const Y = v => pad.t + ih - (v / max) * ih;

  const svg = el('svg', { viewBox:'0 0 ' + W + ' ' + H, height:H,
                          role:'img', 'aria-label':'Reads per day' });

  // gridlines + y ticks
  [0, .5, 1].forEach(function(f){
    const y = pad.t + ih - f * ih;
    svg.appendChild(el('line', { x1:pad.l, x2:pad.l+iw, y1:y, y2:y,
      stroke: f === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width':1 }));
    const label = el('text', { x:pad.l - 8, y:y + 3, 'text-anchor':'end', class:'tick num' });
    label.textContent = comma(Math.round(max * f));
    svg.appendChild(label);
  });

  const line = rows.map((r,i) => (i ? 'L' : 'M') + X(i) + ',' + Y(r.views)).join('');
  svg.appendChild(el('path', { d: line + 'L' + X(rows.length-1) + ',' + Y(0) + 'L' + X(0) + ',' + Y(0) + 'Z',
                               fill:'var(--series-wash)' }));
  svg.appendChild(el('path', { d: line, fill:'none', stroke:'var(--series)',
                               'stroke-width':2, 'stroke-linejoin':'round', 'stroke-linecap':'round' }));

  // x ticks: first, middle, last only
  [0, Math.floor((rows.length-1)/2), rows.length-1].filter((v,i,a) => a.indexOf(v) === i)
    .forEach(function(i){
      const label = el('text', { x:X(i), y:H - 6, class:'tick',
        'text-anchor': i === 0 ? 'start' : (i === rows.length-1 ? 'end' : 'middle') });
      label.textContent = dayLabel(rows[i].day);
      svg.appendChild(label);
    });

  // endpoint marker + direct label (the only labelled point)
  const last = rows[rows.length-1];
  svg.appendChild(el('circle', { cx:X(rows.length-1), cy:Y(last.views), r:4,
    fill:'var(--series)', stroke:'var(--surface)', 'stroke-width':2 }));

  const crosshair = el('line', { y1:pad.t, y2:pad.t+ih, stroke:'var(--axis)',
                                 'stroke-width':1, opacity:0 });
  svg.appendChild(crosshair);
  const cursor = el('circle', { r:4, fill:'var(--series)', stroke:'var(--surface)',
                                'stroke-width':2, opacity:0 });
  svg.appendChild(cursor);

  const hit = el('rect', { x:0, y:0, width:W, height:H, fill:'transparent' });
  svg.appendChild(hit);
  hit.addEventListener('mousemove', function(ev){
    const box = svg.getBoundingClientRect();
    const px = (ev.clientX - box.left) * (W / box.width);
    const i = Math.max(0, Math.min(rows.length - 1,
      Math.round(((px - pad.l) / iw) * (rows.length - 1))));
    const r = rows[i];
    crosshair.setAttribute('x1', X(i)); crosshair.setAttribute('x2', X(i));
    crosshair.setAttribute('opacity', 1);
    cursor.setAttribute('cx', X(i)); cursor.setAttribute('cy', Y(r.views));
    cursor.setAttribute('opacity', 1);
    tt.innerHTML = esc(dayLabel(r.day)) + '<br/><b>' + comma(r.views) + '</b> reads · <b>' +
                   comma(r.readers) + '</b> readers';
    tt.style.left = (X(i) / W * box.width) + 'px';
    tt.style.top  = (Y(r.views) / H * box.height - 8) + 'px';
    tt.classList.add('on');
  });
  hit.addEventListener('mouseleave', function(){
    crosshair.setAttribute('opacity', 0);
    cursor.setAttribute('opacity', 0);
    tt.classList.remove('on');
  });

  host.appendChild(svg);
}

/* ── read-depth funnel: ordinal blue ramp, labels outside ────── */
function drawFunnel(rows){
  const host = document.getElementById('plot-funnel');
  if(!host) return;
  const tt = document.getElementById('tt-funnel');
  host.querySelectorAll('svg').forEach(n => n.remove());

  const RAMP = ['var(--ord-1)','var(--ord-2)','var(--ord-3)','var(--ord-4)'];
  const LBL  = ['A quarter in','Halfway','Three quarters','Finished'];
  const W = host.clientWidth || 420;
  const rowH = 34, barH = 20, padL = 96, padR = 46;
  const H = rows.length * rowH + 8;
  const iw = Math.max(10, W - padL - padR);

  const svg = el('svg', { viewBox:'0 0 ' + W + ' ' + H, height:H,
                          role:'img', 'aria-label':'How far readers get' });

  rows.forEach(function(r, i){
    const y = i * rowH + 4;
    const w = Math.max(2, (r.pct / 100) * iw);

    const name = el('text', { x:padL - 10, y:y + barH/2 + 4, 'text-anchor':'end', class:'tick' });
    name.textContent = LBL[i] || (r.step + '%');
    svg.appendChild(name);

    svg.appendChild(el('rect', { x:padL, y:y, width:iw, height:barH, fill:'var(--surface-2)' }));

    const bar = el('path', { d: barPath(padL, y, w, barH, 4), fill: RAMP[i] });
    svg.appendChild(bar);

    const val = el('text', { x:padL + w + 8, y:y + barH/2 + 4, class:'mark-label' });
    val.textContent = r.pct + '%';
    svg.appendChild(val);

    const hit = el('rect', { x:0, y:y - 4, width:W, height:rowH, fill:'transparent' });
    svg.appendChild(hit);
    hit.addEventListener('mousemove', function(){
      tt.innerHTML = esc(LBL[i] || (r.step + '%')) + '<br/><b>' + comma(r.sessions) +
                     '</b> sessions · <b>' + r.pct + '%</b> of reads';
      tt.style.left = Math.min(W - 60, padL + w) + 'px';
      tt.style.top  = y + 'px';
      tt.classList.add('on');
    });
    hit.addEventListener('mouseleave', function(){ tt.classList.remove('on'); });
  });

  host.appendChild(svg);
}

/* ── referrers: single-hue horizontal bars ───────────────────── */
function drawRefs(rows){
  const host = document.getElementById('plot-refs');
  if(!host) return;
  const tt = document.getElementById('tt-refs');
  host.querySelectorAll('svg, p.empty').forEach(n => n.remove());

  if(!rows.length){
    host.insertAdjacentHTML('beforeend', '<p class="empty">No reads yet.</p>');
    return;
  }

  const W = host.clientWidth || 420;
  const rowH = 30, barH = 18, padL = 96, padR = 46;
  const H = rows.length * rowH + 8;
  const iw = Math.max(10, W - padL - padR);
  const max = Math.max.apply(null, rows.map(r => r.views)) || 1;

  const svg = el('svg', { viewBox:'0 0 ' + W + ' ' + H, height:H,
                          role:'img', 'aria-label':'Reads by referring source' });

  rows.forEach(function(r, i){
    const y = i * rowH + 4;
    const w = Math.max(2, (r.views / max) * iw);
    const name = String(r.source);

    const label = el('text', { x:padL - 10, y:y + barH/2 + 4, 'text-anchor':'end', class:'tick' });
    label.textContent = name.length > 15 ? name.slice(0,14) + '…' : name;
    svg.appendChild(label);

    svg.appendChild(el('path', { d: barPath(padL, y, w, barH, 4), fill:'var(--series)' }));

    const val = el('text', { x:padL + w + 8, y:y + barH/2 + 4, class:'mark-label' });
    val.textContent = comma(r.views);
    svg.appendChild(val);

    const hit = el('rect', { x:0, y:y - 4, width:W, height:rowH, fill:'transparent' });
    svg.appendChild(hit);
    hit.addEventListener('mousemove', function(){
      tt.innerHTML = esc(name) + '<br/><b>' + comma(r.views) + '</b> reads';
      tt.style.left = Math.min(W - 60, padL + w) + 'px';
      tt.style.top  = y + 'px';
      tt.classList.add('on');
    });
    hit.addEventListener('mouseleave', function(){ tt.classList.remove('on'); });
  });

  host.appendChild(svg);
}

let resizeTimer;
addEventListener('resize', function(){
  if(location.pathname !== '/dashboard' || !lastDash) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function(){ drawCharts(lastDash); }, 150);
});

/* ═══════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════ */
/* GitHub Pages answers a hard load of /p/<slug> with 404.html, which
   stashes the path and bounces here. Put the URL back before routing. */
(function restoreDeepLink(){
  let to = null;
  try{
    to = sessionStorage.getItem('ss_redirect');
    if(to) sessionStorage.removeItem('ss_redirect');
  }catch(e){}
  if(to && to !== location.pathname + location.search + location.hash){
    history.replaceState({}, '', to);
  }
})();

paintAuthorBar();

(async function boot(){
  if(!db){
    blogNotice('Not connected yet',
      'Add your Supabase project URL and anon key to config.js, then reload. ' +
      'Both are in the Supabase dashboard under Settings → API.');
    return;
  }
  try{ await initAuth(); }catch(e){}
  route();
})();
