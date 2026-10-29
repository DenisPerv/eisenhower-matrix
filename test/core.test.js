// node --test test/  — the page's <script id="core">, loaded through vm by cli/lib.mjs. No network.
const test = require('node:test');
const assert = require('node:assert/strict');

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });
const NOW = Date.parse('2026-10-27T10:00:00Z');
const row = (o = {}) => Object.assign({ id: 'i1', list_id: 'L1', num: 3, quadrant: 'B', title: 'T', body_md: '', tags: ['a'], due_at: null, start_at: null, status: 'open',
  completed_at: null, urgent_pin: null, sort_key: 1024, category: 'task', review_state: 'none', ai_confidence: null, created_by: 'u1', version: 2,
  deleted_at: null, updated_at: '2026-10-27T09:00:00Z' }, o);

test('readAppConfig: valid, missing, secret key, bad poll', () => {
  const ok = C.readAppConfig({ supabaseUrl: 'https://abc.supabase.co/', publishableKey: 'sb_publishable_x' });
  assert.deepEqual(ok.config, { supabaseUrl: 'https://abc.supabase.co', publishableKey: 'sb_publishable_x', pollMs: 30000 });
  assert.equal(C.readAppConfig(undefined).config, null);
  assert.match(C.readAppConfig({ supabaseUrl: 'https://a.supabase.co', publishableKey: 'sb_secret_x' }).errors[0], /secret/);
  const jwt = 'x.' + Buffer.from('{"role":"service_role"}').toString('base64') + '.y';
  assert.match(C.readAppConfig({ supabaseUrl: 'https://a.supabase.co', publishableKey: jwt }).errors[0], /secret/);
  assert.match(C.readAppConfig({ supabaseUrl: 'ftp://x', publishableKey: 'k', pollMs: 10 }).errors.join(), /supabaseUrl.*pollMs/);
});

test('headers: apikey always, Authorization only with a token', () => {
  assert.deepEqual(C.headers('k', null), { apikey: 'k', 'Content-Type': 'application/json' });
  assert.equal(C.headers('k', { access_token: 't' }, { Prefer: 'p' }).Authorization, 'Bearer t');
  assert.equal(C.headers('k', { access_token: 't' }, { Prefer: 'p' }).Prefer, 'p');
});

test('sessionFromGrant and needsRefresh (60 s skew)', () => {
  const s = C.sessionFromGrant({ access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: 'u', email: 'e' } }, NOW);
  assert.equal(s.expires_at, NOW + 3600e3);
  assert.equal(C.sessionFromGrant({ access_token: 'a' }, NOW), null);
  assert.equal(C.needsRefresh(s, NOW), false);
  assert.equal(C.needsRefresh(s, NOW + 3600e3 - 59e3), true);
  assert.equal(C.needsRefresh(null, NOW), true);
});

test('restError maps the codes from the review table', () => {
  assert.equal(C.restError(0).kind, 'network'); assert.equal(C.restError(0).retry, true);
  assert.equal(C.restError(503, {}).retry, true);
  assert.match(C.restError(400, { code: '22023', message: 'sensitive data: looks like a card number' }).message, /card number/);
  assert.match(C.restError(403, { code: '42501', message: 'this list is archived' }).message, /archived/);
  assert.equal(C.restError(403, { code: '42501', message: 'new row violates' }).kind, 'denied');
  assert.match(C.restError(400, { code: '23514', message: 'items_title_check' }).message, /300/);
  assert.match(C.restError(409, { code: '23505', message: 'duplicate key value violates unique constraint "lists_slug_key"' }).message, /name exists/);
  assert.equal(C.restError(401, { code: 'PGRST301' }).refresh, true);
  assert.equal(C.restError(429, {}).kind, 'rate');
  assert.equal(C.restError(400, { error_code: 'invalid_credentials' }).kind, 'credentials');
  assert.equal(C.restError(400, { error_code: 'refresh_token_already_used' }).kind, 'session');
});

