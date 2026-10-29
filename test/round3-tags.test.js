// node --test test/  — round-3 rules of the page's <script id="core"> for A5-A7 (adjustments 3, 4, 5, 6, 10). No network.
const test = require('node:test');
const assert = require('node:assert/strict');

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });

const lists = () => ({
  D: { id: 'D', owner_id: 'me', name: 'My tags', is_default: true, sort: 1, role: 'owner' },
  W: { id: 'W', owner_id: 'me', name: 'Work', is_default: false, sort: 3, role: 'owner' },
  H: { id: 'H', owner_id: 'me', name: 'Home', is_default: false, sort: 2, role: 'owner' },
  X: { id: 'X', owner_id: 'me', name: 'Old', is_default: false, sort: 4, role: 'owner', archived_at: '2026-10-20T00:00:00Z' },
  A: { id: 'A', owner_id: 'ana', name: 'My tags', is_default: true, sort: 1, role: 'viewer' },
  A2: { id: 'A2', owner_id: 'ana', name: 'Garden', is_default: false, sort: 2, role: 'editor', hidden: true },
  B: { id: 'B', owner_id: 'bob', name: 'Bob tags', is_default: true, sort: 1, role: 'contributor' },
});
const tags = { t1: { id: 't1', tag_list_id: 'D', name: 'urgent', sort: 2 }, t2: { id: 't2', tag_list_id: 'D', name: 'calls', sort: 1 },
  t3: { id: 't3', tag_list_id: 'W', name: 'urgent', sort: 1 }, t4: { id: 't4', tag_list_id: 'A', name: 'urgent', sort: 1 },
  t5: { id: 't5', tag_list_id: 'X', name: 'gone', sort: 1 } };
const names = { me: 'Maksym', ana: 'Anastasiia', bob: 'Bob' };

test('tagListRights: every role places the list (sortList); viewer uses, contributor edits tags, editor all but people, owner everything; no setDefault; archived read only', () => {
  const r = role => [...C.tagListRights({ role })].sort();
  assert.deepEqual(r('viewer'), ['sortList', 'use']);
  assert.deepEqual(r('contributor'), ['addTag', 'renameTag', 'sortList', 'sortTag', 'use']);
  assert.deepEqual(r('editor'), ['addTag', 'archive', 'deleteTag', 'move', 'renameList', 'renameTag', 'share', 'sortList', 'sortTag', 'use']);
  assert.deepEqual(r('owner'), ['addTag', 'archive', 'deleteTag', 'move', 'removePeople', 'renameList', 'renameTag', 'share', 'sortList', 'sortTag', 'use']);
  for (const role of ['viewer', 'contributor', 'editor', 'owner']) assert.equal(C.tagListRights({ role }).has('setDefault'), false, role + ': no setDefault (tags round)');
  const def = [...C.tagListRights({ role: 'owner', is_default: true })].sort();
  assert.deepEqual(def, r('owner').filter(x => x !== 'archive'), 'the landing list (is_default) only loses archive');
  assert.equal(C.tagListRights({ role: 'editor', is_default: true }).has('archive'), false);
  assert.deepEqual([...C.tagListRights({ role: 'editor', archived_at: 'x' })], ['restore']);
  assert.deepEqual([...C.tagListRights({ role: 'viewer', archived_at: 'x' })], []);
  assert.equal(C.tagListRights(null).size, 0);
  assert.equal(C.tagListRights({ role: null }).size, 0);
});

test('moveTargets: other live lists of the same owner where I may move', () => {
  const L = lists();
  assert.deepEqual(C.moveTargets(L.D, L).map(l => l.id).sort(), ['H', 'W']);
  assert.deepEqual(C.moveTargets(L.A, L), [], 'a viewer moves nothing');
  assert.deepEqual(C.moveTargets(L.A2, L), [], "Anastasiia's default is only viewed by me");
  assert.deepEqual(C.moveTargets(L.X, L), [], 'nothing moves out of an archived list');
});

test('tagGroups without an order: my lists by sort, then shared lists by owner name; tags by sort, then name', () => {
  const g = C.tagGroups(lists(), tags, 'me', names);
  assert.deepEqual(g.map(x => x.list.id), ['D', 'H', 'W', 'A', 'B'], 'hidden and archived lists left out');
  assert.deepEqual(g[0].tags, ['t2', 't1']);
  assert.deepEqual(C.tagGroups(lists(), tags, 'me', names, { hidden: true }).map(x => x.list.id), ['D', 'H', 'W', 'A', 'A2', 'B']);
  const a = C.tagGroups(lists(), tags, 'me', names, { archived: true });
  assert.deepEqual(a.map(x => x.list.id), ['X']); assert.deepEqual(a[0].tags, ['t5']);
  const noRole = Object.assign(lists(), { Z: { id: 'Z', owner_id: 'zed', name: 'Z', role: null } });
  assert.ok(!C.tagGroups(noRole, tags, 'me', names).some(x => x.list.id === 'Z'), 'a list I am not on is not offered');
});

test('tag filter: by tag id; "All named X" is an explicit choice', () => {
  const labels = { t1: 'urgent', t3: 'urgent', t4: 'urgent ·A', t2: 'calls' };
  const nameOf = { t1: 'urgent', t3: 'urgent', t4: 'urgent', t2: 'calls' };
  const opts = C.tagFilterOptions(['t1', 't3', 't4', 't2', 't1', 'tx'], labels, nameOf);
  assert.deepEqual(opts.map(o => o.key), ['t2', 'name:urgent', 't1', 't3', 't4']);
  assert.equal(opts[1].label, 'All named urgent'); assert.equal(opts[1].all, true);
  assert.equal(C.tagFilterHit(['t3'], new Set(['t1']), nameOf), false, 'filtering on my urgent does not match another urgent');
  assert.equal(C.tagFilterHit(['t1', 't2'], new Set(['t1']), nameOf), true);
  assert.equal(C.tagFilterHit(['t4'], new Set([C.tagFilterKey('Urgent')]), nameOf), true, 'all named urgent, any case');
  assert.equal(C.tagFilterHit(['t2'], new Set(), nameOf), true, 'no filter');
  assert.equal(C.tagFilterHit(['t9'], new Set(['name:urgent']), nameOf), false, 'a tag I cannot see');
});

