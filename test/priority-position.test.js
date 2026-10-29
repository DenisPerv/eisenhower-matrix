// node --test test/  — priority by position (HomeOS priority-position-plan.md, 2026-10-29) in the page's <script id="core">: no
// priority number in the quadrant rule, the grouped board order (groupedIds), drops that land where the board shows them and take a
// parent's subtree along (placeGrouped), and the task window's previous / next (navNeighbours). No network.
const test = require('node:test');
const assert = require('node:assert/strict');

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });

const NOW = Date.parse('2026-10-29T12:00:00Z');
const k = (id, sortKey) => ({ id, sortKey });

test('quadrant rule: importance only from the category, a priority value never counts', () => {
  const t = o => Object.assign({ qStored: null, category: 'task', pin: undefined, deadline: null }, o);
  assert.equal(C.deriveQuadrant(t({ priority: 5 }), null, NOW), 'D');
  assert.equal(C.deriveQuadrant(t({ category: 'decision' }), null, NOW), 'B');
  assert.equal(C.deriveQuadrant(t({ category: 'reminder', pin: true }), null, NOW), 'A');
});

test('groupedIds: children right after their parent, ghosts left out', () => {
  const P = k('P', 10), X = k('X', 20), Cc = k('C', 50);
  const ix = { parentOf: { C: 'P' }, childrenOf: { P: ['C'] }, predsOf: {}, succsOf: {} };
  assert.deepEqual(C.groupedIds([P, X, Cc], ix, { P, X, C: Cc }), ['P', 'C', 'X']);
});

test('placeGrouped: a drop lands where the board shows it (P, C under P, X)', () => {
  const P = k('P', 10), Cc = k('C', 50), X = k('X', 20), par = { C: 'P' };
  // X dropped on P's lower half or on C: X cannot sit inside P's subtree, so it goes after it
  let w = C.placeGrouped([P, Cc], [X], 'P', false, par);
  assert.deepEqual(w, [{ id: 'X', sortKey: 50 + C.SPACING }]);
  w = C.placeGrouped([P, Cc], [X], 'C', true, par);
  assert.deepEqual(w, [{ id: 'X', sortKey: 50 + C.SPACING }]);
  // X above P
  w = C.placeGrouped([P, Cc], [X], 'P', true, par);
  assert.deepEqual(w, [{ id: 'X', sortKey: 10 - C.SPACING }]);
});

test('placeGrouped: a parent takes its subtree along; its own subtree is no target', () => {
  const P = k('P', 10), Cc = k('C', 50), X = k('X', 20), par = { C: 'P' };
  const w = C.placeGrouped([X], [P, Cc], 'X', false, par);
  assert.deepEqual(w, [{ id: 'P', sortKey: 20 + C.SPACING }, { id: 'C', sortKey: 20 + 2 * C.SPACING }]);
  assert.equal(C.placeGrouped([X], [P, Cc], 'C', false, par), null);
});

test('placeGrouped: a subtask stays among its siblings', () => {
  const P = k('P', 1024), A = k('A', 2048), B = k('B', 3072), Y = k('Y', 4096), par = { A: 'P', B: 'P' };
  // B dropped above P: it stays under P, as its first child
  assert.deepEqual(C.placeGrouped([P, A, Y], [B], 'P', true, par), [{ id: 'B', sortKey: 1536 }]);
  // B dropped on Y (outside P): it becomes P's last child
  assert.deepEqual(C.placeGrouped([P, A, Y], [B], 'Y', false, par), [{ id: 'B', sortKey: 3072 }]);
  // B before A
  assert.deepEqual(C.placeGrouped([P, A, Y], [B], 'A', true, par), [{ id: 'B', sortKey: 1536 }]);
});

test('placeGrouped: keys not increasing in the drawn order → the quadrant is renumbered in the new order', () => {
  const P = k('P', 10), Cc = k('C', 5), X = k('X', 20), par = { C: 'P' };
  const w = C.placeGrouped([P, Cc, X], [k('N', null)], 'X', false, par);
  assert.deepEqual(w.map(r => r.id), ['P', 'C', 'X', 'N']);
  assert.deepEqual(w.map(r => r.sortKey), [1, 2, 3, 4].map(i => i * C.SPACING));
});

test('navNeighbours: previous and next in the shown order, null at the ends', () => {
  assert.deepEqual(C.navNeighbours(['a', 'b', 'c'], 'b'), { prev: 'a', next: 'c' });
  assert.deepEqual(C.navNeighbours(['a', 'b'], 'a'), { prev: null, next: 'b' });
  assert.deepEqual(C.navNeighbours(['a'], 'z'), { prev: null, next: null });
});
