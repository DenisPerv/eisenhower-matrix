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

test('e2e guests: guest login names, leaks a guest must never read', () => {
  assert.deepEqual(L.guestLogins({}), [
    { handle: 'guest-a', missing: ['TASKSDB_GUEST_A_EMAIL', 'TASKSDB_GUEST_A_PASSWORD'] },
    { handle: 'guest-b', missing: ['TASKSDB_GUEST_B_EMAIL', 'TASKSDB_GUEST_B_PASSWORD'] }]);
  const env = { TASKSDB_GUEST_A_EMAIL: 'a@x.test', TASKSDB_GUEST_A_PASSWORD: 'p', TASKSDB_GUEST_B_EMAIL: 'b@x.test' };
  assert.deepEqual(L.guestLogins(env).map(g => g.missing), [[], ['TASKSDB_GUEST_B_PASSWORD']]);
  const allow = { uid: 'g', lists: ['mine', 'shared'], tagLists: ['gdef'] };
  const clean = { lists: [{ id: 'mine' }, { id: 'shared' }], items: [{ id: 'i1', list_id: 'shared' }], categories: [{ slug: 'task' }, { slug: 'reminder' }],
    profiles: [{ id: 'g' }], tagLists: [{ id: 'gdef' }], tags: [{ id: 't1', tag_list_id: 'gdef', name: 'x' }], itemTags: [{ item_id: 'i1', tag_id: 't1' }] };
  assert.deepEqual(L.guestLeaks(clean, allow), []);
  assert.deepEqual(L.guestLeaks({}, allow), []);
  const dirty = { lists: [{ id: 'hh', slug: 'family-tasks' }], items: [{ id: 'i9', list_id: 'hh' }], categories: [{ slug: 'tbd' }], profiles: [{ id: 'm', handle: 'maksym' }],
    tagLists: [{ id: 'mdef' }], tags: [{ id: 't9', tag_list_id: 'mdef', name: 'car' }], itemTags: [{ item_id: 'i1', tag_id: 't9' }] };
  assert.deepEqual(L.guestLeaks(dirty, allow), ['list family-tasks', 'item i9', 'category tbd', 'profile maksym', 'tag list mdef', 'tag car', 'item tag i1/t9']);
});

test('e2e --url and --access-env: arguments, https origin only, CF-Access headers only for the page origin, hosts allowed', () => {
  assert.deepEqual(L.e2eArgs(['--env', 'e', '--url', 'https://p.pages.dev', '--smoke', '--access-env', 'a']), { env: 'e', url: 'https://p.pages.dev', smoke: true, 'access-env': 'a' });
  assert.equal(L.e2eArgs(['--url', '--smoke']).url, true);
  assert.equal(L.hostedOrigin('https://p.pages.dev'), 'https://p.pages.dev');
  assert.equal(L.hostedOrigin('https://p.pages.dev/'), 'https://p.pages.dev');
  assert.equal(L.hostedOrigin('https://p.pages.dev:443'), 'https://p.pages.dev');
  for (const bad of ['http://p.pages.dev', 'file:///x.html', 'https://p.pages.dev/index.html', 'https://p.pages.dev/?a=1', 'https://u:p@p.pages.dev', 'p.pages.dev', true]) assert.throws(() => L.hostedOrigin(bad), /--url/);
  const creds = { id: 'id-value', secret: 'secret-value' }, O = 'https://p.pages.dev';
  const h = L.accessHeaders({ url: O + '/version.json', headers: { Accept: '*/*', 'cf-access-client-id': 'old' } }, O, creds);
  assert.deepEqual(h, [{ name: 'Accept', value: '*/*' }, { name: 'CF-Access-Client-Id', value: 'id-value' }, { name: 'CF-Access-Client-Secret', value: 'secret-value' }]);
  assert.ok(L.accessHeaders({ url: O + '/', headers: {} }, O, creds));
  for (const url of ['https://x.supabase.co/rest/v1/items', 'https://p.pages.dev.evil.example/', 'https://abc123.p.pages.dev/', 'http://p.pages.dev/', 'https://x.cloudflareaccess.com/cdn-cgi/access/login', 'data:text/plain,x', 'not a url'])
    assert.equal(L.accessHeaders({ url, headers: {} }, O, creds), null, url);
  assert.equal(L.accessHeaders({ url: O + '/', headers: {} }, O, null), null);
  assert.equal(L.accessHeaders({ url: O + '/', headers: {} }, null, creds), null);
  assert.deepEqual(L.strayHosts(new Set(['x.supabase.co', 'p.pages.dev']), 'x.supabase.co', O), []);
  assert.deepEqual(L.strayHosts(new Set(['x.supabase.co', 'p.pages.dev', 'x.cloudflareaccess.com']), 'x.supabase.co', O), ['x.cloudflareaccess.com']);
  assert.deepEqual(L.strayHosts(new Set(['x.supabase.co', 'p.pages.dev']), 'x.supabase.co', null), ['p.pages.dev']);
  const f = path.join(os.tmpdir(), `td-access-${process.pid}.env`);
  try {
    fs.writeFileSync(f, 'CF_ACCESS_CLIENT_ID=abc\n');
    assert.deepEqual(L.accessCreds(f), { missing: ['CF_ACCESS_CLIENT_SECRET'] });
    fs.writeFileSync(f, 'CF_ACCESS_CLIENT_ID=abc\nCF_ACCESS_CLIENT_SECRET="def"\n');
    assert.deepEqual(L.accessCreds(f), { missing: [], id: 'abc', secret: 'def' });
  } finally { fs.unlinkSync(f); }
});

