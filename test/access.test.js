// node --test test/  — cli/access.mjs without network: the rules, then every command against a mocked Cloudflare fetch
// and a fake database client. Nothing reaches Cloudflare or Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');

let A;
test.before(async () => { A = await import('../cli/access.mjs'); });

const TOKEN = 'cf-token-never-printed';
const ENV = { CLOUDFLARE_ACCOUNT_ID: 'acc1', CLOUDFLARE_ACCESS_TOKEN: TOKEN, CF_ACCESS_GUEST_POLICY_ID: 'pg', CF_ACCESS_PROD_APP_ID: 'app1',
  TASKSDB_URL: 'https://x.supabase.co', TASKSDB_ANON_KEY: 'sb_publishable_x', TASKSDB_AGENT_EMAIL: 'agent@example.invalid', TASKSDB_AGENT_PASSWORD: 'pw' };

// an in-memory Cloudflare Access account behind a fetch(url, init) mock; calls are logged as "METHOD path"
function fakeCf(state, opts = {}) {
  const calls = [];
  const ok = result => ({ ok: true, status: 200, json: async () => ({ success: true, errors: [], result, result_info: { total_pages: 1 } }) });
  const fetch = async (url, init) => {
    assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/accounts/acc1/access/'), url);
    assert.equal(init.headers.Authorization, 'Bearer ' + TOKEN);
    const p = url.split('/access/')[1].split('?')[0];
    calls.push(init.method + ' ' + p);
    if (opts.status) return { ok: false, status: opts.status, json: async () => ({ success: false, errors: [{ message: 'denied' }] }) };
    const body = init.body ? JSON.parse(init.body) : undefined;
    const [kind, id] = p.split('/');
    if (init.method === 'GET' && !id) return ok(Object.values(state[kind]));
    if (init.method === 'GET') return ok(state[kind][id]);
    if (init.method === 'POST') { const nid = kind[0] + (Object.keys(state[kind]).length + 1); state[kind][nid] = Object.assign({ id: nid }, body); return ok(state[kind][nid]); }
    if (init.method === 'PUT' && kind === 'apps') {
      const pols = body.policies.map(x => Object.assign({}, state.policies[x.id] || { id: x.id }, { precedence: x.precedence }));
      state.apps[id] = Object.assign({}, body, { id, policies: opts.dropOnPut ? pols.slice(1) : pols }); return ok(state.apps[id]);
    }
    if (init.method === 'PUT') { state[kind][id] = Object.assign({ id }, body); return ok(state[kind][id]); }
    throw new Error('unexpected ' + init.method + ' ' + p);
  };
  return { fetch, calls };
}
const cfState = (emails = ['a@x.com']) => ({
  policies: { pg: { id: 'pg', name: A.GUEST_POLICY, decision: 'allow', include: emails.map(email => ({ email: { email } })), session_duration: '730h' },
              ph: { id: 'ph', name: 'Household', decision: 'allow', include: [{ email: { email: 'h@x.com' } }] } },
  apps: { app1: { id: 'app1', aud: 'aud1', created_at: 't', name: 'TasksDashboard', type: 'self_hosted', domain: 'board.example.com',
                  policies: [{ id: 'ph', name: 'Household', precedence: 1 }] } },
});
const runCmd = async (argv, deps) => { const lines = []; let code, err; try { code = await A.run(argv, s => lines.push(s), deps); } catch (e) { err = e; } return { code, err, out: lines.join('\n') }; };

test('decisionOf: the first word, any case; anything else is undecided', () => {
  assert.equal(A.decisionOf('Approved'), 'approved');
  assert.equal(A.decisionOf('  approved. welcome'), 'approved');
  assert.equal(A.decisionOf('DECLINED, spam'), 'declined');
  assert.equal(A.decisionOf('Write Approved or Declined as the first word of this description.'), null);
  assert.equal(A.decisionOf('Approvedx'), null);
  assert.equal(A.decisionOf('not approved'), null);
  assert.equal(A.decisionOf(''), null);
  assert.equal(A.decisionOf(null), null);
});

