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
