// node --test test/  — list panels on the board (prefs.listBar): rules of the page's <script id="core">. No network.
const test = require('node:test');
const assert = require('node:assert/strict');

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });

const ids = n => Array.from({ length: n }, (_, i) => 'l' + (i + 1));
const places = p => p.rows.flat().concat(p.stray ? [p.stray] : [], p.more);

test('null bar: today\'s view, the first four of the order and the rest under +N', () => {
  const p = C.listPanels(null, ids(7));
  assert.deepEqual(p.rows, [['l1', 'l2', 'l3', 'l4']]);
  assert.deepEqual(p.more, ['l5', 'l6', 'l7']);
  assert.equal(p.stray, null);
  assert.equal(p.two, false);
});

test('readListBar: wrong shapes are refused, unknown ids are kept, duplicates and the 12 limit are cut', () => {
  for (const bad of [null, 1, 'x', [], {}, { two: 1, rows: [[], []] }, { two: true }, { two: true, rows: [[]] }, { two: true, rows: [[], [], []] }, { two: true, rows: [[1], []] }, { two: false, rows: ['a', []] }]) assert.equal(C.readListBar(bad), null);
  assert.deepEqual(C.readListBar({ two: true, rows: [['a', 'unknown'], ['b']] }), { two: true, rows: [['a', 'unknown'], ['b']] });
  assert.deepEqual(C.readListBar({ two: true, rows: [['a', 'b', 'a'], ['b', 'c']] }).rows, [['a', 'b'], ['c']], 'a list has one place');
  assert.equal(C.readListBar({ two: false, rows: [ids(20), []] }).rows[0].length, C.LIST_PANEL_MAX);
});

test('prefsFromRow: listBar defaults to null and keeps ids the client does not know', () => {
  assert.equal(C.prefsFromRow(null).listBar, null);
  assert.equal(C.PREFS_DEFAULTS.listBar, null);
  const raw = { listBar: { two: true, rows: [['x'], ['not-known']] } };
  assert.deepEqual(C.prefsFromRow(raw, { listIds: ['x'] }).listBar, raw.listBar);
  assert.equal(C.prefsFromRow({ listBar: { rows: 1 } }).listBar, null);
  assert.deepEqual(C.rowFromPrefs('me', C.prefsFromRow(raw)).prefs.listBar, raw.listBar);
});

test('a stale id stays in the row but does not show, and returns to its place when the list is back', () => {
  const bar = { two: false, rows: [['l1', 'gone', 'l2'], []] };
  assert.deepEqual(C.listPanels(bar, ['l1', 'l2', 'l3']).rows, [['l1', 'l2']]);
  assert.deepEqual(C.listBarOf(bar).rows[0], ['l1', 'gone', 'l2']);
  assert.deepEqual(C.listPanels(bar, ['l1', 'gone', 'l2', 'l3']).rows, [['l1', 'gone', 'l2']]);
  const moved = C.listBarMove(bar, ['l1', 'l2', 'l3'], 'l3', 0);
  assert.deepEqual(moved.bar.rows[0], ['l1', 'gone', 'l2', 'l3'], 'a move keeps a stale id');
});

test('every list has exactly one place, whatever the moves', () => {
  const order0 = ids(10);
  let bar = { two: true, rows: [['l1', 'l2'], ['l3']] }, order = order0;
  const moves = [['l1', 1, 'l3', true], ['l3', 'rest'], ['l9', 0, 'l2', false], ['l2', 1], ['l5', 0], ['l5', 0, 'l9', true], ['l9', 'rest', 'l6', false]];
  for (const [id, z, t, b] of moves) {
    ({ bar, order } = C.listBarMove(bar, order, id, z, t, b));
    const p = C.listPanels(bar, order);
    assert.deepEqual(places(p).slice().sort(), order0.slice().sort(), 'after moving ' + id);
    assert.equal(new Set(bar.rows.flat()).size, bar.rows.flat().length);
  }
});

test('move: before and after a target, the end of a panel, the front of +N', () => {
  const order = ids(6), bar = { two: true, rows: [['l1', 'l2'], ['l3']] };
  assert.deepEqual(C.listBarMove(bar, order, 'l5', 0, 'l2', true).bar.rows[0], ['l1', 'l5', 'l2']);
  assert.deepEqual(C.listBarMove(bar, order, 'l5', 0, 'l1', false).bar.rows[0], ['l1', 'l5', 'l2']);
  assert.deepEqual(C.listBarMove(bar, order, 'l5', 1).bar.rows[1], ['l3', 'l5']);
  const off = C.listBarMove(bar, order, 'l1', 'rest');
  assert.deepEqual(off.bar.rows[0], ['l2']);
  assert.deepEqual(C.listPanels(off.bar, off.order).more, ['l1', 'l4', 'l5', 'l6']);
  const inRest = C.listBarMove(bar, order, 'l6', 'rest', 'l4', true);
  assert.deepEqual(C.listPanels(inRest.bar, inRest.order).more, ['l6', 'l4', 'l5']);
  assert.deepEqual(C.listBarMove(bar, order, 'l1', 0, 'l2', false).bar.rows[0], ['l2', 'l1'], 'inside a panel');
});

