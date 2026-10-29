// node --test test/  — task links (db/018) in the page's <script id="core">: merging rows, the index, waiting and progress,
// loops, the picker's candidates, cards grouped by parent, the Timeline's rows and arrows, Card layout switches. No network.
const test = require('node:test');
const assert = require('node:assert/strict');

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });

const day = (d, h = 9) => new Date(2026, 10, d, h);
const T = (id, o) => Object.assign({ id, num: Number(id.replace(/\D/g, '')) || 1, list: 'L1', title: 'task ' + id, status: 'open', deleted: false }, o || {});
const row = (from_item, to_item, kind, removed_at) => ({ from_item, to_item, kind, removed_at: removed_at || null });
function world(tasks, rows) {
  const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
  const links = C.mergeLinkRows(null, rows).links;
  return { byId, links, ix: C.linkIndex(links, byId) };
}

test('mergeLinkRows: shown kinds only, removed rows leave, changes counted', () => {
  let m = C.mergeLinkRows(null, [row('a', 'b', 'parent'), row('a', 'c', 'relates'), row('c', 'b', 'depends_on')]);
  assert.equal(m.links.size, 2);
  assert.equal(m.changed, 2);
  m = C.mergeLinkRows(m.links, [row('a', 'b', 'parent', '2026-11-01T00:00:00Z'), row('c', 'b', 'depends_on')]);
  assert.equal(m.links.size, 1);
  assert.equal(m.changed, 1, 'an unchanged row is not a change');
  assert.deepEqual([...m.links.values()][0], { from: 'c', to: 'b', kind: 'depends_on' });
  assert.match(C.linkPollFilter(Date.UTC(2026, 10, 1)), /^changed_at=gte\./);
  assert.deepEqual(C.LINK_KINDS, ['depends_on', 'parent']);
});

test('linkIndex: both ends must be known; parent, children, predecessors, next', () => {
  const { ix } = world([T('p1'), T('c2'), T('c3'), T('d4')], [row('c2', 'p1', 'parent'), row('c3', 'p1', 'parent'), row('c3', 'c2', 'depends_on'), row('x9', 'p1', 'parent')]);
  assert.equal(ix.parentOf.c2, 'p1');
  assert.deepEqual(ix.childrenOf.p1, ['c2', 'c3'], 'x9 is not loaded, so its link is not shown');
  assert.deepEqual(ix.predsOf.c3, ['c2']);
  assert.deepEqual(ix.succsOf.c2, ['c3']);
});

test('waitingFor and subtaskProgress: done and cancelled release, cancelled children do not count', () => {
  const tasks = [T('p1'), T('a2', { status: 'done' }), T('b3', { status: 'cancelled' }), T('c4'), T('n5')];
  const { ix, byId } = world(tasks, [row('n5', 'a2', 'depends_on'), row('n5', 'b3', 'depends_on'), row('n5', 'c4', 'depends_on'),
    row('a2', 'p1', 'parent'), row('b3', 'p1', 'parent'), row('c4', 'p1', 'parent')]);
  assert.deepEqual(C.waitingFor(byId.n5, ix, byId).map(t => t.id), ['c4']);
  assert.deepEqual(C.waitingFor(byId.p1, ix, byId), []);
  assert.deepEqual(C.subtaskProgress(byId.p1, ix, byId), { done: 1, total: 2 });
  assert.equal(C.subtaskProgress(byId.c4, ix, byId), null);
});

