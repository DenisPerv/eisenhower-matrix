// node --test test/  — the decision block of self-improvement cards (items.details.decision): core rules, no network, no DOM.
const test = require('node:test');
const assert = require('node:assert/strict');

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });
const NOW = '2026-11-03T12:00:00.000Z';
const DEC = { v: 1, label_1: 'Yes', label_0: 'No', answer: null, module: 'm2', problem_key: 'm2:evals-missing-x', action: { kind: 'add-evals', skill: 'x' },
  run_id: '2026-11-03--10-00', answered_by: null, answered_at: null, applied_at: null, applied_result: null };
const row = (o = {}) => Object.assign({ id: 'i1', list_id: 'L1', num: 3, quadrant: 'C', title: 'Add evals.md to skill x?', body_md: '', status: 'open',
  sort_key: 1024, category: 'task', version: 2, deleted_at: null, updated_at: '2026-11-03T10:00:00Z', details: { decision: DEC, notify: ['maksym'] } }, o);

test('rowToTask keeps details as a deep copy; a missing or odd value becomes {}', () => {
  const r = row();
  const t = C.rowToTask(r);
  assert.deepEqual(t.details, r.details);
  t.details.decision.answer = 1;
  assert.equal(r.details.decision.answer, null, 'the row is not touched');
  assert.deepEqual(C.rowToTask(row({ details: null })).details, {});
  assert.deepEqual(C.rowToTask(row({ details: [1, 2] })).details, {});
  assert.deepEqual(C.rowToTask(row({ details: undefined })).details, {});
});

test('taskToPatch sends details whole (every key) and never null', () => {
  assert.equal(C.FIELD_COLUMNS.details, 'details');
  const t = C.rowToTask(row());
  const p = C.taskToPatch(t, ['details', 'status']);
  assert.deepEqual(p, { details: { decision: DEC, notify: ['maksym'] }, status: 'open' });
  assert.deepEqual(C.taskToPatch({ details: null }, ['details']), { details: {} });
  // the inverse of an edit (undo) sends the earlier details back
  assert.deepEqual(C.inverseOf('edit', { details: { a: 1 } }, ['details']), { details: { a: 1 } });
});

test('decisionOf: null unless details.decision has both labels', () => {
  assert.equal(C.decisionOf(null), null);
  assert.equal(C.decisionOf({ details: {} }), null);
  assert.equal(C.decisionOf({}), null);
  assert.equal(C.decisionOf({ details: { decision: { label_1: 'Yes' } } }), null);
  assert.equal(C.decisionOf({ details: { decision: { label_1: 'Yes', label_0: '  ' } } }), null);
  assert.equal(C.decisionOf({ details: { decision: 'yes' } }), null);
  const d = C.decisionOf(C.rowToTask(row()));
  assert.deepEqual(d, { label_1: 'Yes', label_0: 'No', answer: null, answered_by: null, answered_at: null, applied_at: null, applied_result: null });
  assert.equal(C.decisionOf({ details: { decision: { label_1: ' Do it ', label_0: 'Skip', answer: 0 } } }).label_1, 'Do it');
  assert.equal(C.decisionOf({ details: { decision: { label_1: 'a', label_0: 'b', answer: '1' } } }).answer, null, 'only the numbers 1 and 0 count');
});

test('answerDecision: answer, who, when and status done; every other key kept; the task itself untouched', () => {
  const t = C.rowToTask(row());
  const ch = C.answerDecision(t, 1, 'maksym', NOW);
  assert.equal(ch.status, 'done');
  assert.deepEqual(ch.details.notify, ['maksym']);
  assert.deepEqual(ch.details.decision, Object.assign({}, DEC, { answer: 1, answered_by: 'maksym', answered_at: NOW }));
  assert.equal(t.details.decision.answer, null, 'pure: the task is changed by the caller (edit), not here');
  assert.equal(C.answerDecision(t, 0, 'anastasiia', NOW).details.decision.answer, 0);
  // a second answer before the routine applied it replaces the first
  const t2 = Object.assign({}, t, ch);
  assert.equal(C.answerDecision(t2, 0, 'maksym', NOW).details.decision.answer, 0);
});

test('answerDecision refuses: no decision, a bad value, already applied', () => {
  const t = C.rowToTask(row());
  assert.equal(C.answerDecision({ details: {} }, 1, 'maksym', NOW), null);
  assert.equal(C.answerDecision(t, 2, 'maksym', NOW), null);
  assert.equal(C.answerDecision(t, '1', 'maksym', NOW), null);
  const applied = C.rowToTask(row({ details: { decision: Object.assign({}, DEC, { answer: 1, applied_at: NOW, applied_result: 'done' }) } }));
  assert.equal(C.answerDecision(applied, 0, 'maksym', NOW), null);
});

test('mergeDetails: per key, one level into decision; clash only where both changed a key differently', () => {
  const base = { decision: DEC, notify: ['maksym'] };
  const mine = { decision: Object.assign({}, DEC, { answer: 1, answered_by: 'maksym', answered_at: NOW }), notify: ['maksym'] };
  // the routine added a key meanwhile: both kept, no clash
  let m = C.mergeDetails(base, mine, Object.assign({}, base, { seen: true }));
  assert.deepEqual(m.clash, []);
  assert.deepEqual(m.value, Object.assign({}, mine, { seen: true }));
  // the routine changed another field of decision (run_id): merged inside decision
  m = C.mergeDetails(base, mine, { decision: Object.assign({}, DEC, { run_id: 'r2' }), notify: ['maksym'] });
  assert.deepEqual(m.clash, []);
  assert.equal(m.value.decision.run_id, 'r2');
  assert.equal(m.value.decision.answer, 1);
  // both answered differently: a clash, theirs kept
  m = C.mergeDetails(base, mine, { decision: Object.assign({}, DEC, { answer: 0, answered_by: 'anastasiia', answered_at: NOW }), notify: ['maksym'] });
  assert.deepEqual(m.clash, ['decision.answer', 'decision.answered_by']);
  assert.equal(m.value.decision.answer, 0);
  // the same change on both sides is no clash; a key they removed stays removed
  m = C.mergeDetails(base, mine, { decision: mine.decision });
  assert.deepEqual(m.clash, []);
  assert.equal('notify' in m.value, false);
  // odd inputs count as {}
  assert.deepEqual(C.mergeDetails(null, { a: 1 }, undefined), { value: { a: 1 }, clash: [] });
});