test('arguments and emails', () => {
  assert.deepEqual(A.parseArgs(['add', '--email', 'A@X.com', '--apply']), { _: ['add'], email: 'A@X.com', apply: true });
  assert.throws(() => A.parseArgs(['add', '--email']), /needs a value/);
  assert.equal(A.normEmail(' A@X.Com '), 'a@x.com');
  assert.throws(() => A.normEmail('nope'), /not an email/);
});

test('guest emails: other rules kept, the placeholder only when nothing else is left and never listed', () => {
  const inc = [{ email: { email: 'B@x.com' } }, { email_domain: { domain: 'x.com' } }];
  assert.deepEqual(A.policyEmails({ include: inc }), ['b@x.com']);
  assert.deepEqual(A.withEmails(inc, ['c@x.com', 'b@x.com']), [{ email_domain: { domain: 'x.com' } }, { email: { email: 'b@x.com' } }, { email: { email: 'c@x.com' } }]);
  assert.deepEqual(A.withEmails([], []), [{ email: { email: A.PLACEHOLDER } }]);
  assert.deepEqual(A.policyEmails({ include: A.withEmails([], []) }), []);
});

test('seats: a warning from 45, refused from 50 unless --force', () => {
  assert.deepEqual([44, 45, 49].map(n => A.seatCheck(n).ok), [true, true, true]);
  assert.match(A.seatCheck(45).note, /near/);
  assert.equal(A.seatCheck(50).ok, false);
  assert.equal(A.seatCheck(50, true).ok, true);
  assert.equal(A.seatCheck(51).ok, false);
});

test('attachPlan keeps every policy and adds the guests policy last; lostPolicies; appBody', () => {
  const p = A.attachPlan([{ id: 'a', name: 'A', precedence: 1 }, { id: 'b', name: 'B', precedence: 3 }], 'g');
  assert.equal(p.changed, true);
  assert.deepEqual(p.after.map(x => [x.id, x.precedence]), [['a', 1], ['b', 3], ['g', 4]]);
  assert.equal(A.attachPlan(p.after, 'g').changed, false);
  assert.deepEqual(A.lostPolicies(p.before, [{ id: 'b' }]), ['a']);
  const body = A.appBody({ id: 'x', aud: 'y', created_at: 't', updated_at: 't', uid: 'u', name: 'N', domain: 'd', policies: [{ id: 'a' }] }, p.after);
  assert.deepEqual(Object.keys(body).sort(), ['domain', 'name', 'policies']);
  assert.deepEqual(body.policies, [{ id: 'a', precedence: 1 }, { id: 'b', precedence: 3 }, { id: 'g', precedence: 4 }]);
});

test('planTask: what process does per decision and request status', () => {
  const it = b => ({ body_md: b });
  assert.equal(A.planTask(it('Write Approved or Declined'), { status: 'pending' }).action, 'skip');
  assert.equal(A.planTask(it('Approved'), null).action, 'skip');
  assert.equal(A.planTask(it('Approved'), { status: 'pending' }).action, 'approve');
  assert.equal(A.planTask(it('approved'), { status: 'declined' }).action, 'approve');
  assert.equal(A.planTask(it('Approved'), { status: 'approved' }).action, 'close');
  assert.equal(A.planTask(it('Approved'), { status: 'removed' }).action, 'skip');
  assert.equal(A.planTask(it('Declined'), { status: 'pending' }).action, 'decline');
  assert.equal(A.planTask(it('Declined'), { status: 'declined' }).action, 'close');
  assert.match(A.planTask(it('Declined'), { status: 'approved' }).why, /use remove/);
  assert.match(A.closingLine('approved', new Date('2026-07-01T17:05:00Z')), /Applied 2026-07-01 18:05 Europe\/Lisbon by cli\/access\.mjs: added/);
});

test('env: missing names are listed, values never printed', async () => {
  const r = await runCmd(['list'], { env: { CLOUDFLARE_ACCESS_TOKEN: TOKEN } });
  assert.equal(r.err.exit, 2);
  assert.match(r.err.message, /CLOUDFLARE_ACCOUNT_ID.*CF_ACCESS_GUEST_POLICY_ID.*CF_ACCESS_PROD_APP_ID/);
  assert.ok(!r.err.message.includes(TOKEN));
  const p = await runCmd(['process'], { env: Object.assign({}, ENV, { TASKSDB_AGENT_PASSWORD: '' }) });
  assert.equal(p.err.exit, 2);
  assert.match(p.err.message, /TASKSDB_AGENT_PASSWORD/);
  assert.equal((await runCmd(['nope'], { env: ENV })).code, 1);
});

