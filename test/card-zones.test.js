// harness configurations T17: Card layout zones (Top, Main, Bottom) for the board card and the open task window: reading stored
// zones, the zones drawn (every block once, tag list blocks), storing them back and moving a block. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from '../cli/lib.mjs';

const C = loadCore();
const plain = o => JSON.parse(JSON.stringify(o));

test('zones: defaults draw today\'s card and window; tag lists stand where tl:* is', () => {
  const L = C.readCardLayout(null);
  assert.deepEqual(plain(C.layoutZones(L, 'board', ['a', 'b'])), { top: [], main: ['facts', 'tl:a', 'tl:b', 'description'], bottom: [], off: [] });
  // the task window draws the v3 sections (taskLayoutView): Header, Top, Main, Bottom; tl:* expands to the tag lists
  const V = C.taskLayoutView(L, ['a', 'b'], [], [], 'edit');
  assert.deepEqual(plain(V.sections.map(s => s.cells)), [[['id'], ['title', 'list'], ['close']], [['autonomy', 'decision', 'format']], [['description', 'dates']], [['tagsearch', 'tl:a', 'tl:b', 'links', 'sources']]]);
});

test('zones: stored zones are checked; unknown blocks, duplicates and unknown tag lists are dropped; decision is never hidden', () => {
  const raw = { zones: { board: { top: ['description', 'x', 'tl:gone'], main: ['facts', 'facts', 'tl:a'], bottom: ['tl:*'], off: ['facts', 'nope'] },
    task: { top: ['links'], main: ['decision'], bottom: [], off: ['decision', 'links'] } } };
  const L = C.readCardLayout(raw, ['a', 'b']);
  assert.deepEqual(plain(L.zones.board), { top: ['description'], main: ['facts', 'tl:a'], bottom: ['tl:*'], off: ['facts'] });
  assert.deepEqual(plain(L.zones.task.off), ['links']);
  assert.equal(L.zones.task.v, 3, 'a v2 task value is migrated');
  // drawn: tl:b (new) goes where tl:* stands; missing task blocks go to the end of their default zone
  assert.deepEqual(plain(C.layoutZones(L, 'board', ['a', 'b'])), { top: ['description'], main: ['facts', 'tl:a'], bottom: ['tl:b'], off: ['facts'] });
  const T = C.taskLayoutView(L, [], [], [], 'edit');
  assert.deepEqual(plain(T.sections.map(s => s.cells.flat())), [['id', 'title', 'list', 'close'], ['autonomy', 'format'], ['decision', 'description', 'dates'], ['tagsearch', 'sources']]);
  assert.deepEqual(plain(T.hidden), ['links']);
  assert.equal(C.readCardLayout({ zones: { board: 'junk' } }).zones.board.main.join(), 'facts,tl:*,description');
});

test('zones: store keeps tl:* after the last tag list block; move steps within and across zones', () => {
  const Z = C.layoutZones(C.readCardLayout(null), 'board', ['a']);
  assert.deepEqual(plain(C.layoutStore(Z, 'board')).main, ['facts', 'tl:a', 'tl:*', 'description']);
  let m = C.layoutMove(Z, 'facts', 'up');
  assert.deepEqual(plain(m).top, ['facts']); assert.deepEqual(plain(m).main, ['tl:a', 'description']);
  m = C.layoutMove(m, 'facts', 'down');
  assert.deepEqual(plain(m).main, ['facts', 'tl:a', 'description']);
  m = C.layoutMove(m, 'description', 'right');
  assert.deepEqual(plain(m).bottom, ['description']);
  m = C.layoutMove(m, 'description', null, { zone: 'main', before: 'facts' });
  assert.deepEqual(plain(m).main, ['description', 'facts', 'tl:a']);
  assert.deepEqual(plain(Z).main, ['facts', 'tl:a', 'description'], 'the input is not changed');
  const back = C.readCardLayout({ zones: { board: C.layoutStore(m, 'board') } }, ['a', 'b']);
  assert.deepEqual(plain(C.layoutZones(back, 'board', ['a', 'b'])).main, ['description', 'facts', 'tl:a', 'tl:b']);
});

