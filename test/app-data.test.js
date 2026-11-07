// node --test test/  — the phone app's data layer (app/td-data.js) against a fake Supabase (fetch), fake storage, a fake
// IndexedDB queue store and fake timers: Google sign-in (no password path), the hand-over from /signin, sign-out to other tabs,
// refresh and retry on 401, a versioned PATCH that misses (conflict
// merge), the durable queue (record/restore, offline edit -> new page -> sent with the persisted version), the access gate,
// and the Google PKCE verifier (10-minute expiry, one use). No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'app', 'td-core.js'));
const D = require(path.join(__dirname, '..', 'app', 'td-data.js'));

const URL0 = 'https://abc.supabase.co';
const CONFIG = { supabaseUrl: URL0, publishableKey: 'sb_publishable_test', pollMs: 30000 };
const UID = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const LIST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const T0 = Date.parse('2026-10-29T10:00:00Z');

const memStore = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; };
const memQueue = () => { const m = new Map(); return { all: async uid => [...m.values()].filter(r => r.uid === uid).map(r => JSON.parse(JSON.stringify(r))), put: async r => { m.set(r.key, JSON.parse(JSON.stringify(r))); }, del: async k => { m.delete(k); }, clear: async uid => { [...m.keys()].forEach(k => { if (m.get(k).uid === uid) m.delete(k); }); }, m }; };
const timers = { setTimeout: (f, ms) => setTimeout(f, Math.min(ms, 5)), clearTimeout: id => clearTimeout(id), setInterval: () => 1, clearInterval: () => {} };
const grant = (token, uid) => ({ access_token: token, refresh_token: 'r-' + token, expires_in: 3600, user: { id: uid || UID, email: 'me@example.com' } });
const row = o => Object.assign({ id: ITEM, list_id: LIST, num: 1, title: 'Buy milk', body_md: '', status: 'open', quadrant: 'A', urgent_pin: null, due_at: null, start_at: null, sort_key: 0, category: 'task', review_state: 'none', ai_confidence: null, created_by: UID, owner_id: UID, version: 1, deleted_at: null, updated_at: '2026-10-29T09:00:00Z', created_at: '2026-10-29T08:00:00Z' }, o);

// a tiny Supabase: routes are [method, regex, handler(match, body, headers, url)] -> [status, json]; calls are recorded
function fakeSupabase(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = url.slice(URL0.length), method = (init && init.method) || 'GET', body = init && init.body ? JSON.parse(init.body) : undefined, headers = (init && init.headers) || {};
    calls.push({ method, u, body, auth: headers.Authorization || null });
    if (fetch.offline) throw new TypeError('fetch failed');
    for (const [m, rx, fn] of routes.concat(BASE)) {
      const hit = m === method && u.match(rx);
      if (hit) { const [status, json] = fn(hit, body, headers, u); return new Response(json === undefined ? '' : JSON.stringify(json), { status }); }
    }
    return new Response(JSON.stringify({ message: 'no route ' + method + ' ' + u }), { status: 404 });
  };
  fetch.calls = calls;
  return fetch;
}
// what loadAll reads, for a household member with one list and one item
const BASE = [
  ['POST', /^\/auth\/v1\/token\?grant_type=pkce/, () => [200, grant('A')]],
  ['POST', /^\/auth\/v1\/token\?grant_type=refresh_token/, () => [200, grant('R')]],
  ['GET', /^\/rest\/v1\/items\?select=\*&deleted_at/, () => [200, [row()]]],
  ['GET', /^\/rest\/v1\/lists\?select=id,slug/, () => [200, [{ id: LIST, slug: 'home', name: 'Home', default_category: 'task', sort: 1, owner_id: UID }]]],
  ['GET', /^\/rest\/v1\/list_members\?select=list_id,role/, () => [200, [{ list_id: LIST, role: 'owner', hidden_at: null }]]],
  ['GET', /^\/rest\/v1\/categories/, () => [200, []]],
  ['GET', /^\/rest\/v1\/profiles\?select=id,handle/, () => [200, [{ id: UID, handle: 'me', display_name: 'Me', kind: 'human', is_household: true }]]],
  ['POST', /^\/rest\/v1\/rpc\/visible_profiles/, () => [200, []]],
  ['GET', /^\/rest\/v1\/tag_lists/, () => [200, []]],
  ['GET', /^\/rest\/v1\/tag_list_members/, () => [200, []]],
  ['GET', /^\/rest\/v1\/tags\?select=\*&deleted_at/, () => [200, []]],
  ['POST', /^\/rest\/v1\/rpc\/my_invitations/, () => [200, []]],
  ['GET', /^\/rest\/v1\/shared_notices/, () => [200, []]],
  ['GET', /^\/rest\/v1\/preferences/, () => [200, []]],
  ['POST', /^\/rest\/v1\/preferences/, () => [201, undefined]],
  ['GET', /^\/rest\/v1\/item_tags/, () => [200, []]],
  ['GET', /^\/rest\/v1\/item_links/, () => [200, []]],
];

function make(fetch, more) {
  let t = T0;
  const o = Object.assign({ config: CONFIG, core: C, fetch, now: () => t, storage: { local: memStore(), session: memStore() }, idb: null, locks: null, broadcast: () => null, timers,
    location: { origin: 'https://homeos-tasksboard.pages.dev', href: 'https://homeos-tasksboard.pages.dev/app/', pathname: '/app/' }, navigate: () => {}, replaceUrl: () => {} }, more || {});
  const d = D.create(o);
  d.tick = ms => { t += ms; };
  d.opts = o;
  return d;
}
// a signed-in data layer the way the app signs in: back from Google with a stored verifier (token?grant_type=pkce -> grant A)
async function signIn(d, stay = true) {
  d.opts.storage.local.setItem(D.PKCE_KEY, JSON.stringify({ verifier: 'v'.repeat(43), stay, at: d.opts.now() }));
  const r = await d.finishGoogle({ code: 'code-1', cleanUrl: '/app/' });
  assert.equal(r, null, 'signed in');
}
const until = async (fn, n = 200) => { for (let i = 0; i < n && !fn(); i++) await new Promise(r => setTimeout(r, 2)); assert.ok(fn(), 'condition not reached'); };

test('no password path: the data layer has no signIn; Google keeps td.auth in localStorage (Stay signed in), unticked in sessionStorage', async () => {
  const f = fakeSupabase([]);
  const d = make(f);
  assert.equal(typeof d.signIn, 'undefined');
  await signIn(d, true);
  assert.deepEqual(JSON.parse(d.opts.storage.local.getItem('td.auth')), { refresh_token: 'r-A', uid: UID });
  assert.equal(d.opts.storage.session.getItem('td.auth'), null);
  assert.equal(d.session.uid, UID);
  const d2 = make(f);
  await signIn(d2, false);
  assert.equal(d2.opts.storage.local.getItem('td.auth'), null);
  assert.ok(d2.opts.storage.session.getItem('td.auth'));
  assert.ok(!f.calls.some(c => /grant_type=password/.test(c.u)), 'no password grant is ever sent');
});

