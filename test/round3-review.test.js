// node --test test/  — round-3 Weekly review and KPI rules of the page's <script id="core"> (adjustments 8 and 9). No network.
const test = require('node:test');
const assert = require('node:assert/strict');

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });
const at = s => new Date(s).getTime(); // local time, as the page
const DAY = 864e5;

test('isoWeek / weekFromKey / weekLabel: ISO weeks, Monday start, across years', () => {
  const w = C.isoWeek(at('2026-10-28T15:00'));
  assert.equal(w.key, '2026-W44'); assert.equal(w.start, at('2026-10-26T00:00')); assert.equal(w.end, at('2026-11-02T00:00'));
  assert.equal(C.weekLabel(w), 'W44 · 26 Oct–1 Nov');
  assert.equal(C.weekLabel(C.weekFromKey('2026-W45')), 'W45 · 2–8 Nov');
  assert.equal(C.isoWeek(at('2027-01-01T12:00')).key, '2026-W53'); // 2026 has 53 weeks
  assert.equal(C.isoWeek(at('2027-01-04T00:00')).key, '2027-W01');
  assert.equal(C.isoWeek(at('2025-12-29T09:00')).key, '2026-W01'); // Monday of week 1 is in the year before
  assert.equal(C.isoWeek(at('2026-11-01T23:59')).key, '2026-W44'); // Sunday stays in the week
  assert.equal(C.weekFromKey('2026-W44').start, w.start);
  assert.equal(C.weekFromKey('2025-W53'), null); // 2025 has 52 weeks
  assert.equal(C.weekFromKey('nonsense'), null);
  const r = C.weekRange(at('2026-10-28'), 3);
  assert.deepEqual(r.map(x => x.key), ['2026-W44', '2026-W45', '2026-W46']);
  assert.equal(r[1].start, r[0].end);
});

test('weekSelect: click one, Ctrl toggles, Shift range from the anchor, Ctrl+Shift adds it (Windows logic)', () => {
  let s = C.weekSelect({ sel: [], anchor: null }, '2026-W44', {});
  assert.deepEqual(s, { sel: ['2026-W44'], anchor: '2026-W44' });
  s = C.weekSelect(s, '2026-W40', { ctrl: true });
  assert.deepEqual(s, { sel: ['2026-W40', '2026-W44'], anchor: '2026-W40' });
  s = C.weekSelect(s, '2026-W44', { ctrl: true });
  assert.deepEqual(s.sel, ['2026-W40']);
  assert.deepEqual(C.weekSelect(s, '2026-W40', { ctrl: true }).sel, ['2026-W40'], 'the last week stays picked');
  s = C.weekSelect({ sel: ['2026-W40'], anchor: '2026-W40' }, '2026-W43', { shift: true });
  assert.deepEqual(s, { sel: ['2026-W40', '2026-W41', '2026-W42', '2026-W43'], anchor: '2026-W40' });
  assert.deepEqual(C.weekSelect(s, '2026-W38', { shift: true }).sel, ['2026-W38', '2026-W39', '2026-W40'], 'Shift replaces; backwards works');
  s = C.weekSelect({ sel: ['2026-W30'], anchor: '2026-W40' }, '2026-W41', { shift: true, ctrl: true });
  assert.deepEqual(s.sel, ['2026-W30', '2026-W40', '2026-W41']);
  assert.deepEqual(C.weekSelect({ sel: ['2026-W52'], anchor: '2026-W52' }, '2027-W02', { shift: true }).sel, ['2026-W52', '2026-W53', '2027-W01', '2027-W02']);
  assert.equal(C.weekSelect({ sel: [], anchor: '2020-W01' }, '2026-W44', { shift: true }).sel.length, C.WEEKS_MAX);
  assert.deepEqual(C.weekSelect({ sel: ['2026-W44'], anchor: 'x' }, 'bad', {}).sel, ['2026-W44']);
});

