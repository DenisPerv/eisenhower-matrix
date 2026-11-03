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

// ---- find, show, update, done, reopen, cancel against a fake Supabase behind globalThis.fetch (no network) ----
const NOW = Date.now();
const iso = ms => new Date(ms).toISOString();
const item = (o) => Object.assign({ category: 'task', body_md: '', status: 'open', quadrant: null, urgent_pin: null, sort_key: null, due_at: null, start_at: null,
  owner_id: null, details: {}, review_state: 'none', version: 1, deleted_at: null, tags: [] }, o);
function fakeDb(opts = {}) {
  const db = {
    profiles: [{ id: 'PA', handle: 'homeos-agent', kind: 'agent', is_household: true }, { id: 'PM', handle: 'maksym', kind: 'human', is_household: true }],
    lists: [{ id: 'L1', slug: 'backlog', name: 'Backlog', archived_at: null, owner_id: 'PM' }, { id: 'L2', slug: 'old', name: 'Old', archived_at: iso(NOW - 864e5), owner_id: 'PM' },
      { id: 'L3', slug: '_selftest', name: '_selftest', archived_at: null, owner_id: 'PM' }, { id: 'L4', slug: 'family', name: 'Family', archived_at: null, owner_id: 'PM' }],
    items: [
      item({ id: 'I1', list_id: 'L1', num: 1, title: 'Call the bank', sort_key: 2048, due_at: iso(NOW + 2 * 864e5), owner_id: 'PM', dedup_key: 'task:aaa', version: 3 }),
      item({ id: 'I2', list_id: 'L1', num: 2, title: 'Call the plumber', sort_key: 1024, due_at: iso(NOW + 3 * 864e5), dedup_key: 'task:bbb' }),
      item({ id: 'I3', list_id: 'L1', num: 3, title: 'Water plants', body_md: 'weekly', status: 'done', quadrant: 'D', sort_key: 0, dedup_key: 'task:ccc', version: 2 }),
      item({ id: 'I4', list_id: 'L2', num: 1, title: 'Archived chore', quadrant: 'B', sort_key: 0, dedup_key: 'task:ddd' }),
      item({ id: 'I5', list_id: 'L3', num: 1, title: 'Call selftest', dedup_key: 'task:eee' }),
      item({ id: 'I6', list_id: 'L4', num: 1, category: 'tbd', title: 'Open question', dedup_key: 'tbd:1' })],
    tags: [{ id: 'T1', tag_list_id: 'TL', name: 'money' }, { id: 'T2', tag_list_id: 'TL', name: 'phone' }],
    item_tags: [{ item_id: 'I1', tag_id: 'T1', removed_at: null }, { item_id: 'I1', tag_id: 'T2', removed_at: null }],
    item_links: [{ from_item: 'I2', to_item: 'I1', kind: 'depends_on', removed_at: null }],
  };
  const calls = [];
  const cond = (row, col, expr) => {
    const v = row[col];
    let m;
    if (expr === 'is.null') return v === null || v === undefined;
    if ((m = expr.match(/^not\.in\.\((.*)\)$/))) return !m[1].split(',').includes(String(v));
    if ((m = expr.match(/^in\.\((.*)\)$/))) return m[1].split(',').includes(String(v));
    if ((m = expr.match(/^eq\.(.*)$/))) return String(v) === m[1];
    if ((m = expr.match(/^lt\.(.*)$/))) return v !== null && v < m[1];
    if ((m = expr.match(/^ilike\.\*(.*)\*$/))) return String(v || '').toLowerCase().includes(m[1].toLowerCase());
    throw new Error('fake: unknown filter ' + col + '=' + expr);
  };
  const group = s => s.replace(/^\(|\)$/g, '').split(/,(?![^(]*\))/).map(x => { const i = x.indexOf('.'); return [x.slice(0, i), x.slice(i + 1)]; });
  const match = (row, params) => params.every(([k, v]) => {
    if (['select', 'order', 'limit', 'offset'].includes(k)) return true;
    if (k === 'and') return group(v).every(([c, e]) => cond(row, c, e));
    if (k === 'or') return group(v).some(([c, e]) => cond(row, c, e));
    return cond(row, k, v);
  });
  const res = (status, body) => ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body });
  const fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    if (u.pathname === '/auth/v1/token') return res(200, { access_token: 'tok', refresh_token: 'ref', expires_in: 3600, user: { id: 'PA' } });
    if (u.pathname === '/auth/v1/logout') return res(204);
    const table = u.pathname.replace('/rest/v1/', ''), params = [...u.searchParams.entries()];
    calls.push(method + ' ' + table + (method === 'PATCH' ? ' ' + u.search : ''));
    const rows = (db[table] || []).filter(r => match(r, params));
    if (method === 'GET') {
      const sel = u.searchParams.get('select') || '';
      return res(200, sel.includes('tags(') ? rows.map(r => Object.assign({}, r, { tags: db.tags.find(t => t.id === r.tag_id) || null })) : rows);
    }
    if (method === 'PATCH') {
      const body = JSON.parse(init.body);
      if (table === 'items') {
        if (opts.stale) return res(200, []);
        if (rows.some(r => (db.lists.find(l => l.id === r.list_id) || {}).archived_at)) return res(403, { code: '42501', message: 'this list is archived' });
        for (const r of rows) {
          const names = body.tags || [];
          Object.assign(r, body, { tags: [], version: r.version + 1 });
          for (const n of names) {   // the compatibility trigger: names filed additively into a tag list
            let t = db.tags.find(x => x.name === n);
            if (!t) { t = { id: 'T' + (db.tags.length + 1), tag_list_id: 'TA', name: n }; db.tags.push(t); }
            if (!db.item_tags.some(x => x.item_id === r.id && x.tag_id === t.id && !x.removed_at)) db.item_tags.push({ item_id: r.id, tag_id: t.id, removed_at: null });
          }
        }
      } else rows.forEach(r => Object.assign(r, body));
      return /return=representation/.test((init.headers || {}).Prefer || '') ? res(200, rows) : res(204);
    }
    throw new Error('fake: ' + method + ' ' + table);
  };
  return { db, calls, fetch };
}
const ENVF = path.join(os.tmpdir(), `td-cli-fake-${process.pid}.env`);
test.before(() => fs.writeFileSync(ENVF, 'TASKSDB_URL=https://fake.supabase.co\nTASKSDB_ANON_KEY=sb_publishable_fake\nTASKSDB_AGENT_EMAIL=a@x.test\nTASKSDB_AGENT_PASSWORD=pw\n'));
test.after(() => { try { fs.unlinkSync(ENVF); } catch (e) {} });
async function cmd(args, fake) {
  const lines = [], real = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try { const code = await T.run([...args, '--env', ENVF], s => lines.push(s)); return { code, out: lines.join('\n') }; }
  catch (e) { return { code: e.exit, out: lines.join('\n'), err: e.message }; }
  finally { globalThis.fetch = real; }
}
const writes = f => f.calls.filter(c => !c.startsWith('GET'));
const liveTags = (f, id) => f.db.item_tags.filter(x => x.item_id === id && !x.removed_at).map(x => f.db.tags.find(t => t.id === x.tag_id).name).sort();

