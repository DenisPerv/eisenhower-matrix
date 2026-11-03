#!/usr/bin/env node
// TasksDashboard CLI: add-task, add-reminder, overdue, do, restore-list, link, unlink, find, show, update, done, reopen, cancel
// against TasksDashboardDB.
// node cli/tasks.mjs <command> [options]; README "CLI" lists the options and exit codes. Never prints an env value.
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { EXIT, TdError, readEnv, missingEnv, connect, loadCore, errorExit, parseWhen, localStamp } from './lib.mjs';

const TZ = 'Europe/Lisbon';
const COMMANDS = ['add-task', 'add-reminder', 'overdue', 'do', 'restore-list', 'link', 'unlink', 'find', 'show', 'update', 'done', 'reopen', 'cancel'];
const FLAGS = new Set(['json', 'dry-run', 'needs-review', 'help', 'all', 'top']);
const USAGE = `usage: node cli/tasks.mjs <command> [options]
  add-task      --title T [--list LIST] [--q A|B|C|D] [--due WHEN] [--tags a,b] [--owner HANDLE|none] [--notify a,b] [--body MD] [--confidence 0-1] [--needs-review]
                [--start WHEN] [--parent REF] [--after REF]
  add-reminder  --title T --due WHEN [--list LIST] [--owner HANDLE|none] [--notify a,b] [--body MD]
  overdue       [--limit 10] [--list slug]
  do            [--list slug] [--limit N]
  restore-list  --list slug                      (people only: --as maksym or anastasiia)
  link          REF --parent REF | --after REF   (task links, db/018: REF becomes a child of, or comes after, the other)
  unlink        REF --parent REF | --after REF   (removes that link)
  find          WORDS | REF | --key KEY  [--in LIST] [--all]   (every match is listed; never writes)
  show          TARGET
  update        TARGET [--title T] [--body MD] [--due WHEN|none] [--start WHEN|none] [--q A|B|C|D] [--top] [--owner HANDLE|none]
                [--tags a,b] [--add-tag t] [--remove-tag t] [--list LIST]   (tasks and reminders; a versioned write)
  done | reopen | cancel  TARGET                 (tasks and reminders; cancel is also delete: nothing is deleted)
common: --env FILE  --as HANDLE (default homeos-agent)  --for HANDLE  --via CHANNEL (default script:tasks-cli)  --run-id ID  --json  --dry-run
WHEN: YYYY-MM-DD (09:00) or YYYY-MM-DD HH:mm in ${TZ}, or ISO with an offset
LIST: a slug, or OWNER/slug when two owners use the same slug (slugs are unique per owner)
REF: LIST#num, a task by its list and number (backlog#12, maksym/backlog#12)
TARGET: REF, --key KEY, or title words with exactly one match (open items; closed ones for reopen; --in LIST narrows;
        test lists _… only with --in); several matches are listed with exit 10 and nothing is written
who: --owner and --notify take people's handles; maksym, anastasiia or shared in --tags set the owner instead (shared = none)
exit: 0 ok, 1 error, 2 env missing, 3 conflict, 4 duplicate, 5 sensitive, 6 unreachable, 7 auth failed, 8 list archived or not restorable, 9 limit reached,
      10 several matches (listed, nothing written)`;

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

// ---- find, show, update, done, reopen, cancel (the rules of HomeOS /workitem-board-update after the tags round) ----
const ITEM_SELECT = 'id,list_id,num,category,title,body_md,status,quadrant,urgent_pin,sort_key,due_at,start_at,owner_id,details,review_state,dedup_key,version,updated_at';
const WRITABLE = ['task', 'reminder'];
const CLOSED_ST = ['done', 'cancelled'];
const REF_RE = /^.+#\d+$/;
const NIL = '00000000-0000-0000-0000-000000000000';