test('linkFor and wouldLoop: the four roles, loops of 1, 2 and 3 steps', () => {
  assert.deepEqual(C.linkFor('parent', 's', 'o'), { from: 's', to: 'o', kind: 'parent' });
  assert.deepEqual(C.linkFor('child', 's', 'o'), { from: 'o', to: 's', kind: 'parent' });
  assert.deepEqual(C.linkFor('pred', 's', 'o'), { from: 's', to: 'o', kind: 'depends_on' });
  assert.deepEqual(C.linkFor('next', 's', 'o'), { from: 'o', to: 's', kind: 'depends_on' });
  const { ix } = world([T('a1'), T('b2'), T('c3')], [row('b2', 'a1', 'depends_on'), row('c3', 'b2', 'depends_on'), row('b2', 'a1', 'parent'), row('c3', 'b2', 'parent')]);
  assert.equal(C.wouldLoop(ix, 'a1', 'a1', 'parent'), true);
  assert.equal(C.wouldLoop(ix, 'a1', 'b2', 'depends_on'), true, '2 steps');
  assert.equal(C.wouldLoop(ix, 'a1', 'c3', 'depends_on'), true, '3 steps');
  assert.equal(C.wouldLoop(ix, 'a1', 'c3', 'parent'), true);
  assert.equal(C.wouldLoop(ix, 'c3', 'a1', 'depends_on'), false);
});

test('linkCandidates: words, numbers, list#num; self, linked, loops and closed left out; my rights; max', () => {
  const tasks = [T('s1', { title: 'Launch **v2**' }), T('a2', { title: 'Write launch notes' }), T('b3', { title: 'Launch party', list: 'L2' }),
    T('c4', { title: 'Old launch', status: 'done' }), T('d5', { title: 'Launch blog' }), T('e6', { title: 'other', list: 'L2' })];
  const { ix, byId } = world(tasks, [row('d5', 's1', 'parent'), row('s1', 'a2', 'depends_on')]);
  const ids = (role, q, o) => C.linkCandidates(tasks, ix, byId.s1, role, q, Object.assign({ listName: l => ({ L1: 'Work', L2: 'Home' })[l] }, o)).map(t => t.id);
  assert.deepEqual(ids('child', 'launch'), ['b3'], 'a2 and d5 are already linked; c4 is done');
  assert.deepEqual(ids('pred', 'launch'), ['c4', 'b3'], 'a closed task can be a predecessor; same list first');
  assert.deepEqual(ids('next', '#6'), ['e6']);
  assert.deepEqual(ids('next', '6'), ['e6']);
  assert.deepEqual(ids('next', 'home#6'), ['e6']);
  assert.deepEqual(ids('next', 'work#6'), []);
  // a2 comes before s1, so a2 cannot also be next after s1 (it is linked anyway) and its predecessors would loop
  const t2 = [...tasks, T('f7', { title: 'f' })];
  const w2 = world(t2, [row('s1', 'a2', 'depends_on'), row('a2', 'f7', 'depends_on')]);
  assert.ok(!C.linkCandidates(t2, w2.ix, w2.byId.s1, 'next', 'f').some(t => t.id === 'f7'), 'f7 -> s1 would loop');
  assert.deepEqual(C.linkCandidates(tasks, ix, byId.s1, 'child', '', { canEdit: t => t.id === 'e6' }).map(t => t.id), ['e6'], 'I cannot edit s1: only ends I can edit');
  assert.equal(C.linkCandidates(tasks, ix, byId.s1, 'pred', '', { max: 2 }).length, 2);
});

test('groupCards: parent first, children indented, ghost parent from another quadrant, depth cap, last child', () => {
  const tasks = [T('p1'), T('c2'), T('g3'), T('c4'), T('x5'), T('o6'), T('k7'), T('q8')];
  const { ix, byId } = world(tasks, [row('c2', 'p1', 'parent'), row('g3', 'c2', 'parent'), row('c4', 'p1', 'parent'), row('k7', 'o6', 'parent'), row('q8', 'o6', 'parent')]);
  // quadrant holds c4, x5, p1, g3, c2, k7, q8 in board order; o6 lives in another quadrant
  const cards = ['c4', 'x5', 'p1', 'g3', 'c2', 'k7', 'q8'].map(id => byId[id]);
  const rows = C.groupCards(cards, ix, byId);
  assert.deepEqual(rows.map(r => (r.ghost ? '~' : '') + r.t.id + ':' + r.depth), ['x5:0', 'p1:0', 'c4:1', 'c2:1', 'g3:2', '~o6:0', 'k7:1', 'q8:1']);
  assert.deepEqual(rows.filter(r => r.depth).map(r => r.t.id + ':' + r.last), ['c4:false', 'c2:true', 'g3:true', 'k7:false', 'q8:true']);
  assert.equal(C.groupCards(cards, ix, byId, { cap: 1 }).find(r => r.t.id === 'g3').deep, true);
  assert.equal(C.groupCards(cards, ix, byId, { cap: 1 }).find(r => r.t.id === 'g3').depth, 1);
  assert.deepEqual(C.groupCards([byId.x5], ix, byId).map(r => r.t.id), ['x5']);
});