// task window layout v3 (2026-11-11): sections with 1-3 columns, header pieces movable, one block per tag list
const ids = L => L.sections.map(s => s.id);
const cellsOf = (L, id) => plain(L.sections.find(s => s.id === id).cells);

test('task layout v3: defaults; readCardLayout keeps a v3 value', () => {
  const T = C.readCardLayout(null).zones.task;
  assert.deepEqual(plain(T), { v: 3, sections: [
    { id: 'header', name: 'Header', cols: 3, widths: ['fit', 'fill', 'fit'], cells: [['id'], ['title', 'list'], ['close']] },
    { id: 'top', name: 'Top', cols: 1, widths: ['fill'], cells: [['autonomy', 'decision', 'format']] },
    { id: 'main', name: 'Main', cols: 1, widths: ['fill'], cells: [['description', 'dates']] },
    { id: 'bottom', name: 'Bottom', cols: 1, widths: ['fill'], cells: [['tagsearch', 'tl:*', 'links', 'sources']] }], off: [] });
  assert.ok(!C.TASK_BLOCKS.includes('tags'));
  const v = C.taskLayoutSetCols(T, 'top', 3);
  assert.deepEqual(plain(C.readCardLayout({ zones: { task: v } }).zones.task), plain(v));
  assert.deepEqual(plain(C.readTaskLayout('junk')), plain(C.TASK_LAYOUT_DEFAULTS));
  assert.deepEqual(plain(C.readTaskLayout({ v: 3, sections: [] })), plain(C.TASK_LAYOUT_DEFAULTS));
  assert.deepEqual(plain(C.readTaskLayout({ v: 9, sections: [{}] })), plain(C.TASK_LAYOUT_DEFAULTS));
});

test('task layout v3: the reader drops unknown and duplicate blocks, fixes cells, clamps sections, cleans names and ids, adds missing blocks', () => {
  const raw = { v: 3, sections: [
    { id: 'Bad id!', name: '  A\u0007 very long section name beyond limit  ', cols: 1, cells: [['title', 'title', 'nope', 'tl:a', 'tl:gone'], ['close']] },
    { id: 'x', name: '\u0001 ', cols: 2, cells: [['tl:*']] },
    { id: 'x', name: 'Dup', cols: 7, cells: [[], [], ['links']] },
    ...Array.from({ length: 8 }, (_, i) => ({ id: 'e' + i, name: 'E' + i, cols: 1, cells: [[]] }))],
    off: ['title', 'close', 'decision', 'tl:*', 'list', 'list', 'nope'] };
  const L = C.readTaskLayout(raw, ['a', 'b']);
  assert.equal(L.sections.length, 8, 'at most 8 sections');
  assert.deepEqual(ids(L).slice(0, 3), ['s1', 'x', 's3'], 'invalid or duplicate ids are regenerated');
  assert.equal(L.sections[0].name, 'A very long section name'.slice(0, 24));
  assert.ok(L.sections[0].name.length <= 24 && !/[\u0000-\u001f]/.test(L.sections[0].name));
  assert.equal(L.sections[1].name, 'Section 2');
  assert.deepEqual(plain(L.sections[0].cells), [['title', 'tl:a', 'close']], 'the extra cell joins the last cell; unknown, duplicate, gone tag list dropped');
  assert.deepEqual(plain(L.sections[1].cells), [['tagsearch', 'tl:*'], []], 'cells padded to cols; Find a tag added right before tl:*');
  assert.equal(L.sections[2].cols, 3, 'a bad cols comes from the cells');
  // the default sections are gone: missing blocks go to the end of the last section's last cell
  const last = L.sections[7].cells[0];
  assert.deepEqual(plain(last), ['list', 'id', 'autonomy', 'decision', 'format', 'description', 'dates', 'sources']);
  assert.deepEqual(plain(L.off), ['list'], 'never-hidden, tl:*, duplicates and unknown blocks are not in off');
  // tl:* missing → start of Bottom's first cell
  const M = C.readTaskLayout({ v: 3, sections: [{ id: 'header', cols: 1, cells: [['title', 'close']] }, { id: 'bottom', name: 'B', cols: 2, cells: [['links'], []] }] });
  assert.deepEqual(cellsOf(M, 'bottom'), [['tagsearch', 'tl:*', 'links'], ['autonomy', 'decision', 'format', 'description', 'dates', 'sources']], 'tl:* at the start of the first cell; blocks of the missing Top and Main go to the last section, end of its last cell');
  assert.deepEqual(cellsOf(M, 'header')[0], ['title', 'close', 'list', 'id'], 'list and id go to the end of the default section (header)');
});

