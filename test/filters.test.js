// node --test test/  — the board's filter row: rules of the page's <script id="core">. No network.
const test = require('node:test');
const assert = require('node:assert/strict');

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });

const NOW = new Date(2026, 10, 5, 14, 30).getTime();
const at = (d, h = 12, m = 0) => ({ deadline: new Date(2026, 10, d, h, m) });
const NONE = { deadline: null };

test('Mine: an owned task assigned to someone else is not mine; an assigned task I do not own is', () => {
  const me = { id: 'me', mine_tag_ids: ['maksym'] }, names = { maksym: 'Maksym', ana: 'Anastasiia' };
  assert.equal(C.isMine({ ownerId: 'me', tags: ['ana'] }, me, names), false);
  assert.equal(C.isMine({ ownerId: 'ana', tags: ['maksym'] }, me, names), true);
  assert.equal(C.isMine({ ownerId: 'me', tags: [] }, { id: 'me', mine_tag_ids: [] }, names), false, 'no tags chosen: nothing is mine');
});

test('Mine picker: a tag named like me comes first, by display name, its first word or handle, any case', () => {
  const names = { a: 'Maksym', b: 'Anastasiia', c: 'maksym denysiuk', d: 'Planned' };
  const me = { display_name: 'Maksym Denysiuk', handle: 'maksym' };
  assert.deepEqual(C.mineSuggestions(['a', 'b', 'c', 'd'], names, me), ['a', 'c']);
  assert.deepEqual(C.mineSuggestions(['a'], names, null), []);
});

test('tag filter: any inside one tag list, every list with a selection must match', () => {
  const listOf = { m: 'Assignee', a: 'Assignee', p: 'Status', w: 'Status' };
  const hit = (ids, keys) => C.tagFilterHit(ids, new Set(keys), listOf);
  assert.equal(hit(['m'], ['m', 'a']), true, 'OR inside Assignee');
  assert.equal(hit(['w'], ['m', 'a']), false);
  assert.equal(hit(['m', 'p'], ['m', 'p']), true, 'AND across lists');
  assert.equal(hit(['m'], ['m', 'p']), false, 'a second list narrows, it does not widen');
  assert.equal(hit(['p'], ['m', 'p']), false);
  assert.equal(hit([], []), true, 'no filter');
  assert.equal(C.tagFilterHit(['x'], null, listOf), true);
});

test('Due: Overdue is the same test as the card mark (before now)', () => {
  const f = { due: 'overdue' };
  assert.equal(C.dueMatch(at(4, 23, 59), f, NOW), true, '23:59 yesterday');
  assert.equal(C.dueMatch(at(5, 14, 29), f, NOW), true, 'earlier today: the card says overdue too');
  assert.equal(C.dueMatch(at(5, 14, 31), f, NOW), false);
  assert.equal(C.dueMatch(NONE, f, NOW), false);
});

test('Due: Today is the local calendar day', () => {
  const f = { due: 'today' };
  assert.equal(C.dueMatch(at(4, 23, 59), f, NOW), false, '23:59 yesterday');
  assert.equal(C.dueMatch(at(5, 0, 0), f, NOW), true, '00:00 today');
  assert.equal(C.dueMatch(at(5, 23, 59), f, NOW), true, '23:59 today');
  assert.equal(C.dueMatch(at(6, 0, 0), f, NOW), false, '00:00 tomorrow');
  assert.equal(C.dueMatch(NONE, f, NOW), false);
});

test('Due: Next 7 days runs from today to today + 7, no overdue from earlier days', () => {
  const f = { due: 'week' };
  assert.equal(C.dueMatch(at(4, 23, 59), f, NOW), false);
  assert.equal(C.dueMatch(at(5, 0, 0), f, NOW), true);
  assert.equal(C.dueMatch(at(12, 23, 59), f, NOW), true, 'day 7');
  assert.equal(C.dueMatch(at(13, 0, 0), f, NOW), false, 'day 8');
});