test('signed out on a hosted origin: goSignin goes to /signin?next=/app/ with the Stay box; localhost and file:// stay', () => {
  const went = [];
  const d = make(fakeSupabase([]), { location: { origin: 'https://eisenhower-agentic-planner-app.pages.dev', href: 'https://eisenhower-agentic-planner-app.pages.dev/app/', pathname: '/app/', replace: u => went.push(u) } });
  assert.equal(d.signinPage(), '/signin?next=/app/');
  assert.equal(d.goSignin(false), '/signin?next=/app/');
  assert.deepEqual(went, ['/signin?next=/app/']);
  assert.equal(d.opts.storage.session.getItem('td.signin.stay'), '0');
  for (const origin of ['http://localhost:8788', 'http://127.0.0.1:8788', 'https://localhost', 'null', '']) {
    const e = make(fakeSupabase([]), { location: { origin, href: origin + '/app/', pathname: '/app/', replace: u => went.push(u) } });
    assert.equal(e.signinPage(), null, origin);
    assert.equal(e.goSignin(true), null, origin);
  }
  assert.equal(went.length, 1);
});

test('back from /signin: its session (sessionStorage td.request.auth) becomes td.auth once, as its Stay box said; a bad one is dropped', async () => {
  let used = null;
  const f = fakeSupabase([['POST', /grant_type=refresh_token/, (m, body) => { used = body.refresh_token; return [200, grant('H')]; }]]);
  const d = make(f);
  d.opts.storage.session.setItem('td.request.auth', JSON.stringify({ access_token: 'x', refresh_token: 'from-signin', expires_at: T0 + 3600e3, email: 'me@example.com' }));
  d.opts.storage.session.setItem('td.signin.stay', '1');
  assert.equal((await d.start()).state, 'signedin');
  assert.equal(used, 'from-signin');
  assert.equal(d.opts.storage.session.getItem('td.request.auth'), null, 'the hand-over key is deleted');
  assert.equal(d.opts.storage.session.getItem('td.signin.stay'), null);
  assert.deepEqual(JSON.parse(d.opts.storage.local.getItem('td.auth')), { refresh_token: 'r-H', uid: UID });

  const e = make(fakeSupabase([]));
  e.opts.storage.session.setItem('td.request.auth', JSON.stringify({ refresh_token: 'from-signin' }));
  e.opts.storage.session.setItem('td.signin.stay', '0');
  assert.equal((await e.start()).state, 'signedin');
  assert.equal(e.opts.storage.local.getItem('td.auth'), null, 'unticked: this tab only');
  assert.ok(e.opts.storage.session.getItem('td.auth'));

  const g = make(fakeSupabase([]));
  g.opts.storage.session.setItem('td.request.auth', '{not json');
  assert.equal((await g.start()).state, 'signin');
  assert.equal(g.opts.storage.session.getItem('td.request.auth'), null);
  // a dead hand-over token: signed out, and nothing is left to hand over again (no loop back to the board)
  const h = make(fakeSupabase([['POST', /grant_type=refresh_token/, () => [400, { error_code: 'refresh_token_not_found' }]]]));
  h.opts.storage.session.setItem('td.request.auth', JSON.stringify({ refresh_token: 'dead' }));
  const r = await h.start();
  assert.equal(r.state, 'signin');
  assert.equal(h.opts.storage.session.getItem('td.request.auth'), null);
  assert.equal(h.opts.storage.local.getItem('td.auth'), null);
});

test('S14: sign-out reaches the other tabs of the same person (BroadcastChannel td.auth), and a tab signs out on that message', async () => {
  const posted = [];
  let onA = null;
  const chan = () => { const c = { postMessage: m => posted.push(m) }; Object.defineProperty(c, 'onmessage', { set: fn => { onA = fn; }, get: () => onA }); return c; };
  const d = make(fakeSupabase([['POST', /^\/auth\/v1\/logout/, () => [204, undefined]]]), { broadcast: chan });
  await signIn(d, true);
  assert.equal((await d.signOut(true)).ok, true);
  assert.deepEqual(posted.filter(m => m.type === 'signout'), [{ type: 'signout', uid: UID }]);
  // the receiving side: another tab of the same person shows sign-in with a message
  let onB = null;
  const chanB = () => { const c = { postMessage: () => {} }; Object.defineProperty(c, 'onmessage', { set: fn => { onB = fn; }, get: () => onB }); return c; };
  const e = make(fakeSupabase([]), { broadcast: chanB });
  await signIn(e, true);
  const events = [];
  e.on('session', x => events.push(x));
  onB({ data: { type: 'signout', uid: OTHER } });
  assert.ok(e.session, 'another person signing out changes nothing');
  onB({ data: { type: 'signout', uid: UID } });
  assert.equal(e.session, null);
  assert.ok(events.some(x => x.state === 'signin' && /another tab/.test(x.msg)));
  // signed out already (no live session): nothing is broadcast
  posted.length = 0;
  await d.signOut(true);
  assert.equal(posted.length, 0);
});

test('rest: a 401 refreshes once and retries with the new token; a dead refresh token ends the session and keeps the queue', async () => {
  let refreshed = 0;
  const f = fakeSupabase([
    ['POST', /grant_type=refresh_token/, () => { refreshed++; return [200, grant('B')]; }],
    ['GET', /^\/rest\/v1\/probe/, (m, b, h) => h.Authorization === 'Bearer B' ? [200, [{ ok: 1 }]] : [401, { code: 'PGRST301', message: 'JWT expired' }]],
  ]);
  const d = make(f);
  await signIn(d, true);
  const r = await d.rest('GET', 'probe');
  assert.equal(r.ok, true);
  assert.equal(refreshed, 1);
  assert.deepEqual(f.calls.filter(c => c.u === '/rest/v1/probe').map(c => c.auth), ['Bearer A', 'Bearer B']);

  const g = fakeSupabase([
    ['POST', /grant_type=refresh_token/, () => [400, { error_code: 'refresh_token_already_used' }]],
    ['PATCH', /^\/rest\/v1\/items/, () => [401, { code: 'PGRST301' }]],
  ]);
  const e = make(g);
  const events = [];
  e.on('session', x => events.push(x.state));
  await signIn(e, true);
  await e.loadAll();
  e.edit(ITEM, t => { t.title = 'Buy oat milk'; });
  await until(() => events.includes('ended'));
  assert.equal(e.pending, 1, 'the change waits for the next sign-in');
  assert.equal(e.syncState().state, 'ended');
});