test('task layout v3: a realistic v2 row is migrated', () => {
  const row = { version: 2, theme: 'dark', cardLayout: { description: true, tags: 'all', zones: {
    board: { top: [], main: ['facts', 'tl:*', 'description'], bottom: [], off: [] },
    task: { top: ['format', 'autonomy', 'decision'], main: ['tags', 'description'], bottom: ['dates', 'links', 'sources'], off: ['sources', 'decision', 'tags'] } } } };
  const T = C.prefsFromRow(row, { tagListIds: ['a'] }).cardLayout.zones.task;
  assert.deepEqual(plain(T), { v: 3, sections: [
    { id: 'header', name: 'Header', cols: 3, widths: ['fit', 'fill', 'fit'], cells: [['id'], ['title', 'list'], ['close']] },
    { id: 'top', name: 'Top', cols: 1, widths: ['fill'], cells: [['format', 'autonomy', 'decision']] },
    { id: 'main', name: 'Main', cols: 1, widths: ['fill'], cells: [['description']] },
    { id: 'bottom', name: 'Bottom', cols: 1, widths: ['fill'], cells: [['tagsearch', 'tl:*', 'dates', 'links', 'sources']] }], off: ['sources'] });
});

test('task layout v3: the view expands tl:* starred first, then tagListOrder, then as given; create mode; hidden reported', () => {
  const lists = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  let V = C.taskLayoutView(C.readCardLayout(null), lists, ['d', 'b'], ['c', 'b'], 'edit');
  assert.deepEqual(plain(V.sections[3].cells[0]), ['tagsearch', 'tl:b', 'tl:d', 'tl:c', 'tl:a', 'links', 'sources']);
  assert.deepEqual(plain(V.hidden), []);
  // a placed tag list stays where it is; the rest follow tl:*; a hidden block is reported
  let L = C.taskLayoutMove(C.TASK_LAYOUT_DEFAULTS, 'links', null, { section: 'top', cell: 0, before: null });
  L = { ...L, sections: L.sections.map(s => s.id === 'main' ? { ...s, cells: [['tl:c', ...s.cells[0]]] } : s) };
  L = C.taskLayoutHide(L, 'list', true); L = C.taskLayoutHide(L, 'tl:c', true);
  V = C.taskLayoutView(L, ['a', 'b', 'c'], [], [], 'create');
  assert.deepEqual(plain(V.sections[0].cells), [[], ['title'], ['close']], 'create drops id; list hidden (an empty cell stays)');
  assert.deepEqual(plain(V.sections[1].cells[0]), ['format', 'links'], 'create drops autonomy and decision');
  assert.deepEqual(plain(V.sections[2].cells[0]), ['description', 'dates']);
  assert.deepEqual(plain(V.sections[3].cells[0]), ['tagsearch', 'tl:a', 'tl:b'], 'create drops sources');
  assert.deepEqual(plain(V.hidden).sort(), ['list', 'tl:c']);
  assert.deepEqual(plain(C.taskLayoutView(null, [], [], [], 'edit').sections[3].cells[0]), ['tagsearch', 'links', 'sources']);
});

// the round-1 default Header (2 columns: list, id, title | close), as a person's stored layout
const OLD = C.readTaskLayout({ v: 3, sections: [{ id: 'header', name: 'Header', cols: 2, cells: [['list', 'id', 'title'], ['close']] },
  ...C.TASK_LAYOUT_DEFAULTS.sections.slice(1)], off: [] });

