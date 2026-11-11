// node --test test/  — signin.html (/signin) without network: its one inline script runs in a vm with a fake location,
// sessionStorage, document and fetch. Checks the exact PKCE return URL, the `next` rules, the forward for let-in logins and
// the consulting-call mode (?intent=consult, db/025).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'signin.html'), 'utf8');
const INLINE = [...HTML.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi)].filter(m => !/\ssrc\s*=/i.test(m[1] || '')).map(m => m[2]);
const ORIGIN = 'https://app.example.pages.dev';
const NEXT_KEY = 'td.signin.next', AUTH_KEY = 'td.request.auth', INTENT_KEY = 'td.signin.intent';
const SESSION = () => ({ access_token: 'acc', refresh_token: 'ref', expires_at: Date.now() + 3600e3, email: 'p@example.invalid' });

// answers: { mine, request, consultMine, consult: [status, body] }; bodies: the JSON body of each rpc call by path
function load(href, { stored = {}, answers = {}, inputs = {}, config = {} } = {}) {
  const store = new Map(Object.entries(stored).map(([k, v]) => [k, JSON.stringify(v)]));
  const u = new URL(href);
  const loc = { href, origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash, assigned: null, replaced: null,
    assign(x) { this.assigned = x; }, replace(x) { this.replaced = x; } };
  const history = { replaceState(_s, _t, url) { const n = new URL(url, href); Object.assign(loc, { href: n.href, pathname: n.pathname, search: n.search, hash: n.hash }); } };
  const app = { dataset: {}, innerHTML: '', addEventListener(t, f) { this['on' + t] = f; } };
  const listeners = {};
  const calls = [], bodies = {};
  const fetch = async (url, init) => {
    const p = new URL(url).pathname;
    calls.push(p);
    try { bodies[p] = JSON.parse((init && init.body) || 'null'); } catch (e) {}
    const [status, body] = (p.endsWith('/my_access_request') ? answers.mine : p.endsWith('/request_access') ? answers.request
      : p.endsWith('/my_consultation_request') ? answers.consultMine : p.endsWith('/request_consultation') ? answers.consult
      : p.endsWith('/my_telegram_link') ? answers.tgMine : p.endsWith('/telegram_link_token') ? answers.tgToken : p.endsWith('/set_telegram_claim') ? answers.tgClaim : null) || [204];
    return { status, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
  };
  const ctx = {
    TD_CONFIG: Object.assign({ supabaseUrl: 'https://abc.supabase.co', publishableKey: 'sb_publishable_test' }, config),
    location: loc, history, fetch, crypto: globalThis.crypto, btoa, TextEncoder, URL, URLSearchParams, console, setTimeout,
    document: { readyState: 'loading', addEventListener(t, f) { listeners[t] = f; }, getElementById: id => (id === 'app' ? app : inputs[id] || null), documentElement: { dataset: {} } },
    sessionStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    localStorage: { getItem: () => null },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(INLINE[0], ctx);
  return { ctx, loc, app, store, calls, bodies, start: () => listeners.DOMContentLoaded() };
}
const settle = async (s, ms = 2000) => { const t = Date.now(); while (s.app.dataset.state === 'sending' || !s.app.dataset.state) { if (Date.now() - t > ms) break; await new Promise(r => setTimeout(r, 5)); } };
const stored = (s, k) => (s.store.has(k) ? JSON.parse(s.store.get(k)) : null);

test('signin.html has exactly one inline script, the config as its only external script, and no password field', () => {
  assert.equal(INLINE.length, 1);
  const ext = [...HTML.matchAll(/<script\s[^>]*src\s*=\s*"([^"]+)"/gi)].map(m => m[1]);
  assert.deepEqual(ext, ['config/tasksdashboard.config.js']);
  assert.ok(!/type\s*=\s*["']?password/i.test(HTML));
});

test('next: only /board/, /app/ and /harness/; anything else, another host included, is /board/', () => {
  const { safeNext, NEXT_PAGES } = load(ORIGIN + '/signin').ctx.TDSignin;
  assert.deepEqual([...NEXT_PAGES], ['/board/', '/app/', '/harness/']);
  assert.equal(safeNext('/harness/'), '/harness/');
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

// ---- consulting-call mode (?intent=consult, db/025) ----
function submit(s, v) {
  const f = { telegram: { value: v.telegram || '' }, whatsapp: { value: v.whatsapp || '' }, note: { value: v.note || '' } };
  f.closest = () => f;
  s.app.onsubmit({ target: f, preventDefault() {} });
}

test('consult: ?intent=consult is kept in this tab and taken off the address; another value clears it', () => {
  const s = load(ORIGIN + '/signin?intent=consult&next=/app/'); s.start();
  assert.equal(stored(s, INTENT_KEY), 'consult');
  assert.equal(s.loc.search, '');
  const t = load(ORIGIN + '/signin?intent=other', { stored: { [INTENT_KEY]: 'consult' } }); t.start();
  assert.equal(stored(t, INTENT_KEY), null);
  assert.equal(t.loc.search, '');
});

test('consult: signed out it asks for Google sign-in to book a call, with no access-request wording', () => {
  const s = load(ORIGIN + '/signin?intent=consult'); s.start();
  assert.equal(s.app.dataset.state, 'signedout');
  assert.match(s.app.innerHTML, /<h1>Book a consulting call<\/h1>/);
  assert.match(s.app.innerHTML, /data-act="google"/);
  assert.match(s.app.innerHTML, /does not give access to any board/);
  assert.ok(!/decision \(approved or not\)/.test(s.app.innerHTML));
  assert.match(s.app.innerHTML, /<a href="\/privacy">privacy<\/a>/);
});

test('consult: signed in with no open request, the form shows the email read-only; no access request is made', async () => {
  const s = load(ORIGIN + '/signin', { stored: { [AUTH_KEY]: SESSION(), [INTENT_KEY]: 'consult' }, answers: { consultMine: [200, null] } });
  s.start(); await settle(s);
  assert.equal(s.app.dataset.state, 'consult');
  assert.match(s.app.innerHTML, /name="email" value="p@example.invalid" readonly/);
  for (const n of ['telegram', 'whatsapp', 'note']) assert.match(s.app.innerHTML, new RegExp(`name="${n}"`));
  assert.deepEqual(s.calls, ['/rest/v1/rpc/my_consultation_request']);
  assert.equal(s.loc.replaced, null);
});

test('consult: an open request is shown as sent (already with us), not the form', async () => {
  const s = load(ORIGIN + '/signin', { stored: { [AUTH_KEY]: SESSION(), [INTENT_KEY]: 'consult' },
    answers: { consultMine: [200, { status: 'open', requested_at: '2026-11-03T10:00:00Z', telegram: 'https://t.me/ada_l' }] } });
  s.start(); await settle(s);
  assert.equal(s.app.dataset.state, 'consultsent');
  assert.match(s.app.innerHTML, /already with us/);
  assert.match(s.app.innerHTML, /@ada_l/);
});

test('consult: sending calls request_consultation with the typed values, then shows the request', async () => {
  const s = load(ORIGIN + '/signin', { stored: { [AUTH_KEY]: SESSION(), [INTENT_KEY]: 'consult' },
    answers: { consultMine: [200, null], consult: [200, { created: true, status: 'open', whatsapp: 'https://wa.me/351912345678' }] } });
  s.start(); await settle(s);
  submit(s, { telegram: ' @ada_l ', whatsapp: '+351 912 345 678', note: '' });
  await settle(s);
  assert.equal(s.app.dataset.state, 'consultsent');
  assert.deepEqual(s.bodies['/rest/v1/rpc/request_consultation'], { p_telegram: '@ada_l', p_whatsapp: '+351 912 345 678', p_note: null });
  assert.match(s.app.innerHTML, /\+351912345678/);
  assert.ok(!/already with us/.test(s.app.innerHTML));
});

test('consult: a refused value (22023) goes back to the form with the message and what was typed', async () => {
  const s = load(ORIGIN + '/signin', { stored: { [AUTH_KEY]: SESSION(), [INTENT_KEY]: 'consult' },
    answers: { consultMine: [200, null], consult: [400, { code: '22023', message: 'Telegram: a username of 5 to 32 letters, digits or _' }] } });
  s.start(); await settle(s);
  submit(s, { telegram: 'ab', note: 'hello <b>' });
  await settle(s);
  assert.equal(s.app.dataset.state, 'consult');
  assert.match(s.app.innerHTML, /role="alert">Telegram: a username/);
  assert.match(s.app.innerHTML, /name="telegram"[^>]*value="ab"/);
  assert.match(s.app.innerHTML, /hello &lt;b&gt;<\/textarea>/);
});

test('consult: the cap (54000) says try later', async () => {
  const s = load(ORIGIN + '/signin', { stored: { [AUTH_KEY]: SESSION(), [INTENT_KEY]: 'consult' },
    answers: { consultMine: [200, null], consult: [400, { code: '54000', message: 'too many' }] } });
  s.start(); await settle(s);
  submit(s, {});
  await settle(s);
  assert.equal(s.app.dataset.state, 'cap');
});

// ---- Telegram link (db/032) ----
const TG_TOKEN = 'ab'.repeat(20);
const press = (s, act) => s.app.onclick({ target: { closest: () => ({ dataset: { act }, disabled: false }) } });

test('telegram: telegramClaim has the rules of set_telegram_claim; telegramDeepLink needs a bot and a 40-hex token', () => {
  const { telegramClaim, telegramDeepLink } = load(ORIGIN + '/signin').ctx.TDSignin;
  const ok = (v, want) => assert.deepEqual([telegramClaim(v).ok, telegramClaim(v).value], [true, want], String(v));
  ok('', null); ok('  ', null); ok(null, null);
  ok('@ada_lovelace', '@ada_lovelace'); ok(' ada_lovelace ', '@ada_lovelace'); ok('https://t.me/ada_lovelace', '@ada_lovelace'); ok('t.me/ada_lovelace', '@ada_lovelace');
  ok('123456789', '123456789');
  for (const bad of ['@abc', 'ada lovelace', '1234', '_ada_l', '@' + 'a'.repeat(33), 'ada-l', '+351912345678'])
    assert.equal(telegramClaim(bad).ok, false, bad);
  assert.equal(telegramDeepLink('MD_support_line_bot', TG_TOKEN), 'https://t.me/MD_support_line_bot?start=' + TG_TOKEN);
  assert.equal(telegramDeepLink('', TG_TOKEN), '');
  assert.equal(telegramDeepLink('bad bot', TG_TOKEN), '');
  assert.equal(telegramDeepLink('MD_support_line_bot', 'xyz'), '');
  assert.equal(telegramDeepLink('MD_support_line_bot', TG_TOKEN.toUpperCase()), '');
});

test('telegram: the sign-in screen has the optional field; a valid claim is kept in this tab before Google opens', async () => {
  const s = load(ORIGIN + '/signin', { inputs: { 'tg-claim': { value: ' ada_lovelace ' } } }); s.start();
  assert.match(s.app.innerHTML, /<label class="tgfield"><span>Telegram <span class="opt">\(optional\)<\/span><\/span><input type="text" name="telegram" id="tg-claim"/);
  assert.match(s.app.innerHTML, /one-time link/);
  press(s, 'google');
  for (let i = 0; i < 200 && !s.loc.assigned; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(stored(s, 'td.signin.telegram'), '@ada_lovelace');
  assert.ok(s.loc.assigned);
});

test('telegram: a bad claim stops before Google with the reason; an empty one clears what was kept', () => {
  const s = load(ORIGIN + '/signin', { inputs: { 'tg-claim': { value: 'ada lovelace' } } }); s.start();
  press(s, 'google');
  assert.equal(s.loc.assigned, null);
  assert.match(s.app.innerHTML, /role="alert">Telegram: a username of 5 to 32/);
  const t = load(ORIGIN + '/signin', { stored: { 'td.signin.telegram': '@old_name' }, inputs: { 'tg-claim': { value: '' } } }); t.start();
  press(t, 'google');
  assert.equal(stored(t, 'td.signin.telegram'), null);
});

test('telegram: the kept claim is sent with set_telegram_claim before request_access, then forgotten', async () => {
  const s = load(ORIGIN + '/signin', { stored: { [AUTH_KEY]: SESSION(), 'td.signin.telegram': '@ada_lovelace' },
    answers: { mine: [200, null], request: [200, { status: 'pending' }], tgClaim: [200, { claim: '@ada_lovelace' }], tgMine: [200, { linked: false, claim: '@ada_lovelace' }] } });
  s.start(); await settle(s);
  assert.deepEqual(s.calls.slice(0, 3), ['/rest/v1/rpc/my_access_request', '/rest/v1/rpc/set_telegram_claim', '/rest/v1/rpc/request_access']);
  assert.deepEqual(s.bodies['/rest/v1/rpc/set_telegram_claim'], { p_claim: '@ada_lovelace' });
  assert.equal(stored(s, 'td.signin.telegram'), null);
  assert.equal(s.app.dataset.state, 'sent');
  assert.match(s.app.innerHTML, /@ada_lovelace <span class="opt">\(not confirmed yet\)<\/span>/);
});

test('telegram: no claim, no set_telegram_claim call; a household login still goes on', async () => {
  const s = load(ORIGIN + '/signin', { stored: { [AUTH_KEY]: SESSION() },
    answers: { mine: [200, null], request: [400, { code: '22023', message: 'household members already have access' }] } });
  s.start(); await settle(s);
  assert.ok(!s.calls.includes('/rest/v1/rpc/set_telegram_claim'));
  assert.equal(s.loc.replaced, '/board/');
});

test('telegram: Link Telegram on the request screen asks for a token and shows the deep link', async () => {
  const s = load(ORIGIN + '/signin', { config: { telegramBot: '@MD_support_line_bot' }, stored: { [AUTH_KEY]: SESSION() },
    answers: { mine: [200, [{ status: 'pending', requested_at: '2026-11-11T10:00:00Z' }]], tgMine: [200, { linked: false, claim: null }],
      tgToken: [200, { token: TG_TOKEN, expires_at: '2026-11-11T10:15:00Z' }] } });
  s.start(); await settle(s);
  assert.match(s.app.innerHTML, /<button type="button" class="secondary" data-act="tglink">Link Telegram<\/button>/);
  press(s, 'tglink');
  for (let i = 0; i < 200 && !/Open Telegram/.test(s.app.innerHTML); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(s.app.innerHTML.includes('href="https://t.me/MD_support_line_bot?start=' + TG_TOKEN + '" target="_blank" rel="noopener noreferrer"'));
  assert.match(s.app.innerHTML, /Link valid until/);
  assert.match(s.app.innerHTML, /Works once, for 15 minutes/);
});

test('telegram: linked shows the username and no button; no bot in the config says so; a database without db/032 says so', async () => {
  let s = load(ORIGIN + '/signin', { config: { telegramBot: 'MD_support_line_bot' }, stored: { [AUTH_KEY]: SESSION() },
    answers: { mine: [200, [{ status: 'pending' }]], tgMine: [200, { linked: true, tg_username: 'ada_lovelace' }] } });
  s.start(); await settle(s);
  assert.match(s.app.innerHTML, /Linked as @ada_lovelace/);
  assert.ok(!/data-act="tglink"/.test(s.app.innerHTML));
  s = load(ORIGIN + '/signin', { stored: { [AUTH_KEY]: SESSION() }, answers: { mine: [200, [{ status: 'pending' }]] } });
  s.start(); await settle(s);
  assert.match(s.app.innerHTML, /Telegram linking is not set up on this site yet/);
  s = load(ORIGIN + '/signin', { config: { telegramBot: 'MD_support_line_bot' }, stored: { [AUTH_KEY]: SESSION() },
    answers: { mine: [200, [{ status: 'pending' }]], tgMine: [404, { code: 'PGRST202' }], tgToken: [404, { code: 'PGRST202', message: 'no function' }] } });
  s.start(); await settle(s);
  assert.equal(s.app.dataset.state, 'sent');
  press(s, 'tglink');
  for (let i = 0; i < 200 && !/role="alert"/.test(s.app.innerHTML); i++) await new Promise(r => setTimeout(r, 5));
  assert.match(s.app.innerHTML, /not set up on the database yet/);
});
