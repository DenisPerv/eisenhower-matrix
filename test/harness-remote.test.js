// harness/harness-remote.js, the web transport of the Eisenhower Harness page (db/031): the merge of the parts a reader selected, the
// session-to-list index from list parts, the per-scope limits commands and the greyed-control verdicts (decisions 2 and 5). No network.
// HomeOS keeps merge equal to its lib/run-snapshot.js (HomeOS-TasksBoardHarness/test/copies.test.js). Run: node --test "test/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const R = require(path.join(__dirname, '..', 'harness', 'harness-remote.js'));

const L1 = '11111111-1111-4111-8111-111111111111', L2 = '22222222-2222-4222-8222-222222222222';
const parts = {
  household: { sessions: [{ _i: 0, e: { name: 'master', role: 'master' } }], tasks: [], wakes: null, decisions: ['10:00 x'], board: { items: [{ _i: 1, e: { ref: 'h#1' } }], lists: [] }, mother_decisions: { m0: ['a'] } },
  ['list:' + L1]: { sessions: [{ _i: 1, e: { name: 'do-a-1', list: 'a' } }], board_items: [{ _i: 0, e: { ref: 'a#1' } }], mother_decisions: { 'mother-a': ['b'] } },
  ['list:' + L2]: { sessions: [{ _i: 2, e: { name: 'do-b-1', list: 'b' } }] },
};

test('merge: arrays come back in their original order, a null list array stays null, mother decisions join', () => {
  const m = R.merge(parts);
  assert.deepEqual(m.sessions.map((s) => s.name), ['master', 'do-a-1', 'do-b-1']);
  assert.equal(m.wakes, null);
  assert.deepEqual(m.board.items.map((i) => i.ref), ['a#1', 'h#1']);
  assert.deepEqual(Object.keys(m.mother_decisions).sort(), ['m0', 'mother-a']);
});

test('merge: a guest without the household part gets typed empties and only their list', () => {
  const m = R.merge({ ['list:' + L1]: parts['list:' + L1] });
  assert.deepEqual(m.sessions.map((s) => s.name), ['do-a-1']);
  assert.deepEqual(m.decisions, []);
  assert.deepEqual(m.day.done, []);
  assert.equal(m.board.items.length, 1);
});

test('mergeFeed and sessionLists', () => {
  const f = R.mergeFeed('do-a-1', [{ k: 1, entries: [{ i: 60 }], last_index: 60, dropped: 1 }, { k: 0, entries: [{ i: 1 }] }]);
  assert.deepEqual(f.entries.map((e) => e.i), [1, 60]);
  assert.equal(f.last_index, 60);
  assert.equal(f.dropped, 1);
  assert.deepEqual(R.sessionLists([{ part: 'household', body: parts.household }, { part: 'list:' + L1, body: parts['list:' + L1] }]), { 'do-a-1': L1 });
});

test('limitScopes: one command per changed scope, each with its base hash and list id', () => {
  const view = { defaults: { max_sessions: 2, max_agents_per_session: 2 }, base_hash: { defaults: 'd0', 'list:a': 'a0', 'list:b': 'b0' },
    rows: [{ slug: 'a', list_id: L1, source: 'list', enabled: true, max_sessions: 1, max_agents_per_session: 0 }, { slug: 'b', list_id: L2, source: 'defaults', enabled: true, max_sessions: 2, max_agents_per_session: 2 }] };
  assert.deepEqual(R.limitScopes(view, { defaults: view.defaults, lists: { a: { enabled: true, max_sessions: 1, max_agents_per_session: 0 } } }), []);
  const s = R.limitScopes(view, { defaults: { max_sessions: 3, max_agents_per_session: 2 }, lists: { b: { enabled: false, max_sessions: 1, max_agents_per_session: 0 } } });
  assert.deepEqual(s.map((x) => [x.scope, x.scope_list, x.base_hash]), [['defaults', null, 'd0'], ['list:a', L1, 'a0'], ['list:b', L2, 'b0']]);
  assert.deepEqual(s[1].payload, { slug: 'a', row: null }, 'a list row left out of the form is removed');
  assert.deepEqual(s[2].payload.row, { enabled: false, max_sessions: 1, max_agents_per_session: 0 });
});

test('verdict: Continue in Claude and Copy always greyed; silent, controls off, owners of the list, the PC owner for the master and defaults', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const dev = { label: 'Laptop', owner_id: 'me', beat_at: new Date(now - 30000).toISOString(), state: 'running', controls: true };
  const ctx = { device: dev, me: 'me', roles: { [L1]: 'owner', [L2]: 'editor' }, sessionList: { 'do-a-1': L1, 'do-b-1': L2 }, limits: { rows: [{ slug: 'a', list_id: L1 }, { slug: 'b', list_id: L2 }] }, now };
  assert.match(R.verdict(ctx, 'claude', { name: 'do-a-1' }), /Claude app on Laptop/);
  assert.match(R.verdict(ctx, 'copy', { name: 'do-a-1' }), /Laptop/);
  assert.equal(R.verdict(ctx, 'stop', { name: 'do-a-1', list: 'a' }), null);
  assert.match(R.verdict(ctx, 'stop', { name: 'do-b-1', list: 'b' }), /only the owners of b/);
  assert.equal(R.verdict(ctx, 'continue', { name: 'master', role: 'master' }), null);
  assert.match(R.verdict({ ...ctx, me: 'other' }, 'continue', { name: 'master', role: 'master' }), /owner of Laptop/);
  assert.match(R.verdict({ ...ctx, device: { ...dev, beat_at: new Date(now - 4 * 60000).toISOString() } }, 'stop', { name: 'do-a-1' }), /Laptop is silent/);
  assert.match(R.verdict({ ...ctx, device: { ...dev, state: 'offline' } }, 'stop', { name: 'do-a-1' }), /silent/);
  assert.match(R.verdict({ ...ctx, device: { ...dev, controls: false } }, 'stop', { name: 'do-a-1' }), /remote control is off on Laptop/);
  assert.equal(R.verdict(ctx, 'limits', null, { scope: 'list:a' }), null);
  assert.match(R.verdict(ctx, 'limits', null, { scope: 'list:b' }), /owners of this list/);
  assert.equal(R.verdict(ctx, 'limits', null, { scope: 'defaults' }), null);
  assert.match(R.verdict({ ...ctx, me: 'x', roles: {} }, 'limits', null, { scope: 'any' }), /owners of a list/);
  assert.match(R.verdict({ ...ctx, device: null }, 'stop', { name: 'do-a-1' }), /no PC/);
});
