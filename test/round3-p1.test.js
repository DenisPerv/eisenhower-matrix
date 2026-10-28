// node --test test/  — round-3 P1 fixes of the page's <script id="core">: the task window's tag groups (U3 order, U6 search, U7 open
// state) and their preferences. No network.
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

test('tagGroups: o.order puts shared lists in my order first, the rest by owner name; my own lists are not affected', () => {
  assert.deepEqual(ids(C.tagGroups(lists(), tags, 'me', names)), ['D', 'H', 'W', 'A', 'A2', 'B']);
  assert.deepEqual(ids(C.tagGroups(lists(), tags, 'me', names, { order: ['B', 'A2'] })), ['D', 'H', 'W', 'B', 'A2', 'A']);
  assert.deepEqual(ids(C.tagGroups(lists(), tags, 'me', names, { order: ['W', 'gone'] })), ['D', 'H', 'W', 'A', 'A2', 'B'], 'an own id or a stale id in order changes nothing');
});

test('tagListReorder: own lists among own lists (the default never moves), shared among shared; Alt+arrows and drops', () => {
  const g = C.tagGroups(lists(), tags, 'me', names);
  assert.deepEqual(C.tagListReorder(g, 'me', 'W', { dir: -1 }), { kind: 'own', order: ['W', 'H'] });
  assert.equal(C.tagListReorder(g, 'me', 'H', { dir: -1 }), null, 'not above the default');
  assert.equal(C.tagListReorder(g, 'me', 'W', { dir: 1 }), null, 'not past my last list into the shared ones');
  assert.equal(C.tagListReorder(g, 'me', 'D', { dir: 1 }), null, 'the default list does not move');
  assert.deepEqual(C.tagListReorder(g, 'me', 'A', { dir: 1 }), { kind: 'shared', order: ['A2', 'A', 'B'] });
  assert.deepEqual(C.tagListReorder(g, 'me', 'B', { targetId: 'A', before: true }), { kind: 'shared', order: ['B', 'A', 'A2'] });
  assert.deepEqual(C.tagListReorder(g, 'me', 'H', { targetId: 'W', before: false }), { kind: 'own', order: ['W', 'H'] });
  assert.equal(C.tagListReorder(g, 'me', 'H', { targetId: 'A', before: true }), null, 'an own list cannot go among shared ones');
  assert.equal(C.tagListReorder(g, 'me', 'A', { targetId: 'A2', before: true }), null, 'already there: nothing changes');
  assert.equal(C.tagListReorder(g, 'me', 'A', { targetId: 'A', before: true }), null);
  assert.equal(C.tagListReorder(g, 'me', 'nope', { dir: 1 }), null);
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

test('tagGroupOpen: used on the task opens; else the remembered choice; else only my default list', () => {
  const L = lists();
  assert.equal(C.tagGroupOpen(L.D, 'me', new Set(), {}), true);
  assert.equal(C.tagGroupOpen(L.W, 'me', new Set(), {}), false);
  assert.equal(C.tagGroupOpen(L.A, 'me', new Set(), {}), false, "someone else's default list starts closed");
  assert.equal(C.tagGroupOpen(L.W, 'me', new Set(['W']), { W: false }), true, 'a list the task uses is open');
  assert.equal(C.tagGroupOpen(L.W, 'me', new Set(), { W: true }), true);
  assert.equal(C.tagGroupOpen(L.D, 'me', null, { D: false }), false, 'my default closed when I closed it');
});

test('tagSearch: chips across all groups by name (case, outer spaces ignored); groups with no hit leave; empty text keeps all', () => {
  const g = C.tagGroups(lists(), tags, 'me', names);
  const nameOf = x => (tags[x] || {}).name;
  assert.equal(C.tagSearch(g, '  ', nameOf), g);
  assert.deepEqual(C.tagSearch(g, ' URG', nameOf).map(x => [x.list.id, x.tags]), [['D', ['t1']], ['W', ['t3']]]);
  assert.deepEqual(C.tagSearch(g, 'call', { t2: 'calls', t3: 'Urgent call' }).map(x => x.tags), [['t2'], ['t3']], 'nameOf as an object');
  assert.deepEqual(C.tagSearch(g, 'zzz', nameOf), []);
});

test('prefs: tagListOrder and tagListsOpen read back, with stale ids and wrong types dropped; defaults empty', () => {
  assert.deepEqual(C.PREFS_DEFAULTS.tagListOrder, []);
  assert.deepEqual(C.PREFS_DEFAULTS.tagListsOpen, {});
  const p = C.prefsFromRow({ tagListOrder: ['A', 'gone', 'B'], tagListsOpen: { A: true, D: false, gone: true, W: 'yes' } }, { tagListIds: ['A', 'B', 'D', 'W'] });
  assert.deepEqual(p.tagListOrder, ['A', 'B']);
  assert.deepEqual(p.tagListsOpen, { A: true, D: false });
  const bad = C.prefsFromRow({ tagListOrder: 'A', tagListsOpen: ['A'] });
  assert.deepEqual([bad.tagListOrder, bad.tagListsOpen], [[], {}]);
  assert.deepEqual(C.rowFromPrefs('p', p).prefs.tagListsOpen, { A: true, D: false });
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
