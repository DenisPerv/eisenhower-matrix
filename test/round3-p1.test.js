// node --test test/  — round-3 P1 fixes of the page's <script id="core">: the task window's tag groups (U3 order, U6 search; the tags
// round's one free order, favourites and prefs migration) and their preferences. No network.
const test = require('node:test');
const assert = require('node:assert/strict');

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });

const lists = () => ({
  D: { id: 'D', owner_id: 'me', name: 'My tags', is_default: true, sort: 1, role: 'owner' },
  W: { id: 'W', owner_id: 'me', name: 'Work', is_default: false, sort: 3, role: 'owner' },
  H: { id: 'H', owner_id: 'me', name: 'Home', is_default: false, sort: 2, role: 'owner' },
  A: { id: 'A', owner_id: 'ana', name: 'My tags', is_default: true, sort: 1, role: 'viewer' },
  A2: { id: 'A2', owner_id: 'ana', name: 'Garden', is_default: false, sort: 2, role: 'editor' },
  B: { id: 'B', owner_id: 'bob', name: 'Bob tags', is_default: true, sort: 1, role: 'contributor' },
});
const tags = { t1: { id: 't1', tag_list_id: 'D', name: 'urgent', sort: 2 }, t2: { id: 't2', tag_list_id: 'D', name: 'calls', sort: 1 },
  t3: { id: 't3', tag_list_id: 'W', name: 'Urgent call', sort: 1 }, t4: { id: 't4', tag_list_id: 'A', name: 'garden', sort: 1 } };
const names = { me: 'Maksym', ana: 'Anastasiia', bob: 'Bob' };
const ids = g => g.map(x => x.list.id);

test('tagGroups (tags round): o.order first, in that order, own and shared mixed; then my lists by sort, then shared by owner name; no default pin', () => {
  assert.deepEqual(ids(C.tagGroups(lists(), tags, 'me', names)), ['D', 'H', 'W', 'A', 'A2', 'B'], 'no order: mine by sort, then shared by owner name');
  assert.deepEqual(ids(C.tagGroups(lists(), tags, 'me', names, { order: ['B', 'W', 'A'] })), ['B', 'W', 'A', 'D', 'H', 'A2'], 'a shared list between my own');
  assert.deepEqual(ids(C.tagGroups(lists(), tags, 'me', names, { order: ['H', 'D'] })), ['H', 'D', 'W', 'A', 'A2', 'B'], 'my landing list is not pinned first');
  assert.deepEqual(ids(C.tagGroups(lists(), tags, 'me', names, { order: ['gone', 'A2'] })), ['A2', 'D', 'H', 'W', 'A', 'B'], 'a stale id changes nothing');
  const L = Object.assign(lists(), { Z: { id: 'Z', owner_id: 'me', name: 'Hidden', sort: 4, role: 'owner', hidden: true } });
  const order = ['Z', 'A', 'D'];
  assert.deepEqual(ids(C.tagGroups(L, tags, 'me', names, { order })), ['A', 'D', 'H', 'W', 'A2', 'B'], 'a hidden list in the order is left out');
  assert.deepEqual(ids(C.tagGroups(L, tags, 'me', names, { order, hidden: true })), ['Z', 'A', 'D', 'H', 'W', 'A2', 'B'], 'with hidden: in its place');
});

