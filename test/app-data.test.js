// node --test test/  — the phone app's data layer (app/td-data.js) against a fake Supabase (fetch), fake storage, a fake
// IndexedDB queue store and fake timers: password sign-in, refresh and retry on 401, a versioned PATCH that misses (conflict
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
  ['POST', /^\/auth\/v1\/token\?grant_type=password/, () => [200, grant('A')]],
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
const until = async (fn, n = 200) => { for (let i = 0; i < n && !fn(); i++) await new Promise(r => setTimeout(r, 2)); assert.ok(fn(), 'condition not reached'); };

test('password sign-in: Stay signed in keeps td.auth in localStorage, unticked in sessionStorage; a wrong password is an error', async () => {
  const f = fakeSupabase([]);
  const d = make(f);
  assert.equal(await d.signIn('me@example.com', 'pw', true), null);
  assert.deepEqual(JSON.parse(d.opts.storage.local.getItem('td.auth')), { refresh_token: 'r-A', uid: UID });
  assert.equal(d.opts.storage.session.getItem('td.auth'), null);
  assert.equal(d.session.uid, UID);
  const d2 = make(f);
  await d2.signIn('me@example.com', 'pw', false);
  assert.equal(d2.opts.storage.local.getItem('td.auth'), null);
  assert.ok(d2.opts.storage.session.getItem('td.auth'));
  const bad = make(fakeSupabase([['POST', /grant_type=password/, () => [400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' }]]]));
  assert.equal((await bad.signIn('me@example.com', 'x', true)).kind, 'credentials');
});

test('rest: a 401 refreshes once and retries with the new token; a dead refresh token ends the session and keeps the queue', async () => {
  let refreshed = 0;
  const f = fakeSupabase([
    ['POST', /grant_type=refresh_token/, () => { refreshed++; return [200, grant('B')]; }],
    ['GET', /^\/rest\/v1\/probe/, (m, b, h) => h.Authorization === 'Bearer B' ? [200, [{ ok: 1 }]] : [401, { code: 'PGRST301', message: 'JWT expired' }]],
  ]);
  const d = make(f);
  await d.signIn('me@example.com', 'pw', true);
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
  await e.signIn('me@example.com', 'pw', true);
  await e.loadAll();
  e.edit(ITEM, t => { t.title = 'Buy oat milk'; });
  await until(() => events.includes('ended'));
  assert.equal(e.pending, 1, 'the change waits for the next sign-in');
  assert.equal(e.syncState().state, 'ended');
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
  await d.signIn('me@example.com', 'pw', true);
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
  await d.signIn('me@example.com', 'pw', true);
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

test('durable queue fails open: a throwing store turns durability off, the edit still goes out from memory', async () => {
  const bad = { all: async () => { throw new Error('quota'); }, put: async () => { throw new Error('quota'); }, del: async () => {}, clear: async () => {} };
  const f = fakeSupabase([
    ['GET', /^\/rest\/v1\/items\?select=\*&deleted_at/, () => [200, [row()]]],
    ['PATCH', /^\/rest\/v1\/items/, (m, body) => [200, [row(Object.assign({}, body, { version: 2 }))]]],
  ]);
  const d = make(f, { idb: bad });
  await d.signIn('me@example.com', 'pw', true);
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
  await d.signIn('me@example.com', 'pw', true);
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
  const gateOf = async o => { const d = make(guest(o)); await d.signIn('g@example.com', 'pw', true); return d.gate(); };
  assert.equal(await gateOf({}), 'none', 'a guest with only their own My tasks');
  assert.equal(await gateOf({ owner: OTHER }), 'board');
  assert.equal(await gateOf({ req: { status: 'approved' } }), 'board');
  assert.equal(await gateOf({ req: [{ status: 'pending', requested_at: '2026-10-29T09:00:00Z' }] }), 'pending');
  assert.equal(await gateOf({ req: { status: 'declined' } }), 'declined');
  assert.equal(await gateOf({ reqFail: true }), 'error');
  const hh = make(fakeSupabase([['GET', /^\/rest\/v1\/profiles\?select=id,is_household/, () => [200, [{ id: UID, is_household: true }]]],
    ['GET', /^\/rest\/v1\/list_members\?select=list_id&/, () => [200, []]], ['POST', /rpc\/my_access_request/, () => [404, { message: 'no function' }]]]));
  await hh.signIn('me@example.com', 'pw', true);
  assert.equal(await hh.gate(), 'board', 'household even on a database without db/015');

  const d = make(guest({ cap: true }));
  await d.signIn('g@example.com', 'pw', true);
  assert.equal((await d.requestAccess()).state, 'cap');
  let asked = 0;
  const e = make(fakeSupabase([
    ['POST', /rpc\/my_access_request/, () => [200, asked ? { status: 'pending', requested_at: '2026-10-29T10:00:00Z' } : null]],
    ['POST', /rpc\/request_access/, () => { asked++; return [200, null]; }],
  ]));
  await e.signIn('g@example.com', 'pw', true);
  const r = await e.requestAccess();
  assert.equal(r.state, 'pending');
  assert.equal(asked, 1);
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
