// node --test test/  — the Telegram card's copy of the quadrant rule (telegram-integration/tasksboard_telegram/quadrant.py)
// against the page: deriveQuadrant on the cases both read (telegram-integration/tests/quadrant_cases.json), and the
// quadrant names QN. CLAUDE.md "The task card has a twin in Telegram". No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, 'telegram-integration', 'tests', 'quadrant_cases.json'), 'utf8'));
let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });

test('telegram-integration: deriveQuadrant gives the shared answers', () => {
  const now = Date.UTC(2026, 9, 29, 10, 0);
  for (const c of CASES.cases) {
    const t = { qStored: c.stored, priority: c.priority === null ? undefined : c.priority, category: c.category, pin: c.pin,
                deadline: c.deadline_h === null ? null : new Date(now + c.deadline_h * 3600e3) };
    assert.equal(C.deriveQuadrant(t, { windowDays: c.window }, now), c.expect, JSON.stringify(c));
  }
});

test('telegram-integration: quadrant names match the page', () => {
  const html = fs.readFileSync(path.join(ROOT, 'TasksDashboard.html'), 'utf8');
  const m = html.match(/const QN = (\{[^}]*\});/);
  assert.ok(m, 'QN not found in TasksDashboard.html');
  const qn = Function('return ' + m[1])();
  assert.deepEqual(qn, CASES.names);
});