test('Session ended: the message says the waiting change is sent after sign-in only when IndexedDB keeps it; otherwise that it is lost', async () => {
  const ended = async idb => {
    const g = fakeSupabase([
      ['POST', /grant_type=refresh_token/, () => [400, { error_code: 'refresh_token_already_used' }]],
      ['PATCH', /^\/rest\/v1\/items/, () => [401, { code: 'PGRST301' }]],
    ]);
    const e = make(g, { idb });
    const msgs = [];
    e.on('session', x => { if (x.state === 'ended') msgs.push(x.msg); });
    await signIn(e, true);
    await e.loadAll();
    e.edit(ITEM, t => { t.title = 'Buy oat milk'; });
    await until(() => msgs.length > 0);
    return msgs[0];
  };
  assert.equal(await ended(memQueue()), 'Session ended. Sign in again. 1 change waits and is sent after you sign in.');
  assert.equal(await ended(null), 'Session ended. Sign in again. 1 change is not saved: signing in again reloads the page and drops it.');
});

test('versioned PATCH that matches no row: no clash -> sent again on the new version; a clash -> conflict event, their version kept', async () => {
  let remote = row({ version: 1 });
  const f = fakeSupabase([
    ['GET', /^\/rest\/v1\/items\?select=\*&deleted_at/, () => [200, [row()]]],
    ['GET', /^\/rest\/v1\/items\?select=\*&id=eq\./, () => [200, [remote]]],
    ['PATCH', /^\/rest\/v1\/items\?id=eq\.[^&]+&version=eq\.(\d+)/, (m, body) => {
      if (Number(m[1]) !== remote.version) return [200, []];
      remote = Object.assign({}, remote, body, { version: remote.version + 1 });
      return [200, [remote]];
    }],
  ]);
  const d = make(f);
  await signIn(d, true);
  await d.loadAll();
  // someone else changed the description meanwhile (version 2)
  remote = row({ version: 2, body_md: 'from the shop' });
  d.edit(ITEM, t => { t.title = 'Buy oat milk'; });
  await until(() => d.pending === 0);
  const t = d.find(ITEM);
  assert.equal(t.title, 'Buy oat milk');
  assert.equal(t.notes, 'from the shop');
  assert.equal(t.version, 3);
  assert.equal(remote.title, 'Buy oat milk');

  // now a clash: they changed the title too
  const conflicts = [];
  d.on('conflict', c => conflicts.push(c));
  remote = Object.assign({}, remote, { title: 'Buy soy milk', version: 4 });
  d.edit(ITEM, x => { x.title = 'Buy rice milk'; }, { origin: 'dialog' });
  await until(() => conflicts.length === 1 && d.pending === 0);
  assert.deepEqual(conflicts[0].fields, ['title']);
  assert.equal(conflicts[0].draft.title, 'Buy rice milk');
  assert.equal(d.find(ITEM).title, 'Buy soy milk');
  assert.equal(d.syncState().state, 'conflict');
});

test('queue record and restore: dates, an unset urgency, tags and the version at edit time survive the round trip', () => {
  const t = C.rowToTask(row({ version: 7, due_at: '2026-11-02T09:00:00Z' }));
  t.deadline = new Date('2026-11-05T09:00:00Z'); t.pin = undefined; t.tags = ['x'];
  const e = { fields: new Set(['deadline', 'pin', 'tags']), base: { deadline: new Date('2026-11-02T09:00:00Z'), pin: true, tags: [] }, create: null, origin: 'dialog' };
  const rec = JSON.parse(JSON.stringify(D.queueRecord(UID, t, e)));
  assert.equal(rec.key, UID + ':' + ITEM);
  const fresh = C.rowToTask(row({ version: 9 }));
  const r = D.queueRestore(rec, fresh);
  assert.equal(r.task, fresh);
  assert.equal(fresh.version, 7, 'the persisted version: a later save by someone else makes the PATCH miss');
  assert.equal(fresh.deadline.toISOString(), '2026-11-05T09:00:00.000Z');
  assert.equal(fresh.pin, undefined);
  assert.deepEqual(fresh.tags, ['x']);
  assert.deepEqual([...r.entry.fields].sort(), ['deadline', 'pin', 'tags']);
  assert.equal(r.entry.base.deadline.toISOString(), '2026-11-02T09:00:00.000Z');
  assert.equal(r.entry.base.pin, true);
  assert.equal(r.entry.origin, 'dialog');
  // a write in flight stays in the record until it lands
  const flying = D.queueRecord(UID, t, { fields: new Set(), base: {}, sending: { fields: new Set(['title']), base: { title: 'old' } } });
  assert.deepEqual(flying.fields, ['title']);
  // a create keeps the whole task; an edit of an item that is gone is dropped
  const nt = Object.assign(C.rowToTask(row({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })), { createdAt: new Date(T0) });
  const cr = D.queueRestore(JSON.parse(JSON.stringify(D.queueRecord(UID, nt, { fields: new Set(), base: {}, create: true }))), null);
  assert.equal(cr.isNew, true);
  assert.equal(cr.entry.create, true);
  assert.equal(cr.task.createdAt.getTime(), T0);
  assert.equal(D.queueRestore(rec, null), null);
});

test('durable queue: an offline edit is stored, a new page sends it after loadAll with the persisted version, then the record goes', async () => {
  const q = memQueue();
  let patches = [];
  const f = fakeSupabase([
    ['GET', /^\/rest\/v1\/items\?select=\*&deleted_at/, () => [200, [row({ version: 1 })]]],
    ['PATCH', /^\/rest\/v1\/items\?id=eq\.[^&]+&version=eq\.(\d+)/, (m, body) => { patches.push([Number(m[1]), body]); return [200, [row(Object.assign({}, body, { version: 2 }))]]; }],
  ]);
  const local = memStore();
  const d = make(f, { idb: q, storage: { local, session: memStore() } });
  await signIn(d, true);
  await d.loadAll();
  f.offline = true;
  d.edit(ITEM, t => { t.title = 'Call the plumber'; });
  await until(() => d.syncState().state === 'offline');
  assert.equal(q.m.size, 1);
  assert.equal([...q.m.values()][0].values.title, 'Call the plumber');
  // the app is killed; a new page starts online with the same storage and IndexedDB
  f.offline = false;
  const d2 = make(f, { idb: q, storage: { local, session: memStore() } });
  assert.equal((await d2.start()).state, 'signedin');
  await d2.loadAll();
  await until(() => d2.pending === 0 && q.m.size === 0);
  assert.deepEqual(patches.map(p => p[0]), [1]);
  assert.equal(patches[0][1].title, 'Call the plumber');
  assert.equal(d2.find(ITEM).title, 'Call the plumber');
});

test('durable queue: an edit made after "Session ended" is stored too; sign-out clears that person\'s queue and app keys', async () => {
  const q = memQueue(), local = memStore();
  const f = fakeSupabase([
    ['POST', /grant_type=refresh_token/, () => [400, { error_code: 'refresh_token_already_used' }]],
    ['PATCH', /^\/rest\/v1\/items/, () => [401, { code: 'PGRST301' }]],
  ]);
  const d = make(f, { idb: q, storage: { local, session: memStore() } });
  await signIn(d, true);
  await d.loadAll();
  local.setItem('td.app.list', LIST); local.setItem('td.app.lastList', LIST);
  d.edit(ITEM, t => { t.title = 'first'; });
  await until(() => d.syncState().state === 'ended');
  d.edit(ITEM, t => { t.notes = 'typed after the session ended'; });
  await until(() => q.m.size === 1 && (([...q.m.values()][0].values || {}).notes === 'typed after the session ended'));
  assert.deepEqual([...q.m.values()][0].fields.sort(), ['notes', 'title']);
  assert.equal((await d.signOut(true)).ok, true);
  assert.equal(q.m.size, 0, 'the dropped changes do not come back at the next sign-in');
  for (const k of D.USER_KEYS) assert.equal(local.getItem(k), null, k);
});