test('list: emails, seats and whether the guests policy is on the production app', async () => {
  const cf = fakeCf(cfState(['b@x.com', 'a@x.com']));
  const r = await runCmd(['list'], { env: ENV, fetch: cf.fetch });
  assert.equal(r.code, 0);
  assert.match(r.out, /2 of 50 seats\n  a@x\.com\n  b@x\.com/);
  assert.match(r.out, /NOT attached: run setup/);
  assert.ok(cf.calls.every(c => c.startsWith('GET ')));
  assert.ok(!r.out.includes(TOKEN));
});

test('add and remove: dry run sends no write; --apply writes; the seat limit refuses; the last removal leaves the placeholder', async () => {
  let st = cfState(), cf = fakeCf(st);
  let r = await runCmd(['add', '--email', 'New@X.com'], { env: ENV, fetch: cf.fetch });
  assert.equal(r.code, 0);
  assert.match(r.out, /dry run/);
  assert.match(r.out, /would add new@x\.com/);
  assert.ok(!cf.calls.some(c => !c.startsWith('GET ')));
  r = await runCmd(['add', '--email', 'new@x.com', '--apply'], { env: ENV, fetch: cf.fetch });
  assert.deepEqual(A.policyEmails(st.policies.pg).sort(), ['a@x.com', 'new@x.com']);
  assert.equal(st.policies.pg.session_duration, '730h');
  st = cfState(Array.from({ length: 49 }, (_, i) => `g${i}@x.com`)); cf = fakeCf(st);
  r = await runCmd(['add', '--email', 'z@x.com', '--apply'], { env: ENV, fetch: cf.fetch });
  assert.equal(r.err.exit, 9);
  assert.ok(!cf.calls.some(c => c.startsWith('PUT')));
  r = await runCmd(['add', '--email', 'z@x.com', '--apply', '--force'], { env: ENV, fetch: cf.fetch });
  assert.equal(r.code, 0);
  assert.equal(A.policyEmails(st.policies.pg).length, 50);
  st = cfState(['a@x.com']); cf = fakeCf(st);
  const env = Object.assign({}, ENV, { TASKSDB_AGENT_EMAIL: '' });
  r = await runCmd(['remove', '--email', 'a@x.com', '--apply'], { env, fetch: cf.fetch });
  assert.equal(r.code, 0);
  assert.deepEqual(st.policies.pg.include, [{ email: { email: A.PLACEHOLDER } }]);
  assert.match(r.out, /database not updated/);
});

test('remove marks the approved request removed through the agent login', async () => {
  const st = cfState(['a@x.com']), cf = fakeCf(st), db = fakeDb([], [{ id: 'r1', email: 'a@x.com', status: 'approved' }]);
  const r = await runCmd(['remove', '--email', 'a@x.com', '--apply'], { env: ENV, fetch: cf.fetch, connect: async () => db });
  assert.equal(r.code, 0);
  assert.deepEqual(db.calls.filter(c => c.startsWith('POST rpc/access_request_decided')), ['POST rpc/access_request_decided {"p_id":"r1","p_status":"removed"}']);
  assert.equal(db.closed, true);
});

