// node --test test/  — the CLI without network: arguments, keys, dates, output lines, env checks, exit codes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let T, L;
test.before(async () => { T = await import('../cli/tasks.mjs'); L = await import('../cli/lib.mjs'); });
const CLI = path.join(__dirname, '..', 'cli', 'tasks.mjs');
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TASKSDB_')));
const runCli = (args, env) => spawnSync(process.execPath, [CLI, ...args], { env: env || cleanEnv(), encoding: 'utf8' });

test('parseArgs: values, flags, inline values', () => {
  const a = T.parseArgs(['add-task', '--title', 'Buy milk', '--json', '--q=A', '--tags', 'a, b']);
  assert.deepEqual(a, { _: ['add-task'], title: 'Buy milk', json: true, q: 'A', tags: 'a, b' });
  assert.throws(() => T.parseArgs(['--title']), /needs a value/);
  assert.deepEqual(T.tagsOf('a, b,,a'), ['a', 'b']);
});

test('dedup keys: task hash of title + due day + list; reminder by creation minute (Europe/Lisbon)', () => {
  const k = T.taskKey('Buy Milk', new Date('2026-11-02T09:00:00Z'), 'othertasks');
  assert.match(k, /^task:[0-9a-f]{12}$/);
  assert.equal(k, T.taskKey('buy milk', new Date('2026-11-02T20:00:00Z'), 'othertasks'));
  assert.notEqual(k, T.taskKey('buy milk', null, 'othertasks'));
  assert.equal(T.reminderKey(new Date('2026-07-01T17:05:30Z')), 'reminder:2026-07-01--18-05');
});

test('parseWhen: wall time in Europe/Lisbon, summer and winter, date only = 09:00, ISO with offset kept', () => {
  assert.equal(L.parseWhen('2026-07-01 18:30').toISOString(), '2026-07-01T17:30:00.000Z');
  assert.equal(L.parseWhen('2026-12-01T18:30').toISOString(), '2026-12-01T18:30:00.000Z');
  assert.equal(L.parseWhen('2026-12-01').toISOString(), '2026-12-01T09:00:00.000Z');
  assert.equal(L.parseWhen('2026-12-01T18:30:00+02:00').toISOString(), '2026-12-01T16:30:00.000Z');
  assert.equal(L.parseWhen(''), null);
  assert.throws(() => L.parseWhen('next friday'), /not a date/);
});

test('output line: <initial><num> · title · due · list', () => {
  const lists = { L1: { name: 'Backlog', slug: 'backlog' } };
  assert.equal(T.line({ list: 'L1', num: 7, title: 'Pay rent', deadline: new Date('2026-11-01T12:00:00Z') }, lists), 'B7 · Pay rent · 2026-11-01 12:00 · Backlog');
  assert.equal(T.line({ list: 'L1', num: 8, title: 'x', deadline: null }, lists), 'B8 · x · - · Backlog');
});

test('readEnv: KEY=value, quotes, comments; loginName for the agents', () => {
  const f = path.join(os.tmpdir(), 'td-env-' + process.pid);
  fs.writeFileSync(f, '# c\nTASKSDB_URL="https://x.supabase.co"\nexport TASKSDB_ANON_KEY=k\nOTHER=1\n');
  try {
    const env = L.readEnv(f);
    assert.equal(env.TASKSDB_URL, 'https://x.supabase.co'); assert.equal(env.TASKSDB_ANON_KEY, 'k');
  } finally { fs.unlinkSync(f); }
  assert.equal(L.loginName('homeos-agent'), 'AGENT'); assert.equal(L.loginName('telegram-bot'), 'TELEGRAM'); assert.equal(L.loginName('maksym'), 'MAKSYM');
  assert.deepEqual(L.missingEnv({ TASKSDB_URL: 'u' }, 'maksym'), ['TASKSDB_ANON_KEY', 'TASKSDB_MAKSYM_EMAIL', 'TASKSDB_MAKSYM_PASSWORD']);
});

test('exit codes: no command 1, help 0, env missing 2 with names only', () => {
  assert.equal(runCli([]).status, 1);
  assert.equal(runCli(['--help']).status, 0);
  const r = runCli(['overdue']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /env missing: TASKSDB_URL, TASKSDB_ANON_KEY, TASKSDB_AGENT_EMAIL, TASKSDB_AGENT_PASSWORD/);
});

test('exit 6 when the database is unreachable; nothing printed from the env', () => {
  const env = Object.assign(cleanEnv(), { TASKSDB_URL: 'http://127.0.0.1:9', TASKSDB_ANON_KEY: 'secret-looking-key', TASKSDB_AGENT_EMAIL: 'a@example.invalid', TASKSDB_AGENT_PASSWORD: 'pw-should-not-print' });
  const r = runCli(['overdue'], env);
  assert.equal(r.status, 6);
  assert.doesNotMatch(r.stdout + r.stderr, /pw-should-not-print|secret-looking-key|a@example\.invalid/);
});

test('errorExit maps database errors to CLI exit codes', () => {
  const C = L.loadCore();
  assert.equal(L.errorExit(C.restError(409, { code: '23505' })), 4);
  assert.equal(L.errorExit(C.restError(400, { code: '22023', message: 'sensitive data: x' })), 5);
  assert.equal(L.errorExit(C.restError(403, { code: '42501', message: 'this list is archived' })), 8);
  assert.equal(L.errorExit(C.restError(0)), 6);
  assert.equal(L.errorExit(C.restError(400, { error_code: 'invalid_credentials' })), 7);
});
