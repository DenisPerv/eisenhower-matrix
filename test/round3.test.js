// node --test test/  — round-3 rules of the page's <script id="core"> (adjustments 1, 2, 4, 11, 12, 13). No network.
const test = require('node:test');
const assert = require('node:assert/strict');

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });

test('createdList: a uuid (db/010) or { id, slug, name, sort } (db/012, object or one-row array)', () => {
  const req = { name: ' Home ', slug: null, ownerId: 'me', sort: 4 };
  assert.deepEqual(C.createdList('L1', req), { id: 'L1', slug: null, name: 'Home', default_category: 'task', sort: 4, owner_id: 'me' });
  const full = { id: 'L2', slug: 'home-2', name: 'Home', sort: 7 };
  assert.deepEqual(C.createdList(full, req), { id: 'L2', slug: 'home-2', name: 'Home', default_category: 'task', sort: 7, owner_id: 'me' });
  assert.equal(C.createdList([full], req).slug, 'home-2');
  assert.equal(C.createdList(null, req), null);
  assert.equal(C.createdList({ slug: 'x' }, req), null);
  assert.equal(C.createdList('L3', { name: 'Дім', slug: 'list-abc123', ownerId: 'me' }).slug, 'list-abc123');
});

test('listNameClash: only my lists, case and spaces ignored, live and archived apart', () => {
  const lists = [{ id: 'a', name: 'Home', owner_id: 'me' }, { id: 'b', name: 'home ', owner_id: 'other' },
    { id: 'c', name: 'Old', owner_id: 'me', archived_at: '2026-10-01T00:00:00Z' }];
  assert.equal(C.listNameClash(' HOME', lists, 'me').live.id, 'a');
  assert.equal(C.listNameClash('home', lists, 'other').live.id, 'b');
  assert.deepEqual(C.listNameClash('Work', lists, 'me'), { live: null, archived: null });
  const old = C.listNameClash('old', lists, 'me');
  assert.equal(old.live, null); assert.equal(old.archived.id, 'c');
});

test('settings: Working days and Hours per day are dropped on read; review is a view', () => {
  assert.deepEqual(C.SETTINGS_DEFAULTS, { threshold: 50, windowDays: 7, doLimit: 5 });
  assert.deepEqual(C.readSettings({ threshold: 30, windowDays: 10, doLimit: 3, workingDays: true, hoursPerDay: 6 }), { threshold: 30, windowDays: 10, doLimit: 3 });
  const p = C.prefsFromRow({ view: 'review', settings: { hoursPerDay: 8, workingDays: false } });
  assert.equal(p.view, 'review'); assert.deepEqual(p.settings, C.SETTINGS_DEFAULTS);
  assert.equal(C.prefsFromRow({ view: 'timeline' }).view, 'timeline');
  assert.equal(C.prefsFromRow({ view: 'kanban' }).view, 'matrix');
});

test('dueSoon: less than threshold % of the window left, open and not overdue', () => {
  const now = Date.parse('2026-10-28T12:00:00Z'), D = C.DAY, s = { windowDays: 10, threshold: 50, doLimit: 5 };
  const t = ms => ({ deadline: new Date(now + ms), status: 'open', deleted: false });
  assert.equal(C.dueSoon(t(4.9 * D), s, now), true);
  assert.equal(C.dueSoon(t(5 * D), s, now), false);
  assert.equal(C.dueSoon(t(0), s, now), true);
  assert.equal(C.dueSoon(t(-1), s, now), false, 'overdue is its own mark');
  assert.equal(C.dueSoon(Object.assign(t(D), { status: 'done' }), s, now), false);
  assert.equal(C.dueSoon({ deadline: null, status: 'open' }, s, now), false);
  assert.equal(C.dueSoon(t(3 * D), null, now), true, 'defaults: 7 days × 50 % = 3.5 days');
});

test('mergeTagRows: an unknown tag is reported even on an item with writes waiting', () => {
  const tasks = [{ id: 'i1', tags: [] }, { id: 'i2', tags: [] }];
  const m = C.mergeTagRows(tasks, [{ item_id: 'i1', tag_id: 'tNew' }, { item_id: 'i2', tag_id: 'tOld' }], { pending: new Set(['i1']), knownTags: ['tOld'] });
  assert.deepEqual(m.unknownTags, ['tNew']);
  assert.deepEqual(tasks[0].tags, [], 'the pending item keeps its own tags');
  assert.deepEqual(tasks[1].tags, ['tOld']);
});

test('mergeTagDefs: new tag, rename, delete, unknown tag list', () => {
  const tags = { a: { id: 'a', tag_list_id: 'L', name: 'home', sort: 1 } };
  const m = C.mergeTagDefs(tags, [{ id: 'a', tag_list_id: 'L', name: 'house', sort: 1 }, { id: 'b', tag_list_id: 'L', name: 'car', sort: 2 },
    { id: 'c', tag_list_id: 'X', name: 'shared', sort: 1 }], ['L']);
  assert.equal(m.tags.a.name, 'house'); assert.equal(m.tags.b.name, 'car'); assert.equal(m.tags.c, undefined);
  assert.equal(m.changed, 2); assert.deepEqual(m.unknownLists, ['X']);
  assert.equal(tags.a.name, 'home', 'the input is not changed');
  const d = C.mergeTagDefs(m.tags, [{ id: 'b', tag_list_id: 'L', name: 'car', deleted_at: '2026-10-28T00:00:00Z' }], ['L']);
  assert.equal(d.tags.b, undefined); assert.equal(d.changed, 1);
  assert.equal(C.mergeTagDefs(m.tags, [{ id: 'a', tag_list_id: 'L', name: 'house', sort: 1 }], ['L']).changed, 0);
  assert.match(C.tagDefsFilter(Date.parse('2026-10-28T12:02:00Z')), /^updated_at=gte\.2026-10-28T12%3A00%3A00\.000Z$/);
});

