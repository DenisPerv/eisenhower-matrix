// node --test test/  — the Edit task window adjustments (HomeOS edit-task-plan.md, 2026-10-29) in the page's <script id="core">:
// "Who it is for" is no Card layout switch and no fact (item 3), archived tag lists never reach Card layout or the window (item 4).
const test = require('node:test');
const assert = require('node:assert/strict');

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });

const lists = () => ({
  D: { id: 'D', owner_id: 'me', name: 'My tags', is_default: true, sort: 1, role: 'owner' },
  W: { id: 'W', owner_id: 'me', name: 'Work', sort: 3, role: 'owner' },
  X: { id: 'X', owner_id: 'me', name: 'e2e tags b', sort: 2, role: 'owner', archived_at: '2026-10-29T00:00:00Z' },
  A: { id: 'A', owner_id: 'ana', name: 'Assignee', sort: 1, role: 'viewer' },
  H: { id: 'H', owner_id: 'ana', name: 'Garden', sort: 2, role: 'editor', hidden: true },
  Y: { id: 'Y', owner_id: 'ana', name: 'Old', sort: 3, role: 'viewer', archived_at: '2026-10-01T00:00:00Z' },
});

test('item 3: owner is not a Card layout field, a stored owner: true is dropped, no For fact', () => {
  assert.ok(!C.CARD_FIELDS.includes('owner'));
  assert.equal('owner' in C.CARD_LAYOUT_DEFAULTS, false);
  const l = C.readCardLayout({ owner: true, created: true });
  assert.equal(l.owner, undefined, 'old prefs load without it');
  const t = { createdAt: new Date(1), createdBy: 'u1', ownerId: 'u2' };
  assert.deepEqual(C.cardFacts(t, Object.assign({}, l, { owner: true, creator: true })).map(f => f.k), ['created', 'creator']);
});

test('item 4: Card layout offers live, shown tag lists only, mine first then by sort', () => {
  assert.deepEqual(C.cardLayoutTagLists(lists(), 'me').map(l => l.id), ['D', 'W', 'A']);
  assert.deepEqual(C.cardLayoutTagLists(null, 'me'), []);
});

test('item 4: the task window (tagGroups without archived) never lists an archived tag list', () => {
  const ids = C.tagGroups(lists(), {}, 'me', { me: 'Maksym', ana: 'Anastasiia' }, {}).map(g => g.list.id);
  assert.ok(!ids.includes('X') && !ids.includes('Y'));
  assert.ok(ids.includes('D') && ids.includes('A'));
});
