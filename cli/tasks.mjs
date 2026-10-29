#!/usr/bin/env node
// TasksDashboard CLI: add-task, add-reminder, overdue, do, restore-list, link, unlink against TasksDashboardDB.
// node cli/tasks.mjs <command> [options]; README "CLI" lists the options and exit codes. Never prints an env value.
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { EXIT, TdError, readEnv, missingEnv, connect, loadCore, errorExit, parseWhen, localStamp } from './lib.mjs';

const TZ = 'Europe/Lisbon';
const COMMANDS = ['add-task', 'add-reminder', 'overdue', 'do', 'restore-list', 'link', 'unlink'];
const FLAGS = new Set(['json', 'dry-run', 'needs-review', 'help']);
const USAGE = `usage: node cli/tasks.mjs <command> [options]
  add-task      --title T [--list LIST] [--q A|B|C|D] [--due WHEN] [--tags a,b] [--owner HANDLE|none] [--notify a,b] [--body MD] [--priority 0-5] [--confidence 0-1] [--needs-review]
                [--start WHEN] [--parent REF] [--after REF]
  add-reminder  --title T --due WHEN [--list LIST] [--owner HANDLE|none] [--notify a,b] [--body MD]
  overdue       [--limit 10] [--list slug]
  do            [--list slug] [--limit N]
  restore-list  --list slug                      (people only: --as maksym or anastasiia)
  link          REF --parent REF | --after REF   (task links, db/018: REF becomes a child of, or comes after, the other)
  unlink        REF --parent REF | --after REF   (removes that link)
common: --env FILE  --as HANDLE (default homeos-agent)  --for HANDLE  --via CHANNEL (default script:tasks-cli)  --run-id ID  --json  --dry-run
WHEN: YYYY-MM-DD (09:00) or YYYY-MM-DD HH:mm in ${TZ}, or ISO with an offset
LIST: a slug, or OWNER/slug when two owners use the same slug (slugs are unique per owner)
REF: LIST#num, a task by its list and number (backlog#12, maksym/backlog#12)
who: --owner and --notify take people's handles; maksym, anastasiia or shared in --tags set the owner instead (shared = none)
exit: 0 ok, 1 error, 2 env missing, 3 conflict, 4 duplicate, 5 sensitive, 6 unreachable, 7 auth failed, 8 list archived or not restorable, 9 limit reached`;

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
export const taskKey = (title, due, listSlug) => 'task:' + crypto.createHash('sha1').update(String(title).toLowerCase() + (due ? localStamp(due, TZ).day : '') + listSlug).digest('hex').slice(0, 12);
export const reminderKey = created => 'reminder:' + localStamp(created, TZ).minute;
export function line(t, lists) {
  const l = lists[t.list] || {};
  return [(l.name ? l.name[0].toUpperCase() : '?') + t.num, t.title, t.deadline ? localStamp(t.deadline, TZ).wall : '-', l.name || '?'].join(' · ');
}
const asJson = (t, lists) => ({ ref: ((lists[t.list] || {}).name || '?')[0].toUpperCase() + t.num, id: t.id, title: t.title, due_at: t.deadline ? t.deadline.toISOString() : null,
  list: (lists[t.list] || {}).slug || null, quadrant: t.q, status: t.status, sort_key: t.sortKey });
export function tagsOf(s) { return s ? [...new Set(String(s).split(',').map(x => x.trim()).filter(Boolean))] : []; }
// who an item is for is never a tag (multi-user: tags are private per person): maksym or anastasiia → owner, shared or
// both → no owner (both are told); returns { tags, owner } with owner undefined when no such tag was given
export const OWNER_TAGS = ['maksym', 'anastasiia', 'shared'];
export function ownerFromTags(tags) {
  const low = tags.map(t => String(t).toLowerCase());
  const people = ['maksym', 'anastasiia'].filter(p => low.includes(p));
  const owner = low.includes('shared') || people.length > 1 ? null : people.length === 1 ? people[0] : undefined;
  return { tags: tags.filter(t => !OWNER_TAGS.includes(String(t).toLowerCase())), owner };
}
// a list by slug, or owner/slug; several owners with that slug: household lists win, else an error naming owner/slug
export function findList(ls, ref, people) {
  const all = Object.values(ls);
  const m = String(ref).match(/^([^/]+)\/(.+)$/);
  const slug = m ? m[2] : String(ref), owner = m ? m[1].toLowerCase() : null;
  let hits = all.filter(l => l.slug === slug);
  if (owner) hits = hits.filter(l => ((people[l.owner_id] || {}).handle || '').toLowerCase() === owner);
  if (hits.length > 1) { const h = hits.filter(l => (people[l.owner_id] || {}).is_household); if (h.length) hits = h; }
  if (hits.length > 1) throw new TdError(EXIT.error, `several lists are called ${slug}: use OWNER/${slug} (${hits.map(l => ((people[l.owner_id] || {}).handle || '?') + '/' + l.slug).join(', ')})`);
  return hits[0];
}