test('task layout v3: moves within a cell, across cells and sections, and to a drop target', () => {
  const D = OLD, before = JSON.stringify(D);
  assert.deepEqual(plain(D.sections[0].widths), ['fill', 'fill'], 'a stored section without widths reads as fill');
  let L = C.taskLayoutMove(D, 'title', 'up');
  assert.deepEqual(cellsOf(L, 'header')[0], ['list', 'title', 'id']);
  L = C.taskLayoutMove(D, 'list', 'up');
  assert.deepEqual(plain(L), plain(D), 'the first section\'s top is an edge');
  L = C.taskLayoutMove(D, 'autonomy', 'up');
  assert.deepEqual(cellsOf(L, 'header')[0], ['list', 'id', 'title', 'autonomy'], 'up at the edge: end of the previous section\'s cell');
  L = C.taskLayoutMove(D, 'title', 'down');
  assert.deepEqual(cellsOf(L, 'top')[0], ['title', 'autonomy', 'decision', 'format'], 'down at the edge: start of the next section\'s cell');
  L = C.taskLayoutMove(D, 'id', 'right');
  assert.deepEqual(cellsOf(L, 'header'), [['list', 'title'], ['close', 'id']], 'right: the neighbouring cell at the same row');
  L = C.taskLayoutMove(D, 'close', 'right');
  assert.deepEqual(cellsOf(L, 'top')[0], ['close', 'autonomy', 'decision', 'format'], 'right at the edge: next section\'s first cell, start');
  L = C.taskLayoutMove(D, 'format', 'left');
  assert.deepEqual(cellsOf(L, 'header')[1], ['close', 'format'], 'left at the edge: previous section\'s last cell, end');
  L = C.taskLayoutMove(D, 'close', 'left');
  assert.deepEqual(cellsOf(L, 'header'), [['close', 'list', 'id', 'title'], []], 'left: same row (here the first)');
  L = C.taskLayoutMove(D, 'sources', null, { section: 'header', cell: 1, before: 'close' });
  assert.deepEqual(cellsOf(L, 'header')[1], ['sources', 'close']);
  assert.deepEqual(plain(C.taskLayoutMove(D, 'sources', null, { section: 'nope', cell: 0 })), plain(D));
  assert.deepEqual(plain(C.taskLayoutMove(D, 'sources', null, { section: 'top', cell: 3 })), plain(D));
  assert.equal(JSON.stringify(D), before, 'the input is not changed');
});

test('task layout v3: hide and show, sections added, renamed, columns set, reordered, removed only when empty', () => {
  const D = C.TASK_LAYOUT_DEFAULTS, before = JSON.stringify(D);
  ['title', 'close', 'decision', 'tl:*'].forEach(b => assert.deepEqual(plain(C.taskLayoutHide(D, b, true).off), [], b + ' is never hidden'));
  let L = C.taskLayoutHide(C.taskLayoutHide(D, 'id', true), 'id', true);
  assert.deepEqual(plain(L.off), ['id']);
  assert.deepEqual(plain(C.taskLayoutHide(L, 'id', false).off), []);
  L = C.taskLayoutAddSection(D, 'header');
  assert.deepEqual(ids(L), ['header', 's5', 'top', 'main', 'bottom']);
  assert.deepEqual(plain(L.sections[1]), { id: 's5', name: 'Section 5', cols: 1, widths: ['fill'], cells: [[]] });
  let M = L; for (let i = 0; i < 6; i++) M = C.taskLayoutAddSection(M);
  assert.equal(M.sections.length, 8); assert.equal(C.taskLayoutAddSection(M), M, 'at 8 sections the same layout comes back');
  assert.equal(new Set(ids(M)).size, 8);
  L = C.taskLayoutRename(L, 's5', ' Notes\n ');
  assert.equal(L.sections[1].name, 'Notes');
  assert.equal(C.taskLayoutRename(L, 's5', '   ').sections[1].name, 'Section 2');
  L = C.taskLayoutSetCols(L, 'top', 3);
  assert.deepEqual(cellsOf(L, 'top'), [['autonomy', 'decision', 'format'], [], []]);
  L = C.taskLayoutMove(L, 'format', null, { section: 'top', cell: 2, before: null });
  L = C.taskLayoutMove(L, 'decision', null, { section: 'top', cell: 1, before: null });
  L = C.taskLayoutSetCols(L, 'top', 1);
  assert.deepEqual(cellsOf(L, 'top'), [['autonomy', 'decision', 'format']], 'shrinking moves removed cells\' blocks into the new last cell');
  L = C.taskLayoutMoveSection(L, 'bottom', 'up');
  assert.deepEqual(ids(L), ['header', 's5', 'top', 'bottom', 'main']);
  assert.deepEqual(ids(C.taskLayoutMoveSection(L, 'header', 'up')), ids(L));
  assert.equal(C.taskLayoutRemoveSection(L, 'top'), L, 'a section with blocks stays');
  assert.deepEqual(ids(C.taskLayoutRemoveSection(L, 's5')), ['header', 'top', 'bottom', 'main']);
  assert.equal(JSON.stringify(D), before, 'the input is not changed');
  // a stored layout survives the reader
  assert.deepEqual(plain(C.readTaskLayout(JSON.parse(JSON.stringify(L)))), plain(L));
});

