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

test('freeListName: the first free "X (n)"', () => {
  assert.equal(C.freeListName('Old', ['Old']), 'Old (2)');
  assert.equal(C.freeListName('Old', ['old', 'OLD (2)', 'Old (3)']), 'Old (4)');
});