async function lists(c) {
  const r = await c.getAll('lists?select=id,slug,name,default_category,archived_at,owner_id');
  if (!r.ok) throw new TdError(errorExit(r.err), r.err.message);
  return Object.fromEntries(r.json.map(l => [l.id, l]));
}
// profiles this login may read (own, household; 011 F2), by id
async function people(c) {
  const r = await c.rest('GET', 'profiles?select=id,handle,kind,is_household');
  if (!r.ok) throw new TdError(errorExit(r.err), r.err.message);
  return Object.fromEntries(r.json.map(p => [p.id, p]));
}
// a task by LIST#num (live, not deleted); errors name the reference only
export function parseRef(ref) {
  const m = String(ref || '').match(/^(.+)#(\d+)$/);
  if (!m) throw new TdError(EXIT.error, `a task reference is LIST#num: ${ref}`);
  return { list: m[1], num: Number(m[2]) };
}
async function itemByRef(c, ls, ppl, ref) {
  const p = parseRef(ref), l = findList(ls, p.list, ppl);
  if (!l) throw new TdError(EXIT.error, 'list not found: ' + p.list);
  const r = await c.rest('GET', `items?select=id,num,list_id,title&list_id=eq.${l.id}&num=eq.${p.num}&deleted_at=is.null`);
  if (!r.ok) throw new TdError(errorExit(r.err), r.err.message);
  if (!r.json.length) throw new TdError(EXIT.error, 'task not found: ' + ref);
  return r.json[0];
}
// --parent P: the task becomes a child of P; --after P: the task comes after P (rpc/link_items, rpc/unlink_items)
export function linkArgs(a) {
  if (a.parent !== undefined && a.after !== undefined) throw new TdError(EXIT.error, 'give --parent or --after, not both');
  if (a.parent !== undefined) return { other: a.parent, kind: 'parent' };
  if (a.after !== undefined) return { other: a.after, kind: 'depends_on' };
  return null;
}
async function linkRpc(c, fn, from, to, kind) {
  const r = await c.rest('POST', 'rpc/' + fn, { p_from: from, p_to: to, p_kind: kind });
  if (!r.ok) throw new TdError(errorExit(r.err), r.err.message);
  return r.json;
}
// every write first reads its list: an archived list is exit 8 and nothing is sent
function writable(l, slug) {
  if (!l) throw new TdError(EXIT.error, `list not found or not yours: ${slug}`);
  if (l.archived_at) throw new TdError(EXIT.archived, `list archived, restore it first: ${l.slug}`);
  return l;
}
async function liveItems(c, ls, extra = '') {
  const r = await c.getAll('items?select=*&deleted_at=is.null&status=not.in.(done,cancelled)' + extra);
  if (!r.ok) throw new TdError(errorExit(r.err), r.err.message);
  return r.json.filter(x => ls[x.list_id] && !ls[x.list_id].archived_at).map(c.core.rowToTask);
}
// the top of the item's quadrant (stored or derived), 1024 above the first card
async function topKey(c, ls, listId, item, now) {
  const items = await liveItems(c, ls, '&list_id=eq.' + listId);
  const q = c.core.deriveQuadrant(item, null, now);
  const keys = items.filter(t => c.core.deriveQuadrant(t, null, now) === q && t.sortKey !== null).map(t => t.sortKey);
  return keys.length ? c.core.sortBetween(null, Math.min(...keys)) : 0;
}
async function profileId(c, handle, flag = '--for') {
  if (!handle) return null;
  const r = await c.rest('GET', 'profiles?select=id,kind&handle=eq.' + encodeURIComponent(String(handle).toLowerCase()));
  if (!r.ok) throw new TdError(errorExit(r.err), r.err.message);
  if (!r.json.length || r.json[0].kind !== 'human') throw new TdError(EXIT.error, `${flag} needs a person's handle: ${handle}`);
  return r.json[0].id;
}
async function insert(c, body, opts, ls) {
  if (opts['dry-run']) return { dry: true, body };
  const r = await c.rest('POST', 'items', body, { Prefer: 'return=representation' });
  if (!r.ok) throw new TdError(errorExit(r.err), r.err.kind === 'duplicate' ? `duplicate: ${body.dedup_key} is stored already` : r.err.message);
  return { item: c.core.rowToTask(r.json[0]) };
}

export async function run(argv, out = console.log) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  if (a.help || !COMMANDS.includes(cmd)) { out(USAGE); return cmd || a.help ? (a.help ? EXIT.ok : EXIT.error) : EXIT.error; }
  const env = readEnv(a.env);
  const as = a.as || 'homeos-agent';
  const miss = missingEnv(env, as);
  if (miss.length) throw new TdError(EXIT.env, 'env missing: ' + miss.join(', ') + (a.env ? '' : ' (pass --env <file>)'));
  const c = await connect(env, as, { core: loadCore(), via: a.via || 'script:tasks-cli', runId: a['run-id'] });
  try { return await command(a, cmd, c, out); } finally { await c.close(); }
}