test('a queued change sent twice (a second tab, a restored record) is not a conflict when the row already holds it', async () => {
  let remote = row({ version: 2, title: 'Call the plumber' }); // the first copy landed: version 1 -> 2
  let patches = 0;
  const f = fakeSupabase([
    ['GET', /^\/rest\/v1\/items\?select=\*&deleted_at/, () => [200, [row({ version: 1 })]]],
    ['GET', /^\/rest\/v1\/items\?select=\*&id=eq\./, () => [200, [remote]]],
    ['PATCH', /^\/rest\/v1\/items\?id=eq\.[^&]+&version=eq\.(\d+)/, (m, body) => { patches++; if (Number(m[1]) !== remote.version) return [200, []]; remote = Object.assign({}, remote, body, { version: remote.version + 1 }); return [200, [remote]]; }],
  ]);
  const d = make(f);
  const conflicts = [];
  d.on('conflict', c => conflicts.push(c));
  await signIn(d, true);
  await d.loadAll();
  d.edit(ITEM, t => { t.title = 'Call the plumber'; });
  await until(() => d.pending === 0);
  assert.equal(conflicts.length, 0);
  assert.equal(patches, 1, 'not sent again');
  assert.equal(d.find(ITEM).version, 2);
  assert.notEqual(d.syncState().state, 'conflict');
});

test('durable queue fails open: a throwing store turns durability off, the edit still goes out from memory', async () => {
  const bad = { all: async () => { throw new Error('quota'); }, put: async () => { throw new Error('quota'); }, del: async () => {}, clear: async () => {} };
  const f = fakeSupabase([
    ['GET', /^\/rest\/v1\/items\?select=\*&deleted_at/, () => [200, [row()]]],
    ['PATCH', /^\/rest\/v1\/items/, (m, body) => [200, [row(Object.assign({}, body, { version: 2 }))]]],
  ]);
  const d = make(f, { idb: bad });
  await signIn(d, true);
  await d.loadAll();
  assert.equal(d.durable, false);
  d.edit(ITEM, t => { t.title = 'x'; });
  await until(() => d.pending === 0);
});

