// harness configurations (HomeOS plan T14-T16, db/032): Autonomy inheritance and choices, the Delegate card read by the Decision
// section, and the answer it writes (V2b: the stored body keeps ## Your answer, read back by the same rule as gate.js sectionText). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from '../cli/lib.mjs';

const C = loadCore();

// the text HomeOS claim.js cardText writes for two questions (copied from its output, 2026-11-11)
const CARD = ['Original task text', '', '---', '', '## Delegate · 2026-11-11 10:00', 'Session: **do-142 · abc**', '', '### Questions',
  '**1. Keep how many remote backups?**', 'A) 2', 'B) 4', 'C) 8', 'Recommended: A) 2', '', '**2. Delete local exports older than 30 days?**', 'A) Yes', 'B) No', '',
  'Class: E3 · data organisation and structure', '', '### Facts', '- Backups run every 6 h', '- 2 kept today', '', '### On each answer', '- A) nothing changes',
  '- B) the job keeps 4', '', 'If no answer: nothing changes, the card stays open', '', 'Comes back to: plan', '', '---', '', '## Your answer', C.ANSWER_PROMPT].join('\n');

test('autonomy: a list is never inherit, a task inherits its parent chain first, then its list', () => {
  assert.equal(C.listModeOf({}), 'guided');
  assert.equal(C.listModeOf({ autonomy: 'inherit' }), 'guided');
  assert.equal(C.itemModeOf({ autonomy: 'manual' }), 'manual');
  const list = { autonomy: 'ai_brain' };
  const a = { id: 'a', autonomy: 'manual' }, b = { id: 'b', autonomy: 'inherit' }, c = { id: 'c', autonomy: 'inherit' };
  const ctx = { list, byId: { a, b, c }, parentOf: { c: 'b', b: 'a' } };
  assert.deepEqual(C.autonomyOf(c, ctx).mode, 'manual');
  assert.equal(C.autonomyOf(c, ctx).from, 'parent');
  assert.equal(C.autonomyOf(c, ctx).parent, a);
  assert.equal(C.autonomyOf(a, ctx).from, 'here');
  assert.deepEqual(C.autonomyOf(c, { list, byId: {}, parentOf: {} }), { mode: 'ai_brain', from: 'list', parent: null });
  // a cycle never loops
  assert.equal(C.autonomyOf(b, { list, byId: { a: { id: 'a', autonomy: 'inherit' }, b }, parentOf: { b: 'a', a: 'b' } }).from, 'list');
});

test('autonomy: three modes to pick (Project rules, Mixed, AI Brain), guests Mixed only; Manual shown off when current; warnings', () => {
  const g = C.autonomyChoices(false, true);
  assert.deepEqual(g.map(x => x.mode), ['inherit', 'project_rules', 'guided', 'ai_brain']);
  assert.deepEqual(g.filter(x => x.off).map(x => x.mode), ['project_rules', 'ai_brain']);
  assert.equal(C.AUTONOMY_NAME.guided, 'Mixed');
  const old = C.autonomyChoices(true, false, 'manual');
  assert.deepEqual(old.map(x => x.mode), ['project_rules', 'guided', 'ai_brain', 'manual']);
  assert.deepEqual(old.filter(x => x.off).map(x => [x.mode, !!x.legacy]), [['manual', true]]);
  assert.equal(C.autonomyChoices(true, false, 'guided').length, 3);
  assert.equal(g.find(x => x.mode === 'ai_brain').why, C.AUTONOMY_HOUSEHOLD);
  assert.equal(C.autonomyChoices(true, false).some(x => x.off || x.mode === 'inherit'), false);
  // 2026-11-11: no list ceiling; a neutral hint only when the task runs as another mode than its list
  assert.equal(C.autonomyWarning, undefined, 'the ceiling warning is gone');
  assert.equal(C.autonomyHint('ai_brain', { mode: 'guided', from: 'list' }, 'guided'), 'Runs as AI Brain; its list is Mixed.');
  assert.equal(C.autonomyHint('inherit', { mode: 'project_rules', from: 'parent' }, 'ai_brain'), 'Runs as Project rules; its list is AI Brain.');
  assert.equal(C.autonomyHint('guided', { mode: 'guided', from: 'list' }, 'guided'), '', 'same as the list: no hint');
  assert.equal(C.autonomyHint('inherit', { mode: 'guided', from: 'list' }, 'guided'), '');
  assert.equal(C.autonomyHint('inherit', null, 'manual'), '');
  assert.doesNotMatch(C.autonomyHint('ai_brain', null, 'guided'), /only if|wider|owner/);
});

test('rowToTask reads autonomy read only; taskToPatch never writes it', () => {
  const t = C.rowToTask({ id: 'x', list_id: 'l', title: 't', autonomy: 'manual', autonomy_set_by: 'p', autonomy_set_at: '2026-11-11T10:00:00Z' });
  assert.equal(t.autonomy, 'manual'); assert.equal(t.autonomySetBy, 'p'); assert.ok(t.autonomySetAt instanceof Date);
  assert.equal(C.rowToTask({ id: 'y', list_id: 'l', title: 't' }).autonomy, 'inherit');
  assert.equal('autonomy' in C.taskToPatch(t), false);
});