async function command(a, cmd, c, out) {
  const core = c.core, now = Date.now();
  const ls = await lists(c);
  const ppl = await people(c);
  const bySlug = (_, ref) => findList(ls, ref, ppl);
  const print = (items, title) => {
    if (a.json) out(JSON.stringify(items.map(t => asJson(t, ls)), null, 2));
    else { if (title) out(title); items.forEach(t => out(line(t, ls))); if (!items.length) out('(none)'); }
  };
  const common = async (body, l) => Object.assign(body, {
    list_id: l.id, created_via: a.via || 'script:tasks-cli', on_behalf_of: await profileId(c, a.for), run_id: a['run-id'] || null,
  });

  if (cmd === 'add-task' || cmd === 'add-reminder') {
    if (!a.title || !String(a.title).trim()) throw new TdError(EXIT.error, '--title is required');
    const reminder = cmd === 'add-reminder';
    const due = parseWhen(a.due, TZ), start = parseWhen(a.start, TZ);
    const lk = linkArgs(a);
    const other = lk ? await itemByRef(c, ls, ppl, lk.other) : null;
    if (reminder && !due) throw new TdError(EXIT.error, '--due is required for a reminder');
    const cats = await c.rest('GET', 'categories?select=slug,default_list_id');
    if (!cats.ok) throw new TdError(errorExit(cats.err), cats.err.message);
    const cat = reminder ? 'reminder' : 'task';
    const defaultList = (cats.json.find(x => x.slug === cat) || {}).default_list_id;
    const l = writable(a.list ? bySlug(ls, a.list) : ls[defaultList], a.list || cat + ' default list');
    if (a.q && !core.QS.includes(a.q)) throw new TdError(EXIT.error, '--q is one of A, B, C, D');
    const priority = a.priority === undefined ? null : Number(a.priority);
    if (priority !== null && !(Number.isInteger(priority) && priority >= 0 && priority <= 5)) throw new TdError(EXIT.error, '--priority is 0 to 5');
    const conf = a.confidence === undefined ? null : Number(a.confidence);
    if (conf !== null && !(conf >= 0 && conf <= 1)) throw new TdError(EXIT.error, '--confidence is 0 to 1');
    const draft = { qStored: a.q || null, priority, category: cat, deadline: due, pin: undefined };
    const who = ownerFromTags(tagsOf(a.tags));
    const ownerArg = a.owner !== undefined ? a.owner : who.owner === null ? 'none' : who.owner;
    const owner_id = ownerArg === undefined || /^none$/i.test(ownerArg) ? null : await profileId(c, ownerArg, '--owner');
    const notify = [];
    for (const h of tagsOf(a.notify)) { await profileId(c, h, '--notify'); notify.push(h.toLowerCase()); }
    const body = await common({
      category: cat, title: String(a.title).trim(), body_md: a.body || '', tags: who.tags, quadrant: a.q || null, priority, owner_id,
      due_at: due ? due.toISOString() : null, start_at: start ? start.toISOString() : null, sort_key: await topKey(c, ls, l.id, draft, now),
      dedup_key: reminder ? reminderKey(new Date(now)) : taskKey(String(a.title).trim(), due, l.slug),
      details: notify.length ? { notify: [...new Set(notify)] } : {},
    }, l);
    if (conf !== null) body.ai_confidence = conf;
    if (a['needs-review']) body.review_state = 'needs_review';
    const r = await insert(c, body, a, ls);
    if (r.dry) { out(a.json ? JSON.stringify(r.body, null, 2) : 'dry run, nothing sent: ' + body.title + ' -> ' + l.slug + ' (' + body.dedup_key + ')'); return EXIT.ok; }
    // task links: the new task becomes a child of, or comes after, the task named by --parent / --after
    if (lk) await linkRpc(c, 'link_items', r.item.id, other.id, lk.kind);
    print([r.item], a.json ? null : 'added');
    return EXIT.ok;
  }
  if (cmd === 'link' || cmd === 'unlink') {
    const lk = linkArgs(a);
    if (!a._[1] || !lk) throw new TdError(EXIT.error, cmd + ' needs REF and --parent REF or --after REF');
    const self = await itemByRef(c, ls, ppl, a._[1]), other = await itemByRef(c, ls, ppl, lk.other);
    writable(ls[self.list_id], a._[1]);
    const what = a._[1] + (lk.kind === 'parent' ? ' under ' : ' after ') + lk.other;
    if (a['dry-run']) { out('dry run, nothing sent: ' + cmd + ' ' + what); return EXIT.ok; }
    const res = await linkRpc(c, cmd === 'link' ? 'link_items' : 'unlink_items', self.id, other.id, lk.kind);
    out(a.json ? JSON.stringify({ [cmd]: res, from: self.id, to: other.id, kind: lk.kind }) : (cmd === 'link' ? 'linked ' : res === 'none' ? 'no such link: ' : 'unlinked ') + what);
    return EXIT.ok;
  }
  if (cmd === 'overdue') {
    const l = a.list ? bySlug(ls, a.list) : null;
    if (a.list && !l) throw new TdError(EXIT.error, 'list not found: ' + a.list);
    const items = await liveItems(c, ls, '&due_at=lt.' + encodeURIComponent(new Date(now).toISOString()));
    print(core.overdueItems(items, now, { limit: Number(a.limit) || 10, list: l && l.id }));
    return EXIT.ok;
  }
  if (cmd === 'do') {
    const l = a.list ? bySlug(ls, a.list) : null;
    if (a.list && !l) throw new TdError(EXIT.error, 'list not found: ' + a.list);
    // Urgency window and Do limit: the login's own settings (preferences); with --for, that person's (db/012
    // urgency_settings, household profiles for household logins and agents); else the defaults (agents)
    let settings = core.readSettings(null);
    if (a.for) {
      const u = await c.rest('POST', 'rpc/urgency_settings', { p_profile: await profileId(c, a.for) });
      if (u.ok && u.json) settings = core.readSettings(Object.fromEntries(Object.entries(u.json).filter(([, v]) => v !== null)));
    } else {
      const p = await c.rest('GET', 'preferences?select=prefs&profile_id=eq.' + c.uid + '&app=eq.tasksdashboard');
      if (p.ok && p.json.length) settings = core.readSettings(p.json[0].prefs && p.json[0].prefs.settings);
    }
    const items = await liveItems(c, ls, l ? '&list_id=eq.' + l.id : '');
    const top = core.topDo(items, { now, settings, list: l && l.id, limit: a.limit === undefined ? undefined : Number(a.limit) });
    const order = Object.keys(top).sort((x, y) => ls[x].name.localeCompare(ls[y].name));
    if (a.json) out(JSON.stringify(Object.fromEntries(order.map(id => [ls[id].slug, top[id].map(t => asJson(t, ls))])), null, 2));
    else if (!order.length) out('(none)');
    else order.forEach(id => { out(ls[id].name); top[id].forEach(t => out('  ' + line(t, ls))); });
    return EXIT.ok;
  }
  if (cmd === 'restore-list') {
    if (!a.list) throw new TdError(EXIT.error, '--list is required');
    const l = bySlug(ls, a.list);
    if (!l || !l.archived_at) throw new TdError(EXIT.archived, l ? `list is not archived: ${a.list}` : `list not found: ${a.list}`);
    if (a['dry-run']) { out('dry run, nothing sent: restore ' + l.slug); return EXIT.ok; }
    const r = await c.rest('PATCH', 'lists?id=eq.' + l.id, { archived_at: null }, { Prefer: 'return=representation' });
    if (!r.ok) throw new TdError(errorExit(r.err), r.err.message);
    if (r.json.length !== 1) throw new TdError(EXIT.error, 'not allowed: only a person who owns the list restores it');
    out(a.json ? JSON.stringify({ restored: l.slug }) : 'restored ' + l.name);
    return EXIT.ok;
  }
  return EXIT.error;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => {
    console.error('tasks: ' + (e instanceof TdError ? e.message : 'unexpected error: ' + (e && e.message)));
    process.exitCode = e instanceof TdError ? e.exit : EXIT.error;
  });
}
