// The phone app's service worker (app/sw.js), scope /app/. Handles same-origin GETs only: nothing on the Supabase origin (auth,
// REST: tokens in headers and bodies) is ever intercepted or cached. Navigations are network-first with the cached /app/ shell
// as the offline fallback; the app's scripts, the manifest and the icons are cache-first; the public config is served from the
// cache and revalidated; /version.json is network-only. The durable write queue lives in IndexedDB (app/td-data.js), not here.
// Each deploy replaces the VERSION line with the release sha (HomeOS scripts/tasksdb/deploy-pages.js), so the browser installs
// the new worker; the page shows "New version" and posts SKIP_WAITING.
// Push-ready: a V2 'push' / 'notificationclick' handler goes below (server Web Push, mobile-app-plan.md "V1 shape and V2 room").
'use strict';
const VERSION = 'dev';
const CACHE = 'td-app-' + VERSION;
const SHELL = '/app/';
// the deploy also stamps app/index.html's script addresses with ?v=<short sha>, so a new page never runs an older cached script
const V = VERSION === 'dev' ? '' : '?v=' + VERSION.slice(0, 7);
const PRECACHE = [SHELL, '/app/td-core.js' + V, '/app/td-data.js' + V, '/app/manifest.webmanifest', '/app/icons/icon-192.png', '/app/icons/icon-512.png', '/config/tasksdashboard.config.js'];

// what the worker does with a request: skip (the browser handles it), network, navigate, cache (cache-first), revalidate
// (stale-while-revalidate). Pure, tested in test/app-sw.test.js
function cacheRule(url, origin, mode) {
  let u;
  try { u = new URL(url); } catch (e) { return 'skip'; }
  if (u.origin !== origin) return 'skip';
  const p = u.pathname;
  if (p === '/version.json') return 'network';
  if (mode === 'navigate') return p === '/app' || p.startsWith('/app/') ? 'navigate' : 'skip';
  if (p === '/app/sw.js') return 'skip';
  if (/^\/app\/[\w.-]+\.js$/.test(p) || p === '/app/manifest.webmanifest' || /^\/app\/icons\/[\w.-]+\.png$/.test(p)) return 'cache';
  if (p === '/config/tasksdashboard.config.js') return 'revalidate';
  return 'skip';
}
// a response worth keeping: a plain 200 from this origin, not a redirect (an access login page never lands in the cache)
const storable = r => !!r && r.status === 200 && r.type === 'basic' && !r.redirected;
// the shell is stored only from an address without a query (never ?code= of a Google sign-in)
const shellUrl = url => { try { const u = new URL(url); return !u.search && (u.pathname === '/app/' || u.pathname === '/app/index.html'); } catch (e) { return false; } };

self.TDSW = { cacheRule, storable, shellUrl, VERSION, CACHE, PRECACHE };

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(PRECACHE.map(p => fetch(p, { cache: 'reload' }).then(r => storable(r) ? c.put(p, r) : null).catch(() => null)))));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('td-app-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const rule = cacheRule(req.url, self.location.origin, req.mode);
  if (rule === 'skip') return;
  if (rule === 'network') { e.respondWith(fetch(req)); return; }
  if (rule === 'navigate') {
    e.respondWith(fetch(req).then(r => {
      if (storable(r) && shellUrl(req.url)) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(SHELL, copy)); }
      return r;
    }).catch(() => caches.match(SHELL, { ignoreSearch: true }).then(r => r || Response.error())));
    return;
  }
  const u = new URL(req.url), key = u.pathname + u.search; // ?v=<sha> keeps script versions apart (no ?code= here)
  if (rule === 'cache') {
    // cache-first by exact address; offline with no exact copy, any version of the file
    e.respondWith(caches.match(key).then(hit => hit || fetch(req).then(r => { if (storable(r)) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); } return r; })
      .catch(() => caches.match(u.pathname, { ignoreSearch: true }).then(r => r || Response.error()))));
    return;
  }
  // revalidate: the cached config at once, a fresh copy for next time
  e.respondWith(caches.match(key).then(hit => {
    const fresh = fetch(req).then(r => { if (storable(r)) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); } return r; });
    if (hit) { e.waitUntil(fresh.catch(() => null)); return hit; }
    return fresh;
  }));
});