test('setup: dry run changes nothing; --apply creates both policies, the request app and the phone app, keeps the household policy, prints the id', async () => {
  let st = cfState(), cf = fakeCf(st);
  const env = Object.assign({}, ENV, { CF_ACCESS_GUEST_POLICY_ID: '' });
  delete st.policies.pg;
  let r = await runCmd(['setup'], { env, fetch: cf.fetch });
  assert.equal(r.code, 0);
  assert.match(r.out, /would create policy "TasksDashboard guests"/);
  assert.match(r.out, /would create app "TasksDashboard request" for board\.example\.com\/request, board\.example\.com\/config\/tasksdashboard\.config\.js/);
  assert.match(r.out, /would create app "TasksDashboard phone app" for board\.example\.com\/app, board\.example\.com\/app\/\*/);
  assert.match(r.out, /before: Household\n.*after: {2}Household, TasksDashboard guests/);
  assert.ok(cf.calls.every(c => c.startsWith('GET ')));
  r = await runCmd(['setup', '--apply'], { env, fetch: cf.fetch });
  assert.equal(r.code, 0, r.err && r.err.message);
  const guest = Object.values(st.policies).find(p => p.name === A.GUEST_POLICY);
  const bypass = Object.values(st.policies).find(p => p.name === A.BYPASS_POLICY);
  assert.deepEqual(guest.include, [{ email: { email: A.PLACEHOLDER } }]);
  assert.equal(bypass.decision, 'bypass');
  const app = Object.values(st.apps).find(x => x.name === A.REQUEST_APP);
  assert.deepEqual(app.destinations.map(d => d.uri), ['board.example.com/request', 'board.example.com/config/tasksdashboard.config.js']);
  assert.deepEqual(app.policies.map(p => p.id), [bypass.id]);
  const phone = Object.values(st.apps).find(x => x.name === A.PHONE_APP);
  assert.deepEqual(phone.destinations.map(d => d.uri), ['board.example.com/app', 'board.example.com/app/*']);
  assert.equal(phone.domain, 'board.example.com/app');
  assert.deepEqual(phone.policies.map(p => p.id), [bypass.id]);
  assert.deepEqual(st.apps.app1.policies.map(p => p.id), ['ph', guest.id]);
  assert.equal(st.apps.app1.aud, undefined);   // read-only fields are not sent back
  assert.match(r.out, new RegExp(`CF_ACCESS_GUEST_POLICY_ID=${guest.id}`));
  assert.match(r.out, /verified/);
  // again: nothing new
  const n = cf.calls.length;
  r = await runCmd(['setup', '--apply'], { env: Object.assign({}, env, { CF_ACCESS_GUEST_POLICY_ID: guest.id }), fetch: cf.fetch });
  assert.ok(cf.calls.slice(n).every(c => c.startsWith('GET ')));
});

test('setup stops (exit 3) when the production app lost a policy', async () => {
  const st = cfState(), cf = fakeCf(st, { dropOnPut: true });
  const r = await runCmd(['setup', '--apply'], { env: ENV, fetch: cf.fetch });
  assert.equal(r.err.exit, 3);
  assert.match(r.err.message, /STOP: the production app lost ph/);
});

test('Cloudflare refusing the token is exit 7, unreachable is exit 6; the token is never printed', async () => {
  let r = await runCmd(['list'], { env: ENV, fetch: fakeCf(cfState(), { status: 403 }).fetch });
  assert.equal(r.err.exit, 7);
  assert.ok(!r.err.message.includes(TOKEN));
  r = await runCmd(['list'], { env: ENV, fetch: async () => { throw new Error('offline'); } });
  assert.equal(r.err.exit, 6);
});

// a fake agent client: the list, the requests, the items; writes logged as "METHOD path body"
function fakeDb(items, reqs) {
  const calls = [];
  const res = json => ({ ok: true, status: 200, json });
  return {
    calls, closed: false,
    async rest(method, p, body) {
      calls.push(method + ' ' + p + (body === undefined ? '' : ' ' + JSON.stringify(body)));
      if (p.startsWith('lists?')) return res([{ id: 'L', slug: 'access-requests', archived_at: null }]);
      if (p === 'rpc/access_requests') return res(body && body.p_status ? reqs.filter(r => r.status === body.p_status) : reqs);
      if (p === 'rpc/access_request_decided') { const r = reqs.find(x => x.id === body.p_id); r.status = body.p_status; return res(r); }
      if (method === 'PATCH') return res(null);
      throw new Error('unexpected ' + method + ' ' + p);
    },
    async getAll(p) { calls.push('GET ' + p); return res(items); },
    async close() { this.closed = true; },
  };
}