test('tagListReorder (tags round): every live list moves among all, own and shared; merged into the full stored order, hidden and archived keep their slots', () => {
  const g = C.tagGroups(lists(), tags, 'me', names);
  assert.deepEqual(C.tagListReorder(g, 'me', 'A2', { targetId: 'H', before: true }, []), { order: ['D', 'A2', 'H', 'W', 'A', 'B'] }, 'a shared list dropped between my own');
  assert.deepEqual(C.tagListReorder(g, 'me', 'H', { dir: -1 }, []), { order: ['H', 'D', 'W', 'A', 'A2', 'B'] }, 'above my landing list: nothing is pinned');
  assert.deepEqual(C.tagListReorder(g, 'me', 'W', { dir: 1 }, []), { order: ['D', 'H', 'A', 'W', 'A2', 'B'] }, 'my list past a shared one');
  assert.deepEqual(C.tagListReorder(g, 'me', 'H', { targetId: 'B', before: false }, []), { order: ['D', 'W', 'A', 'A2', 'B', 'H'] });
  assert.equal(C.tagListReorder(g, 'me', 'D', { dir: -1 }, []), null, 'first cannot go up');
  assert.equal(C.tagListReorder(g, 'me', 'B', { dir: 1 }, []), null, 'last cannot go down');
  assert.equal(C.tagListReorder(g, 'me', 'A', { targetId: 'A2', before: true }, []), null, 'already there: nothing changes');
  assert.equal(C.tagListReorder(g, 'me', 'A', { targetId: 'A', before: true }, []), null);
  assert.equal(C.tagListReorder(g, 'me', 'nope', { dir: 1 }, []), null);
  assert.equal(C.tagListReorder(g, 'me', 'A', null, []), null);
  // a hidden list (Z) and an archived one (X) sit in the stored order; the task window shows neither
  const L = Object.assign(lists(), { Z: { id: 'Z', owner_id: 'me', name: 'Hidden', sort: 4, role: 'owner', hidden: true },
    X: { id: 'X', owner_id: 'me', name: 'Old', sort: 5, role: 'owner', archived_at: '2026-10-20T00:00:00Z' } });
  const stored = ['D', 'Z', 'H', 'X', 'W', 'A', 'A2', 'B'];
  const shown = C.tagGroups(L, tags, 'me', names, { order: stored });
  assert.deepEqual(ids(shown), ['D', 'H', 'W', 'A', 'A2', 'B']);
  assert.deepEqual(C.tagListReorder(shown, 'me', 'B', { dir: -1 }, stored), { order: ['D', 'Z', 'H', 'X', 'W', 'A', 'B', 'A2'] }, 'Z and X keep their slots');
  assert.deepEqual(C.tagListReorder(shown, 'me', 'A', { targetId: 'D', before: true }, stored), { order: ['A', 'Z', 'D', 'X', 'H', 'W', 'A2', 'B'] }, 'a shared list to the top: the hidden and archived slots stay');
  assert.deepEqual(C.tagListReorder(shown, 'me', 'H', { dir: -1 }, ['A2']), { order: ['H', 'D', 'W', 'A', 'A2', 'B'] }, 'a short order is completed from the screen: the result is the new row');
  const arch = C.tagGroups(L, tags, 'me', names, { archived: true });
  assert.equal(C.tagListReorder(arch, 'me', 'X', { dir: 1 }, stored), null, 'an archived list does not move');
});

test('tagListOwnSorts: my own live lists keep tag_lists.sort in their relative order; shared and archived are never written', () => {
  const L = Object.assign(lists(), { X: { id: 'X', owner_id: 'me', name: 'Old', sort: 0, role: 'owner', archived_at: 'x' } });
  assert.deepEqual(C.tagListOwnSorts(['D', 'A2', 'H', 'W', 'A', 'B'], L, 'me'), [], 'a shared list between mine: my relative order is the same');
  assert.deepEqual(C.tagListOwnSorts(['W', 'A', 'X', 'D', 'H'], L, 'me'), [{ id: 'W', sort: 1 }, { id: 'D', sort: 2 }, { id: 'H', sort: 3 }]);
  assert.deepEqual(C.tagListOwnSorts(['B', 'A'], L, 'me'), []);
  assert.deepEqual(C.tagListOwnSorts(null, L, 'me'), []);
  assert.deepEqual(C.tagListOwnSorts(['W', 'D'], null, 'me'), []);
});

test('sortWrites: the same sort values in the new order, written only where one changes; duplicates raised', () => {
  const s = { a: 2, b: 3, c: 4, d: 5 };
  assert.deepEqual(C.sortWrites(['a', 'b', 'd', 'c'], x => s[x]), [{ id: 'd', sort: 4 }, { id: 'c', sort: 5 }], 'a swap touches only the two lists');
  assert.deepEqual(C.sortWrites(['a', 'b', 'c', 'd'], x => s[x]), []);
  assert.deepEqual(C.sortWrites(['d', 'a', 'b', 'c'], x => s[x]), [{ id: 'd', sort: 2 }, { id: 'a', sort: 3 }, { id: 'b', sort: 4 }, { id: 'c', sort: 5 }]);
  const dup = { x: 1, y: 1, z: 2 };
  assert.deepEqual(C.sortWrites(['x', 'y', 'z'], k => dup[k]), [{ id: 'y', sort: 2 }, { id: 'z', sort: 3 }]);
  assert.deepEqual(C.sortWrites([], () => 0), []);
});