test('rowToTask / taskToPatch round trip; never null for body_md or tags', () => {
  const t = C.rowToTask(row({ status: 'done', completed_at: '2026-10-26T10:00:00Z', urgent_pin: true, review_state: 'needs_review', ai_confidence: '0.420' }));
  assert.equal(t.doneAt.toISOString(), '2026-10-26T10:00:00.000Z');
  assert.equal(t.pin, true); assert.equal(t.aiConfidence, 0.42); assert.equal(t.qStored, 'B');
  assert.equal(C.rowToTask(row({ status: 'cancelled' })).doneAt.toISOString(), '2026-10-27T09:00:00.000Z');
  assert.equal(C.rowToTask(row({ status: 'proposed' })).doneAt, null);
  const p = C.taskToPatch({ title: 'x', notes: null, tags: null, qStored: null, pin: undefined, deadline: null }, ['title', 'notes', 'tags', 'q', 'pin', 'deadline']);
  assert.deepEqual(p, { title: 'x', body_md: '', tags: [], quadrant: null, urgent_pin: null, due_at: null });
  assert.deepEqual(C.taskToPatch({ deleted: true }, ['deleted'], '2026-10-27T10:00:00.000Z'), { deleted_at: '2026-10-27T10:00:00.000Z' });
  assert.deepEqual(C.taskToPatch({ status: 'bogus' }, ['status']), { status: 'open' });
});

test('inverseOf: create, delete, done, edit', () => {
  const before = { status: 'proposed', title: 'old', tags: [] };
  assert.deepEqual(C.inverseOf('create', before, null, 'N'), { deleted_at: 'N' });
  assert.deepEqual(C.inverseOf('delete', before), { deleted_at: null });
  assert.deepEqual(C.inverseOf('done', before), { status: 'proposed' });
  assert.deepEqual(C.inverseOf('edit', before, ['title']), { title: 'old' });
});

test('prefs v2: list ids kept, v1 path keys and stale ids dropped, settings validated', () => {
  const p = C.prefsFromRow({ version: 1, theme: 'dark', list: '../../references/Family-Tasks/backlog-tasks.json', listOrder: ['L1', '../x.json', 'gone'],
    cards: { mode: 'expanded', flipped: ['i1', 'tbd-18'] }, settings: { doLimit: 7, threshold: 500 }, extra: 1 }, { listIds: ['L1', 'L2'], itemIds: ['i1'] });
  assert.equal(p.version, 2); assert.equal(p.theme, 'dark'); assert.equal(p.list, 'all');
  assert.deepEqual(p.listOrder, ['L1']); assert.deepEqual(p.cards.flipped, ['i1']);
  assert.equal(p.settings.doLimit, 7); assert.equal(p.settings.threshold, 50);
  assert.equal('extra' in p, false);
  assert.deepEqual(C.prefsFromRow(null), C.PREFS_DEFAULTS);
  const r = C.rowFromPrefs('u1', p);
  assert.equal(r.app, 'tasksdashboard'); assert.equal(r.profile_id, 'u1'); assert.equal(r.prefs.version, 2);
});

test('deriveQuadrant: stored wins; importance from the category (no priority number); urgency from pin or the window', () => {
  const t = (o) => Object.assign({ qStored: null, category: 'task', pin: undefined, deadline: null }, o);
  assert.equal(C.deriveQuadrant(t({ qStored: 'C' }), null, NOW), 'C');
  assert.equal(C.deriveQuadrant(t({}), null, NOW), 'D');
  assert.equal(C.deriveQuadrant(t({ priority: 5 }), null, NOW), 'D', 'a stray priority is ignored');
  assert.equal(C.deriveQuadrant(t({ category: 'reminder', deadline: new Date(NOW + 2 * 864e5) }), null, NOW), 'A');
  assert.equal(C.deriveQuadrant(t({ category: 'tbd', deadline: new Date(NOW + 20 * 864e5) }), null, NOW), 'B');
  assert.equal(C.deriveQuadrant(t({ deadline: new Date(NOW + 864e5), pin: false }), null, NOW), 'D');
  assert.equal(C.deriveQuadrant(t({ pin: true }), null, NOW), 'C');
  assert.equal(C.deriveQuadrant(t({ deadline: new Date(NOW + 9 * 864e5) }), { windowDays: 10 }, NOW), 'C');
});

test('card order: midpoint, ends, small gaps, renumber, nulls last', () => {
  assert.equal(C.sortBetween(null, null), 0);
  assert.equal(C.sortBetween(null, 0), -1024);
  assert.equal(C.sortBetween(2048, null), 3072);
  assert.equal(C.sortBetween(1024, 2048), 1536);
  assert.equal(C.gapTooSmall(1, 1 + 1e-7), true);
  assert.equal(C.gapTooSmall(1, 2), false);
  assert.deepEqual(C.renumber(['a', 'b']), [{ id: 'a', sortKey: 1024 }, { id: 'b', sortKey: 2048 }]);
  const list = [{ sortKey: null, num: 1 }, { sortKey: 5, num: 9 }, { sortKey: 1, num: 2 }].sort(C.byOrder);
  assert.deepEqual(list.map(x => x.num), [2, 9, 1]);
});

