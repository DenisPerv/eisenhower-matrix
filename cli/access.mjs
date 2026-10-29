#!/usr/bin/env node
// Access requests → Cloudflare Access: list, add, remove, setup, process. Dry run unless --apply.
// node cli/access.mjs <command> [options]; README "CLI" lists the env names, options and exit codes. Never prints an env
// value or a token. Cloudflare through its documented REST API (api.cloudflare.com/client/v4), the database as homeos-agent.
import { pathToFileURL } from 'node:url';
import { EXIT, TdError, readEnv, missingEnv, connect, errorExit, localStamp } from './lib.mjs';

const TZ = 'Europe/Lisbon';
const CF_API = 'https://api.cloudflare.com/client/v4';
export const GUEST_POLICY = 'TasksDashboard guests';
export const BYPASS_POLICY = 'TasksDashboard request (bypass)';
export const REQUEST_APP = 'TasksDashboard request';
export const REQUEST_PATHS = ['/request', '/config/tasksdashboard.config.js'];
// the phone app (app/, published at /app/) is public at the edge and gates itself (docs/hosting.md "The phone app")
export const PHONE_APP = 'TasksDashboard phone app';
export const PHONE_PATHS = ['/app', '/app/*'];
// a reusable policy needs one include rule; this address can never sign in (.invalid), and list/add/remove hide it
export const PLACEHOLDER = 'no-guests-yet@example.invalid';
export const SEATS = { warn: 45, max: 50 };   // Zero Trust free plan: 50 users (G5)
const CF_NAMES = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_ACCESS_TOKEN', 'CF_ACCESS_GUEST_POLICY_ID', 'CF_ACCESS_PROD_APP_ID'];
const COMMANDS = ['list', 'add', 'remove', 'setup', 'process'];
const FLAGS = new Set(['apply', 'force', 'json', 'help']);
const USAGE = `usage: node cli/access.mjs <command> [options]     (dry run unless --apply)
  list                         the guests policy's emails and seats, the production app's policies
  add     --email A [--force]  add A to the guests policy (warn at ${SEATS.warn} emails, refuse at ${SEATS.max} unless --force)
  remove  --email A            take A off the guests policy; its approved request becomes removed
  setup                        create the guests policy, the bypass policy, the request app (${REQUEST_PATHS.join(', ')})
                               and the phone app (${PHONE_PATHS.join(', ')}), both on the bypass policy,
                               attach the guests policy to the production app keeping every policy it has
  process [--force]            open tasks in the Access requests list: Approved / Declined as the first word of the
                               description → the guests policy, access_request_decided, the task done
common: --env FILE  --apply  --json
env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ACCESS_TOKEN (Access: Apps and Policies Edit), CF_ACCESS_GUEST_POLICY_ID (after setup),
     CF_ACCESS_PROD_APP_ID; process and remove also TASKSDB_URL, TASKSDB_ANON_KEY, TASKSDB_AGENT_EMAIL, TASKSDB_AGENT_PASSWORD
exit: 0 ok, 1 error, 2 env missing, 3 a policy would be lost (stop), 6 unreachable, 7 auth failed, 9 seat limit`;

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (FLAGS.has(k)) out[k] = true;
    else { const v = inline !== undefined ? inline : argv[++i]; if (v === undefined) throw new TdError(EXIT.error, `--${k} needs a value`); out[k] = v; }
  }
  return out;
}

// ---------- pure rules ----------

export function normEmail(s) {
  const e = String(s || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 320) throw new TdError(EXIT.error, 'not an email address');
  return e;
}
// G4: the first word of the description, any case: approved or declined; anything else is undecided (null)
export function decisionOf(body) {
  const m = String(body || '').match(/^\s*([A-Za-z]+)/);
  const w = m ? m[1].toLowerCase() : '';
  return w === 'approved' || w === 'declined' ? w : null;
}
// the email rules of a policy's include list (other rule kinds are kept as they are), without the placeholder
export const policyEmails = p => (p && p.include || []).filter(r => r && r.email && r.email.email).map(r => String(r.email.email).toLowerCase())
  .filter(e => e !== PLACEHOLDER);
