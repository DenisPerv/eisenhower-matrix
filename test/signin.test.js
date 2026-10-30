// node --test test/  — signin.html (/signin) without network: its one inline script runs in a vm with a fake location,
// sessionStorage, document and fetch. Checks the exact PKCE return URL, the `next` rules and the forward for let-in logins.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'signin.html'), 'utf8');
const INLINE = [...HTML.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi)].filter(m => !/\ssrc\s*=/i.test(m[1] || '')).map(m => m[2]);
const ORIGIN = 'https://app.example.pages.dev';
const NEXT_KEY = 'td.signin.next', AUTH_KEY = 'td.request.auth';
const SESSION = () => ({ access_token: 'acc', refresh_token: 'ref', expires_at: Date.now() + 3600e3, email: 'p@example.invalid' });

// answers: { mine: [status, body], request: [status, body] }
function load(href, { stored = {}, answers = {} } = {}) {
  const store = new Map(Object.entries(stored).map(([k, v]) => [k, JSON.stringify(v)]));
  const u = new URL(href);
  const loc = { href, origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash, assigned: null, replaced: null,
    assign(x) { this.assigned = x; }, replace(x) { this.replaced = x; } };
  const history = { replaceState(_s, _t, url) { const n = new URL(url, href); Object.assign(loc, { href: n.href, pathname: n.pathname, search: n.search, hash: n.hash }); } };
  const app = { dataset: {}, innerHTML: '', addEventListener(t, f) { this.onclick = f; } };
  const listeners = {};
  const calls = [];
  const fetch = async (url, init) => {
    const p = new URL(url).pathname;
    calls.push(p);
    const [status, body] = (p.endsWith('/my_access_request') ? answers.mine : p.endsWith('/request_access') ? answers.request : null) || [204];
    return { status, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
  };
  const ctx = {
    TD_CONFIG: { supabaseUrl: 'https://abc.supabase.co', publishableKey: 'sb_publishable_test' },
    location: loc, history, fetch, crypto: globalThis.crypto, btoa, TextEncoder, URL, URLSearchParams, console, setTimeout,
    document: { readyState: 'loading', addEventListener(t, f) { listeners[t] = f; }, getElementById: id => (id === 'app' ? app : null), documentElement: { dataset: {} } },
    sessionStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    localStorage: { getItem: () => null },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(INLINE[0], ctx);
  return { ctx, loc, app, store, calls, start: () => listeners.DOMContentLoaded() };
}
const settle = async (s, ms = 2000) => { const t = Date.now(); while (s.app.dataset.state === 'sending' || !s.app.dataset.state) { if (Date.now() - t > ms) break; await new Promise(r => setTimeout(r, 5)); } };
const stored = (s, k) => (s.store.has(k) ? JSON.parse(s.store.get(k)) : null);

test('signin.html has exactly one inline script, the config as its only external script, and no password field', () => {
  assert.equal(INLINE.length, 1);
  const ext = [...HTML.matchAll(/<script\s[^>]*src\s*=\s*"([^"]+)"/gi)].map(m => m[1]);
  assert.deepEqual(ext, ['config/tasksdashboard.config.js']);
  assert.ok(!/type\s*=\s*["']?password/i.test(HTML));
});

test('next: only /board/ and /app/; anything else, another host included, is /board/', () => {
  const { safeNext, NEXT_PAGES } = load(ORIGIN + '/signin').ctx.TDSignin;
  assert.deepEqual([...NEXT_PAGES], ['/board/', '/app/']);
  assert.equal(safeNext('/board/'), '/board/');
  assert.equal(safeNext('/app/'), '/app/');
  for (const bad of ['//evil.example', '//evil.example/app/', 'https://evil.example/app/', `${ORIGIN}/app/`, '/app', '/board', '/app/x', '/board/../x',
    '/\\evil.example', 'javascript:alert(1)', '', null, undefined, 42, ['/app/']])
    assert.equal(safeNext(bad), '/board/', String(bad));
});

test('the PKCE return URL is exactly <origin>/signin, with no query, from any address of the page', () => {
  for (const href of [ORIGIN + '/signin', ORIGIN + '/signin.html', ORIGIN + '/signin?next=/app/', ORIGIN + '/request?x=1#h'])
    assert.equal(load(href).ctx.TDSignin.backUrl(), ORIGIN + '/signin', href);
});

test('next is read on arrival, kept in this tab and taken off the address; a bad one is kept as /board/', () => {
  let s = load(ORIGIN + '/signin?next=%2Fapp%2F'); s.start();
  assert.equal(stored(s, NEXT_KEY), '/app/');
  assert.equal(s.loc.search, '');
  assert.equal(s.loc.pathname, '/signin');
  for (const bad of ['//evil.example', 'https://evil.example/app/', '/elsewhere/']) {
    s = load(ORIGIN + '/signin?next=' + encodeURIComponent(bad)); s.start();
    assert.equal(stored(s, NEXT_KEY), '/board/', bad);
  }
  s = load(ORIGIN + '/signin'); s.start();
  assert.equal(stored(s, NEXT_KEY), null);
});

test('Continue with Google: redirect_to is the exact return URL even when the page was opened with ?next=', async () => {
  const s = load(ORIGIN + '/signin?next=/app/'); s.start();
  assert.equal(s.app.dataset.state, 'signedout');
  const btn = { dataset: { act: 'google' }, disabled: false };
  s.app.onclick({ target: { closest: () => btn } });
  for (let i = 0; i < 200 && !s.loc.assigned; i++) await new Promise(r => setTimeout(r, 5));
  const a = new URL(s.loc.assigned);
  assert.equal(a.origin + a.pathname, 'https://abc.supabase.co/auth/v1/authorize');
  assert.equal(a.searchParams.get('redirect_to'), ORIGIN + '/signin');
  assert.equal(a.searchParams.get('provider'), 'google');
  assert.equal(a.searchParams.get('code_challenge_method'), 's256');
  assert.equal(stored(s, NEXT_KEY), '/app/');
});

test('signed out: the decision-email line and one notice line with a /privacy link', () => {
  const s = load(ORIGIN + '/signin'); s.start();
  assert.match(s.app.innerHTML, /send you one email with the decision \(approved or not\)/);
  assert.match(s.app.innerHTML, /<p class="fine" data-privacy>[^<]*<a href="\/privacy">privacy<\/a>/);
  assert.ok(!/type="password"/.test(s.app.innerHTML));
});

test('an approved request goes on to next with location.replace; next is then cleared', async () => {
  const s = load(ORIGIN + '/signin', { stored: { [AUTH_KEY]: SESSION(), [NEXT_KEY]: '/app/' },
    answers: { mine: [200, [{ status: 'approved', decided_at: '2026-10-30T10:00:00Z' }]] } });
  s.start(); await settle(s);
  assert.equal(s.app.dataset.state, 'approved');
  assert.equal(s.loc.replaced, '/app/');
  assert.equal(stored(s, NEXT_KEY), null);
  assert.deepEqual(s.calls, ['/rest/v1/rpc/my_access_request']);
});

test('a household login (request_access answers 22023) goes on to /board/ when no next was given', async () => {
  const s = load(ORIGIN + '/signin', { stored: { [AUTH_KEY]: SESSION() },
    answers: { mine: [200, null], request: [400, { code: '22023', message: 'household members already have access' }] } });
  s.start(); await settle(s);
  assert.equal(s.loc.replaced, '/board/');
});

test('a stored next that is not allowed still forwards only to /board/', async () => {
  const s = load(ORIGIN + '/signin', { stored: { [AUTH_KEY]: SESSION(), [NEXT_KEY]: '//evil.example' },
    answers: { mine: [200, { status: 'approved' }] } });
  s.start(); await settle(s);
  assert.equal(s.loc.replaced, '/board/');
});

test('everyone else keeps the request screens: pending, declined and the cap never forward', async () => {
  const cases = [
    [{ mine: [200, [{ status: 'pending', requested_at: '2026-10-30T10:00:00Z' }]] }, 'sent'],
    [{ mine: [200, [{ status: 'declined', decided_at: '2026-10-30T10:00:00Z' }]] }, 'declined'],
    [{ mine: [200, []], request: [400, { code: '54000', message: 'capped' }] }, 'cap'],
  ];
  for (const [answers, state] of cases) {
    const s = load(ORIGIN + '/signin', { stored: { [AUTH_KEY]: SESSION(), [NEXT_KEY]: '/app/' }, answers });
    s.start(); await settle(s);
    assert.equal(s.app.dataset.state, state);
    assert.equal(s.loc.replaced, null, state);
    assert.equal(stored(s, NEXT_KEY), '/app/', state);
  }
});

test('not on a hosted origin (file://): an approved login is shown the link, not forwarded', async () => {
  const s = load('file:///C:/repo/signin.html', { stored: { [AUTH_KEY]: SESSION() }, answers: { mine: [200, [{ status: 'approved' }]] } });
  s.start(); await settle(s);
  assert.equal(s.app.dataset.state, 'approved');
  assert.equal(s.loc.replaced, null);
});