// the same screen as the database's assert_no_sensitive (db/002): card numbers (Luhn), IBANs, ID numbers. null = clean
function luhnOk(d) {
  let s = 0;
  for (let i = 0; i < d.length; i++) { let n = +d[d.length - 1 - i]; if (i % 2) { n *= 2; if (n > 9) n -= 9; } s += n; }
  return d.length >= 12 && s % 10 === 0;
}
export function sensitiveCheck(text) {
  if (text === null || text === undefined) return null;
  const t = String(text).replace(/https?:\/\/\S+/gi, ' ');
  const card = /(?<![0-9])([2-6][0-9]{12,18}|[2-6][0-9]{3}(?:[ -][0-9]{4}){3}|3[47][0-9]{2}[ -][0-9]{6}[ -][0-9]{5})(?![0-9])/g;
  for (const m of t.matchAll(card)) if (luhnOk(m[1].replace(/\D/g, ''))) return 'looks like a card number';
  if (/\b[A-Z]{2}[0-9]{2}( ?[A-Z0-9]{4}){3,7}( ?[A-Z0-9]{1,4})?\b/.test(t)) return 'looks like an IBAN';
  if (/\b(nif|niss|nipc|passport|passaporte|cart[aã]o de cidad[aã]o|citizen card|id card|id number)\s*(no\.?|n\.?º|number|#|:)?\s*[a-z]{0,2}[0-9]{6,}/i.test(t))
    return 'looks like an ID number';
  return null;
}
// title words for a search: lower case, letters, digits and hyphens, two letters or more, at most 6
export function searchWords(q) {
  const w = String(q || '').toLowerCase().split(/\s+/).map(x => x.replace(/[^\p{L}\p{N}-]/gu, '')).filter(x => x.length > 1).slice(0, 6);
  if (!w.length) throw new TdError(EXIT.error, 'give at least one title word of two letters or more');
  return w;
}
// --due: none clears; a bare date keeps the item's time of day (none yet: 09:00 for a reminder, 18:00 otherwise)
export function dueValue(raw, row) {
  if (/^none$/i.test(String(raw))) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) {
    const time = row.due_at ? localStamp(new Date(row.due_at), TZ).wall.slice(11) : row.category === 'reminder' ? '09:00' : '18:00';
    return parseWhen(`${raw} ${time}`, TZ);
  }
  return parseWhen(raw, TZ);
}
// --start: none clears; a bare date is 09:00
export const startValue = raw => /^none$/i.test(String(raw)) ? null : parseWhen(raw, TZ);
// the sort_key that puts the item first in quadrant q of the list (a task's priority is its position in its quadrant):
// SPACING above the first open card with a key (stored or derived quadrant), 0 when none has one; null = it is first already
export function topSortKey(core, row, peers, q, now, settings = null) {
  const keys = peers.filter(x => x.id !== row.id && !CLOSED_ST.includes(x.status) && typeof x.sort_key === 'number'
    && core.deriveQuadrant(core.rowToTask(x), settings, now) === q).map(x => x.sort_key);
  const first = keys.length ? Math.min(...keys) : null;
  if (typeof row.sort_key === 'number' && (first === null || row.sort_key < first)) return null;
  return core.sortBetween(null, first);
}
// a list's reference: its slug, or owner/slug when another list this login reads has the same slug
function listRef(l, ls, ppl) {
  if (!l) return '?';
  const twins = Object.values(ls).filter(x => x.slug === l.slug).length > 1;
  return twins ? `${(ppl[l.owner_id] || {}).handle || '?'}/${l.slug}` : l.slug;
}
const itemRef = (row, ls, ppl) => `${listRef(ls[row.list_id], ls, ppl)}#${row.num}`;
export function itemLine(row, ls, ppl) {
  const due = row.due_at ? ' · due ' + localStamp(new Date(row.due_at), TZ).wall : '';
  return `${itemRef(row, ls, ppl)} · ${row.category} · ${row.status} · ${row.title}${due}${row.quadrant ? ' · ' + row.quadrant : ''}`;
}
const rowJson = (row, ls, ppl) => ({ ref: itemRef(row, ls, ppl), id: row.id, list: (ls[row.list_id] || {}).slug || null, num: row.num, category: row.category,
  status: row.status, title: row.title, due_at: row.due_at || null, quadrant: row.quadrant || null, dedup_key: row.dedup_key || null, version: row.version });

async function get(c, p, what) {
  const r = await c.rest('GET', p);
  if (!r.ok) throw new TdError(errorExit(r.err), `${what}: ${r.err.message}`);
  return r.json;
}
// items whose title holds every word: open ones (closed for reopen, all with --all); test lists only when --in names one
async function search(c, ls, ppl, words, { closed = false, all = false, inList = null } = {}) {
  let scope = Object.values(ls).filter(l => !c.core.isTestList(l));
  if (inList) { const l = findList(ls, inList, ppl); if (!l) throw new TdError(EXIT.error, 'list not found: ' + inList); scope = [l]; }
  let p = `items?select=${ITEM_SELECT}&deleted_at=is.null&list_id=in.(${scope.map(l => l.id).join(',') || NIL})`;
  p += `&and=(${searchWords(words).map(w => `title.ilike.*${encodeURIComponent(w)}*`).join(',')})`;
  if (!all) p += closed ? `&status=in.(${CLOSED_ST.join(',')})` : `&status=not.in.(${CLOSED_ST.join(',')})`;
  return get(c, p + '&order=updated_at.desc&limit=10', 'find');
}
// the items REF, --key or title words name: { rows, what, exact } (exact = REF or key, not a title search)
async function lookup(c, a, ls, ppl, { closed = false, all = false } = {}) {
  const words = a._.slice(1).join(' ').trim();
  if ((a.key !== undefined) === !!words) throw new TdError(EXIT.error, 'name the item: LIST#num, --key KEY or title words');
  let rows, what;
  if (a.key !== undefined) {
    what = 'key ' + a.key;
    rows = await get(c, `items?select=${ITEM_SELECT}&dedup_key=eq.${encodeURIComponent(a.key)}&deleted_at=is.null`, 'read item');
  } else if (REF_RE.test(words)) {
    what = words;
    const p = parseRef(words), l = findList(ls, p.list, ppl);
    if (!l) throw new TdError(EXIT.error, 'list not found: ' + p.list);
    rows = await get(c, `items?select=${ITEM_SELECT}&list_id=eq.${l.id}&num=eq.${p.num}&deleted_at=is.null`, 'read item');
  } else {
    what = `"${words}"`;
    rows = await search(c, ls, ppl, words, { closed, all, inList: a.in });
  }
  return { rows: rows.filter(x => ls[x.list_id]), what, exact: a.key !== undefined || REF_RE.test(words) };
}
// the one item a command is about (TARGET): no match exit 1, several matches listed with exit 10; nothing written either way
async function resolveTarget(c, a, ls, ppl, out, { closed = false } = {}) {
  const { rows, what, exact } = await lookup(c, a, ls, ppl, { closed });
  if (!rows.length) throw new TdError(EXIT.error, `no ${exact ? '' : closed ? 'closed ' : 'open '}item matches ${what}; nothing written`);
  if (rows.length > 1) {
    if (a.json) out(JSON.stringify({ candidates: rows.map(x => rowJson(x, ls, ppl)) }, null, 2));
    else { out(`${rows.length} items match; nothing written. Name one with LIST#num:`); rows.forEach(x => out('  ' + itemLine(x, ls, ppl))); }
    throw new TdError(EXIT.ambiguous, `several items match ${what}`);
  }
  return rows[0];
}
// a change needs an open list and a task or reminder
function changeable(row, ls, ppl) {
  const l = writable(ls[row.list_id], itemRef(row, ls, ppl));
  if (!WRITABLE.includes(row.category)) throw new TdError(EXIT.error, `${itemRef(row, ls, ppl)} is a ${row.category}: only tasks and reminders are changed here; nothing written`);
  return l;
}
// topic tags on an item (item_tags, live rows): [{ tag_id, name }]
async function itemTags(c, id) {
  const r = await get(c, `item_tags?select=tag_id,tags(name,tag_list_id)&item_id=eq.${id}&removed_at=is.null`, 'read tags');
  return r.filter(x => x.tags).map(x => ({ tag_id: x.tag_id, name: x.tags.name }));
}
// the item's live links per role, "<ref> title" each, and how many predecessors are still open
async function linksOf(c, row, ls, ppl) {
  const res = { parent: [], subtasks: [], after: [], next: [], waiting: 0 };
  const r = await c.rest('GET', `item_links?select=from_item,to_item,kind&removed_at=is.null&kind=in.(depends_on,parent)&or=(from_item.eq.${row.id},to_item.eq.${row.id})`);
  if (!r.ok || !r.json.length) return res;
  const ids = [...new Set(r.json.map(l => (l.from_item === row.id ? l.to_item : l.from_item)))];
  const other = Object.fromEntries((await get(c, `items?select=id,list_id,num,title,status&deleted_at=is.null&id=in.(${ids.join(',')})`, 'read links')).map(x => [x.id, x]));
  for (const l of r.json) {
    const mine = l.from_item === row.id, x = other[mine ? l.to_item : l.from_item];
    if (!x || !ls[x.list_id]) continue;
    const role = l.kind === 'parent' ? (mine ? 'parent' : 'subtasks') : (mine ? 'after' : 'next');
    res[role].push(`${itemRef(x, ls, ppl)} ${x.title}${CLOSED_ST.includes(x.status) ? ` (${x.status})` : ''}`);
    if (role === 'after' && !CLOSED_ST.includes(x.status)) res.waiting++;
  }
  return res;
}
// the versioned write: 0 rows back = changed meanwhile (or not editable), exit 3
async function versioned(c, row, patch, ref) {
  const r = await c.rest('PATCH', `items?id=eq.${row.id}&version=eq.${row.version}`, patch, { Prefer: 'return=representation' });
  if (!r.ok) throw new TdError(errorExit(r.err), `${ref}: ${r.err.message}; nothing written`);
  if (!Array.isArray(r.json) || r.json.length !== 1) throw new TdError(EXIT.conflict, `conflict: ${ref} changed meanwhile or is not editable by this login; nothing written (show it and try again)`);
  return r.json[0];
}
// update: the item patch, plus tag names to soft-remove (item_tags.removed_at) and notes for the report
async function buildPatch(c, a, row, ls, ppl, now) {
  const p = {}, notes = [];
  let removeTags = [];
  if (a.title !== undefined) {
    p.title = String(a.title).replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
    if (!p.title) throw new TdError(EXIT.error, '--title cannot be empty');
  }
  if (a.body !== undefined) p.body_md = String(a.body);
  if (a.due !== undefined) { const d = dueValue(a.due, row); p.due_at = d ? d.toISOString() : null; }
  if (a.start !== undefined) { const d = startValue(a.start); p.start_at = d ? d.toISOString() : null; }
  const q = a.q !== undefined ? a.q : a.quadrant;
  if (q !== undefined) {
    p.quadrant = String(q).toUpperCase();
    if (!c.core.QS.includes(p.quadrant)) throw new TdError(EXIT.error, '--q is one of A, B, C, D');
  }
  if (a.owner !== undefined) p.owner_id = /^none$/i.test(a.owner) ? null : await profileId(c, a.owner, '--owner');
  let listId = row.list_id;
  if (a.list !== undefined) {
    const to = writable(findList(ls, a.list, ppl), a.list);
    if (to.id !== row.list_id) { p.list_id = to.id; listId = to.id; }
  }
  if (a.tags !== undefined || a['add-tag'] !== undefined || a['remove-tag'] !== undefined) {
    const norm = s => String(s).trim().toLowerCase().replace(/\s+/g, '-');
    const current = [...new Set((await itemTags(c, row.id)).map(t => t.name.toLowerCase()))];
    const given = [...(a.tags !== undefined ? String(a.tags).split(',') : []), ...(a['add-tag'] !== undefined ? [a['add-tag']] : [])].map(norm).filter(Boolean);
    // who an item is for is never a tag: person names are dropped (the owner changes only with --owner)
    const people = given.filter(t => OWNER_TAGS.includes(t));
    if (people.length) notes.push(`not tags: ${[...new Set(people)].join(', ')} (use --owner)`);
    const topic = given.filter(t => !OWNER_TAGS.includes(t));
    let wanted = a.tags !== undefined ? topic : [...current, ...topic];
    const rm = a['remove-tag'] !== undefined ? norm(a['remove-tag']) : null;
    if (rm) wanted = wanted.filter(t => t !== rm);
    wanted = [...new Set(wanted)];
    const add = wanted.filter(t => !current.includes(t));
    removeTags = current.filter(t => !wanted.includes(t));
    if (add.length) p.tags = add;   // filed by the database's compatibility trigger (additive) into the writer's tag list
  }
  if (a.top) {
    const t = c.core.rowToTask(Object.assign({}, row, p));
    const qq = c.core.deriveQuadrant(t, null, now);
    const peers = await get(c, `items?select=id,list_id,status,category,quadrant,urgent_pin,due_at,sort_key&list_id=eq.${listId}&deleted_at=is.null&status=not.in.(${CLOSED_ST.join(',')})`, 'read the quadrant order');
    const key = topSortKey(c.core, listId === row.list_id ? row : Object.assign({}, row, { sort_key: null }), peers, qq, now);
    if (key === null) notes.push('already first in ' + qq); else p.sort_key = key;
  }
  return { patch: p, removeTags, notes };
}

export async function run(argv, out = console.log) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  if (a.help || !COMMANDS.includes(cmd)) { out(USAGE); return cmd || a.help ? (a.help ? EXIT.ok : EXIT.error) : EXIT.error; }
  // refused before sign-in: priority was removed (a task's priority is its position in its quadrant; --top puts it first)
  if (cmd === 'update' && a.priority !== undefined) throw new TdError(EXIT.error, "--priority was removed: a task's priority is its position in its quadrant; use --top");
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
    // priority by position (2026-10-29): no priority number; a task's priority is its position in its quadrant
    if (a.priority !== undefined) throw new TdError(EXIT.error, "--priority was removed: a task's priority is its position in its quadrant");
    const conf = a.confidence === undefined ? null : Number(a.confidence);
    if (conf !== null && !(conf >= 0 && conf <= 1)) throw new TdError(EXIT.error, '--confidence is 0 to 1');
    const draft = { qStored: a.q || null, category: cat, deadline: due, pin: undefined };
    const who = ownerFromTags(tagsOf(a.tags));
    const ownerArg = a.owner !== undefined ? a.owner : who.owner === null ? 'none' : who.owner;
    const owner_id = ownerArg === undefined || /^none$/i.test(ownerArg) ? null : await profileId(c, ownerArg, '--owner');
    const notify = [];
    for (const h of tagsOf(a.notify)) { await profileId(c, h, '--notify'); notify.push(h.toLowerCase()); }
    const body = await common({
      category: cat, title: String(a.title).trim(), body_md: a.body || '', tags: who.tags, quadrant: a.q || null, owner_id,
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
  if (cmd === 'find') {
    // every match is listed; nothing is ever written. REF and --key name one item, words search titles
    const { rows, what, exact } = await lookup(c, a, ls, ppl, { all: !!a.all });
    if (a.json) out(JSON.stringify(rows.map(x => rowJson(x, ls, ppl)), null, 2));
    else if (!rows.length) out(`none: no ${a.all || exact ? '' : 'open '}item matches ${what}`);
    else rows.forEach(x => out(itemLine(x, ls, ppl) + (ls[x.list_id].archived_at ? ' · list archived' : '')));
    return EXIT.ok;
  }
  if (cmd === 'show') {
    const row = await resolveTarget(c, a, ls, ppl, out);
    const l = ls[row.list_id];
    const tags = (await itemTags(c, row.id)).map(t => t.name);
    const lk = await linksOf(c, row, ls, ppl);
    const q = row.quadrant || core.deriveQuadrant(core.rowToTask(row), null, now);
    const owner = row.owner_id ? ((ppl[row.owner_id] || {}).handle || row.owner_id) : null;
    const notify = (row.details && row.details.notify) || [];
    if (a.json) {
      out(JSON.stringify(Object.assign(rowJson(row, ls, ppl), { body_md: row.body_md || '', start_at: row.start_at || null, quadrant_shown: q, quadrant_stored: !!row.quadrant,
        sort_key: row.sort_key, owner, notify, tags, links: lk, review_state: row.review_state || 'none', list_name: l.name, archived: !!l.archived_at }), null, 2));
      return EXIT.ok;
    }
    out(itemLine(row, ls, ppl) + (l.archived_at ? ' · list archived' : ''));
    out(`list: ${l.name} · quadrant: ${q}${row.quadrant ? '' : ' (derived)'} · owner: ${owner || 'none'}`);
    if (row.start_at) out('start: ' + localStamp(new Date(row.start_at), TZ).wall);
    if (tags.length) out('tags: ' + tags.join(', '));
    if (notify.length) out('notify: ' + notify.join(', '));
    if (lk.parent.length) out('parent: ' + lk.parent.join(', '));
    if (lk.subtasks.length) out('subtasks: ' + lk.subtasks.join(', '));
    if (lk.after.length) out('comes after: ' + lk.after.join(', ') + (lk.waiting ? ` (waiting for ${lk.waiting})` : ''));
    if (lk.next.length) out('next: ' + lk.next.join(', '));
    if (row.review_state && row.review_state !== 'none') out('review: ' + row.review_state);
    out(`key: ${row.dedup_key || '-'} · version ${row.version}`);
    if (row.body_md) out('\n' + row.body_md);
    return EXIT.ok;
  }
  if (cmd === 'update') {
    const named = ['title', 'body', 'due', 'start', 'q', 'quadrant', 'owner', 'tags', 'add-tag', 'remove-tag', 'list', 'top'].filter(k => a[k] !== undefined);
    if (!named.length) throw new TdError(EXIT.error, 'update needs at least one of --title, --body, --due, --start, --q, --top, --owner, --tags, --add-tag, --remove-tag, --list');
    const row = await resolveTarget(c, a, ls, ppl, out);
    changeable(row, ls, ppl);
    const ref = itemRef(row, ls, ppl);
    const { patch, removeTags, notes } = await buildPatch(c, a, row, ls, ppl, now);
    const why = sensitiveCheck([patch.title, patch.body_md, (patch.tags || []).join(' ')].filter(Boolean).join(' '));
    if (why) throw new TdError(EXIT.sensitive, `sensitive data refused (${why}); nothing written`);
    const fields = [...Object.keys(patch), ...(removeTags.length ? ['removed tags ' + removeTags.join(', ')] : [])];
    if (!fields.length) { out(a.json ? JSON.stringify({ unchanged: true, ref, notes }) : `nothing to change: ${itemLine(row, ls, ppl)}${notes.length ? ' · ' + notes.join('; ') : ''}`); return EXIT.ok; }
    if (a['dry-run']) { out(a.json ? JSON.stringify({ dry: true, ref, patch, removeTags }, null, 2) : `dry run, nothing sent: update ${ref} · ${fields.join(', ')}`); return EXIT.ok; }
    const next = Object.keys(patch).length ? await versioned(c, row, patch, ref) : row;
    if (removeTags.length) {
      const ids = (await itemTags(c, row.id)).filter(t => removeTags.includes(t.name.toLowerCase())).map(t => t.tag_id);
      if (ids.length) {
        const w = await c.rest('PATCH', `item_tags?item_id=eq.${row.id}&tag_id=in.(${ids.join(',')})`, { removed_at: new Date(now).toISOString() });
        if (!w.ok) throw new TdError(errorExit(w.err), `${ref}: tags not removed: ${w.err.message}`);
      }
    }
    const after = Object.assign({}, row, next);
    out(a.json ? JSON.stringify(Object.assign({ action: 'updated', fields, notes }, rowJson(after, ls, ppl))) : `updated ${itemLine(after, ls, ppl)} · ${fields.join(', ')}${notes.length ? ' · ' + notes.join('; ') : ''}`);
    return EXIT.ok;
  }
  if (cmd === 'done' || cmd === 'reopen' || cmd === 'cancel') {
    const status = { done: 'done', reopen: 'open', cancel: 'cancelled' }[cmd];
    const row = await resolveTarget(c, a, ls, ppl, out, { closed: cmd === 'reopen' });
    changeable(row, ls, ppl);
    const ref = itemRef(row, ls, ppl);
    if (cmd === 'reopen' ? !CLOSED_ST.includes(row.status) : row.status === status) {
      out(a.json ? JSON.stringify({ unchanged: true, ref, status: row.status }) : `already ${row.status}: ${itemLine(row, ls, ppl)}; nothing written`);
      return EXIT.ok;
    }
    if (a['dry-run']) { out(`dry run, nothing sent: ${cmd} ${ref}`); return EXIT.ok; }
    const after = Object.assign({}, row, await versioned(c, row, { status }, ref));
    const verb = { done: 'done', reopen: 'reopened', cancel: 'cancelled' }[cmd];
    out(a.json ? JSON.stringify(Object.assign({ action: verb }, rowJson(after, ls, ppl))) : `${verb} ${itemLine(after, ls, ppl)}`);
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