// a new include list with these emails; the placeholder only when no rule at all would be left
export function withEmails(include, emails) {
  const other = (include || []).filter(r => !(r && r.email && r.email.email));
  const rules = [...new Set(emails.map(e => e.toLowerCase()))].sort().map(email => ({ email: { email } }));
  return other.length || rules.length ? [...other, ...rules] : [{ email: { email: PLACEHOLDER } }];
}
// G5: emails after a change: a warning from 45, refused from 50 unless forced (the household's own seats count too)
export function seatCheck(n, force) {
  if (n >= SEATS.max) return { ok: !!force, note: `${n} of ${SEATS.max} seats: at the free plan's limit${force ? ' (--force)' : '; free seats in Zero Trust → Users → Remove, or --force'}` };
  if (n >= SEATS.warn) return { ok: true, note: `${n} of ${SEATS.max} seats: near the free plan's limit` };
  return { ok: true, note: `${n} of ${SEATS.max} seats` };
}
// G6: the production app's policies after attaching one; precedence after the last; ids only
export function attachPlan(appPolicies, policyId) {
  const before = (appPolicies || []).map((p, i) => ({ id: p.id, name: p.name || p.id, precedence: p.precedence || i + 1 }));
  if (before.some(p => p.id === policyId)) return { before, after: before, changed: false };
  const top = before.reduce((m, p) => Math.max(m, p.precedence), 0);
  return { before, after: [...before, { id: policyId, name: GUEST_POLICY, precedence: top + 1 }], changed: true };
}
// ids that were on the app before and are gone now (any → stop)
export const lostPolicies = (before, after) => before.map(p => p.id).filter(id => !(after || []).some(p => p.id === id));
// the app's own fields for a PUT: everything the GET gave except what the API sets itself
const READ_ONLY = ['id', 'uid', 'aud', 'created_at', 'updated_at', 'policies'];
export const appBody = (app, policies) => Object.assign(Object.fromEntries(Object.entries(app).filter(([k]) => !READ_ONLY.includes(k))),
  { policies: policies.map(p => ({ id: p.id, precedence: p.precedence })) });
// the host of a self-hosted app: its domain without a path
export const appHost = app => String((app && (app.domain || (app.destinations || []).map(d => d.uri)[0])) || '').split('/')[0];
// the closing line on a processed task
export const closingLine = (decision, when) => `\n\n${decision === 'approved' ? 'Applied' : 'Declined'} ${localStamp(when, TZ).wall} ${TZ} by cli/access.mjs: `
  + (decision === 'approved' ? 'added to the access policy.' : 'nothing applied.');
// what process does with one task: { action: 'approve' | 'decline' | 'close' | 'skip', why }
export function planTask(item, req) {
  const d = decisionOf(item.body_md);
  if (!d) return { action: 'skip', why: 'undecided' };
  if (!req) return { action: 'skip', why: 'no access request for this task' };
  if (d === 'approved') {
    if (req.status === 'approved') return { action: 'close', decision: d, why: 'already approved' };
    if (req.status === 'pending' || req.status === 'declined') return { action: 'approve', decision: d };
    return { action: 'skip', why: `request is ${req.status}` };
  }
  if (req.status === 'declined') return { action: 'close', decision: d, why: 'already declined' };
  if (req.status === 'pending') return { action: 'decline', decision: d };
  return { action: 'skip', why: `request is ${req.status}: use remove` };
}

// ---------- Cloudflare ----------

export function cfEnv(file) {
  const env = readEnv(file);
  for (const k of CF_NAMES) if (!env[k] && process.env[k]) env[k] = process.env[k];
  return env;
}
export const cfMissing = (env, names) => names.filter(k => !env[k]);