test('tagGroupOpen (tags round): only favourites open (an array or a Set, any number, own or shared); every other list starts closed', () => {
  const L = lists();
  assert.equal(C.tagGroupOpen(L.D, []), false, 'my landing list is not open by itself');
  assert.equal(C.tagGroupOpen(L.W, ['W', 'A']), true);
  assert.equal(C.tagGroupOpen(L.A, ['W', 'A']), true, 'a shared favourite opens');
  assert.equal(C.tagGroupOpen(L.H, ['W', 'A']), false);
  assert.equal(C.tagGroupOpen(L.A2, new Set(['A2', 'B'])), true);
  assert.equal(C.tagGroupOpen(L.D, new Set(['A2', 'B'])), false);
  assert.deepEqual(Object.values(L).filter(l => C.tagGroupOpen(l, ['D', 'A2', 'B'])).map(l => l.id), ['D', 'A2', 'B'], 'several favourites, the rest closed');
  assert.equal(C.tagGroupOpen(null, ['D']), false);
  assert.equal(C.tagGroupOpen(L.D, undefined), false);
  assert.equal(C.tagGroupOpen(L.D, { D: true }), false, 'the old tagListsOpen map is not read');
});

test('tagSearch: chips across all groups by name (case, outer spaces ignored); groups with no hit leave; empty text keeps all', () => {
  const g = C.tagGroups(lists(), tags, 'me', names);
  const nameOf = x => (tags[x] || {}).name;
  assert.equal(C.tagSearch(g, '  ', nameOf), g);
  assert.deepEqual(C.tagSearch(g, ' URG', nameOf).map(x => [x.list.id, x.tags]), [['D', ['t1']], ['W', ['t3']]]);
  assert.deepEqual(C.tagSearch(g, 'call', { t2: 'calls', t3: 'Urgent call' }).map(x => x.tags), [['t2'], ['t3']], 'nameOf as an object');
  assert.deepEqual(C.tagSearch(g, 'zzz', nameOf), []);
});

test('prefs (tags round): tagListOrder, tagListFavs and tagListOrderV read back; stale ids and wrong types dropped; tagListsOpen gone', () => {
  assert.deepEqual(C.PREFS_DEFAULTS.tagListOrder, []);
  assert.deepEqual(C.PREFS_DEFAULTS.tagListFavs, []);
  assert.equal(C.PREFS_DEFAULTS.tagListOrderV, 0);
  assert.equal(C.TAG_LIST_ORDER_V, 2);
  assert.equal('tagListsOpen' in C.PREFS_DEFAULTS, false);
  const known = { tagListIds: ['A', 'B', 'D', 'W', 'X'] }; // X: archived, still known
  const p = C.prefsFromRow({ tagListOrder: ['A', 'gone', 'B', 'X', 'A'], tagListFavs: ['W', 'gone', 'W', 'X'], tagListOrderV: 2, tagListsOpen: { A: true } }, known);
  assert.deepEqual(p.tagListOrder, ['A', 'B', 'X'], 'archived ids keep their place, gone ones leave, no duplicates');
  assert.deepEqual(p.tagListFavs, ['W', 'X']);
  assert.equal(p.tagListOrderV, 2);
  assert.equal('tagListsOpen' in p, false, 'a stored tagListsOpen is not read');
  for (const v of ['2', -1, 1.5, 1001, null]) assert.equal(C.prefsFromRow({ tagListOrderV: v }).tagListOrderV, 0, 'bad tagListOrderV ' + v);
  const bad = C.prefsFromRow({ tagListOrder: 'A', tagListFavs: { A: true } });
  assert.deepEqual([bad.tagListOrder, bad.tagListFavs], [[], []]);
  const row = C.rowFromPrefs('p', p).prefs;
  assert.deepEqual([row.tagListOrder, row.tagListFavs, row.tagListOrderV], [['A', 'B', 'X'], ['W', 'X'], 2]);
  assert.equal('tagListsOpen' in row, false);
});