test('delegateCard: questions, options, recommended, class, facts, what happens, if no answer', () => {
  const d = C.delegateCard(CARD);
  assert.equal(d.date, '2026-11-11 10:00');
  assert.equal(d.session, 'do-142 · abc');
  assert.deepEqual(d.questions.map(q => q.q), ['Keep how many remote backups?', 'Delete local exports older than 30 days?']);
  assert.deepEqual(d.questions[0].options, ['A) 2', 'B) 4', 'C) 8']);
  assert.equal(d.questions[0].recIndex, 0);
  assert.equal(d.questions[1].recIndex, -1);
  assert.equal(d.cls, 'E3'); assert.equal(d.clsWord, 'data organisation and structure');
  assert.deepEqual(d.facts, ['Backups run every 6 h', '2 kept today']);
  assert.deepEqual(d.onAnswer, ['A) nothing changes', 'B) the job keeps 4']);
  assert.equal(d.ifNoAnswer, 'nothing changes, the card stays open');
  assert.equal(C.delegateCard('no card here'), null);
  // one question keeps its "Question:" line
  const one = C.delegateCard('## Delegate · 2026-11-10\nSession: **s**\n\nQuestion: **Run backup now?**\nA) Yes\nB) No\n\n---\n\n## Your answer\n');
  assert.deepEqual(one.questions.map(q => [q.q, q.options]), [['Run backup now?', ['A) Yes', 'B) No']]]);
});

test('V2b: the Decision answer goes under ## Your answer, every other byte kept, read back as written', () => {
  const d = C.delegateCard(CARD);
  const ans = C.decisionAnswerText(d.questions, ['B) 4', 'my  own\nanswer']);
  assert.equal(ans, '1. B) 4\n2. my own answer');
  const out = C.setAnswer(CARD, ans);
  assert.ok(out.startsWith(CARD.slice(0, CARD.indexOf('## Your answer'))), 'everything above the answer section is unchanged');
  assert.ok(out.includes('\n## Your answer\n' + C.ANSWER_PROMPT + '\n1. B) 4\n2. my own answer'));
  assert.equal(C.answerSection(out).text, ans);
  assert.equal(C.decisionAnswerText(d.questions, [], { reason: '' }), 'Declined');
  assert.equal(C.answerSection(C.setAnswer(CARD, C.decisionAnswerText(d.questions, [], { reason: ' not  now ' }))).text, 'Declined: not now');
  assert.equal(C.decisionAnswerText([{ q: 'x' }], ['A) Yes']), 'A) Yes');
});

test('answerRounds: earlier answers newest first', () => {
  const md = 'Task\n\n## Answer (read 2026-11-08)\nYes\n\n## Answer (read 2026-11-09)\n\nTelegram\nmore';
  assert.deepEqual(C.answerRounds(md), [{ date: '2026-11-09', text: 'Telegram' }, { date: '2026-11-08', text: 'Yes' }]);
});

test('doneBlock: the Done control is off with a reason on decision cards, checks, waiting, closed, read-only and new tasks', () => {
  const t = { id: 'a', status: 'open', details: {}, ai: {} };
  assert.equal(C.doneBlock(t, { editable: true }), '');
  assert.match(C.doneBlock(null), /new task/);
  assert.match(C.doneBlock(t, { editable: false }), /cannot change/);
  assert.match(C.doneBlock({ ...t, status: 'done' }, {}), /Already done/);
  assert.match(C.doneBlock({ ...t, status: 'cancelled' }, {}), /Cancelled/);
  assert.match(C.doneBlock({ ...t, status: 'waiting' }, {}), /Waiting|check/);
});

// a Delegate or check card the harness answered, applied and returned to the board: its answer buttons are off (applied_at), so the
// only way to close it is the Done control. Before 2026-11-14 doneBlock still called it a decision card and the card could never be
// closed from the board or the phone (homeos-self-improvements#28)
test('doneBlock: an applied decision card no longer blocks Done; an unanswered or unapplied one still does', () => {
  const dec = (d) => ({ id: 'a', status: 'open', details: { decision: { v: 1, label_1: 'Accept', label_0: 'Decline', ...d } }, ai: {} });
  assert.match(C.doneBlock(dec({}), { editable: true }), /decision card/, 'unanswered: the answer closes it');
  assert.match(C.doneBlock(dec({ answer: 1, answered_by: 'maksym' }), { editable: true }), /decision card/, 'answered, not applied: still answerable');
  assert.equal(C.doneBlock(dec({ answer: 1, applied_at: '2026-11-08T12:22:57.291Z', applied_result: 'returned to Plan' }), { editable: true }), '',
    'applied: the buttons are off, so Done must be on');
});

test('Project rules follows the project folder; the folder field checks an absolute path (db/034)', () => {
  assert.equal(C.AUTONOMY_INFO.project_rules.does, "Agents follow this project's own CLAUDE.md, rules, permissions and hooks.");
  assert.equal(C.AUTONOMY_INFO.project_rules.you, 'Where they say nothing, it comes to you.');
  assert.equal(C.PROJECT_DIR_HINT, 'Empty = HomeOS. Without CLAUDE.md, rules or hooks there, Project rules acts as Mixed.');
  assert.deepEqual(C.projectDirCheck('  '), { dir: '', error: '' });
  assert.deepEqual(C.projectDirCheck(' D:\\Claude\\Personal\\EventBoard '), { dir: 'D:\\Claude\\Personal\\EventBoard', error: '' });
  assert.equal(C.projectDirCheck('D:/Claude/x').error, '');
  assert.equal(C.projectDirCheck('/home/me/app').error, '');
  assert.match(C.projectDirCheck('Claude\\x').error, /absolute path/);
  assert.match(C.projectDirCheck('D:\\a\\..\\b').error, /No \.\./);
  assert.match(C.projectDirCheck('D:/' + 'a'.repeat(C.PROJECT_DIR_MAX)).error, /At most 260/);
  assert.match(C.projectDirCheck('D:/a\tb').error, /control/);
  assert.equal(C.projectDirCheck('D:/a..b').error, '', 'two dots inside a name are fine');
});