test('create: a new task goes on top of its quadrant with a client id; done and delete give an undo', async () => {
  const posted = [];
  const f = fakeSupabase([
    ['GET', /^\/rest\/v1\/items\?select=\*&deleted_at/, () => [200, [row({ sort_key: 0 })]]],
    ['POST', /^\/rest\/v1\/items$/, (m, body) => { posted.push(body); return [201, [row(Object.assign({}, body, { quadrant: body.quadrant, num: 2, version: 1 }))]]; }],
    ['PATCH', /^\/rest\/v1\/items/, (m, body) => [200, [row(Object.assign({ id: posted[0] ? posted[0].id : ITEM }, body, { version: 2 }))]]],
  ]);
  const d = make(f, { uuid: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
  await signIn(d, true);
  await d.loadAll();
  const c = d.create({ list: LIST, q: 'A', title: 'New one' });
  assert.equal(c.task.id, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  assert.ok(c.task.sortKey < 0, 'above the card on top');
  assert.equal(typeof c.undo, 'function');
  await until(() => d.pending === 0);
  assert.equal(posted[0].id, c.task.id);
  assert.equal(posted[0].quadrant, 'A');
  const done = d.markDone(c.task.id);
  assert.match(done.msg, /^Completed: New one/);
  assert.equal(d.find(c.task.id).status, 'done');
  done.undo();
  assert.equal(d.find(c.task.id).status, 'open');
});

test('gate: household, an approved request or a list shared by someone else -> board; otherwise pending, declined, none; failures -> error', async () => {
  assert.equal(D.gateFrom({ household: true }), 'board');
  assert.equal(D.gateFrom({ shared: true }), 'board');
  assert.equal(D.gateFrom({ request: { status: 'approved' } }), 'board');
  assert.equal(D.gateFrom({ request: { status: 'pending' } }), 'pending');
  assert.equal(D.gateFrom({ request: { status: 'declined' } }), 'declined');
  assert.equal(D.gateFrom({ request: { status: 'removed' } }), 'none');
  assert.equal(D.gateFrom({ request: null }), 'none');
  assert.equal(D.gateFrom({ request: null, failed: true }), 'error');

  const guest = (o) => fakeSupabase([
    ['GET', /^\/rest\/v1\/profiles\?select=id,is_household/, () => [200, [{ id: UID, is_household: false }]]],
    ['GET', /^\/rest\/v1\/list_members\?select=list_id&/, () => [200, o.members || [{ list_id: LIST }]]],
    ['GET', /^\/rest\/v1\/lists\?select=id,owner_id/, () => [200, [{ id: LIST, owner_id: o.owner || UID }]]],
    ['POST', /^\/rest\/v1\/rpc\/my_access_request/, () => o.reqFail ? [500, { message: 'boom' }] : [200, o.req === undefined ? null : o.req]],
    ['POST', /^\/rest\/v1\/rpc\/request_access/, () => o.cap ? [400, { code: '54000', message: 'too many open requests' }] : [200, null]],
  ]);
  const gateOf = async o => { const d = make(guest(o)); await signIn(d, true); return d.gate(); };
  assert.equal(await gateOf({}), 'none', 'a guest with only their own My tasks');
  assert.equal(await gateOf({ owner: OTHER }), 'board');
  assert.equal(await gateOf({ req: { status: 'approved' } }), 'board');
  assert.equal(await gateOf({ req: [{ status: 'pending', requested_at: '2026-10-29T09:00:00Z' }] }), 'pending');
  assert.equal(await gateOf({ req: { status: 'declined' } }), 'declined');
  assert.equal(await gateOf({ reqFail: true }), 'error');
  const hh = make(fakeSupabase([['GET', /^\/rest\/v1\/profiles\?select=id,is_household/, () => [200, [{ id: UID, is_household: true }]]],
    ['GET', /^\/rest\/v1\/list_members\?select=list_id&/, () => [200, []]], ['POST', /rpc\/my_access_request/, () => [404, { message: 'no function' }]]]));
  await signIn(hh, true);
  assert.equal(await hh.gate(), 'board', 'household even on a database without db/015');

  const d = make(guest({ cap: true }));
  await signIn(d, true);
  assert.equal((await d.requestAccess()).state, 'cap');
  let asked = 0;
  const e = make(fakeSupabase([
    ['POST', /rpc\/my_access_request/, () => [200, asked ? { status: 'pending', requested_at: '2026-10-29T10:00:00Z' } : null]],
    ['POST', /rpc\/request_access/, () => { asked++; return [200, null]; }],
  ]));
  await signIn(e, true);
  const r = await e.requestAccess();
  assert.equal(r.state, 'pending');
  assert.equal(asked, 1);
});

// 2026-10-30: the first tap saved the request but showed "Something went wrong" (twice with Try again): requestAccess()
// answers 'pending' and the app's screen table only has 'sent'. accessScreen() maps every gate and request state to a screen.
test('access request: the first tap and Try again both land on the "Request sent" screen with the request time', async () => {
  const fs = require('node:fs');
  const ROW = { id: 'r1', status: 'pending', email: 'g@example.com', first_name: 'G', last_name: null,
    requested_at: '2026-10-30T09:12:00+00:00', decided_at: null, applied_at: null, item_id: 'i1' };
  let saved = null, made = 0;
  // like db/015: my_access_request() is jsonb (null until a request exists); request_access() returns the row and, with a
  // request already open, returns that same row without making a second one
  const f = fakeSupabase([
    ['POST', /rpc\/my_access_request/, () => [200, saved]],
    ['POST', /rpc\/request_access/, () => { if (!saved) { saved = ROW; made++; } return [200, saved]; }],
  ]);
  const d = make(f);
  await signIn(d, true);
  const first = await d.requestAccess();
  assert.equal(D.accessScreen(first.state), 'sent', 'first tap');
  assert.equal(d.accessRequest().requested_at, ROW.requested_at, 'the screen shows the request time');
  const again = await d.requestAccess();
  assert.equal(D.accessScreen(again.state), 'sent', 'Try again after a saved request');
  assert.equal(made, 1, 'one request only');
  assert.equal(D.accessScreen('none'), 'ask');
  for (const s of ['board', 'declined', 'cap', 'error']) assert.equal(D.accessScreen(s), s);

  // the app page: every screen accessScreen() can return exists, and both paths (after sign-in, after a tap) go through it
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const table = page.slice(page.indexOf('function openAccess('), page.indexOf('$(\'#ac-body\')'));
  for (const s of ['none', 'pending', 'board', 'declined', 'cap', 'error']) assert.match(table, new RegExp('\\n\\s+' + D.accessScreen(s) + ': `'), 'screen ' + s);
  assert.match(page, /openAccess\(TDData\.accessScreen\(g\)\)/, 'afterSignIn');
  assert.match(page, /openAccess\(TDData\.accessScreen\(r\.state\), r\.message\)/, 'Ask for access / Try again');
});

test('Google PKCE: back to /app/, verifier in localStorage for 10 minutes and used once', async () => {
  let exchanged = null, went = null;
  const f = fakeSupabase([['POST', /grant_type=pkce/, (m, body) => { exchanged = body; return [200, grant('G')]; }]]);
  const local = memStore();
  const d = make(f, { storage: { local, session: memStore() }, navigate: u => { went = u; } });
  const url = await d.startGoogle({ stay: true });
  assert.equal(url, went);
  const q = new URL(url).searchParams;
  assert.equal(q.get('redirect_to'), 'https://homeos-tasksboard.pages.dev/app/');
  assert.equal(q.get('code_challenge_method'), 's256');
  const saved = JSON.parse(local.getItem(D.PKCE_KEY));
  assert.equal(saved.at, T0);
  // back within 10 minutes, in a new page (an installed iOS app): signed in, the verifier is gone
  const back = { origin: 'https://homeos-tasksboard.pages.dev', href: 'https://homeos-tasksboard.pages.dev/app/?code=abc', pathname: '/app/' };
  const d2 = make(f, { storage: { local, session: memStore() }, location: back });
  d2.tick(9 * 60 * 1000);
  assert.equal((await d2.start()).state, 'signedin');
  assert.deepEqual(exchanged, { auth_code: 'abc', code_verifier: saved.verifier });
  assert.equal(local.getItem(D.PKCE_KEY), null);
  // the same code again: the verifier was used
  const d3 = make(f, { storage: { local, session: memStore() }, location: back });
  const s3 = await d3.start();
  assert.equal(s3.state, 'signin');
  assert.match(s3.msg, /expired/);
  // too late: 11 minutes
  await d.startGoogle({});
  const d4 = make(f, { storage: { local, session: memStore() }, location: back });
  d4.tick(11 * 60 * 1000);
  assert.match((await d4.start()).msg, /expired/);
  assert.equal(local.getItem(D.PKCE_KEY), null);
});

test('sync state: saved, saving, offline with a count, conflict, ended', () => {
  assert.equal(D.syncStateOf({ pending: 0 }).state, 'saved');
  assert.equal(D.syncStateOf({ pending: 2 }).state, 'saving');
  assert.deepEqual(D.syncStateOf({ pending: 3, offline: true }), { state: 'offline', n: 3, text: 'Offline: 3 waiting' });
  assert.equal(D.syncStateOf({ pending: 0, conflict: true }).state, 'conflict');
  assert.equal(D.syncStateOf({ pending: 1, offline: true, ended: true }).state, 'ended');
});

test('saveProfile: PATCH profiles with display_name and timezone, names follow; an empty name or a refused row is an error', async () => {
  let refuse = false;
  const f = fakeSupabase([['PATCH', /^\/rest\/v1\/profiles\?id=eq\./, (m, body) => [200, refuse ? [] : [Object.assign({ id: UID }, body)]]]]);
  const d = make(f);
  await signIn(d, true);
  assert.equal((await d.loadAll()).ok, true);
  const r = await d.saveProfile({ display_name: ' Maks\u0007 ', timezone: 'Europe/Lisbon' });
  assert.equal(r.ok, true);
  const call = f.calls.find(c => c.method === 'PATCH' && c.u.startsWith('/rest/v1/profiles'));
  assert.deepEqual(call.body, { display_name: 'Maks', timezone: 'Europe/Lisbon' });
  assert.equal(d.me.display_name, 'Maks'); assert.equal(d.names[UID], 'Maks'); assert.equal(d.me.timezone, 'Europe/Lisbon');
  assert.equal((await d.saveProfile({ display_name: '  ' })).ok, false);
  refuse = true;
  assert.equal((await d.saveProfile({ display_name: 'X' })).err.kind, 'denied');
});

test('filter row: a phone write keeps the board\'s filters and filterBar, ids the phone does not know included', async () => {
  const filters = { mine: true, due: 'range', from: '2026-11-01', to: '2026-11-09', tags: ['tag-the-phone-does-not-know'], cats: ['task'], low: false };
  const filterBar = ['due', 'tl:list-the-phone-does-not-know', 'low'], saved = [];
  const f = fakeSupabase([
    ['GET', /^\/rest\/v1\/preferences/, () => [200, [{ prefs: { version: 2, filters, filterBar, tagListOrderV: 2 } }]]],
    ['POST', /^\/rest\/v1\/preferences/, (m, body) => { saved.push(body.prefs); return [201, undefined]; }],
  ]);
  const d = make(f);
  await signIn(d, true);
  assert.equal((await d.loadAll()).ok, true);
  d.setPrefs({ theme: 'dark' });
  await d.flushPrefs?.();
  assert.deepEqual(d.prefs.filters, filters);
  assert.deepEqual(d.prefs.filterBar, filterBar);
});

test('list panels: listBar survives a phone write, ids the phone does not know included', async () => {
  const listBar = { two: true, rows: [['list-the-phone-does-not-know'], ['another']] }, saved = [];
  const f = fakeSupabase([
    ['GET', /^\/rest\/v1\/preferences/, () => [200, [{ prefs: { version: 2, listBar, tagListOrderV: 2 } }]]],
    ['POST', /^\/rest\/v1\/preferences/, (m, body) => { saved.push(body.prefs); return [201, undefined]; }],
  ]);
  const d = make(f);
  await signIn(d, true);
  assert.equal((await d.loadAll()).ok, true);
  d.setPrefs({ theme: 'dark' });
  assert.deepEqual(d.prefs.listBar, listBar);
  await d.writePrefs();
  assert.deepEqual(saved[saved.length - 1].listBar, listBar);
});

test('archived lists: tasks by list, Delete through the RPC, who else loses it, the backup line', async () => {
  const OLD = 'cccccccc-cccc-4ccc-8ccc-cccccccccc11', SYS = 'cccccccc-cccc-4ccc-8ccc-cccccccccc12', calls = [];
  const f = fakeSupabase([
    ['GET', /^\/rest\/v1\/items\?select=id,list_id,title,num/, () => [200, [{ list_id: OLD, title: 'One', num: 1 }, { list_id: OLD, title: 'Two', num: 2 }]]],
    ['POST', /^\/rest\/v1\/rpc\/list_people/, () => [200, [{ state: 'member', profile_id: UID, display_name: 'Me' }, { state: 'member', profile_id: OTHER, display_name: 'Ana' }, { state: 'invited', email: 'x@example.com' }]]],
    ['POST', /^\/rest\/v1\/rpc\/last_backup_at/, () => [200, '2026-11-05T06:14:00Z']],
    ['POST', /^\/rest\/v1\/rpc\/delete_archived_list/, (m, body) => { calls.push(body); return [200, { name: 'Old', items: 2 }]; }],
  ]);
  const d = make(f);
  await signIn(d, true);
  assert.equal((await d.loadAll()).ok, true);
  const t = await d.archivedTasks([OLD, SYS]);
  assert.deepEqual({ [OLD]: t.tasks[OLD].map(x => x.title), [SYS]: t.tasks[SYS] }, { [OLD]: ['One', 'Two'], [SYS]: [] });
  const info = await d.deleteInfo(OLD);
  assert.deepEqual(info.others, ['Ana']);
  assert.match(info.backup, /^Last backup 2026-11-05 \d\d:\d4$/);
  const r = await d.deleteArchivedList(OLD);
  assert.equal(r.ok, true);
  assert.equal(r.msg, 'Deleted: Old');
  assert.deepEqual(calls, [{ p_list: OLD }]);
});

test('archived lists: no backup time yet reads as unknown; a refusal comes back as a sentence', async () => {
  const f = fakeSupabase([
    ['POST', /^\/rest\/v1\/rpc\/list_people/, () => [200, []]],
    ['POST', /^\/rest\/v1\/rpc\/last_backup_at/, () => [200, null]],
    ['POST', /^\/rest\/v1\/rpc\/delete_archived_list/, () => [409, { code: '23503', message: 'this list is the default list of the category task' }]],
  ]);
  const d = make(f);
  await signIn(d, true);
  assert.equal((await d.loadAll()).ok, true);
  assert.equal((await d.deleteInfo(LIST)).backup, 'Last backup time unknown');
  const r = await d.deleteArchivedList(LIST);
  assert.equal(r.ok, false);
  assert.equal(r.err.message, 'This list is the default list of the category task.');
});

test('tag lists (tags round): an old prefs row is migrated to the full order with the landing list as favourite and saved; ★ and a move write prefs and own sort', async () => {
  const A = 'cccccccc-cccc-4ccc-8ccc-cccccccccc01', B = 'cccccccc-cccc-4ccc-8ccc-cccccccccc02', S = 'cccccccc-cccc-4ccc-8ccc-cccccccccc03';
  const sorts = { [A]: 2, [B]: 1 }, saved = [], patched = [];
  let refuse = false;
  const f = fakeSupabase([
    ['GET', /^\/rest\/v1\/tag_lists/, () => [200, [
      { id: A, owner_id: UID, name: 'My tags', is_default: true, sort: sorts[A], archived_at: null },
      { id: B, owner_id: UID, name: 'Assignee', is_default: false, sort: sorts[B], archived_at: null },
      { id: S, owner_id: OTHER, name: 'Shared', is_default: false, sort: 1, archived_at: null }]]],
    ['GET', /^\/rest\/v1\/tag_list_members/, () => [200, [{ tag_list_id: A, role: 'owner', hidden_at: null }, { tag_list_id: B, role: 'owner', hidden_at: null }, { tag_list_id: S, role: 'viewer', hidden_at: null }]]],
    ['GET', /^\/rest\/v1\/preferences/, () => [200, [{ prefs: { version: 2, tagListOrder: [S], tagListsOpen: { [A]: true } } }]]],
    ['POST', /^\/rest\/v1\/preferences/, (m, body) => { saved.push(body.prefs); return [201, undefined]; }],
    ['PATCH', /^\/rest\/v1\/tag_lists\?id=eq\.([^&]+)/, (m, body) => { if (refuse) return [200, []]; patched.push([m[1], body.sort]); sorts[m[1]] = body.sort; return [200, [{ id: m[1], sort: body.sort }]]; }],
  ]);
  const d = make(f);
  await signIn(d, true);
  assert.equal((await d.loadAll()).ok, true);
  // web: load + C.tagListPrefsMigrate: own lists first (landing list first, then by sort), then the shared ones; favourite = landing list
  assert.deepEqual(d.prefs.tagListOrder, [A, B, S]);
  assert.deepEqual(d.prefs.tagListFavs, [A]);
  assert.equal(d.prefs.tagListOrderV, C.TAG_LIST_ORDER_V);
  assert.equal('tagListsOpen' in d.prefs, false);
  await until(() => saved.length > 0);
  assert.deepEqual(saved[0].tagListOrder, [A, B, S]);
  assert.equal(saved[0].tagListOrderV, 2);
  assert.equal('tagListsOpen' in saved[0], false);
  // ★ (web: toggleTagListFav): any number, also a shared list; off again
  assert.equal(d.toggleTagListFav(S), true);
  assert.deepEqual(d.prefs.tagListFavs, [A, S]);
  assert.equal(d.toggleTagListFav(A), false);
  assert.deepEqual(d.prefs.tagListFavs, [S]);
  // a move (web: saveTagListOrder): the shared list between my own; my own get sort in their new relative order (Assignee before My tags)
  const groups = C.tagGroups(d.tagLists, d.tags, UID, d.names, { order: d.prefs.tagListOrder });
  const r = C.tagListReorder(groups, UID, S, { dir: -1 }, d.prefs.tagListOrder);
  assert.deepEqual(r.order, [A, S, B]);
  assert.deepEqual(await d.saveTagListOrder(r.order), { ok: true });
  assert.deepEqual(d.prefs.tagListOrder, [A, S, B]);
  assert.deepEqual(patched, [[A, 1], [B, 2]]);
  assert.equal(d.tagLists[A].sort, 1);
  // the same order again writes nothing
  patched.length = 0;
  assert.deepEqual(await d.saveTagListOrder([A, S, B]), { ok: true });
  assert.deepEqual(patched, []);
  // a refused sort write is an error; the order is kept in prefs
  refuse = true;
  const r3 = await d.saveTagListOrder([B, S, A]);
  assert.equal(r3.ok, false);
  assert.equal(r3.err.message, 'You may not reorder these lists.');
  // a row already on v2 is not migrated again
  const d2 = make(fakeSupabase([
    ['GET', /^\/rest\/v1\/preferences/, () => [200, [{ prefs: { version: 2, tagListOrder: [], tagListOrderV: 2, tagListFavs: [] } }]]],
  ]));
  await signIn(d2, true);
  await d2.loadAll();
  assert.equal(d2.prefs.tagListOrderV, 2);
  assert.deepEqual(d2.prefs.tagListFavs, []);
  assert.equal(typeof d2.setDefaultTagList, 'undefined');
});

// self-improvement cards: the decision block's answer (C.answerDecision through saveTask) and items.details on the write path
const DEC = { v: 1, label_1: 'Yes', label_0: 'No', answer: null, module: 'm3', problem_key: 'm3:move-x', action: { kind: 'move', from: 'a', to: 'b' }, run_id: 'r1',
  answered_by: null, answered_at: null, applied_at: null, applied_result: null };
const decRow = o => row(Object.assign({ quadrant: 'C', title: 'Move x to y?', details: { decision: DEC, notify: ['me'] } }, o));

test('decision: saveTask answers with the other changes in one versioned PATCH (details whole, status done); Undo sends both back', async () => {
  let remote = decRow({ version: 1 }); const patches = [];
  const f = fakeSupabase([
    ['GET', /^\/rest\/v1\/items\?select=\*&deleted_at/, () => [200, [remote]]],
    ['PATCH', /^\/rest\/v1\/items\?id=eq\.[^&]+&version=eq\.(\d+)/, (m, body) => {
      patches.push(body);
      if (Number(m[1]) !== remote.version) return [200, []];
      remote = Object.assign({}, remote, body, { version: remote.version + 1 }); return [200, [remote]];
    }],
  ]);
  const d = make(f);
  await signIn(d, true);
  await d.loadAll();
  assert.deepEqual(C.decisionOf(d.find(ITEM)).label_1, 'Yes');
  const r = d.saveTask(ITEM, { title: 'Move x to y?', notes: 'checked', decision: 1 });
  assert.equal(r.decided, true);
  assert.equal(r.msg, 'Answered “Yes”: Move x to y?');
  await until(() => d.pending === 0);
  assert.equal(patches.length, 1, 'one write');
  assert.equal(patches[0].status, 'done');
  assert.equal(patches[0].body_md, 'checked');
  assert.deepEqual(patches[0].details.notify, ['me'], 'other keys kept');
  assert.equal(patches[0].details.decision.answer, 1);
  assert.equal(patches[0].details.decision.answered_by, 'me');
  assert.equal(patches[0].details.decision.answered_at, new Date(T0).toISOString());
  assert.equal(patches[0].details.decision.problem_key, 'm3:move-x');
  assert.equal(d.find(ITEM).status, 'done');
  r.undo();
  await until(() => d.pending === 0 && patches.length === 2);
  assert.equal(patches[1].status, 'open');
  assert.equal(patches[1].details.decision.answer, null);
  // applied by the routine: no answer any more
  remote = decRow({ version: remote.version + 1, details: { decision: Object.assign({}, DEC, { answer: 1, applied_at: '2026-11-04T10:00:00Z', applied_result: 'moved' }) } });
  await d.loadAll();
  const r2 = d.saveTask(ITEM, { decision: 0 });
  assert.equal(r2, null, 'nothing changed, nothing sent');
  assert.equal(patches.length, 2);
});

test('decision: a check or Delegate card closes at once (status done) and the toast says the task moves on the next check', async () => {
  for (const kind of ['check', 'delegate']) {
    let remote = decRow({ version: 1, details: { decision: Object.assign({}, DEC, { kind, label_1: 'Accept', label_0: 'Needs changes' }) } }); const patches = [];
    const f = fakeSupabase([
      ['GET', /^\/rest\/v1\/items\?select=\*&deleted_at/, () => [200, [remote]]],
      ['PATCH', /^\/rest\/v1\/items\?id=eq\.[^&]+&version=eq\.(\d+)/, (m, body) => {
        patches.push(body);
        if (Number(m[1]) !== remote.version) return [200, []];
        remote = Object.assign({}, remote, body, { version: remote.version + 1 }); return [200, [remote]];
      }],
    ]);
    const d = make(f);
    await signIn(d, true);
    await d.loadAll();
    const r = d.saveTask(ITEM, { decision: 0 });
    assert.equal(r.msg, 'Answered “Needs changes”: Move x to y? · the task moves on the master\'s next check', kind);
    await until(() => d.pending === 0);
    assert.equal(patches.length, 1, kind);
    assert.equal(patches[0].status, 'done', kind);
    assert.equal(patches[0].details.decision.answer, 0, kind);
    assert.equal(patches[0].details.decision.kind, kind);
    assert.equal(d.find(ITEM).status, 'done', kind);
  }
});

test('decision: the routine changed details meanwhile -> merged per key and sent again; both answered differently -> a conflict', async () => {
  let remote = decRow({ version: 1 }); const patches = [];
  const f = fakeSupabase([
    ['GET', /^\/rest\/v1\/items\?select=\*&deleted_at/, () => [200, [decRow({ version: 1 })]]],
    ['GET', /^\/rest\/v1\/items\?select=\*&id=eq\./, () => [200, [remote]]],
    ['PATCH', /^\/rest\/v1\/items\?id=eq\.[^&]+&version=eq\.(\d+)/, (m, body) => {
      patches.push(body);
      if (Number(m[1]) !== remote.version) return [200, []];
      remote = Object.assign({}, remote, body, { version: remote.version + 1 }); return [200, [remote]];
    }],
  ]);
  const d = make(f);
  await signIn(d, true);
  await d.loadAll();
  remote = decRow({ version: 2, details: { decision: DEC, notify: ['me'], seen: 'run2' } });
  d.saveTask(ITEM, { decision: 0 });
  await until(() => d.pending === 0);
  assert.equal(remote.version, 3);
  assert.equal(remote.details.seen, 'run2', 'their key kept');
  assert.equal(remote.details.decision.answer, 0, 'my answer sent on the new version');
  // a clash: someone answered Yes meanwhile, I answer No again from a stale copy
  const conflicts = [];
  d.on('conflict', c => conflicts.push(c));
  const t = d.find(ITEM);
  d.edit(t, x => { x.details = { decision: Object.assign({}, DEC, { answer: 1, answered_by: 'me', answered_at: 'x' }), notify: ['me'], seen: 'run2' }; });
  await until(() => d.pending === 0);
  remote = Object.assign({}, remote, { version: 9, details: { decision: Object.assign({}, DEC, { answer: 0, answered_by: 'other', answered_at: 'y' }), notify: ['me'], seen: 'run2' } });
  d.edit(t, x => { x.details = { decision: Object.assign({}, DEC, { answer: 1, answered_by: 'me', answered_at: 'z' }), notify: ['me'], seen: 'run2' }; }, { origin: 'dialog' });
  await until(() => conflicts.length === 1 && d.pending === 0);
  assert.deepEqual(conflicts[0].fields, ['details']);
  assert.match(conflicts[0].what, /decision/);
  assert.equal(d.find(ITEM).details.decision.answered_by, 'other', 'theirs kept');
});

test('decision offline: the answer waits in IndexedDB with details intact, a new page sends it after loadAll', async () => {
  const q = memQueue();
  const patches = [];
  const f = fakeSupabase([
    ['GET', /^\/rest\/v1\/items\?select=\*&deleted_at/, () => [200, [decRow({ version: 1 })]]],
    ['PATCH', /^\/rest\/v1\/items\?id=eq\.[^&]+&version=eq\.(\d+)/, (m, body) => { patches.push([Number(m[1]), body]); return [200, [decRow(Object.assign({}, body, { version: 2 }))]]; }],
  ]);
  const local = memStore();
  const d = make(f, { idb: q, storage: { local, session: memStore() } });
  await signIn(d, true);
  await d.loadAll();
  f.offline = true;
  d.saveTask(ITEM, { decision: 1 });
  await until(() => d.syncState().state === 'offline');
  const rec = [...q.m.values()][0];
  assert.ok(rec.fields.includes('details') && rec.fields.includes('status'));
  // a details key named like the encoder's markers ("d", "u") survives the record
  const back = D.queueRestore(JSON.parse(JSON.stringify(D.queueRecord(UID, Object.assign(C.rowToTask(decRow()), { details: { d: 1, u: 2, decision: DEC } }), { fields: new Set(['details']), base: { details: {} } }))), C.rowToTask(decRow()));
  assert.deepEqual(back.task.details, { d: 1, u: 2, decision: DEC });
  assert.deepEqual(back.entry.base.details, {});
  f.offline = false;
  const d2 = make(f, { idb: q, storage: { local, session: memStore() } });
  assert.equal((await d2.start()).state, 'signedin');
  await d2.loadAll();
  await until(() => d2.pending === 0 && q.m.size === 0);
  assert.equal(patches.length, 1);
  assert.equal(patches[0][0], 1);
  assert.equal(patches[0][1].status, 'done');
  assert.equal(patches[0][1].details.decision.answer, 1);
  assert.equal(patches[0][1].details.decision.module, 'm3');
  assert.deepEqual(patches[0][1].details.notify, ['me']);
  assert.equal(d2.find(ITEM).details.decision.answer, 1);
});

// quadrant buttons in the sheet (2026-11-07): saveTask's q goes in the same versioned write as the other fields, as a move writes it
test('saveTask q: a picked quadrant and a new End in one PATCH (quadrant, pin, on top); the same quadrant writes nothing of it', async () => {
  let remote = row({ version: 1, quadrant: 'A', sort_key: 50 }); const patches = [];
  const other = row({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', num: 2, quadrant: 'B', sort_key: 10, title: 'Other' });
  const f = fakeSupabase([
    ['GET', /^\/rest\/v1\/items\?select=\*&deleted_at/, () => [200, [remote, other]]],
    ['PATCH', /^\/rest\/v1\/items\?id=eq\.[^&]+&version=eq\.(\d+)/, (m, body) => {
      patches.push(body);
      if (Number(m[1]) !== remote.version) return [200, []];
      remote = Object.assign({}, remote, body, { version: remote.version + 1 }); return [200, [remote]];
    }],
  ]);
  const d = make(f);
  await signIn(d, true);
  await d.loadAll();
  const end = new Date('2026-11-20T18:00:00Z');
  const r = d.saveTask(ITEM, { title: 'Buy milk', deadline: end, q: 'B' });
  assert.equal(r.msg, 'Moved to Plan');
  await until(() => d.pending === 0);
  assert.equal(patches.length, 1, 'one write');
  assert.equal(patches[0].quadrant, 'B');
  assert.equal(patches[0].urgent_pin, false, 'urgent to not urgent: the pin follows');
  assert.equal(patches[0].due_at, end.toISOString());
  assert.ok(patches[0].sort_key < 10, 'on top of Plan');
  assert.equal(d.find(ITEM).q, 'B');
  r.undo();
  await until(() => d.pending === 0 && patches.length === 2);
  assert.equal(patches[1].quadrant, 'A');
  const r2 = d.saveTask(ITEM, { title: 'Buy oat milk', q: 'A' });
  await until(() => d.pending === 0 && patches.length === 3);
  assert.equal(r2.msg, 'Saved');
  assert.ok(!('quadrant' in patches[2]) && !('urgent_pin' in patches[2]), 'the shown quadrant again: no quadrant fields');
});

// done checkbox in the sheet (2026-11-07): saveTask done sends status done with the other edits and a quadrant pick in one write
test('saveTask done: a title edit, a quadrant pick and done in one PATCH, "Completed" with Undo back to open', async () => {
  let remote = row({ version: 1, quadrant: 'B' }); const patches = [];
  const f = fakeSupabase([
    ['GET', /^\/rest\/v1\/items\?select=\*&deleted_at/, () => [200, [remote]]],
    ['PATCH', /^\/rest\/v1\/items\?id=eq\.[^&]+&version=eq\.(\d+)/, (m, body) => {
      patches.push(body);
      if (Number(m[1]) !== remote.version) return [200, []];
      remote = Object.assign({}, remote, body, { version: remote.version + 1 }); return [200, [remote]];
    }],
  ]);
  const d = make(f);
  await signIn(d, true);
  await d.loadAll();
  const r = d.saveTask(ITEM, { title: 'Buy oat milk', q: 'A', done: true });
  assert.equal(r.completed, true);
  assert.equal(r.msg, 'Completed: Buy oat milk');
  await until(() => d.pending === 0);
  assert.equal(patches.length, 1, 'one write');
  assert.equal(patches[0].status, 'done');
  assert.equal(patches[0].title, 'Buy oat milk');
  assert.equal(patches[0].quadrant, 'A');
  assert.equal(patches[0].urgent_pin, true);
  r.undo();
  await until(() => d.pending === 0 && patches.length === 2);
  assert.equal(patches[1].status, 'open');
  assert.equal(patches[1].quadrant, 'B');
});