test('tagListPrefsMigrate (V12): a legacy row gets own lists first (landing, then by sort), then shared in stored order, then archived; favs = [landing]', () => {
  const L = Object.assign(lists(), { X: { id: 'X', owner_id: 'me', name: 'Old', sort: 0, role: 'owner', archived_at: 'x' } });
  L.D.sort = 9; // the landing list came first in the old display whatever its sort
  const legacy = C.prefsFromRow({ tagListOrder: ['B', 'A2'] });
  const m = C.tagListPrefsMigrate(legacy, L, 'me', names);
  assert.deepEqual(m, { tagListOrder: ['D', 'H', 'W', 'B', 'A2', 'A', 'X'], tagListFavs: ['D'], tagListOrderV: 2 });
  assert.deepEqual(ids(C.tagGroups(L, tags, 'me', names, { order: m.tagListOrder })), ['D', 'H', 'W', 'B', 'A2', 'A'], 'after the migration the task window shows the old display');
  assert.equal(C.tagListPrefsMigrate(Object.assign({}, legacy, m), L, 'me', names), null, 'a v2 row is left alone');
  assert.deepEqual(C.tagListPrefsMigrate({ tagListOrder: [], tagListFavs: ['A'], tagListOrderV: 0 }, L, 'me', names).tagListFavs, ['A'], 'favourites already set are kept');
  assert.deepEqual(C.tagListPrefsMigrate({ tagListOrder: ['W', 'A', 'D'], tagListOrderV: 0 }, L, 'me', names).tagListOrder, ['W', 'A', 'D', 'H', 'A2', 'B', 'X'],
    'a stored order with my own lists was written by v2: kept, the rest added in the old order');
  const noDefault = { A: L.A, B: L.B };
  assert.deepEqual(C.tagListPrefsMigrate({}, noDefault, 'me', names), { tagListOrder: ['A', 'B'], tagListFavs: [], tagListOrderV: 2 }, 'no landing list of mine: no favourite');
  assert.deepEqual(C.tagListPrefsMigrate(null, {}, 'me', names), { tagListOrder: [], tagListFavs: [], tagListOrderV: 2 });
});

test('F3 isTestList: a slug starting with _ (today _selftest) is a test list', () => {
  assert.equal(C.isTestList({ slug: '_selftest' }), true);
  assert.equal(C.isTestList({ slug: 'backlog' }), false);
  assert.equal(C.isTestList({ slug: 'e2e_x' }), false);
  assert.equal(C.isTestList({}), false);
  assert.equal(C.isTestList(null), false);
});

test('F4 chipSelect: click picks one, Ctrl toggles, Shift picks the range in chip order from the anchor; all clears', () => {
  const ord = ['a', 'b', 'c', 'd', 'e'];
  let s = C.chipSelect({ sel: [], anchor: null }, 'b', {}, ord);
  assert.deepEqual(s, { sel: ['b'], anchor: 'b' });
  s = C.chipSelect(s, 'd', { shift: true }, ord);
  assert.deepEqual(s, { sel: ['b', 'c', 'd'], anchor: 'b' });
  s = C.chipSelect(s, 'a', { shift: true }, ord);
  assert.deepEqual(s.sel, ['a', 'b'], 'a new range from the same anchor replaces the old one');
  s = C.chipSelect(s, 'e', { ctrl: true }, ord);
  assert.deepEqual(s, { sel: ['a', 'b', 'e'], anchor: 'e' });
  assert.deepEqual(C.chipSelect(s, 'c', { ctrl: true, shift: true }, ord).sel, ['a', 'b', 'c', 'd', 'e'], 'Ctrl+Shift adds the range');
  assert.deepEqual(C.chipSelect({ sel: ['b'], anchor: 'b' }, 'b', { ctrl: true }, ord).sel, [], 'none left = all lists');
  assert.deepEqual(C.chipSelect(s, 'all', {}, ord), { sel: [], anchor: null });
  assert.deepEqual(C.chipSelect({ sel: [], anchor: 'gone' }, 'c', { shift: true }, ord), { sel: ['c'], anchor: 'c' }, 'a stale anchor starts at the clicked chip');
});

