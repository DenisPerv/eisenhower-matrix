// node --test test/  — the task deck around the task window (HomeOS edit-nav-plan.md, 2026-10-29) in the page's <script id="core">:
// what a click beside, above or below the window does (deckAct), the phone swipe on the window header (swipeDir) and the
// position line (deckPos). No network.
const test = require('node:test');
const assert = require('node:assert/strict');

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });

const both = { hasPrev: true, hasNext: true };

test('deckAct: a side zone switches, the bands above and below close', () => {
  assert.equal(C.deckAct({ zone: 'prev', downZone: 'prev', ...both }), 'prev');
  assert.equal(C.deckAct({ zone: 'next', downZone: 'next', ...both }), 'next');
  assert.equal(C.deckAct({ zone: 'close', downZone: 'close', ...both }), 'close');
});

test('deckAct: a press that started elsewhere does nothing (a text selection dragged out of the window)', () => {
  assert.equal(C.deckAct({ zone: 'next', downZone: null, ...both }), null);
  assert.equal(C.deckAct({ zone: 'next', downZone: 'close', ...both }), null);
  assert.equal(C.deckAct({ zone: 'close', downZone: 'prev', ...both }), null);
  assert.equal(C.deckAct({ zone: null, downZone: null, ...both }), null);
});

test('deckAct: a side with no neighbour closes (the ends of the quadrant, a new task)', () => {
  assert.equal(C.deckAct({ zone: 'prev', downZone: 'prev', hasPrev: false, hasNext: true }), 'close');
  assert.equal(C.deckAct({ zone: 'next', downZone: 'next', hasPrev: true, hasNext: false }), 'close');
  assert.equal(C.deckAct({ zone: 'prev', downZone: 'prev', hasPrev: false, hasNext: false }), 'close');
  assert.equal(C.deckAct({ zone: 'other', downZone: 'other', ...both }), null);
});

test('swipeDir: 60 px sideways and more than twice the vertical move; left = next', () => {
  assert.equal(C.swipeDir(-80, 10), 'next');
  assert.equal(C.swipeDir(80, -10), 'prev');
  assert.equal(C.swipeDir(-59, 0), null);
  assert.equal(C.swipeDir(-80, 40), null);
  assert.equal(C.swipeDir(-80, 39), 'next');
  assert.equal(C.swipeDir(-30, 0, 20), 'next');
});

test('deckPos: "3 of 7 in A Do", null when the task is not shown', () => {
  assert.equal(C.deckPos(['a', 'b', 'c'], 'c', 'A', 'Do'), '3 of 3 in A Do');
  assert.equal(C.deckPos(['a'], 'a', 'B', 'Plan'), '1 of 1 in B Plan');
  assert.equal(C.deckPos(['a'], 'z', 'A', 'Do'), null);
});

test('taskSwitcher: standard by default, coverflow kept, anything else falls back', () => {
  assert.deepEqual(C.TASK_SWITCHERS, ['standard', 'coverflow']);
  assert.equal(C.PREFS_DEFAULTS.taskSwitcher, 'standard');
  assert.equal(C.prefsFromRow({}).taskSwitcher, 'standard');
  assert.equal(C.prefsFromRow({ taskSwitcher: 'coverflow' }).taskSwitcher, 'coverflow');
  for (const v of ['3d', 'flat', 'Coverflow', 1, null]) assert.equal(C.prefsFromRow({ taskSwitcher: v }).taskSwitcher, 'standard');
  assert.equal(C.rowFromPrefs('u', C.prefsFromRow({ taskSwitcher: 'coverflow' })).prefs.taskSwitcher, 'coverflow');
});

test('deckGeo: one transform function list, poses mirrored left and right', () => {
  const g = C.deckGeo(720);
  for (const k of ['centre', 'prev', 'next', 'prevHover', 'nextHover', 'prevFar', 'nextFar'])
    assert.match(C.deckTransform(g[k]), /^perspective\(\d+px\) translate3d\(-?[\d.]+px,0px,-?[\d.]+px\) rotateY\(-?[\d.]+deg\)$/);
  for (const p of ['b', 'r']) assert.ok(g.prev[p] + g.next[p] === 0, p);
  assert.equal(g.prev.z, g.next.z);
  assert.equal(g.dur, 280);
  assert.equal(C.deckTransform(g.centre), 'perspective(1200px) translate3d(0px,0px,0px) rotateY(0deg)');
});

test('deckGeo coverflow: Swiper rotate 10, stretch 120, depth 200, modifier 1, perspective 1200', () => {
  const g = C.deckGeo(720);
  assert.deepEqual([g.next.b, g.next.z, g.next.r, g.next.p], [720 - 120, -200, -10, 1200]);
  assert.deepEqual([g.prev.b, g.prev.z, g.prev.r], [-(720 - 120), -200, 10]);
  assert.deepEqual([g.nextFar.b, g.nextFar.z, g.nextFar.r], [2 * 720 - 240, -400, -20]);
  assert.ok(g.nextHover.z > g.next.z); // under the pointer the copy comes forward
  assert.equal(C.COVERFLOW.rotate, 10);
});

test('dotWindow: at most 9 dots, a window that slides with the current task', () => {
  assert.deepEqual(C.dotWindow(7, 2), { from: 0, to: 7 });
  assert.deepEqual(C.dotWindow(20, 0), { from: 0, to: 9 });
  assert.deepEqual(C.dotWindow(20, 10), { from: 6, to: 15 });
  assert.deepEqual(C.dotWindow(20, 19), { from: 11, to: 20 });
  assert.deepEqual(C.dotWindow(9, 8), { from: 0, to: 9 });
  assert.equal(C.dotWindow(1, 0), null);
  assert.equal(C.dotWindow(5, -1), null);
});

test('deckSequence: the window moves A Do, B Plan, C Delegate, D Eliminate; empty quadrants are skipped', () => {
  assert.deepEqual(C.deckSequence({ B: ['b1'], A: ['a1', 'a2'], D: ['d1'] }), ['a1', 'a2', 'b1', 'd1']);
  assert.deepEqual(C.navNeighbours(C.deckSequence({ A: ['a1', 'a2'], C: ['c1'] }), 'a2'), { prev: 'a1', next: 'c1' });
  assert.deepEqual(C.deckSequence({}), []);
});