test('timelineRows: trees join, rows depth first by start, bars and summaries, collapse, arrows and late', () => {
  const tasks = [T('p1', { start: null, deadline: null }), T('a2', { start: day(3), deadline: day(5) }), T('b3', { start: day(4), deadline: day(8) }),
    T('n4', { start: null, deadline: day(10) }), T('z5', { start: day(1), deadline: day(2) }), T('u6', { start: null, deadline: null })];
  const { ix, byId } = world(tasks, [row('a2', 'p1', 'parent'), row('b3', 'p1', 'parent'), row('u6', 'p1', 'parent'), row('b3', 'a2', 'depends_on'), row('n4', 'b3', 'depends_on')]);
  const opts = { start: day(2, 0), days: 14 };
  const r = C.timelineRows([byId.a2, byId.n4, byId.z5], ix, byId, opts);
  assert.deepEqual(r.rows.map(x => x.t.id + ':' + x.depth), ['z5:0', 'n4:0', 'p1:0', 'a2:1', 'b3:1', 'u6:1'], 'undated last');
  const by = Object.fromEntries(r.rows.map(x => [x.t.id, x]));
  assert.deepEqual(by.a2.bar, { a: 1, b: 3 });
  assert.deepEqual(by.n4.bar, { a: 8, b: 8 }, 'no start: the end day only');
  assert.equal(by.u6.bar, null, 'no dates');
  assert.deepEqual(by.p1.sum, { a: 1, b: 6 });
  assert.equal(by.p1.kids, 3);
  assert.ok(r.rows.findIndex(x => x.t.id === 'p1') < r.rows.findIndex(x => x.t.id === 'a2'), 'children after their parent');
  assert.equal(r.rows.filter(x => x.t.id === 'b3').length, 1, 'b3 joins through its parent');
  const e = r.edges.map(x => r.rows[x.from].t.id + '>' + r.rows[x.to].t.id + ':' + x.late);
  assert.deepEqual(e.sort(), ['a2>b3:true', 'b3>n4:false']);
  const c = C.timelineRows([byId.a2], ix, byId, Object.assign({ collapsed: new Set(['p1']) }, opts));
  assert.deepEqual(c.rows.map(x => x.t.id + ':' + x.collapsed), ['p1:true']);
  assert.deepEqual(c.edges, []);
});

test('no priority (priority by position, 2026-10-29); Card layout keys and defaults', () => {
  assert.equal(C.FIELD_COLUMNS.priority, undefined);
  assert.deepEqual(C.taskToPatch({ priority: 4, title: 'x' }, ['title']), { title: 'x' });
  assert.equal(C.rowToTask({ id: 'i', list_id: 'L', num: 1, title: 'x', priority: 4, status: 'open', tags: [] }).priority, undefined);
  const d = C.CARD_LAYOUT_DEFAULTS;
  assert.deepEqual([d.group, d.priority, d.waiting, d.progress], [false, undefined, true, true]);
  ['group', 'waiting', 'progress'].forEach(k => assert.ok(C.CARD_FIELDS.includes(k)));
  assert.ok(!C.CARD_FIELDS.includes('priority'));
  assert.equal(C.readCardLayout({ group: true }).group, true);
  assert.equal(C.readCardLayout({ group: 1 }).group, false);
});