test('mergePoll: version dedup, pending skipped, deletes, unknown lists', () => {
  const tasks = [C.rowToTask(row({ id: 'a', version: 3 })), C.rowToTask(row({ id: 'b', version: 1 })), C.rowToTask(row({ id: 'c' }))];
  const rows = [row({ id: 'a', version: 3, title: 'same' }), row({ id: 'b', version: 2, title: 'new' }), row({ id: 'c', version: 5, deleted_at: 'x' }),
    row({ id: 'd', version: 1 }), row({ id: 'e', list_id: 'L9' }), row({ id: 'p', version: 9 })];
  const m = C.mergePoll(tasks.concat(C.rowToTask(row({ id: 'p', version: 1 }))), rows, { pending: new Set(['p']), knownLists: ['L1'] });
  const by = Object.fromEntries(m.tasks.map(t => [t.id, t]));
  assert.equal(by.a.title, 'T'); assert.equal(by.b.title, 'new'); assert.equal(by.c, undefined); assert.ok(by.d);
  assert.equal(by.p.version, 1); assert.deepEqual(m.unknownLists, ['L9']); assert.equal(m.changed, 3);
  assert.equal(by.b, tasks[1], 'an existing task is updated in place, not replaced');
});

test('pollFilter: 120 s overlap, encoded; pageParams', () => {
  assert.equal(C.pollFilter(Date.parse('2026-10-27T10:02:00Z')), 'updated_at=gte.2026-10-27T10%3A00%3A00.000Z');
  assert.equal(C.pageParams(2000), 'order=id&limit=1000&offset=2000');
});

test('overdueItems: open, past due, most recent first, limit; topDo: A in card order up to the Do limit', () => {
  const mk = (id, o) => C.rowToTask(row(Object.assign({ id }, o)));
  const items = [mk('x', { due_at: '2026-10-20T10:00:00Z' }), mk('y', { due_at: '2026-10-26T10:00:00Z' }), mk('z', { due_at: '2026-10-25T10:00:00Z', status: 'done' }),
    mk('w', { due_at: '2026-10-28T10:00:00Z' })];
  assert.deepEqual(C.overdueItems(items, NOW).map(t => t.id), ['y', 'x']);
  assert.deepEqual(C.overdueItems(items, NOW, { limit: 1 }).map(t => t.id), ['y']);
  const a = [mk('a1', { quadrant: 'A', sort_key: 30 }), mk('a2', { quadrant: 'A', sort_key: 10 }), mk('a3', { quadrant: 'A', sort_key: 20 }), mk('b', { quadrant: 'B' }),
    mk('n', { quadrant: null, category: 'reminder', due_at: '2026-10-28T10:00:00Z', sort_key: 5 })];
  assert.deepEqual(C.topDo(a, { now: NOW, settings: { doLimit: 3, windowDays: 7 } }).L1.map(t => t.id), ['n', 'a2', 'a3']);
  assert.deepEqual(C.topDo(a, { now: NOW, limit: 1 }).L1.map(t => t.id), ['n']);
});

test('can: viewer nothing, contributor own only, owner and editor everything', () => {
  const t = { createdBy: 'me' };
  assert.equal(C.can('viewer', 'add', null, 'me'), false);
  assert.equal(C.can('contributor', 'add', null, 'me'), true);
  assert.equal(C.can('contributor', 'edit', t, 'me'), true);
  assert.equal(C.can('contributor', 'edit', { createdBy: 'x' }, 'me'), false);
  assert.equal(C.can('contributor', 'delete', t, 'me'), false);
  assert.equal(C.can('editor', 'delete', t, 'me'), true);
  assert.equal(C.can(undefined, 'edit', t, 'me'), false);
});

test('time zone: a due time keeps its instant whatever the machine zone (core never reads the clock)', () => {
  const t = C.rowToTask(row({ due_at: '2026-03-29T00:30:00Z' }));
  assert.equal(t.deadline.toISOString(), '2026-03-29T00:30:00.000Z');
  assert.equal(C.taskToPatch(t, ['deadline']).due_at, '2026-03-29T00:30:00.000Z');
});