test('Due: No date and Any', () => {
  assert.equal(C.dueMatch(NONE, { due: 'none' }, NOW), true);
  assert.equal(C.dueMatch(at(5), { due: 'none' }, NOW), false);
  assert.equal(C.dueMatch(NONE, { due: 'any' }, NOW), true);
  assert.equal(C.dueMatch(at(5), { due: null }, NOW), true, 'the phone passes null for no filter');
});

test('Due: a range keeps both end days, an empty end is open, both empty pass, a reversed range is swapped', () => {
  const r = (from, to) => ({ due: 'range', from, to });
  const f = r('2026-11-10', '2026-11-12');
  assert.equal(C.dueMatch(at(9, 23, 59), f, NOW), false);
  assert.equal(C.dueMatch(at(10, 0, 0), f, NOW), true);
  assert.equal(C.dueMatch(at(12, 23, 59), f, NOW), true);
  assert.equal(C.dueMatch(at(13, 0, 0), f, NOW), false);
  assert.equal(C.dueMatch(NONE, f, NOW), false, 'a range needs a date');
  assert.equal(C.dueMatch(at(20), r('2026-11-10', ''), NOW), true, 'open end');
  assert.equal(C.dueMatch(at(1), r('', '2026-11-10'), NOW), true, 'open start');
  assert.equal(C.dueMatch(at(20), r('', '2026-11-10'), NOW), false);
  assert.equal(C.dueMatch(NONE, r('', ''), NOW), true, 'both empty pass');
  assert.equal(C.dueMatch(at(11), r('2026-11-12', '2026-11-10'), NOW), true, 'swapped');
  assert.equal(C.dueMatch(at(12), r('2026-11-12', '2026-11-10'), NOW), true, 'swapped, end day kept');
});

test('prefs: searchRow starts expanded, keeps collapsed, rejects anything else', () => {
  assert.equal(C.prefsFromRow(null).searchRow, 'expanded');
  assert.equal(C.prefsFromRow({ searchRow: 'collapsed' }).searchRow, 'collapsed');
  assert.equal(C.prefsFromRow({ searchRow: 'hidden' }).searchRow, 'expanded');
  assert.equal(C.prefsFromRow({ searchRow: 1 }).searchRow, 'expanded');
});

test('prefs: filters and filterBar default, reject wrong types and keep unknown ids', () => {
  const p = C.prefsFromRow(null);
  assert.deepEqual(p.filters, C.FILTERS_DEFAULTS);
  assert.equal(p.filterBar, null, 'null follows the starred lists');
  const bad = C.prefsFromRow({ filters: { mine: 'yes', due: 'soon', from: '5 Nov', to: 7, tags: 'x', cats: [1], low: 1 }, filterBar: 'due' });
  assert.deepEqual(bad.filters, C.FILTERS_DEFAULTS);
  assert.equal(bad.filterBar, null);
  const good = C.prefsFromRow({ filters: { mine: true, due: 'range', from: '2026-11-01', to: '2026-11-02', tags: ['t1', 't1', 'unknown'], cats: ['task'], low: true }, filterBar: ['low', 'tl:unknown', 'due', 'due', 'nonsense'] }, { listIds: [], tagListIds: [] });
  assert.deepEqual(good.filters, { mine: true, due: 'range', from: '2026-11-01', to: '2026-11-02', tags: ['t1', 'unknown'], cats: ['task'], low: true });
  assert.deepEqual(good.filterBar, ['low', 'tl:unknown', 'due'], 'shape only: the page drops stale ids, a phone write must not');
  assert.deepEqual(C.readFilterBar([]), [], 'an empty bar is a choice: Mine alone');
  const row = C.rowFromPrefs('me', good);
  assert.deepEqual(C.prefsFromRow(row.prefs).filters, good.filters, 'a round trip keeps them');
});

test('defaultFilterBar: Due, then the starred tag lists', () => {
  assert.deepEqual(C.defaultFilterBar(['a', 'b']), ['due', 'tl:a', 'tl:b']);
  assert.deepEqual(C.defaultFilterBar([]), ['due']);
  assert.deepEqual(C.defaultFilterBar(null), ['due']);
});
