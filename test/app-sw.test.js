// node --test test/  — the phone app's service worker (app/sw.js), loaded through vm with a stub `self`: what it does with each
// address (cacheRule), what it stores (storable, shellUrl), the VERSION line the deploy replaces. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'sw.js'), 'utf8').replace(/\r\n/g, '\n'); // a CRLF checkout reads the same
const ORIGIN = 'https://homeos-tasksboard.pages.dev';
function load(src) {
  const listeners = {};
  const self = { location: { origin: ORIGIN }, addEventListener: (k, fn) => { listeners[k] = fn; } };
  vm.runInNewContext(src, { self, URL, caches: {}, fetch: () => {}, Response: {} }, { filename: 'app/sw.js' });
  return { W: self.TDSW, listeners };
}
const { W, listeners } = load(SRC);

test('sw: never touches another origin (Supabase auth and REST, anything else)', () => {
  for (const u of ['https://abc.supabase.co/rest/v1/items?select=*', 'https://abc.supabase.co/auth/v1/token?grant_type=refresh_token', 'https://cdn.example/x.js'])
    for (const mode of ['cors', 'navigate', 'no-cors']) assert.equal(W.cacheRule(u, ORIGIN, mode), 'skip', u + ' ' + mode);
});

test('sw: navigations under /app/ network-first; the desktop page and /request are left to the browser', () => {
  assert.equal(W.cacheRule(ORIGIN + '/app/', ORIGIN, 'navigate'), 'navigate');
  assert.equal(W.cacheRule(ORIGIN + '/app/?code=abc', ORIGIN, 'navigate'), 'navigate');
  assert.equal(W.cacheRule(ORIGIN + '/app', ORIGIN, 'navigate'), 'navigate');
  assert.equal(W.cacheRule(ORIGIN + '/', ORIGIN, 'navigate'), 'skip');
  assert.equal(W.cacheRule(ORIGIN + '/request', ORIGIN, 'navigate'), 'skip');
});

test('sw: app scripts, the manifest and icons cache-first; the config revalidated; version.json network-only; sw.js itself skipped', () => {
  assert.equal(W.cacheRule(ORIGIN + '/app/td-data.js?v=abc1234', ORIGIN, 'no-cors'), 'cache');
  assert.equal(W.cacheRule(ORIGIN + '/app/td-core.js', ORIGIN, 'no-cors'), 'cache');
  assert.equal(W.cacheRule(ORIGIN + '/app/manifest.webmanifest', ORIGIN, 'cors'), 'cache');
  assert.equal(W.cacheRule(ORIGIN + '/app/icons/icon-192.png', ORIGIN, 'no-cors'), 'cache');
  assert.equal(W.cacheRule(ORIGIN + '/config/tasksdashboard.config.js', ORIGIN, 'no-cors'), 'revalidate');
  assert.equal(W.cacheRule(ORIGIN + '/version.json', ORIGIN, 'cors'), 'network');
  assert.equal(W.cacheRule(ORIGIN + '/app/sw.js', ORIGIN, 'same-origin'), 'skip');
  assert.equal(W.cacheRule(ORIGIN + '/index.html', ORIGIN, 'cors'), 'skip');
  assert.equal(W.cacheRule('not a url', ORIGIN, 'cors'), 'skip');
});

test('sw: stores only a plain 200 of this origin, never a redirect; the shell only from an address without a query', () => {
  assert.equal(W.storable({ status: 200, type: 'basic', redirected: false }), true);
  assert.equal(W.storable({ status: 200, type: 'basic', redirected: true }), false, 'an access login redirect');
  assert.equal(W.storable({ status: 200, type: 'opaque', redirected: false }), false);
  assert.equal(W.storable({ status: 302, type: 'basic', redirected: false }), false);
  assert.equal(W.shellUrl(ORIGIN + '/app/'), true);
  assert.equal(W.shellUrl(ORIGIN + '/app/?code=abc'), false);
  assert.equal(W.shellUrl(ORIGIN + '/app/index.html'), true);
});

test('sw: one VERSION line for the deploy; the cache name and precache follow it; SKIP_WAITING and the fetch handler are wired', () => {
  assert.equal((SRC.match(/^const VERSION = 'dev';$/gm) || []).length, 1);
  assert.equal(W.VERSION, 'dev');
  assert.equal(W.CACHE, 'td-app-dev');
  assert.ok(W.PRECACHE.includes('/app/') && W.PRECACHE.includes('/app/td-data.js'));
  const v = load(SRC.replace("const VERSION = 'dev';", "const VERSION = '0123456789abcdef0123456789abcdef01234567';")).W;
  assert.equal(v.CACHE, 'td-app-0123456789abcdef0123456789abcdef01234567');
  assert.ok(v.PRECACHE.includes('/app/td-data.js?v=0123456'));
  assert.ok(!W.PRECACHE.some(u => /supabase/.test(u)));
  for (const k of ['install', 'activate', 'message', 'fetch']) assert.equal(typeof listeners[k], 'function', k);
  assert.doesNotMatch(SRC, /importScripts/);
});