test('find: title words list every open match, REF, --key, --all, test lists only with --in; never writes', async () => {
  const f = fakeDb();
  let r = await cmd(['find', 'call'], f);
  assert.equal(r.code, 0);
  assert.match(r.out, /backlog#1 · task · open · Call the bank/); assert.match(r.out, /backlog#2 · task · open · Call the plumber/);
  assert.doesNotMatch(r.out, /selftest/);
  r = await cmd(['find', 'call', '--in', '_selftest'], f);
  assert.match(r.out, /_selftest#1 · task · open · Call selftest/);
  r = await cmd(['find', 'water'], f); assert.match(r.out, /^none: no open item matches "water"/);
  r = await cmd(['find', 'water', '--all'], f); assert.match(r.out, /backlog#3 · task · done · Water plants/);
  r = await cmd(['find', 'backlog#2', '--json'], f); assert.equal(JSON.parse(r.out)[0].ref, 'backlog#2');
  r = await cmd(['find', '--key', 'task:aaa'], f); assert.match(r.out, /backlog#1/);
  r = await cmd(['find', 'chore', '--in', 'old'], f); assert.match(r.out, /old#1 .* · list archived$/);
  assert.deepEqual(writes(f), []);
});

test('targets: several matches are listed with exit 10 and nothing is written; no match is exit 1', async () => {
  const f = fakeDb();
  let r = await cmd(['update', 'call', '--title', 'X'], f);
  assert.equal(r.code, 10); assert.match(r.out, /2 items match; nothing written/); assert.match(r.out, /backlog#2/);
  r = await cmd(['done', 'call', '--json'], f);
  assert.equal(r.code, 10); assert.equal(JSON.parse(r.out).candidates.length, 2);
  r = await cmd(['done', 'nothing here'], f); assert.equal(r.code, 1); assert.match(r.err, /no open item matches/);
  r = await cmd(['show', 'backlog#99'], f); assert.equal(r.code, 1);
  r = await cmd(['show'], f); assert.equal(r.code, 1); assert.match(r.err, /name the item/);
  assert.deepEqual(writes(f), []);
});

test('update: a versioned PATCH; a bare due date keeps the time of day; title tidied; fields reported', async () => {
  const f = fakeDb();
  const before = L.localStamp(new Date(f.db.items[0].due_at)).wall.slice(11);
  const r = await cmd(['update', 'bank', '--due', '2026-12-01', '--title', ' Call  the bank today. ', '--start', '2026-11-30', '--q', 'b'], f);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(writes(f), ['PATCH items ?id=eq.I1&version=eq.3']);
  const it = f.db.items[0];
  assert.equal(it.title, 'Call the bank today'); assert.equal(it.quadrant, 'B'); assert.equal(it.version, 4);
  assert.equal(L.localStamp(new Date(it.due_at)).wall, '2026-12-01 ' + before);
  assert.equal(it.start_at, '2026-11-30T09:00:00.000Z');
  assert.match(r.out, /^updated backlog#1 · task · open · Call the bank today .* · title, due_at, start_at, quadrant$/);
  const n = await cmd(['update', 'backlog#2', '--due', 'none', '--owner', 'none'], f);
  assert.equal(n.code, 0, n.err); assert.equal(f.db.items[1].due_at, null);
  assert.equal((await cmd(['update', 'backlog#2', '--q', 'E'], f)).code, 1);
  assert.equal((await cmd(['update', 'backlog#2'], f)).code, 1);
});

test('update: exit 3 on a version conflict, 8 on an archived list or move target, 5 on sensitive data, 1 for priority and other categories', async () => {
  let f = fakeDb({ stale: true });
  let r = await cmd(['update', 'backlog#1', '--title', 'New'], f);
  assert.equal(r.code, 3); assert.match(r.err, /changed meanwhile/);
  f = fakeDb();
  r = await cmd(['update', 'old#1', '--title', 'New'], f); assert.equal(r.code, 8); assert.match(r.err, /list archived/);
  r = await cmd(['update', 'backlog#1', '--list', 'old'], f); assert.equal(r.code, 8);
  r = await cmd(['done', 'old#1'], f); assert.equal(r.code, 8);
  r = await cmd(['update', 'backlog#1', '--body', 'card 4111 1111 1111 1111'], f); assert.equal(r.code, 5); assert.match(r.err, /card number\); nothing written/);
  r = await cmd(['update', 'family#1', '--title', 'x'], f); assert.equal(r.code, 1); assert.match(r.err, /is a tbd/);
  r = await cmd(['done', 'family#1'], f); assert.equal(r.code, 1);
  assert.deepEqual(writes(f), []);
  const calls = f.calls.length;
  r = await cmd(['update', 'backlog#1', '--priority', '1'], f); assert.equal(r.code, 1); assert.match(r.err, /priority was removed/);
  assert.equal(f.calls.length, calls);
  r = await cmd(['update', 'backlog#1', '--title', 'New', '--dry-run'], f); assert.equal(r.code, 0); assert.match(r.out, /^dry run, nothing sent/);
  assert.deepEqual(writes(f), []);
  r = await cmd(['update', 'backlog#1', '--list', 'family'], f); assert.equal(r.code, 0, r.err); assert.equal(f.db.items[0].list_id, 'L4');
});

test('update --top: SPACING above the first card of its quadrant; already first writes nothing', async () => {
  const f = fakeDb();
  // I1 (2048) and I2 (1024) are tasks due within 7 days: quadrant C; I1 goes above I2
  let r = await cmd(['update', 'backlog#1', '--top'], f);
  assert.equal(r.code, 0, r.err); assert.equal(f.db.items[0].sort_key, 0);
  r = await cmd(['update', 'backlog#1', '--top'], f);
  assert.match(r.out, /^nothing to change: .* already first in C/);
  assert.equal(writes(f).length, 1);
  const C = L.loadCore();
  assert.equal(T.topSortKey(C, { id: 'x', sort_key: null }, [], 'D', NOW), 0);
});

test('update tags: --tags sets topic tags exactly (new names added, others soft-removed), person names are never tags', async () => {
  const f = fakeDb();
  const r = await cmd(['update', 'backlog#1', '--tags', 'money, Car, maksym'], f);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /tags, removed tags phone · not tags: maksym \(use --owner\)/);
  assert.deepEqual(liveTags(f, 'I1'), ['car', 'money']);
  assert.equal(f.db.items[0].owner_id, 'PM');
  const r2 = await cmd(['update', 'backlog#1', '--remove-tag', 'money', '--add-tag', 'tax'], f);
  assert.equal(r2.code, 0, r2.err);
  assert.deepEqual(liveTags(f, 'I1'), ['car', 'tax']);
});

test('done, reopen, cancel: versioned status writes; already in that state writes nothing; reopen searches closed items', async () => {
  const f = fakeDb();
  let r = await cmd(['done', 'plumber'], f);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /^done backlog#2 · task · done · Call the plumber/);
  r = await cmd(['done', 'backlog#2'], f); assert.match(r.out, /^already done: .*nothing written$/);
  r = await cmd(['reopen', 'water'], f); assert.match(r.out, /^reopened backlog#3 · task · open · Water plants/);
  r = await cmd(['cancel', 'backlog#3', '--json'], f); assert.equal(JSON.parse(r.out).status, 'cancelled');
  assert.deepEqual(writes(f), ['PATCH items ?id=eq.I2&version=eq.1', 'PATCH items ?id=eq.I3&version=eq.2', 'PATCH items ?id=eq.I3&version=eq.3']);
});

test('show: list, derived quadrant, owner, tags, links, key', async () => {
  const f = fakeDb();
  const r = await cmd(['show', 'backlog#1'], f);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /list: Backlog · quadrant: C \(derived\) · owner: maksym/);
  assert.match(r.out, /tags: money, phone/); assert.match(r.out, /next: backlog#2 Call the plumber/); assert.match(r.out, /key: task:aaa · version 3/);
  const j = JSON.parse((await cmd(['show', 'backlog#2', '--json'], f)).out);
  assert.deepEqual(j.links.after, ['backlog#1 Call the bank']); assert.equal(j.links.waiting, 1);
});

test('helpers: sensitive screen as db/002, search words, due values, the new commands in the usage', () => {
  assert.equal(T.sensitiveCheck('pay 4111 1111 1111 1111'), 'looks like a card number');
  assert.equal(T.sensitiveCheck('IBAN PT50000201231234567890154'), 'looks like an IBAN');
  assert.equal(T.sensitiveCheck('passport no 1234567'), 'looks like an ID number');
  assert.equal(T.sensitiveCheck('see https://x.test/4111111111111111 and call at 18:00'), null);
  assert.deepEqual(T.searchWords('Call the  bank!'), ['call', 'the', 'bank']);
  assert.throws(() => T.searchWords('a !'), /title word/);
  assert.equal(T.dueValue('none', {}), null);
  assert.equal(T.dueValue('2026-12-01', { category: 'reminder' }).toISOString(), '2026-12-01T09:00:00.000Z');
  assert.equal(T.dueValue('2026-12-01', { category: 'task' }).toISOString(), '2026-12-01T18:00:00.000Z');
  assert.equal(T.dueValue('2026-12-01', { category: 'task', due_at: '2026-11-01T14:30:00Z' }).toISOString(), '2026-12-01T14:30:00.000Z');
  assert.equal(T.startValue('2026-12-01').toISOString(), '2026-12-01T09:00:00.000Z');
  assert.equal(L.EXIT.ambiguous, 10);
  const u = runCli(['--help']).stdout;
  for (const c of ['find', 'show', 'update', 'done \\| reopen \\| cancel']) assert.match(u, new RegExp('\\n  ' + c + ' '));
});