test('task layout v3: expand for the editor, store back with one tl:*; round trip through rowFromPrefs and prefsFromRow', () => {
  const tl = ['a', 'b', 'c'];
  let E = C.taskLayoutExpand(C.TASK_LAYOUT_DEFAULTS, tl, ['c'], []);
  assert.deepEqual(cellsOf(E, 'bottom')[0], ['tagsearch', 'tl:c', 'tl:a', 'tl:b', 'links', 'sources']);
  assert.deepEqual(plain(C.taskLayoutStore(E, tl, ['c'], [])), plain(C.TASK_LAYOUT_DEFAULTS), 'an unchanged run becomes tl:* again');
  E = C.taskLayoutMove(E, 'tl:b', null, { section: 'top', cell: 0, before: null });
  const S = C.taskLayoutStore(E, tl, ['c'], []);
  assert.deepEqual(cellsOf(S, 'top')[0], ['autonomy', 'decision', 'format', 'tl:b']);
  assert.deepEqual(cellsOf(S, 'bottom')[0], ['tagsearch', 'tl:*', 'links', 'sources']);
  const V = C.taskLayoutView(S, ['a', 'b', 'c', 'd'], ['c'], []);
  assert.deepEqual(plain(V.sections[3].cells[0]), ['tagsearch', 'tl:c', 'tl:a', 'tl:d', 'links', 'sources'], 'a new tag list joins tl:*');
  // without tag lists: tl:* after the last tag list block
  assert.deepEqual(cellsOf(C.taskLayoutStore(E), 'bottom')[0], ['tagsearch', 'tl:c', 'tl:a', 'tl:*', 'links', 'sources']);
  const prefs = C.prefsFromRow({ cardLayout: { zones: { task: S } }, tagListFavs: ['c'] }, { tagListIds: tl });
  const back = C.prefsFromRow(JSON.parse(JSON.stringify(C.rowFromPrefs('p1', prefs).prefs)), { tagListIds: tl });
  assert.deepEqual(plain(back.cardLayout.zones.task), plain(S));
  assert.deepEqual(plain(back.cardLayout.zones.board), plain(C.LAYOUT_DEFAULTS.board), 'the board zones are unchanged');
  // a tag list that is gone is dropped by the reader that knows the tag lists
  assert.deepEqual(cellsOf(C.prefsFromRow(back, { tagListIds: ['a'] }).cardLayout.zones.task, 'top')[0], ['autonomy', 'decision', 'format']);
});

