// node --test test/  — the phone app's copy of the rules (app/td-core.js) is the page's <script id="core"> block, byte for byte
// after its header line (cli/sync-app-core.mjs). No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('app/td-core.js equals the core block of TasksDashboard.html', async () => {
  const { coreFile, PAGE, OUT } = await import('../cli/sync-app-core.mjs');
  const want = coreFile(fs.readFileSync(PAGE, 'utf8'));
  let have = '';
  try { have = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'); } catch (e) {}
  assert.ok(have === want, 'app/td-core.js is out of date or missing: run node cli/sync-app-core.mjs and commit app/td-core.js');
});

test('app/td-core.js loads as the same rule set (CommonJS here, window.TDCore in the page)', () => {
  const C = require(path.join(__dirname, '..', 'app', 'td-core.js'));
  for (const f of ['rowToTask', 'taskToPatch', 'mergePoll', 'restError', 'authorizeUrl', 'deriveQuadrant', 'prefsFromRow']) assert.equal(typeof C[f], 'function', f);
});