test('process: dry run plans only; --apply adds approvals in one write, records decisions, closes the tasks, leaves undecided ones', async () => {
  const mk = () => ({
    items: [
      { id: 'i1', num: 1, title: 'Access request: p@x.com', body_md: 'Approved\n\n- Email: p@x.com', details: { access_request_id: 'r1' } },
      { id: 'i2', num: 2, title: 'Access request: d@x.com', body_md: 'declined', details: { access_request_id: 'r2' } },
      { id: 'i3', num: 3, title: 'Access request: u@x.com', body_md: 'Write Approved or Declined as the first word of this description.', details: { access_request_id: 'r3' } },
      { id: 'i4', num: 4, title: 'Access request: q@x.com', body_md: 'APPROVED', details: { access_request_id: 'r4' } },
      { id: 'i5', num: 5, title: 'something else', body_md: 'Approved', details: {} },
    ],
    reqs: [{ id: 'r1', email: 'p@x.com', status: 'pending' }, { id: 'r2', email: 'd@x.com', status: 'pending' },
           { id: 'r3', email: 'u@x.com', status: 'pending' }, { id: 'r4', email: 'q@x.com', status: 'pending' }],
  });
  let d = mk(), st = cfState(['a@x.com']), cf = fakeCf(st), db = fakeDb(d.items, d.reqs);
  const now = () => new Date('2026-10-29T10:00:00Z');
  let r = await runCmd(['process'], { env: ENV, fetch: cf.fetch, connect: async () => db, now });
  assert.equal(r.code, 0, r.err && r.err.message);
  assert.match(r.out, /A1 p@x\.com: approve\nA2 d@x\.com: decline\nA3 u@x\.com: skip \(undecided\)\nA4 q@x\.com: approve\nA5 something else: skip \(no access request for this task\)/);
  assert.match(r.out, /guests policy: 1 → 3 emails/);
  assert.ok(!db.calls.some(c => /^(PATCH|POST rpc\/access_request_decided)/.test(c)));
  assert.ok(!cf.calls.some(c => c.startsWith('PUT')));
  assert.equal(db.closed, true);

  d = mk(); st = cfState(['a@x.com']); cf = fakeCf(st); db = fakeDb(d.items, d.reqs);
  r = await runCmd(['process', '--apply'], { env: ENV, fetch: cf.fetch, connect: async () => db, now });
  assert.equal(r.code, 0, r.err && r.err.message);
  assert.equal(cf.calls.filter(c => c.startsWith('PUT')).length, 1);
  assert.deepEqual(A.policyEmails(st.policies.pg).sort(), ['a@x.com', 'p@x.com', 'q@x.com']);
  assert.deepEqual(d.reqs.map(x => x.status), ['approved', 'declined', 'pending', 'approved']);
  const patches = db.calls.filter(c => c.startsWith('PATCH'));
  assert.deepEqual(patches.map(c => c.split(' ')[1]), ['items?id=eq.i1', 'items?id=eq.i2', 'items?id=eq.i4']);
  assert.match(patches[0], /"status":"done".*Applied 2026-10-29 10:00 Europe\/Lisbon by cli\/access\.mjs: added to the access policy\./);
  assert.match(patches[1], /Declined 2026-10-29 10:00 Europe\/Lisbon by cli\/access\.mjs: nothing applied\./);

  // a second run: the tasks are done, so the list holds only the undecided one
  db = fakeDb(d.items.filter(x => x.id === 'i3'), d.reqs);
  r = await runCmd(['process', '--apply'], { env: ENV, fetch: cf.fetch, connect: async () => db, now });
  assert.ok(!db.calls.some(c => c.startsWith('PATCH')));
});

test('process: an approval over the seat limit changes nothing', async () => {
  const st = cfState(Array.from({ length: 49 }, (_, i) => `g${i}@x.com`)), cf = fakeCf(st);
  const db = fakeDb([{ id: 'i1', num: 1, title: 't', body_md: 'Approved', details: { access_request_id: 'r1' } }], [{ id: 'r1', email: 'p@x.com', status: 'pending' }]);
  const r = await runCmd(['process', '--apply'], { env: ENV, fetch: cf.fetch, connect: async () => db });
  assert.equal(r.err.exit, 9);
  assert.ok(!cf.calls.some(c => c.startsWith('PUT')));
  assert.ok(!db.calls.some(c => /^(PATCH|POST rpc\/access_request_decided)/.test(c)));
  assert.equal(db.closed, true);
});