test('F5 cancelTimes and reviewEntries: a cancelled task is listed by its latest cancel event, not updated_at (Reminders #16, OtherTasks #28)', () => {
  const events = [
    { item_id: 'r16', at: '2026-10-27T22:33:00Z', status: { old: 'open', new: 'cancelled' } },
    { item_id: 'r16', at: '2026-10-28T01:05:00Z', status: null },
    { item_id: 'o28', at: '2026-10-20T09:00:00Z', diff: { status: { old: 'open', new: 'cancelled' } } },
    { item_id: 'o28', at: '2026-10-21T09:00:00Z', diff: { status: { old: 'cancelled', new: 'open' } } },
    { item_id: 'o28', at: '2026-10-27T22:33:30Z', diff: { status: { old: 'open', new: 'cancelled' } } },
    { item_id: 'x', at: 'not a date', status: { new: 'cancelled' } },
  ];
  const at = C.cancelTimes(events);
  assert.deepEqual(at, { r16: Date.parse('2026-10-27T22:33:00Z'), o28: Date.parse('2026-10-27T22:33:30Z') });
  const migrated = new Date('2026-10-28T01:05:00Z');
  const tasks = [{ id: 'r16', status: 'cancelled', doneAt: migrated, q: 'B', list: 'L', deadline: null },
    { id: 'o28', status: 'cancelled', doneAt: migrated, q: 'C', list: 'L', deadline: null },
    { id: 'd1', status: 'done', doneAt: new Date('2026-10-27T10:00:00Z'), q: 'A', list: 'L', deadline: null }];
  const wk = C.isoWeek(Date.parse('2026-10-27T12:00:00Z')).key, now = Date.parse('2026-10-28T18:00:00Z');
  const e = C.reviewEntries(tasks, [wk], now, at);
  assert.equal(e.find(x => x.t.id === 'r16').at, Date.parse('2026-10-27T22:33:00Z'));
  assert.equal(e.find(x => x.t.id === 'o28').at, Date.parse('2026-10-27T22:33:30Z'));
  assert.equal(e.find(x => x.t.id === 'd1').at, Date.parse('2026-10-27T10:00:00Z'), 'done items keep completed_at');
  assert.equal(C.reviewEntries(tasks, [wk], now).find(x => x.t.id === 'r16').at, migrated.getTime(), 'without events: updated_at as before');
  // the week follows the cancel: cancelled on Saturday of W43, touched on Tuesday of W44
  const t2 = [{ id: 'z', status: 'cancelled', doneAt: new Date('2026-10-27T12:00:00Z'), q: 'B', list: 'L', deadline: null }];
  const w43 = C.isoWeek(Date.parse('2026-10-24T12:00:00Z')).key, cz = { z: Date.parse('2026-10-24T12:00:00Z') };
  assert.equal(C.reviewEntries(t2, [w43], now, cz).length, 1);
  assert.equal(C.reviewEntries(t2, [wk], now, cz).length, 0);
});

test('F6 kpiTicks: first, middle and last point, never two ticks on one day; hours under a 2-day span', () => {
  const d = (m, day, h = 0) => new Date(2026, m, day, h).getTime();
  assert.deepEqual(C.kpiTicks([d(9, 25), d(9, 28), d(9, 28, 12)]), { kind: 'day', idx: [0, 1] }, '27 Oct, 28 Oct, 28 Oct -> two ticks');
  assert.deepEqual(C.kpiTicks([d(9, 26), d(9, 27), d(9, 28), d(9, 28, 15)]), { kind: 'day', idx: [0, 1, 3] });
  assert.deepEqual(C.kpiTicks([d(9, 27), d(9, 28), d(9, 28, 15)]), { kind: 'hour', idx: [0, 1, 2] });
  assert.deepEqual(C.kpiTicks([d(9, 27)]), { kind: 'hour', idx: [0] });
  assert.deepEqual(C.kpiTicks([]), { kind: 'day', idx: [] });
});