test('poll merge (adjustment 4): an unknown tag id is reported, then fetched and labelled; a rename relabels the chips', () => {
  const L = lists();
  const tasks = [{ id: 'i1', tags: [] }, { id: 'i2', tags: ['t4'] }];
  let TAG = { t4: { id: 't4', tag_list_id: 'A', name: 'urgent', sort: 1 } };
  // 1. the item_tags poll brings a tag the page does not know: it is reported (even on an item with writes waiting)
  const m = C.mergeTagRows(tasks, [{ item_id: 'i1', tag_id: 'n1', removed_at: null, changed_at: '2026-10-28T10:00:00Z' }], { knownTags: Object.keys(TAG) });
  assert.deepEqual(m.unknownTags, ['n1']); assert.deepEqual(tasks[0].tags, ['n1']);
  // 2. tags?id=in.(n1) answers; the row is merged and the chip gets its label
  const fetched = C.mergeTagDefs(TAG, [{ id: 'n1', tag_list_id: 'A', name: 'garden', sort: 2, updated_at: '2026-10-28T10:00:00Z' }], Object.keys(L));
  assert.equal(fetched.changed, 1); assert.deepEqual(fetched.unknownLists, []);
  TAG = fetched.tags;
  assert.equal(C.tagLabels(Object.values(TAG), L, names, 'me').n1, 'garden');
  // 3. tags?updated_at=gte… brings a rename by the tag list's owner: the label follows, the item keeps the same tag id
  const renamed = C.mergeTagDefs(TAG, [{ id: 't4', tag_list_id: 'A', name: 'asap', sort: 1, updated_at: '2026-10-28T10:01:00Z' }], Object.keys(L));
  assert.equal(renamed.changed, 1);
  assert.equal(C.tagLabels(Object.values(renamed.tags), L, names, 'me').t4, 'asap');
  assert.deepEqual(tasks[1].tags, ['t4']);
  // 4. a tag on a tag list the page does not know (a new share) asks for the lists again
  assert.deepEqual(C.mergeTagDefs(TAG, [{ id: 'n2', tag_list_id: 'NEW', name: 'x', sort: 1 }], Object.keys(L)).unknownLists, ['NEW']);
});

test('noticeText and canShare (adjustment 3)', () => {
  assert.equal(C.noticeText({ list_id: 'L', inviter_name: 'Maksym', target_name: 'Home', role: 'editor' }), 'Maksym shared the list “Home” with you as Editor.');
  assert.equal(C.noticeText({ tag_list_id: 'T', inviter_name: 'Anastasiia', target_name: 'My tags', role: 'viewer' }), 'Anastasiia shared the tags “My tags” with you as Viewer.');
  assert.equal(C.canShare('owner', 'list'), true); assert.equal(C.canShare('editor', 'list'), false);
  assert.equal(C.canShare('editor', 'tag_list'), true); assert.equal(C.canShare('contributor', 'tag_list'), false);
  assert.deepEqual(C.TAG_LIST_ROLES, ['editor', 'contributor', 'viewer']);
});

test('restError: round-3 database texts in plain words', () => {
  assert.equal(C.restError(400, { code: '22023', message: 'the default tag list is not archived' }).message, 'This tag list can\'t be deleted: tags typed by name land here.');
  assert.equal(C.restError(400, { code: '42501', message: 'this tag list is archived' }).message, 'This tag list is archived. Restore it first.');
  assert.equal(C.restError(400, { code: '22023', message: 'this list is archived' }).message, 'This list is archived. Restore it first.');
  assert.equal(C.restError(409, { code: '23505', message: 'you already have a tag list named Work' }).message, 'You already have a tag list with this name.');
  assert.equal(C.restError(409, { code: '23505', message: 'you already have a list named Home' }).message, 'A list with this name exists.');
  assert.equal(C.restError(400, { code: '54000', message: 'tag list limit reached' }).message, 'You have reached your limit of tag lists.');
});

test('menuMove (adjustment 10): Alt+Up / Alt+Down one step, across group edges', () => {
  const g = { A: ['a1', 'a2'], B: [], C: ['c1'], D: ['d1'] };
  assert.deepEqual(C.menuMove(g, 'a2', -1), { q: 'A', targetId: 'a1', before: true });
  assert.deepEqual(C.menuMove(g, 'a1', 1), { q: 'A', targetId: 'a2', before: false });
  assert.deepEqual(C.menuMove(g, 'a2', 1), { q: 'B', targetId: null, before: true }, 'into an empty group');
  assert.deepEqual(C.menuMove(g, 'c1', -1), { q: 'B', targetId: null, before: false });
  assert.deepEqual(C.menuMove(g, 'd1', -1), { q: 'C', targetId: 'c1', before: false }, 'to the end of the group above');
  assert.deepEqual(C.menuMove(g, 'c1', 1), { q: 'D', targetId: 'd1', before: true }, 'to the start of the group below');
  assert.equal(C.menuMove(g, 'a1', -1), null); assert.equal(C.menuMove(g, 'd1', 1), null); assert.equal(C.menuMove(g, 'zz', 1), null);
});