test('reviewPeriod and reviewFileName', () => {
  assert.deepEqual(C.reviewPeriod(['2026-W44', '2026-W40']), { from: at('2026-09-28T00:00'), to: at('2026-11-02T00:00') });
  assert.equal(C.reviewPeriod([]), null);
  assert.equal(C.reviewFileName(['2026-W44']), 'tasks-review-2026-W44.html');
  assert.equal(C.reviewFileName(['2026-W44', '2026-W40', '2026-W42']), 'tasks-review-2026-W40-2026-W44.html');
});

const task = (id, o) => Object.assign({ id, num: +id.slice(1), list: 'L1', q: 'B', status: 'open', deadline: null, doneAt: null, deleted: false }, o);

test('reviewEntries: completed in the weeks, else due in them; overdue = passed while open; deleted left out', () => {
  const now = at('2026-10-28T12:00'), keys = ['2026-W44'];
  const d = s => new Date(s);
  const tasks = [
    task('t1', { deadline: d('2026-10-27T10:00') }), // passed this week, still open
    task('t2', { deadline: d('2026-10-30T10:00') }), // later this week
    task('t3', { status: 'done', doneAt: d('2026-10-26T09:00'), deadline: d('2026-10-20T00:00') }), // done this week, late
    task('t4', { status: 'cancelled', doneAt: d('2026-10-27T09:00') }),
    task('t5', { status: 'done', doneAt: d('2026-10-20T09:00'), deadline: d('2026-10-29T00:00') }), // due this week, done the week before
    task('t6', { deadline: d('2026-10-19T00:00') }), // overdue, but not this week
    task('t7', { deadline: d('2026-10-27T00:00'), deleted: true }),
    task('t8', {}),
  ];
  const e = Object.fromEntries(C.reviewEntries(tasks, keys, now).map(x => [x.t.id, x]));
  assert.deepEqual(Object.keys(e).sort(), ['t1', 't2', 't3', 't4', 't5']);
  assert.equal(e.t1.kind, 'overdue'); assert.equal(e.t1.late, true);
  assert.equal(e.t2.kind, 'due'); assert.equal(e.t2.late, false);
  assert.equal(e.t3.kind, 'done'); assert.equal(e.t3.late, true); assert.equal(e.t3.at, at('2026-10-26T09:00'));
  assert.equal(e.t4.kind, 'cancelled');
  assert.equal(e.t5.kind, 'due'); assert.equal(e.t5.late, false);
  assert.equal(C.reviewEntries(tasks, ['2026-W43'], now).find(x => x.t.id === 't6').kind, 'overdue');
  assert.deepEqual(C.reviewEntries(tasks, [], now), []);
});

test('reviewGroups: four quadrants, then lists in list order, rows by day then number', () => {
  const E = (id, q, list, ms, num) => ({ t: { id, q, list, num }, kind: 'due', at: ms });
  const g = C.reviewGroups([E('a', 'A', 'L2', 5, 1), E('b', 'A', 'L1', 9, 2), E('c', 'A', 'L1', 3, 3), E('d', 'D', 'LX', 1, 4), E('e', 'A', 'L1', 3, 1)], ['L1', 'L2']);
  assert.deepEqual(g.map(x => [x.q, x.count]), [['A', 4], ['B', 0], ['C', 0], ['D', 1]]);
  assert.deepEqual(g[0].lists.map(l => l.list), ['L1', 'L2']);
  assert.deepEqual(g[0].lists[0].rows.map(r => r.t.id), ['e', 'c', 'b']);
  assert.deepEqual(g[3].lists[0].list, 'LX');
  assert.equal(C.reviewGroups([E('a', 'A', 'L1', 1, 1)], [], e => 'C')[2].count, 1, 'quadOf decides');
});

