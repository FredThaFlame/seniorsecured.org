/* ═══════════════════════════════════════════════════════════════
   UPCOMING TRAINING — the only file to edit when Fred books a session.

   One entry per session. Order does not matter; the page sorts them by
   date. Once a session's day has passed it shows as "Previous", but
   only the most recent past session is shown, so old entries never
   need deleting by hand (tidy them up whenever convenient). Entries
   dated 'TBA' go last. With nothing to show, the box hides itself.

     date   'YYYY-MM-DD', or 'TBA'               required
     start  'HH:MM', 24-hour, California time    optional
     end    'HH:MM'                              optional
     title  what the session is called           required
     venue  where it is                          optional
     city   'San Mateo, CA'                      optional
     address street address, for Google and the map link   optional
     url    a page with details or sign-up       optional
     note   one short line, e.g. 'Free, open to the public'   optional

   After editing, rerun `node tools/build-static.mjs` so the article
   pages pick up the change too.
   ═══════════════════════════════════════════════════════════════ */
const EVENTS = [
  { date:'2026-09-25',
    title:'SeniorSecured Cyber Safety Presentation',
    venue:'Foothill College', city:'Los Altos Hills, CA' },
  { date:'TBA',
    title:'Next SeniorSecured training' }
];
