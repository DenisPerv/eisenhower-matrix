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
  assert.deepEqual(plain(C.layoutZones(L, 'task')), { top: ['autonomy', 'decision', 'format'], main: ['description', 'dates', 'tags'], bottom: ['links', 'sources'], off: [] });
});

test('zones: stored zones are checked; unknown blocks, duplicates and unknown tag lists are dropped; decision is never hidden', () => {
  const raw = { zones: { board: { top: ['description', 'x', 'tl:gone'], main: ['facts', 'facts', 'tl:a'], bottom: ['tl:*'], off: ['facts', 'nope'] },
    task: { top: ['links'], main: ['decision'], bottom: [], off: ['decision', 'links'] } } };
  const L = C.readCardLayout(raw, ['a', 'b']);
  assert.deepEqual(plain(L.zones.board), { top: ['description'], main: ['facts', 'tl:a'], bottom: ['tl:*'], off: ['facts'] });
  assert.deepEqual(plain(L.zones.task.off), ['links']);
  // drawn: tl:b (new) goes where tl:* stands; missing task blocks go to the end of their default zone
  assert.deepEqual(plain(C.layoutZones(L, 'board', ['a', 'b'])), { top: ['description'], main: ['facts', 'tl:a'], bottom: ['tl:b'], off: ['facts'] });
  const T = C.layoutZones(L, 'task');
  assert.deepEqual(plain(T.top), ['links', 'autonomy', 'format']);
  assert.deepEqual(plain(T.main), ['decision', 'description', 'dates', 'tags']);
  assert.deepEqual(plain(T.bottom), ['sources']);
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

test('list brief (T23): lines, a new Decisions line with day and who, the four texts from a row, the count', () => {
  assert.deepEqual([...C.briefLines(' a \n\n b ')], ['a', 'b']);
  assert.equal(C.briefLine('Keep 2\nbackups', '2026-11-11', 'Max'), '2026-11-11 · Max · Keep 2 backups');
  assert.equal(C.briefLine('  ', '2026-11-11', 'Max'), '');
  assert.equal(C.briefLine('x', '2026-11-11', 'A · B'), '2026-11-11 · A B · x', 'the separator never comes from a name');
  assert.deepEqual(plain(C.briefOf({ brief_naming: 'n', brief_concept: null })), { decisions: '', naming: 'n', instruction: '', concept: '' });
  assert.equal(C.briefCount({ decisions: 'a\nb', naming: 'n', instruction: '', concept: ' ' }), 3);
  assert.deepEqual(C.BRIEF_FIELDS.map(x => x.col), ['brief_naming', 'brief_instruction', 'brief_concept']);
});