export function cfClient(env, { fetch: f = globalThis.fetch } = {}) {
  const acc = env.CLOUDFLARE_ACCOUNT_ID;
  async function call(method, p, body) {
    let r;
    try {
      r = await f(`${CF_API}/accounts/${acc}/access/${p}`, { method, headers: { Authorization: `Bearer ${env.CLOUDFLARE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) { throw new TdError(EXIT.unreachable, 'Cloudflare API unreachable'); }
    const j = await r.json().catch(() => null);
    if (r.status === 401 || r.status === 403) throw new TdError(EXIT.auth, `Cloudflare refused the token (HTTP ${r.status}); it needs Access: Apps and Policies Edit`);
    if (!r.ok || !j || j.success === false) throw new TdError(EXIT.error, `Cloudflare ${method} ${p.split('?')[0]}: HTTP ${r.status}` + (j && j.errors && j.errors.length ? ' ' + j.errors.map(e => e.message).join('; ') : ''));
    return j;
  }
  async function all(p) {
    const out = [];
    for (let page = 1; ; page++) {
      const j = await call('GET', `${p}?per_page=100&page=${page}`);
      out.push(...(j.result || []));
      const info = j.result_info || {};
      if (!info.total_pages || page >= info.total_pages) return out;
    }
  }
  return {
    policies: () => all('policies'),
    apps: () => all('apps'),
    policy: id => call('GET', `policies/${id}`).then(j => j.result),
    app: id => call('GET', `apps/${id}`).then(j => j.result),
    createPolicy: body => call('POST', 'policies', body).then(j => j.result),
    updatePolicy: (id, body) => call('PUT', `policies/${id}`, body).then(j => j.result),
    createApp: body => call('POST', 'apps', body).then(j => j.result),
    updateApp: (id, body) => call('PUT', `apps/${id}`, body).then(j => j.result),
  };
}
const policyBody = (p, include) => ({ name: p.name, decision: p.decision, include, exclude: p.exclude || [], require: p.require || [],
  session_duration: p.session_duration || '730h' });

// the guests policy's emails changed to `next`; dry run unless apply; returns { before, after, seats }
async function changeGuests(cf, env, a, next, out) {
  const p = await cf.policy(env.CF_ACCESS_GUEST_POLICY_ID);
  const before = policyEmails(p);
  const after = [...new Set(next(before))].sort();
  const seats = seatCheck(after.length, a.force);
  out(`guests policy: ${before.length} → ${after.length} emails (${seats.note})`);
  if (after.length > before.length && !seats.ok) throw new TdError(EXIT.limit, 'seat limit reached: nothing changed');
  if (a.apply && after.join() !== before.join()) {
    const done = await cf.updatePolicy(p.id, policyBody(p, withEmails(p.include, after)));
    const got = policyEmails(done || await cf.policy(p.id)).sort();
    if (got.join() !== after.join()) throw new TdError(EXIT.error, 'guests policy: Cloudflare answered a different list; check it in Zero Trust');
  }
  return { before, after, seats };
}

// ---------- commands ----------

export async function run(argv, out = console.log, deps = {}) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  if (a.help || !COMMANDS.includes(cmd)) { out(USAGE); return a.help ? EXIT.ok : EXIT.error; }
  const env = deps.env || cfEnv(a.env);
  const need = { list: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_ACCESS_TOKEN', 'CF_ACCESS_GUEST_POLICY_ID', 'CF_ACCESS_PROD_APP_ID'],
    add: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_ACCESS_TOKEN', 'CF_ACCESS_GUEST_POLICY_ID'],
    remove: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_ACCESS_TOKEN', 'CF_ACCESS_GUEST_POLICY_ID'],
    setup: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_ACCESS_TOKEN', 'CF_ACCESS_PROD_APP_ID'],
    process: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_ACCESS_TOKEN', 'CF_ACCESS_GUEST_POLICY_ID'] }[cmd];
  const miss = cfMissing(env, need).concat(cmd === 'process' ? missingEnv(env, 'homeos-agent') : []);
  if (miss.length) throw new TdError(EXIT.env, `missing: ${miss.join(', ')}`);
  const cf = deps.cf || cfClient(env, { fetch: deps.fetch });
  if (!a.apply) out('dry run: nothing is changed (add --apply)');

  if (cmd === 'list') {
    const p = await cf.policy(env.CF_ACCESS_GUEST_POLICY_ID);
    const emails = policyEmails(p).sort();
    const app = await cf.app(env.CF_ACCESS_PROD_APP_ID);
    const pol = attachPlan(app.policies, env.CF_ACCESS_GUEST_POLICY_ID);
    if (a.json) { out(JSON.stringify({ emails, seats: emails.length, max: SEATS.max, app: app.name, policies: pol.before.map(x => x.name), guestsAttached: !pol.changed })); return EXIT.ok; }
    out(`${GUEST_POLICY}: ${seatCheck(emails.length).note}`);
    emails.forEach(e => out('  ' + e));
    out(`${app.name} (${appHost(app)}): ${pol.before.map(x => x.name).join(', ') || '(no policies)'}${pol.changed ? `; ${GUEST_POLICY} NOT attached: run setup` : ''}`);
    return EXIT.ok;
  }

  if (cmd === 'add' || cmd === 'remove') {
    const email = normEmail(a.email);
    const r = await changeGuests(cf, env, a, cmd === 'add' ? xs => [...xs, email] : xs => xs.filter(x => x !== email), out);
    const changed = r.before.join() !== r.after.join();
    out(changed ? `${a.apply ? '' : 'would '}${cmd} ${email}` : `${email} ${cmd === 'add' ? 'is already on' : 'is not on'} the guests policy`);
    // remove: the person's approved request becomes removed, so they can ask again (needs the agent login)
    if (cmd === 'remove') {
      if (missingEnv(env, 'homeos-agent').length) { out('database not updated: TASKSDB_* agent login missing'); return EXIT.ok; }
      const c = await (deps.connect || connect)(env, 'homeos-agent', { via: 'script:access-cli' });
      try {
        const q = await c.rest('POST', 'rpc/access_requests', { p_status: 'approved' });
        if (!q.ok) throw new TdError(errorExit(q.err), q.err.message);
        for (const req of (q.json || []).filter(x => x.email === email)) {
          out(`${a.apply ? '' : 'would mark '}request ${req.id} removed`);
          if (a.apply) { const d = await c.rest('POST', 'rpc/access_request_decided', { p_id: req.id, p_status: 'removed' }); if (!d.ok) throw new TdError(errorExit(d.err), d.err.message); }
        }
      } finally { await c.close(); }
    }
    return EXIT.ok;
  }

  if (cmd === 'setup') {
    const app = await cf.app(env.CF_ACCESS_PROD_APP_ID);
    const host = appHost(app);
    if (!host) throw new TdError(EXIT.error, 'the production app has no domain');
    const pols = await cf.policies();
    let guest = env.CF_ACCESS_GUEST_POLICY_ID ? pols.find(p => p.id === env.CF_ACCESS_GUEST_POLICY_ID) : pols.find(p => p.name === GUEST_POLICY);
    let bypass = pols.find(p => p.name === BYPASS_POLICY);
    let reqApp = (await cf.apps()).find(x => x.name === REQUEST_APP);
    out(`production app: ${app.name} (${host})`);
    if (!guest) {
      out(`${a.apply ? 'create' : 'would create'} policy "${GUEST_POLICY}" (allow, emails, session 730h)`);
      if (a.apply) guest = await cf.createPolicy({ name: GUEST_POLICY, decision: 'allow', include: withEmails([], []), exclude: [], require: [], session_duration: '730h' });
    } else out(`policy "${GUEST_POLICY}": ${guest.id}`);
    if (!bypass) {
      out(`${a.apply ? 'create' : 'would create'} policy "${BYPASS_POLICY}" (bypass, everyone)`);
      if (a.apply) bypass = await cf.createPolicy({ name: BYPASS_POLICY, decision: 'bypass', include: [{ everyone: {} }], exclude: [], require: [] });
    } else out(`policy "${BYPASS_POLICY}": ${bypass.id}`);
    if (!reqApp) {
      out(`${a.apply ? 'create' : 'would create'} app "${REQUEST_APP}" for ${REQUEST_PATHS.map(p => host + p).join(', ')}, policy "${BYPASS_POLICY}"`);
      if (a.apply) reqApp = await cf.createApp({ name: REQUEST_APP, type: 'self_hosted', domain: host + REQUEST_PATHS[0],
        destinations: REQUEST_PATHS.map(p => ({ type: 'public', uri: host + p })), session_duration: '24h', app_launcher_visible: false,
        policies: [{ id: bypass.id, precedence: 1 }] });
    } else out(`app "${REQUEST_APP}": ${reqApp.id}`);
    let phoneApp = (await cf.apps()).find(x => x.name === PHONE_APP);
    if (!phoneApp) {
      out(`${a.apply ? 'create' : 'would create'} app "${PHONE_APP}" for ${PHONE_PATHS.map(p => host + p).join(', ')}, policy "${BYPASS_POLICY}"`);
      if (a.apply) phoneApp = await cf.createApp({ name: PHONE_APP, type: 'self_hosted', domain: host + PHONE_PATHS[0],
        destinations: PHONE_PATHS.map(p => ({ type: 'public', uri: host + p })), session_duration: '24h', app_launcher_visible: false,
        policies: [{ id: bypass.id, precedence: 1 }] });
    } else out(`app "${PHONE_APP}": ${phoneApp.id}`);
    // G6: the production app keeps every policy it has; the guests policy is added after the last
    const plan = attachPlan(app.policies, guest ? guest.id : '(new)');
    out('production app policies before: ' + (plan.before.map(p => p.name).join(', ') || '(none)'));
    out('production app policies after:  ' + plan.after.map(p => p.name).join(', '));
    if (a.apply && plan.changed) {
      await cf.updateApp(app.id, appBody(app, plan.after));
      const now = await cf.app(app.id);
      const lost = lostPolicies(plan.before, now.policies);
      if (lost.length) throw new TdError(EXIT.conflict, `STOP: the production app lost ${lost.join(', ')}; restore them in Zero Trust → Access → Applications`);
      if (!(now.policies || []).some(p => p.id === guest.id)) throw new TdError(EXIT.error, 'the guests policy is not on the production app');
      out('verified: every earlier policy is still on the production app, and the guests policy is on it');
    }
    if (a.apply && guest && !env.CF_ACCESS_GUEST_POLICY_ID) out(`add to the env file: CF_ACCESS_GUEST_POLICY_ID=${guest.id}`);
    return EXIT.ok;
  }

  // process: the Access requests list as homeos-agent
  const c = await (deps.connect || connect)(env, 'homeos-agent', { via: 'script:access-cli' });
  try {
    const now = deps.now ? deps.now() : new Date();
    const lr = await c.rest('GET', 'lists?select=id,slug,archived_at&slug=eq.access-requests');
    if (!lr.ok) throw new TdError(errorExit(lr.err), lr.err.message);
    if (lr.json.length !== 1) throw new TdError(EXIT.error, lr.json.length ? 'several lists are called access-requests' : 'list access-requests not found (db/015)');
    if (lr.json[0].archived_at) throw new TdError(EXIT.archived, 'list archived: access-requests');
    const listId = lr.json[0].id;
    const q = await c.rest('POST', 'rpc/access_requests', {});
    if (!q.ok) throw new TdError(errorExit(q.err), q.err.message);
    const reqs = Object.fromEntries((q.json || []).map(x => [x.id, x]));
    const ir = await c.getAll(`items?select=id,num,title,body_md,details,status&list_id=eq.${listId}&deleted_at=is.null&status=not.in.(done,cancelled)&order=num`);
    if (!ir.ok) throw new TdError(errorExit(ir.err), ir.err.message);
    const plans = ir.json.map(it => ({ it, req: reqs[(it.details || {}).access_request_id], p: planTask(it, reqs[(it.details || {}).access_request_id]) }));
    for (const x of plans) out(`A${x.it.num} ${x.req ? x.req.email : x.it.title}: ${x.p.action}${x.p.why ? ' (' + x.p.why + ')' : ''}`);
    const approve = plans.filter(x => x.p.action === 'approve');
    if (approve.length) await changeGuests(cf, env, a, xs => [...xs, ...approve.map(x => x.req.email)], out);
    if (!a.apply) return EXIT.ok;
    for (const x of plans.filter(y => ['approve', 'decline', 'close'].includes(y.p.action))) {
      if (x.p.action !== 'close') {
        const d = await c.rest('POST', 'rpc/access_request_decided', { p_id: x.req.id, p_status: x.p.decision });
        if (!d.ok) throw new TdError(errorExit(d.err), `A${x.it.num}: ${d.err.message}`);
      }
      const u = await c.rest('PATCH', 'items?id=eq.' + x.it.id, { status: 'done', body_md: x.it.body_md + closingLine(x.p.decision, now) }, { Prefer: 'return=minimal' });
      if (!u.ok) throw new TdError(errorExit(u.err), `A${x.it.num}: ${u.err.message}`);
      out(`A${x.it.num} done`);
    }
    return EXIT.ok;
  } finally { await c.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => {
    console.error('access: ' + (e instanceof TdError ? e.message : 'unexpected error: ' + (e && e.message)));
    process.exitCode = e instanceof TdError ? e.exit : EXIT.error;
  });
}