test('multi-user (HomeOS multi-user-plan.md T13): owner tags set the owner, OWNER/slug, limit is exit 9', () => {
  assert.deepEqual(T.ownerFromTags(['Maksym', 'car']), { tags: ['car'], owner: 'maksym' });
  assert.deepEqual(T.ownerFromTags(['shared', 'home']), { tags: ['home'], owner: null });
  assert.deepEqual(T.ownerFromTags(['maksym', 'anastasiia']), { tags: [], owner: null });
  assert.equal(T.ownerFromTags(['home']).owner, undefined);
  const people = { M: { handle: 'maksym', is_household: true }, G: { handle: 'guesta', is_household: false }, H: { handle: 'guestb', is_household: false } };
  const ls = { l1: { id: 'l1', slug: 'groceries', owner_id: 'M' }, l2: { id: 'l2', slug: 'groceries', owner_id: 'G' },
    l3: { id: 'l3', slug: 'trip', owner_id: 'G' }, l4: { id: 'l4', slug: 'trip', owner_id: 'H' } };
  assert.equal(T.findList(ls, 'groceries', people).id, 'l1');
  assert.equal(T.findList(ls, 'guesta/groceries', people).id, 'l2');
  assert.equal(T.findList(ls, 'nobody/groceries', people), undefined);
  assert.throws(() => T.findList(ls, 'trip', people), /OWNER\/trip/);
  assert.equal(L.EXIT.limit, 9);
  assert.equal(L.errorExit(L.loadCore().restError(400, { code: '54000', message: 'item limit reached' })), 9);
});

test('task links: LIST#num references, --parent or --after, the commands in the usage', () => {
  assert.deepEqual(T.parseRef('backlog#12'), { list: 'backlog', num: 12 });
  assert.deepEqual(T.parseRef('maksym/backlog#3'), { list: 'maksym/backlog', num: 3 });
  assert.throws(() => T.parseRef('backlog'), /LIST#num/);
  assert.deepEqual(T.linkArgs({ parent: 'a#1' }), { other: 'a#1', kind: 'parent' });
  assert.deepEqual(T.linkArgs({ after: 'a#2' }), { other: 'a#2', kind: 'depends_on' });
  assert.equal(T.linkArgs({}), null);
  assert.throws(() => T.linkArgs({ parent: 'a#1', after: 'a#2' }), /not both/);
  const r = runCli(['--help']);
  assert.match(r.stdout, /link {10}REF --parent REF \| --after REF/);
  assert.match(r.stdout, /--start WHEN\] \[--parent REF\] \[--after REF\]/);
});
