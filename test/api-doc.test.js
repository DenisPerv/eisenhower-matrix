// Round 4 wave B (D8): the API description cannot drift from the database. Every /rest/v1/rpc/<name> in docs/api/openapi.yaml
// exists in db/*.sql with `grant execute ... to authenticated`, and every path in it is in the docs/api/README.md table.
// No dependencies: the YAML is read line by line (paths are the two-space keys under `paths:`).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const yaml = fs.readFileSync(path.join(root, 'docs', 'api', 'openapi.yaml'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'docs', 'api', 'README.md'), 'utf8');
const sql = fs.readdirSync(path.join(root, 'db')).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort()
  .map(f => fs.readFileSync(path.join(root, 'db', f), 'utf8')).join('\n');

function docPaths(text) {
  const out = [];
  let inPaths = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
    if (inPaths && /^\S/.test(line)) break;
    const m = inPaths && line.match(/^ {2}(\/[^:\s]+):\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}
// function names granted to authenticated, statement by statement (comments stripped first)
function grantedToAuthenticated(text) {
  const names = new Set();
  const plain = text.replace(/--[^\n]*/g, '');
  for (const st of plain.split(';')) {
    if (!/^\s*grant\s+execute\s+on\s+function/i.test(st) || !/\bto\s+(?:[\w, ]*\b)?authenticated\b/i.test(st)) continue;
    for (const m of st.matchAll(/public\.(\w+)\s*\(/g)) names.add(m[1]);
  }
  return names;
}
const defined = name => new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, 'i').test(sql);

test('openapi.yaml lists the planned paths', () => {
  const p = docPaths(yaml);
  for (const want of ['/auth/v1/token', '/rest/v1/rpc/review_report', '/rest/v1/rpc/kpi_events', '/rest/v1/rpc/urgency_settings',
    '/rest/v1/rpc/list_people', '/rest/v1/rpc/my_invitations', '/rest/v1/lists', '/rest/v1/items']) assert.ok(p.includes(want), want);
  assert.match(yaml, /^openapi: 3\.1\.\d+$/m);
});

test('every RPC in openapi.yaml exists in db/*.sql and is granted to authenticated', () => {
  const rpcs = docPaths(yaml).filter(p => p.startsWith('/rest/v1/rpc/')).map(p => p.slice('/rest/v1/rpc/'.length));
  assert.ok(rpcs.length >= 5);
  const granted = grantedToAuthenticated(sql);
  for (const r of rpcs) {
    assert.ok(defined(r), `${r}: no create or replace function public.${r} in db/`);
    assert.ok(granted.has(r), `${r}: no grant execute ... to authenticated in db/`);
  }
});

test('every path in openapi.yaml is in the docs/api/README.md table', () => {
  const rows = new Set([...readme.matchAll(/^\| `([^`]+)` \|/gm)].map(m => m[1]));
  for (const p of docPaths(yaml)) assert.ok(rows.has(p), `${p} missing from the README table`);
});

test('review_report is security invoker with an empty search_path, not for anon (db/016)', () => {
  const body = fs.readFileSync(path.join(root, 'db', '016_review_report.sql'), 'utf8');
  assert.match(body, /function public\.review_report\(p_weeks text\[\], p_lists uuid\[\] default null, p_now timestamptz default null\)\s*returns jsonb language plpgsql stable security invoker set search_path = ''/);
  assert.match(body, /revoke all on function public\.review_report\(text\[\], uuid\[\], timestamptz\) from public, anon/);
});

test('the API docs hold placeholders only (no keys, tokens or project refs)', () => {
  for (const [name, text] of [['openapi.yaml', yaml], ['README.md', readme]]) {
    assert.doesNotMatch(text, /sb_(publishable|secret)_[A-Za-z0-9_-]{8,}/, name + ': a key');
    assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, name + ': a JWT');
    assert.doesNotMatch(text, /https:\/\/[a-z0-9]{20}\.supabase\.co/, name + ': a project ref');
  }
});
