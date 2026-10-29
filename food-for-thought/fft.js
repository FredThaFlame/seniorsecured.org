/* Food for Thought: reads public.thoughts (supabase/food-for-thought.sql)
   and, for an allowlisted author, adds, edits and deletes notes.
   Same Supabase project and the same sign-in as the blog: the session is
   kept in this origin's localStorage, so an author already signed in on the
   home page is signed in here. The database enforces who may write; the
   buttons below only keep the page honest about it. */
(function(){
  'use strict';

  /* Shown only while the table does not exist yet (SQL not run), so the
     page is never empty. Fred's first note, also seeded by the SQL. */
  var FALLBACK = [{
    id: 0,
    created_at: '2026-10-16T23:28:00-07:00',
    body: 'Food For Thought…..\n\n\nThis is an opinion on the oversharing of personal information. With different A.I platforms such as ChatGPT, CoPilot, Gemini, and others, know that these platforms and other LLMs are engineered to be personable, supportive and engaging. That being said, be extra cautious about the personal information you share with them. Information you share regarding health, financial details, and other personal and sensitive topics has the possibility and probability of coming back to bite you at some point. Remember, for many services where you pay nothing or very little, generally you are the product. Understand that there is a high probability that profiles associated with you from the information you share will at some point be traded and or sold, and that information can be used against your interests.\n\n\n\n-F-'
  }];

  var db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  var notes = [], offline = false, author = false, composing = false, editing = null;
  /* picked: a 'YYYY-MM-DD' day from the calendar, or null for the latest.
     month: the first of the month the calendar is showing. */
  var picked = null, month = null;
  var listEl = document.getElementById('fft-list');
  var barEl  = document.getElementById('fft-bar');
  var calEl  = document.getElementById('fft-cal');
  var showEl = document.getElementById('fft-showing');
  var MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December'];
  var toastEl = document.getElementById('toast');

  function esc(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }
  /* A note shows exactly as Fred typed it: his words, his line breaks and
     his blank lines (white-space: pre-wrap in index.html). Only the
     whitespace before the first line and after the last is dropped. */
  function noteText(body){
    return '<div class="fft-body">' + esc(String(body).replace(/^\s*\n|\s+$/g, '')) + '</div>';
  }
  /* Every date is Fred's calendar day (he is in California), so a note he
     posts at 11 pm has the same date for every reader, wherever they are. */
  var TZ = 'America/Los_Angeles';
  function when(d){
    return new Date(d).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric', timeZone: TZ });
  }
  function pad(n){ return (n < 10 ? '0' : '') + n; }
  function ymd(y, m, d){ return y + '-' + pad(m + 1) + '-' + pad(d); }
  /* en-CA formats as YYYY-MM-DD. */
  function dayOf(d){ return new Date(d).toLocaleDateString('en-CA', { timeZone: TZ }); }
  function firstOf(d){ var k = dayOf(d).split('-'); return new Date(+k[0], k[1] - 1, 1); }
  var toastTimer;
  function toast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove('show'); }, 3200);
  }

  /* ── reading ──────────────────────────────────────────────── */
  async function load(){
    var r = await db.from('thoughts').select('id,body,created_at')
      .order('created_at', { ascending: false });
    if(r.error){
      /* 42P01 / PGRST205: the table is not there yet. Anything else is a
         real failure, and says so rather than pretending. */
      var missing = r.error.code === '42P01' || r.error.code === 'PGRST205';
      offline = true;
      notes = missing ? FALLBACK : [];
      if(!missing) listEl.innerHTML = '<p class="fft-empty">Couldn&rsquo;t load the notes just now. Please try again in a moment.</p>';
    }else{
      offline = false;
      notes = r.data || [];
    }
    /* A picked day whose note was just deleted falls back to the latest. */
    if(picked && !notes.some(function(n){ return dayOf(n.created_at) === picked; })) picked = null;
    if(!month) month = firstOf(notes.length ? notes[0].created_at : new Date());
    paint();
  }

  function paint(){
    paintCal();
    if(!notes.length){
      if(!offline) listEl.innerHTML = '<p class="fft-empty">Nothing here yet. Check back soon.</p>';
      showEl.innerHTML = '';
      paintBar();
      return;
    }
    /* Only one day is ever on screen: the latest note, or every note from
       the day picked on the calendar. */
    var shown = picked
      ? notes.filter(function(n){ return dayOf(n.created_at) === picked; })
      : notes.slice(0, 1);
    showEl.innerHTML = picked
      ? 'Showing ' + esc(when(shown[0].created_at)) +
        ' <span class="dot">&middot;</span> <button class="linkish" data-act="latest">Back to the latest</button>'
      : 'Showing the latest note. Pick a highlighted date to read an earlier one.';
    listEl.innerHTML = shown.map(function(n){
      var i = notes.indexOf(n);
      if(editing === n.id){
        return '<article class="box fft-note"><div class="fg"><label for="fft-edit">Edit this note</label>' +
          '<textarea id="fft-edit" maxlength="4000">' + esc(n.body) + '</textarea></div>' +
          '<div class="fft-actions"><button class="btn" data-act="save" data-id="' + n.id + '">Save</button>' +
          '<button class="btn ghost" data-act="cancel-edit">Cancel</button></div></article>';
      }
      return '<article class="box fft-note' + (i === 0 ? ' latest' : '') + '">' +
        '<div class="fft-date">' + (i === 0 ? '<span class="fft-tag">Latest</span>' : '') +
        esc(when(n.created_at)) + '</div>' +
        '<div class="article">' + noteText(n.body) + '</div>' +
        (author && !offline
          ? '<div class="fft-actions"><button class="linkish" data-act="edit" data-id="' + n.id + '">Edit</button>' +
            '<span class="dot">&middot;</span>' +
            '<button class="linkish fft-del" data-act="delete" data-id="' + n.id + '">Delete</button></div>'
          : '') +
        '</article>';
    }).join('');
    paintBar();
  }

  /* ── the calendar ─────────────────────────────────────────── */
  function paintCal(){
    var have = {};
    notes.forEach(function(n){ have[dayOf(n.created_at)] = true; });
    var on = picked || (notes.length ? dayOf(notes[0].created_at) : null);
    var today = dayOf(new Date());
    var y = month.getFullYear(), m = month.getMonth();
    /* The arrows stop at the first and last month that has a note. */
    var oldest = notes.length ? firstOf(notes[notes.length - 1].created_at) : month;
    var newest = notes.length ? firstOf(notes[0].created_at) : month;
    var cells = '', lead = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
    for(var b = 0; b < lead; b++) cells += '<span></span>';
    for(var d = 1; d <= days; d++){
      var k = ymd(y, m, d);
      var cls = (k === on ? ' on' : '') + (k === today ? ' today' : '');
      cells += have[k]
        ? '<button class="fft-day has' + cls + '" data-act="day" data-day="' + k + '"' +
          ' aria-label="' + esc(MONTHS[m] + ' ' + d + ', ' + y) + ', has a note"' +
          (k === on ? ' aria-pressed="true"' : '') + '>' + d + '</button>'
        : '<span class="fft-day' + cls + '">' + d + '</span>';
    }
    calEl.innerHTML =
      '<div class="fft-cal-head">' +
        '<button class="fft-nav" data-act="prev-month" aria-label="Previous month"' + (month <= oldest ? ' disabled' : '') + '>&#8249;</button>' +
        '<strong>' + MONTHS[m] + ' ' + y + '</strong>' +
        '<button class="fft-nav" data-act="next-month" aria-label="Next month"' + (month >= newest ? ' disabled' : '') + '>&#8250;</button>' +
      '</div>' +
      '<div class="fft-grid fft-wk" aria-hidden="true"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>' +
      '<div class="fft-grid">' + cells + '</div>' +
      '<p class="fft-key"><span class="fft-swatch"></span>A note was posted that day</p>';
  }

  /* ── the author strip ─────────────────────────────────────── */
  function paintBar(){
    if(offline){ barEl.innerHTML = ''; return; }
    if(!author){
      barEl.innerHTML = '<button class="linkish" data-act="show-signin">Author sign in</button>' +
        '<form id="fft-signin" hidden>' +
        '<div class="fg"><label for="fft-email">Author email</label>' +
        '<input type="email" id="fft-email" autocomplete="username" required/></div>' +
        '<div class="fg"><label for="fft-pw">Password</label>' +
        '<input type="password" id="fft-pw" autocomplete="current-password" required/></div>' +
        '<button class="btn" type="submit">Sign in</button></form>';
      return;
    }
    barEl.innerHTML = composing
      ? '<div class="box fft-note"><div class="fg"><label for="fft-new">New note</label>' +
        '<textarea id="fft-new" maxlength="4000" placeholder="Write your food for thought here. It will show exactly as you type it."></textarea></div>' +
        '<div class="fft-actions"><button class="btn" data-act="post">Post it</button>' +
        '<button class="btn ghost" data-act="cancel-new">Cancel</button></div></div>'
      : '<button class="btn" data-act="new">Add a thought</button>' +
        '<button class="linkish" data-act="signout">Sign out</button>';
    var t = document.getElementById('fft-new');
    if(t) t.focus();
  }

  async function checkAuthor(){
    var s = (await db.auth.getSession()).data.session;
    author = false;
    if(s){
      var r = await db.from('authors').select('user_id').limit(1);
      author = !r.error && Array.isArray(r.data) && r.data.length > 0;
    }
  }

  /* ── actions ──────────────────────────────────────────────── */
  async function run(act, id, btn){
    if(act === 'day'){
      picked = btn.dataset.day; editing = null; paint();
    }else if(act === 'latest'){
      picked = null; editing = null;
      month = firstOf(notes[0].created_at); paint();
    }else if(act === 'prev-month' || act === 'next-month'){
      month = new Date(month.getFullYear(), month.getMonth() + (act === 'prev-month' ? -1 : 1), 1);
      paintCal();
    }else if(act === 'show-signin'){
      document.getElementById('fft-signin').hidden = false;
      btn.hidden = true;
      document.getElementById('fft-email').focus();
    }else if(act === 'new'){
      composing = true; paintBar();
    }else if(act === 'cancel-new'){
      composing = false; paintBar();
    }else if(act === 'post'){
      var body = document.getElementById('fft-new').value.trim();
      if(!body) return toast('Write something first.');
      btn.disabled = true;
      var ins = await db.from('thoughts').insert({ body: body });
      if(ins.error){ btn.disabled = false; return toast(ins.error.message); }
      composing = false;
      /* A new note is the latest one, so show it. */
      picked = null; month = null;
      toast('Posted.');
      await load();
    }else if(act === 'edit'){
      editing = id; paint();
      var ta = document.getElementById('fft-edit'); if(ta) ta.focus();
    }else if(act === 'cancel-edit'){
      editing = null; paint();
    }else if(act === 'save'){
      var text = document.getElementById('fft-edit').value.trim();
      if(!text) return toast('A note can’t be empty.');
      btn.disabled = true;
      var up = await db.from('thoughts').update({ body: text }).eq('id', id);
      if(up.error){ btn.disabled = false; return toast(up.error.message); }
      editing = null;
      toast('Saved.');
      await load();
    }else if(act === 'delete'){
      /* Two clicks instead of a browser dialog. */
      if(btn.dataset.sure !== '1'){
        btn.dataset.sure = '1';
        btn.textContent = 'Really delete?';
        setTimeout(function(){ if(btn.isConnected){ btn.dataset.sure = ''; btn.textContent = 'Delete'; } }, 4000);
        return;
      }
      var del = await db.from('thoughts').delete().eq('id', id);
      if(del.error) return toast(del.error.message);
      toast('Deleted.');
      await load();
    }else if(act === 'signout'){
      await db.auth.signOut();
      author = false; composing = false; editing = null;
      paint();
    }
  }

  document.addEventListener('click', function(ev){
    var btn = ev.target.closest('[data-act]');
    if(!btn) return;
    run(btn.dataset.act, btn.dataset.id ? Number(btn.dataset.id) : null, btn);
  });

  document.addEventListener('submit', async function(ev){
    if(ev.target.id !== 'fft-signin') return;
    ev.preventDefault();
    var go = ev.target.querySelector('button[type=submit]');
    go.disabled = true;
    var r = await db.auth.signInWithPassword({
      email: document.getElementById('fft-email').value.trim(),
      password: document.getElementById('fft-pw').value
    });
    if(r.error){ go.disabled = false; return toast(r.error.message); }
    await checkAuthor();
    if(!author){
      await db.auth.signOut();
      go.disabled = false;
      return toast('That account is not an author on this site.');
    }
    paint();
  });

  (async function(){
    await checkAuthor();
    await load();
  })();
})();