test('prefs: cardLayout and welcomeSeen, defaults are today\'s card', () => {
  const p = C.prefsFromRow(null);
  assert.equal(p.welcomeSeen, false);
  assert.deepEqual(p.cardLayout, { description: true, number: true, arrow: true, end: true, created: false, creator: false, source: false, group: false, waiting: true, progress: true, tags: 'all', tagLists: [], autoCollapse: 100 }, 'round 4 adds source, off; task links add group (off), priority, waiting, progress; the edit window drops owner');
  const q = C.prefsFromRow({ welcomeSeen: true, cardLayout: { created: true, owner: true, number: 'yes', tags: 'lists', tagLists: ['TL1', 'gone'], autoCollapse: 250, extra: 1 } }, { tagListIds: ['TL1'] });
  assert.equal(q.welcomeSeen, true);
  assert.equal(q.cardLayout.created, true); assert.equal(q.cardLayout.owner, undefined, 'owner is no longer a field'); assert.equal(q.cardLayout.number, true, 'a wrong type keeps the default');
  assert.deepEqual(q.cardLayout.tagLists, ['TL1'], 'a tag list that no longer exists is dropped');
  assert.equal(q.cardLayout.autoCollapse, 250); assert.equal(q.cardLayout.extra, undefined);
  assert.equal(C.readCardLayout({ autoCollapse: -1, tags: 'some' }).autoCollapse, 100);
  assert.equal(C.readCardLayout({ tags: 'some' }).tags, 'all');
  const back = C.prefsFromRow(C.rowFromPrefs('u', q).prefs, { tagListIds: ['TL1'] });
  assert.deepEqual(back.cardLayout, q.cardLayout, 'round trip through the row');
});

test('prefs: welcomeVersion, the one-card welcome shows once per person for version 3', () => {
  assert.equal(C.WELCOME_VERSION, 3);
  assert.equal(C.prefsFromRow(null).welcomeVersion, 0);
  assert.equal(C.welcomeDue(C.prefsFromRow(null)), true, 'a new person sees it');
  const old = C.prefsFromRow({ welcomeSeen: true });
  assert.equal(old.welcomeVersion, 0); assert.equal(C.welcomeDue(old), true, 'someone who saw only the round-3 note sees it again');
  for (const bad of [-1, 1.5, '2', null, 1001]) assert.equal(C.prefsFromRow({ welcomeVersion: bad }).welcomeVersion, 0, 'a wrong value falls back to 0: ' + bad);
  assert.equal(C.welcomeDue(C.prefsFromRow({ welcomeSeen: true, welcomeVersion: 2 })), true, 'someone who closed the two-panel note (version 2) sees the card once');
  const seen = C.prefsFromRow({ welcomeSeen: true, welcomeVersion: 3 });
  assert.equal(C.welcomeDue(seen), false);
  assert.equal(C.welcomeDue({ welcomeVersion: 4 }), false, 'a later version does not show this one');
  assert.equal(C.prefsFromRow(C.rowFromPrefs('u', seen).prefs).welcomeVersion, 3, 'round trip through the row');
});

test('cardExpanded: mode and flipped only (round 4: autoCollapse cuts the description instead, descClip)', () => {
  const L = C.readCardLayout(null), short = { id: 'a', notes: 'x'.repeat(100) }, long = { id: 'b', notes: 'x'.repeat(101) };
  assert.equal(C.cardExpanded(short, 'expanded', L, new Set()), true);
  assert.equal(C.cardExpanded(long, 'expanded', L, new Set()), true, 'a long description no longer collapses the card');
  assert.equal(C.cardExpanded(long, 'expanded', L, new Set(['b'])), false, 'the arrow closes it');
  assert.equal(C.cardExpanded(long, 'collapsed', L, new Set()), false);
  assert.equal(C.cardExpanded(short, 'collapsed', L, new Set(['a'])), true);
});

test('cardTagIds: all, chosen tag lists, off', () => {
  const of = { t1: 'TL1', t2: 'TL2' };
  assert.deepEqual(C.cardTagIds(['t1', 't2'], C.readCardLayout(null), of), ['t1', 't2']);
  assert.deepEqual(C.cardTagIds(['t1', 't2'], C.readCardLayout({ tags: 'lists', tagLists: ['TL2'] }), of), ['t2']);
  assert.deepEqual(C.cardTagIds(['t1', 't2'], C.readCardLayout({ tags: 'off' }), of), []);
});

test('freeListName: the first free "X (n)"', () => {
  assert.equal(C.freeListName('Old', ['Old']), 'Old (2)');
  assert.equal(C.freeListName('Old', ['old', 'OLD (2)', 'Old (3)']), 'Old (4)');
});