test('move: a move to panel 2 turns it on; the bar a move starts from may be null', () => {
  const r = C.listBarMove(null, ids(6), 'l5', 1);
  assert.equal(r.bar.two, true);
  assert.deepEqual(r.bar.rows, [['l1', 'l2', 'l3', 'l4'], ['l5']]);
});

test('the limit: a full panel refuses a list, ids that do not show give way first', () => {
  const order = ids(14), full = { two: true, rows: [ids(12), []] };
  const r = C.listBarMove(full, order, 'l13', 0);
  assert.equal(r.refused, true);
  assert.deepEqual(r.bar.rows[0], ids(12));
  assert.ok(!C.listBarMove(full, order, 'l1', 0, 'l5', true).refused, 'a move inside a full panel is fine');
  const stale = { two: false, rows: [ids(11).concat('gone'), []] };
  const s = C.listBarMove(stale, order, 'l13', 0);
  assert.ok(!s.refused);
  assert.equal(s.bar.rows[0].length, 12);
  assert.ok(s.bar.rows[0].includes('l13') && !s.bar.rows[0].includes('gone'));
  assert.equal(C.listBarCount(full, order, 0, 1).bar.rows[0].length, 12, '+ on a full panel changes nothing');
});

test('panel 2 off: its lists show under +N, the row is kept, they return when it is on', () => {
  const order = ids(8), bar = { two: true, rows: [['l1', 'l2'], ['l3', 'l4']] };
  const off = C.listBarSetTwo(bar, order, false);
  assert.deepEqual(off.bar.rows[1], ['l3', 'l4']);
  const p = C.listPanels(off.bar, off.order);
  assert.deepEqual(p.rows, [['l1', 'l2']]);
  assert.ok(p.more.includes('l3') && p.more.includes('l4'));
  const on = C.listBarSetTwo(off.bar, off.order, true);
  assert.deepEqual(C.listPanels(on.bar, on.order).rows, [['l1', 'l2'], ['l3', 'l4']]);
});

test('panel 2 on while empty takes the next four from +N; with nothing left it draws no second row', () => {
  const on = C.listBarSetTwo(null, ids(10), true);
  assert.deepEqual(on.bar.rows, [['l1', 'l2', 'l3', 'l4'], ['l5', 'l6', 'l7', 'l8']]);
  const none = C.listBarSetTwo(null, ids(4), true);
  assert.equal(none.bar.two, true);
  assert.deepEqual(C.listPanels(none.bar, ids(4)).rows, [['l1', 'l2', 'l3', 'l4']]);
});

test('Alt+arrow steps inside a panel and across its edge; the ends stay', () => {
  const order = ids(5), bar = { two: true, rows: [['l1', 'l2'], ['l3']] };
  assert.deepEqual(C.listBarStep(bar, order, 'l2', -1).bar.rows[0], ['l2', 'l1']);
  assert.deepEqual(C.listBarStep(bar, order, 'l2', 1).bar.rows, [['l1'], ['l2', 'l3']]);
  assert.deepEqual(C.listBarStep(bar, order, 'l3', -1).bar.rows, [['l1', 'l2', 'l3'], []]);
  const down = C.listBarStep(bar, order, 'l3', 1);
  assert.deepEqual(C.listPanels(down.bar, down.order).more, ['l3', 'l4', 'l5']);
  const up = C.listBarStep(bar, order, 'l4', -1);
  assert.deepEqual(up.bar.rows[1], ['l3', 'l4']);
  assert.deepEqual(C.listBarStep(bar, order, 'l1', -1).bar.rows[0], ['l1', 'l2'], 'the first stays first');
  const last = C.listBarStep(bar, order, 'l5', 1);
  assert.deepEqual(C.listPanels(last.bar, last.order).more, ['l4', 'l5'], 'the last stays last');
  const oneP = C.listBarStep({ two: false, rows: [['l1'], ['l9']] }, ['l1', 'l2'], 'l1', 1);
  assert.deepEqual(oneP.bar.rows, [[], ['l9']], 'one panel: from panel 1 straight to +N');
});