// synthetic history: rows as the database has them now, events with { old, new } diffs (as db/002 writes them)
const S = { threshold: 50, windowDays: 7, doLimit: 5 };
const row = (id, o) => Object.assign({ id, list_id: 'L1', quadrant: null, status: 'open', due_at: null, urgent_pin: null, category: 'task', deleted_at: null, created_at: '2026-10-01T09:00:00Z' }, o);
const ev = (item_id, at, diff, id) => ({ id, item_id, at, diff });

test('kpiHistory / kpiStateAt: the current row with later diffs undone; nothing before created_at; flat diff columns too', () => {
  const rows = [row('i1', { quadrant: 'A', status: 'done' })];
  const events = [
    ev('i1', '2026-10-05T09:00:00Z', { quadrant: { old: 'B', new: 'A' } }, 2),
    ev('i1', '2026-10-10T09:00:00Z', { status: { old: 'open', new: 'done' }, completed_at: { old: null, new: 'x' } }, 3),
    ev('i1', '2026-10-03T09:00:00Z', { body_md: { old: 'a', new: 'b' } }, 1), // no KPI column: no change point
  ];
  const [h] = C.kpiHistory(rows, events);
  assert.equal(h.changes.length, 3);
  assert.equal(C.kpiStateAt(h, Date.parse('2026-09-30T00:00:00Z')), null);
  assert.deepEqual([C.kpiStateAt(h, Date.parse('2026-10-02T00:00:00Z')).quadrant, C.kpiStateAt(h, Date.parse('2026-10-02T00:00:00Z')).status], ['B', 'open']);
  assert.deepEqual([C.kpiStateAt(h, Date.parse('2026-10-06T00:00:00Z')).quadrant, C.kpiStateAt(h, Date.parse('2026-10-06T00:00:00Z')).status], ['A', 'open']);
  assert.equal(C.kpiStateAt(h, Date.parse('2026-10-11T00:00:00Z')).status, 'done');
  const flat = C.kpiHistory(rows, [{ item_id: 'i1', at: '2026-10-05T09:00:00Z', quadrant: { old: 'C', new: 'A' }, status: null }]);
  assert.equal(C.kpiStateAt(flat[0], Date.parse('2026-10-02T00:00:00Z')).quadrant, 'C');
  assert.deepEqual(C.kpiHistory([row('i2')], []).map(x => x.changes.length), [1]);
});

test('kpiStatus and kpiQuadrant: deleted, closed, archived (open in a list archived by then), stored or derived quadrant', () => {
  const T = Date.parse('2026-10-20T00:00:00Z'), arch = { L2: Date.parse('2026-10-15T00:00:00Z') };
  assert.equal(C.kpiStatus(null, T, arch), 'none');
  assert.equal(C.kpiStatus({ deleted_at: 'x', status: 'open' }, T, arch), 'deleted');
  assert.equal(C.kpiStatus({ status: 'cancelled', list_id: 'L2' }, T, arch), 'closed');
  assert.equal(C.kpiStatus({ status: 'open', list_id: 'L2' }, T, arch), 'archived');
  assert.equal(C.kpiStatus({ status: 'open', list_id: 'L2' }, Date.parse('2026-10-14T00:00:00Z'), arch), 'open');
  const s = { quadrant: null, category: 'reminder', urgent_pin: null, due_at: '2026-10-25T00:00:00Z' };
  assert.equal(C.kpiQuadrant(s, S, Date.parse('2026-10-10T00:00:00Z')), 'B', 'important, 15 days left');
  assert.equal(C.kpiQuadrant(s, S, Date.parse('2026-10-20T00:00:00Z')), 'A', 'important, inside the 7-day window');
  assert.equal(C.kpiQuadrant(Object.assign({}, s, { quadrant: 'D' }), S, Date.parse('2026-10-20T00:00:00Z')), 'D', 'stored wins');
});