test('task layout v3: column widths (fit / fill) are read, padded and trimmed to cols, set per column, kept by setCols', () => {
  const L = C.readTaskLayout({ v: 3, sections: [{ id: 'a', cols: 3, widths: ['fit', 'wide', 'fill', 'fit'], cells: [['title'], [], ['close']] },
    { id: 'b', cols: 2, widths: 'fit', cells: [[], []] }, { id: 'c', cols: 1, widths: ['fit'], cells: [[]] }] });
  assert.deepEqual(plain(L.sections.map(x => x.widths)), [['fit', 'fill', 'fill'], ['fill', 'fill'], ['fit']], 'unknown → fill, extra trimmed, missing padded');
  let M = C.taskLayoutSetWidth(L, 'a', 1, 'fit');
  assert.deepEqual(plain(M.sections[0].widths), ['fit', 'fit', 'fill']);
  assert.deepEqual(plain(C.taskLayoutSetWidth(L, 'a', 3, 'fit')), plain(L), 'a column that does not exist');
  assert.deepEqual(plain(C.taskLayoutSetWidth(L, 'a', 0, 'huge')), plain(L), 'an unknown width');
  M = C.taskLayoutSetCols(M, 'a', 2);
  assert.deepEqual(plain(M.sections[0].widths), ['fit', 'fit'], 'fewer columns drop the last widths');
  M = C.taskLayoutSetCols(M, 'c', 3);
  assert.deepEqual(plain(M.sections[2].widths), ['fit', 'fill', 'fill'], 'more columns are fill');
  assert.deepEqual(plain(C.readTaskLayout(JSON.parse(JSON.stringify(M)))), plain(M), 'widths survive the reader');
  assert.deepEqual(plain(C.taskLayoutView(M, [], [], [], 'edit').sections[0].widths), ['fit', 'fit'], 'the view carries the widths');
  assert.deepEqual(plain(C.TASK_WIDTHS), ['fit', 'fill']);
});

test('task layout v3 round 3: Find a tag is a block (default before the tag lists, added to old layouts there, hideable); close stays the Done block', () => {
  assert.ok(C.TASK_BLOCKS.includes('tagsearch') && C.TASK_BLOCKS.includes('close') && C.TASK_NEVER_HIDDEN.includes('close'));
  assert.deepEqual(plain(C.TASK_LAYOUT_DEFAULTS.sections[3].cells[0].slice(0, 2)), ['tagsearch', 'tl:*']);
  const old = C.readTaskLayout({ v: 3, sections: [{ id: 'a', cols: 2, cells: [['title', 'close'], ['tl:x', 'tl:*', 'links']] }] }, ['x']);
  assert.deepEqual(plain(old.sections[0].cells[1]).slice(0, 3), ['tl:x', 'tagsearch', 'tl:*'], 'a stored layout without it gets it right before tl:*');
  assert.deepEqual(plain(C.taskLayoutHide(C.TASK_LAYOUT_DEFAULTS, 'tagsearch', true).off), ['tagsearch']);
  const moved = C.taskLayoutMove(C.TASK_LAYOUT_DEFAULTS, 'tagsearch', null, { section: 'header', cell: 1, before: null });
  assert.deepEqual(plain(C.readTaskLayout(JSON.parse(JSON.stringify(moved))).sections[0].cells[1]), ['title', 'list', 'tagsearch'], 'placed by hand, it stays there');
});

test('list brief (T23): lines, a new Decisions line with day and who, the four texts from a row, the count', () => {
  assert.deepEqual([...C.briefLines(' a \n\n b ')], ['a', 'b']);
  assert.equal(C.briefLine('Keep 2\nbackups', '2026-11-11', 'Max'), '2026-11-11 · Max · Keep 2 backups');
  assert.equal(C.briefLine('  ', '2026-11-11', 'Max'), '');
  assert.equal(C.briefLine('x', '2026-11-11', 'A · B'), '2026-11-11 · A B · x', 'the separator never comes from a name');
  assert.deepEqual(plain(C.briefOf({ brief_naming: 'n', brief_concept: null })), { decisions: '', naming: 'n', instruction: '', concept: '' });
  assert.equal(C.briefCount({ decisions: 'a\nb', naming: 'n', instruction: '', concept: ' ' }), 3);
  assert.deepEqual(C.BRIEF_FIELDS.map(x => x.col), ['brief_naming', 'brief_instruction', 'brief_concept']);
});
