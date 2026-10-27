// Shared Node helpers for the CLI and the e2e runner: env file, the app's core (one rule set), sign-in, REST, paging.
// No dependencies. Never prints an env value, a token or a password.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_HTML = path.join(HERE, '..', 'TasksDashboard.html');
export const EXIT = { ok: 0, error: 1, env: 2, conflict: 3, duplicate: 4, sensitive: 5, unreachable: 6, auth: 7, archived: 8 };

// <script id="core"> from TasksDashboard.html, run in a sandbox: the CLI and the tests use the page's own rules
export function loadCore(htmlPath = APP_HTML) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/<script id="core">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script id="core"> in ' + path.basename(htmlPath));
  // a function scope in this realm (not a new context), so arrays and objects from the core compare like local ones
  const holder = {};
  new vm.Script('(function (self) {' + m[1] + '\n})', { filename: 'TasksDashboard.html#core' }).runInThisContext()(holder);
  return holder.TDCore;
}

// KEY=value lines; quotes stripped; # comments. Values stay in memory only.
export function readEnv(file) {
  const env = {};
  if (file) {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
      env[m[1]] = v;
    }
  }
  for (const k of Object.keys(process.env)) if (k.startsWith('TASKSDB_') && !(k in env)) env[k] = process.env[k];
  return env;
}
// TASKSDB_<HANDLE>_EMAIL / _PASSWORD; the two agents use AGENT and TELEGRAM
export const loginName = handle => ({ 'homeos-agent': 'AGENT', 'telegram-bot': 'TELEGRAM' }[handle] || String(handle).toUpperCase().replace(/-/g, '_'));
export function missingEnv(env, handle) {
  const need = ['TASKSDB_URL', 'TASKSDB_ANON_KEY'];
  if (handle) need.push(`TASKSDB_${loginName(handle)}_EMAIL`, `TASKSDB_${loginName(handle)}_PASSWORD`);
  return need.filter(k => !env[k]);
}

export class TdError extends Error {
  constructor(exit, message) { super(message); this.exit = exit; }
}
const exitFor = err => ({ network: EXIT.unreachable, server: EXIT.unreachable, credentials: EXIT.auth, auth: EXIT.auth, session: EXIT.auth, rate: EXIT.auth,
  duplicate: EXIT.duplicate, sensitive: EXIT.sensitive }[err.kind] || (err.kind === 'denied' && /archived/i.test(err.message) ? EXIT.archived : EXIT.error));
export const errorExit = err => exitFor(err);

// a client for one login: password grant, then REST with apikey + bearer and the audit headers
export async function connect(env, handle, opts = {}) {
  const core = opts.core || loadCore();
  // the same checks as the page's config: https (or localhost), a publishable key, never a secret one
  const cfg = core.readAppConfig({ supabaseUrl: env.TASKSDB_URL, publishableKey: env.TASKSDB_ANON_KEY });
  if (!cfg.config) throw new TdError(EXIT.env, 'env invalid: ' + cfg.errors.map(e => e.replace('supabaseUrl', 'TASKSDB_URL').replace('publishableKey', 'TASKSDB_ANON_KEY')).join('; '));
  const url = cfg.config.supabaseUrl, key = cfg.config.publishableKey;
  const name = loginName(handle);
  let r;
  try {
    r = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: core.headers(key, null),
      body: JSON.stringify({ email: env[`TASKSDB_${name}_EMAIL`], password: env[`TASKSDB_${name}_PASSWORD`] }) });
  } catch (e) { throw new TdError(EXIT.unreachable, 'database unreachable'); }
  const grant = await r.json().catch(() => null);
  const session = r.status === 200 ? core.sessionFromGrant(grant, Date.now()) : null;
  if (!session) { const err = core.restError(r.status, grant); throw new TdError(exitFor(err) === EXIT.error ? EXIT.auth : exitFor(err), `sign-in as ${handle} failed: ${err.message}`); }
  const extra = { 'x-homeos-via': opts.via || 'script:tasks-cli' };
  if (opts.runId) extra['x-homeos-run-id'] = opts.runId;
  async function rest(method, p, body, more) {
    let res;
    try {
      res = await fetch(`${url}/rest/v1/${p}`, { method, headers: core.headers(key, session, Object.assign({}, extra, more || {})), body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) { return { ok: false, status: 0, json: null, err: core.restError(0, null) }; }
    const text = await res.text(); let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = text; }
    const out = { ok: res.ok, status: res.status, json };
    if (!res.ok) out.err = core.restError(res.status, json);
    return out;
  }
  async function getAll(p) {
    const out = [];
    for (let off = 0; ; off += core.PAGE) {
      const r2 = await rest('GET', p + (p.includes('?') ? '&' : '?') + core.pageParams(off));
      if (!r2.ok) return r2;
      out.push(...r2.json);
      if (r2.json.length < core.PAGE) return { ok: true, json: out };
    }
  }
  // ends this session on the server (local scope: other sessions of the login stay)
  async function close() {
    try { await fetch(`${url}/auth/v1/logout?scope=local`, { method: 'POST', headers: core.headers(key, session) }); } catch (e) {}
  }
  return { core, session, uid: session.user.id, handle, rest, getAll, close, url, key };
}
// the grant only (the e2e runner seeds the page's td.auth with its refresh token)
export async function grant(env, handle, core = loadCore()) {
  const c = await connect(env, handle, { core });
  return c.session;
}

// wall time in a time zone -> instant. Accepts 2026-11-02, 2026-11-02 18:30, 2026-11-02T18:30 and full ISO with an offset.
export function parseWhen(s, timeZone = 'Europe/Lisbon', dateOnlyTime = '09:00') {
  if (s === undefined || s === null || s === '') return null;
  const str = String(s).trim();
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(str) && !Number.isNaN(Date.parse(str))) return new Date(str);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  if (!m) throw new TdError(EXIT.error, `not a date: use YYYY-MM-DD or YYYY-MM-DD HH:mm (${timeZone})`);
  const [hh, mi] = m[4] ? [m[4], m[5]] : dateOnlyTime.split(':');
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +hh, +mi);
  const off = at => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at; };
  let t = wall - off(wall);
  t = wall - off(t);
  return new Date(t);
}
// yyyy-mm-dd and yyyy-mm-dd--hh-mm of an instant in a time zone
export function localStamp(d, timeZone = 'Europe/Lisbon') {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minute: `${p.year}-${p.month}-${p.day}--${p.hour}-${p.minute}`, wall: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` };
}
