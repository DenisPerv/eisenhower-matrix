// node --test test/  — the Edit task window adjustments (HomeOS edit-task-plan.md, 2026-10-29) in the page's <script id="core">:
// "Who it is for" is no Card layout switch and no fact (item 3), archived tag lists never reach Card layout or the window (item 4).
const test = require('node:test');
const assert = require('node:assert/strict');

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });

const lists = () => ({
  D: { id: 'D', owner_id: 'me', name: 'My tags', is_default: true, sort: 1, role: 'owner' },
  W: { id: 'W', owner_id: 'me', name: 'Work', sort: 3, role: 'owner' },
  X: { id: 'X', owner_id: 'me', name: 'e2e tags b', sort: 2, role: 'owner', archived_at: '2026-10-29T00:00:00Z' },
  A: { id: 'A', owner_id: 'ana', name: 'Assignee', sort: 1, role: 'viewer' },
  H: { id: 'H', owner_id: 'ana', name: 'Garden', sort: 2, role: 'editor', hidden: true },
  Y: { id: 'Y', owner_id: 'ana', name: 'Old', sort: 3, role: 'viewer', archived_at: '2026-10-01T00:00:00Z' },
});

test('item 3: owner is not a Card layout field, a stored owner: true is dropped, no For fact', () => {
  assert.ok(!C.CARD_FIELDS.includes('owner'));
  assert.equal('owner' in C.CARD_LAYOUT_DEFAULTS, false);
  const l = C.readCardLayout({ owner: true, created: true });
  assert.equal(l.owner, undefined, 'old prefs load without it');
  const t = { createdAt: new Date(1), createdBy: 'u1', ownerId: 'u2' };
  assert.deepEqual(C.cardFacts(t, Object.assign({}, l, { owner: true, creator: true })).map(f => f.k), ['created', 'creator']);
});

test('item 4: Card layout offers live, shown tag lists only, mine first then by sort', () => {
  assert.deepEqual(C.cardLayoutTagLists(lists(), 'me').map(l => l.id), ['D', 'W', 'A']);
  assert.deepEqual(C.cardLayoutTagLists(null, 'me'), []);
});

test('tags round (6): two lists named "My tags" are two choices; unticking mine hides only its tags on cards and previews', () => {
  const L = Object.assign(lists(), { A2: { id: 'A2', owner_id: 'ana', name: 'My tags', sort: 0, role: 'viewer' } });
  const offered = C.cardLayoutTagLists(L, 'me');
  assert.deepEqual(offered.filter(l => l.name === 'My tags').map(l => [l.id, l.owner_id]), [['D', 'me'], ['A2', 'ana']], 'both offered, mine first');
  const of = { m1: 'D', m2: 'D', a1: 'A2', w1: 'W', s1: 'A' };
  const ids = ['m1', 'a1', 'w1', 'm2', 's1'];
  assert.deepEqual(C.cardTagIds(ids, C.readCardLayout({ tags: 'lists', tagLists: ['A2', 'W', 'A'] }, ['D', 'W', 'A', 'A2']), of), ['a1', 'w1', 's1'], 'my My tags unticked: none of its tags');
  assert.deepEqual(C.cardTagIds(ids, C.readCardLayout({ tags: 'lists', tagLists: ['D'] }, ['D', 'W', 'A', 'A2']), of), ['m1', 'm2'], "only mine ticked: Anastasiia's My tags stays out");
  assert.deepEqual(C.cardTagIds(ids, C.readCardLayout({ tags: 'lists', tagLists: [] }), of), []);
});

test('item 4: the task window (tagGroups without archived) never lists an archived tag list', () => {
  const ids = C.tagGroups(lists(), {}, 'me', { me: 'Maksym', ana: 'Anastasiia' }, {}).map(g => g.list.id);
  assert.ok(!ids.includes('X') && !ids.includes('Y'));
  assert.ok(ids.includes('D') && ids.includes('A'));
});

// quadrant buttons (2026-11-07, Anastasiia): a pick in the window is written as a drag writes it (moveTask), and only when it differs
test('quadPick: the shown quadrant again -> nothing; another one -> stored quadrant, pin only when the urgency side changes', () => {
  assert.equal(C.quadPick('A', 'A'), null, 'same quadrant: a quadrant changed elsewhere meanwhile is kept');
  assert.equal(C.quadPick('B', 'x'), null, 'not a quadrant');
  assert.deepEqual(C.quadPick('A', 'B'), { qStored: 'B', pin: false }, 'urgent to not urgent');
  assert.deepEqual(C.quadPick('B', 'C'), { qStored: 'C', pin: true });
  assert.deepEqual(C.quadPick('A', 'C'), { qStored: 'C' }, 'both urgent: the pin stays');
  assert.deepEqual(C.quadPick('B', 'D'), { qStored: 'D' }, 'both not urgent: the pin stays');
  // the derived quadrant of a task the drag rule would write the same way
  for (const from of C.QS) for (const to of C.QS) {
    const p = C.quadPick(from, to); if (!p) continue;
    const t = { qStored: p.qStored, category: 'task', pin: p.pin, deadline: null };
    assert.equal(C.deriveQuadrant(t, null, 0), to);
  }
});

test('the task window: four quadrant buttons under the title, wired on Save through C.quadPick, in the one versioned write', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'TasksDashboard.html'), 'utf8');
  assert.match(html, /class="fquad" role="group" aria-label="Quadrant"/);
  assert.match(html, /const qp = t \? C\.quadPick\(shownQ, pickQ\) : null;/);
  assert.match(html, /if \(qp\) Object\.assign\(x, qp\);/);
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'index.html'), 'utf8');
  assert.match(app, /id="t-quad" role="group" aria-label="Quadrant"/);
  assert.match(app, /if \(st\.q !== st\.q0\) f\.q = st\.q;/);
});

test('the done checkbox: at the right end of the title row, hidden on decision cards, awaiting checks, waiting, closed, read-only and new tasks; one write', () => {
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'TasksDashboard.html'), 'utf8');
  assert.match(html, /const doneOn = !!t && editable && !o\.preview && !C\.decisionOf\(t\) && t\.status !== 'waiting' && !C\.awaitingCheck\(t\) && !C\.CLOSED\.includes\(t\.status\);/);
  // at the right end of the title row, after the title field (2026-11-07, after Anastasiia's local test)
  assert.match(html, /<div class="ftrow"><div class="rt one" id="ft"[^\n]*'<\/div>' \+ doneHtml \+ '<\/div><div class="err" id="fe"/);
  assert.match(html, /if \(doneTick\) x\.status = 'done';/, 'status done in the window\'s one versioned write');
  assert.match(html, /doneTick = true; after = nav\.next \? 'next' : null; fs\.click\(\);/, 'then the next task, else the window closes');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  assert.match(app, /const doneOn = !ro && !closed && !dec && t\.status !== 'waiting' && !C\.awaitingCheck\(t\);/);
  // the phone sheet draws it as the Close block of the task layout (cardLayout.zones.task)
  assert.match(app, /close: doneOn \? '<label class="fclose"><input type="checkbox" class="tdone" id="t-done"/);
  assert.match(app, /ids = navIds\(task\(st\.id\)\)/, 'the next task is read before the save');
});