test('kpiTimes and kpiSeries: from, then daily up to 62 days, else weekly; open items per quadrant at each point', () => {
  const from = at('2026-10-01T00:00'), to = at('2026-10-08T00:00');
  const t = C.kpiTimes(from, to);
  assert.equal(t.step, 1); assert.equal(t.times.length, 8); assert.equal(t.times[0], from); assert.equal(t.times[7], to);
  assert.equal(C.kpiTimes(from, at('2027-01-01T00:00')).step, 7);
  const rows = [
    row('a', { quadrant: 'A', created_at: '2026-10-01T09:00:00Z' }),
    row('b', { quadrant: 'D', status: 'done', created_at: '2026-10-02T09:00:00Z' }),
    row('c', { quadrant: 'C', deleted_at: '2026-10-06T00:00:00Z', created_at: '2026-10-01T09:00:00Z' }),
  ];
  const events = [
    ev('a', '2026-10-04T12:00:00Z', { quadrant: { old: 'B', new: 'A' } }),
    ev('b', '2026-10-05T12:00:00Z', { status: { old: 'open', new: 'done' } }),
    ev('c', '2026-10-06T00:00:00Z', { deleted_at: { old: null, new: '2026-10-06T00:00:00Z' } }),
  ];
  const H = C.kpiHistory(rows, events);
  const pts = C.kpiSeries(H, from, to, { settings: S }).points;
  const day = d => pts.find(p => p.at === at(d)), pick = p => [p.A, p.B, p.C, p.D].join();
  assert.equal(pick(day('2026-10-03T00:00')), '0,1,1,1'); // a in Plan, c in Delegate, b in Eliminate
  assert.equal(pick(day('2026-10-05T00:00')), '1,0,1,1'); // a moved to Do
  assert.equal(pick(day('2026-10-07T00:00')), '1,0,0,0'); // b done, c deleted
});

test('kpiPie and kpiClosure: the period items (open in it), closed as a second shade in their quadrant at closing; how they ended', () => {
  const rows = [
    row('o1', { quadrant: 'A' }), // open all along
    row('c1', { quadrant: 'B', status: 'done' }), // closed in the period, then moved to D after it
    row('d1', { quadrant: 'C', deleted_at: '2026-10-12T00:00:00Z' }),
    row('a1', { quadrant: 'D', list_id: 'L2' }), // open when L2 was archived
    row('x1', { quadrant: 'A', status: 'done' }), // closed before the period: not in it
    row('n1', { quadrant: 'B', created_at: '2026-10-25T00:00:00Z' }), // made after the period
  ];
  const events = [
    ev('c1', '2026-10-11T00:00:00Z', { status: { old: 'open', new: 'done' } }),
    ev('d1', '2026-10-12T00:00:00Z', { deleted_at: { old: null, new: '2026-10-12T00:00:00Z' } }),
    ev('x1', '2026-10-02T00:00:00Z', { status: { old: 'open', new: 'done' } }),
  ];
  const H = C.kpiHistory(rows, events), o = { settings: S, archived: { L2: Date.parse('2026-10-13T00:00:00Z') } };
  const from = Date.parse('2026-10-05T00:00:00Z'), to = Date.parse('2026-10-19T00:00:00Z');
  const pie = C.kpiPie(H, from, to, o);
  assert.deepEqual([pie.A, pie.B, pie.C, pie.D, pie.total], [{ open: 1, closed: 0 }, { open: 0, closed: 1 }, { open: 0, closed: 0 }, { open: 0, closed: 0 }, 2]);
  assert.deepEqual(C.kpiClosure(H, from, to, o), { closed: 1, archived: 1, deleted: 1, open: 1, total: 4 });
  // an item made closed inside the period counts as closed at its creation
  const made = C.kpiHistory([row('m1', { quadrant: 'C', status: 'done', created_at: '2026-10-06T00:00:00Z' })], []);
  assert.equal(C.kpiPie(made, from, to, o).C.closed, 1);
  assert.deepEqual(C.kpiOverall(H, to), { from: new Date(new Date('2026-10-01T09:00:00Z').setHours(0, 0, 0, 0)).getTime(), to });
  assert.equal(C.kpiOverall([], to), null);
});