test('the − and + of a panel', () => {
  const order = ids(5), bar = { two: false, rows: [['l1', 'l2'], []] };
  const less = C.listBarCount(bar, order, 0, -1);
  assert.deepEqual(less.bar.rows[0], ['l1']);
  assert.deepEqual(C.listPanels(less.bar, less.order).more, ['l2', 'l3', 'l4', 'l5'], 'to the front of +N');
  assert.deepEqual(C.listBarCount(less.bar, less.order, 0, 1).bar.rows[0], ['l1', 'l2'], 'back from the front of +N');
  assert.deepEqual(C.listBarCount({ two: false, rows: [[], []] }, order, 0, -1).bar.rows[0], [], 'an empty panel stays empty');
  assert.deepEqual(C.listBarCount({ two: false, rows: [order, []] }, order, 0, 1).bar.rows[0], order, 'nothing under +N');
});

test('selected from +N: stray on the last panel, not counted under +N; a selected list on a panel is not stray', () => {
  const order = ids(7), bar = { two: true, rows: [['l1'], ['l2']] };
  const p = C.listPanels(bar, order, { sel: 'l6' });
  assert.equal(p.stray, 'l6');
  assert.ok(!p.more.includes('l6'));
  assert.equal(C.listPanels(bar, order, { sel: 'l2' }).stray, null);
  assert.equal(C.listPanels(bar, order, { sel: 'all' }).stray, null);
});

test('too narrow: an overflowing list shows under +N and the saved rows do not change', () => {
  const order = ids(6), bar = { two: true, rows: [['l1', 'l2', 'l3'], ['l4']] };
  const p = C.listPanels(bar, order, { overflow: ['l3', 'l4'] });
  assert.deepEqual(p.rows, [['l1', 'l2']], 'a panel with nothing left is not drawn');
  assert.deepEqual(p.more, ['l3', 'l4', 'l5', 'l6']);
  assert.deepEqual(p.saved, [['l1', 'l2', 'l3'], ['l4']]);
  assert.deepEqual(p.rest, ['l5', 'l6'], 'the dialog\'s Under +N holds only what is really there');
  assert.deepEqual(bar.rows, [['l1', 'l2', 'l3'], ['l4']]);
});

test('listOrder is the panels, then the rest', () => {
  assert.deepEqual(C.listBarOrder(null, ['b', 'a']), ['b', 'a']);
  assert.deepEqual(C.listBarOrder({ two: true, rows: [['c'], ['a', 'gone']] }, ['a', 'b', 'c', 'd']), ['c', 'a', 'b', 'd']);
  assert.deepEqual(C.listBarOrder({ two: false, rows: [['c'], ['a']] }, ['a', 'b', 'c']), ['c', 'a', 'b'], 'off: panel 2 keeps its order under +N');
  assert.deepEqual(C.listBarMove(null, ['a', 'b', 'c', 'd', 'e'], 'e', 0, 'a', true).order, ['e', 'a', 'b', 'c', 'd']);
});

test('the delete popup: the time in local form, unknown without one, and only other people lose the list', () => {
  assert.equal(C.backupLine(null), 'Last backup time unknown');
  assert.equal(C.backupLine('not a date'), 'Last backup time unknown');
  assert.match(C.backupLine('2026-11-05T06:14:00Z'), /^Last backup 2026-11-05 \d\d:\d4$/);
  assert.equal(C.localStamp(null), '');
  const rows = [{ state: 'member', profile_id: 'me', display_name: 'Me' }, { state: 'member', profile_id: 'bot', display_name: 'Telegram bot' }, { state: 'member', profile_id: 'a', display_name: 'Ana' }, { state: 'member', profile_id: 'b', display_name: null }, { state: 'pending', email: 'x@example.com' }];
  assert.deepEqual(C.deleteLosers(rows, 'me', new Set(['bot'])), ['Ana', 'Someone']);
  assert.deepEqual(C.deleteLosers(null, 'me'), []);
});

test('isSystemList: access-requests and slugs starting with _', () => {
  assert.equal(C.isSystemList({ slug: 'access-requests' }), true);
  assert.equal(C.isSystemList({ slug: '_selftest' }), true);
  assert.equal(C.isSystemList({ slug: 'work' }), false);
  assert.equal(C.isSystemList(null), false);
});

test('the delete RPC\'s refusals read as sentences', () => {
  assert.equal(C.restError(400, { code: '55000', message: 'archive the list before deleting it' }).message, 'Archive the list before deleting it.');
  assert.equal(C.restError(409, { code: '23503', message: 'this list is the default list of the category task' }).message, 'This list is the default list of the category task.');
  assert.equal(C.restError(403, { code: '42501', message: 'this is a system list, scripts use it' }).message, 'This is a system list: scripts use it, so it stays.');
  assert.equal(C.restError(403, { code: '42501', message: 'only the owner deletes a list' }).message, 'Only the owner deletes a list.');
});
