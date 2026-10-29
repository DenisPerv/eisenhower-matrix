#!/usr/bin/env node
// End-to-end test of TasksDashboard.html against the live TasksDashboardDB, through a headless Chrome / Edge DevTools connection.
// node test/e2e.mjs --env <file> --out <dir> [--smoke] [--group auth|data|sync|archive|errors|ui|links|guests|request|smoke] [--page <html>]
//   [--url <https origin> [--access-env <file>]]
// Without --url the page is the local file (file://). With --url it is <origin>/, and sessions are seeded on <origin>/version.json
// (same origin, same storage); --access-env adds the Cloudflare Access service-token headers to requests for that origin only.
// No dependencies. Real sessions come from a REST sign-in in Node, seeded into the page's td.auth; the form itself is only fed
// dummy credentials while Fetch interception answers it, so no real password is ever typed into the page. Writes stay in the
// _selftest list (and test lists it creates and archives; guests: see gGuests). The transport never logs CDP parameters.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEnv, missingEnv, connect, loadCore, APP_HTML, e2eArgs, hostedOrigin, accessCreds, accessHeaders, strayHosts, guestLogins, guestLeaks } from '../cli/lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = e2eArgs(process.argv.slice(2));
let ORIGIN = null, ACCESS = null; // --url and --access-env, set in main
const GROUPS = ['auth', 'data', 'sync', 'archive', 'errors', 'ui', 'links', 'guests', 'request'];
const want = args.smoke ? ['smoke'] : args.group ? String(args.group).split(',') : GROUPS;
// the request group alone needs no login and no live database: every auth and RPC call is answered in the browser
const OFFLINE = want.every(g => g === 'request');
const OUT = path.resolve(args.out || path.join(os.tmpdir(), 'td-e2e-' + Date.now()));
const PAGE = path.resolve(args.page || APP_HTML);
const RUN = 'e2e-' + new Date().toISOString().replace(/\D/g, '').slice(2, 12);
// a Cyrillic name new on every run (no ASCII letters or digits, so the slug is list-xxxxxx): since db/012 a same name as an
// archived list of an earlier run is refused with Restore, so a fixed name would fail from the second run on
const CYR_LIST = 'Тестовий список ' + RUN.slice(4).replace(/\d/g, (d) => 'абвгдежзик'[d]);
const DUMMY = { email: 'nobody@example.invalid', password: 'not-a-password' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// real key presses (CDP Input): implicit form submission and the dialog's Escape only follow trusted keys. Modifiers: Alt 1
const KEYS = { Enter: { code: 'Enter', vk: 13, text: '\r' }, Escape: { code: 'Escape', vk: 27 }, ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowRight: { code: 'ArrowRight', vk: 39 }, PageUp: { code: 'PageUp', vk: 33 }, PageDown: { code: 'PageDown', vk: 34 }, Tab: { code: 'Tab', vk: 9 } };
const rows = [], leftovers = [], kpiTimes = [], reviewApiTimes = [], timelineTimes = [];
let pass = 0, fail = 0, skipped = 0;
const check = (group, what, ok, note) => { ok ? pass++ : fail++; rows.push(`| ${group} | ${what} | ${ok ? 'pass' : 'FAIL'} | ${String(note || '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 160)} |`); console.log(`${ok ? 'pass' : 'FAIL'} ${group}: ${what}`); };
// a check that cannot run here (a login missing from the env): reported, never counted as passed or failed
const skip = (group, what, note) => { skipped++; rows.push(`| ${group} | ${what} | skipped | ${String(note || '').replace(/\|/g, '/')} |`); console.log(`skip ${group}: ${what} (${note})`); };

// ---- browser ----
function findBrowser() {
  const c = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1181', 'chrome-win', 'chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return c.find(p => p && fs.existsSync(p));
}
async function launch() {
  const exe = findBrowser();
  if (!exe) throw new Error('no Chrome, Edge or Playwright chromium found');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-e2e-profile-'));
  const proc = spawn(exe, ['--headless=new', '--user-data-dir=' + dir, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools connection failed')); });
  let id = 0;
  const waiting = new Map(), listeners = new Set();
  ws.onmessage = m => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { const w = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? w.rej(new Error(w.method + ' failed')) : w.res(msg.result); }
    else if (msg.method) listeners.forEach(l => l(msg));
  };
  // never logs parameters: a failure names only the method
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej, method }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const close = () => { try { ws.close(); } catch (e) {} try { proc.kill(); } catch (e) {} setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }, 1500); };
  return { send, on: l => { listeners.add(l); return () => listeners.delete(l); }, close };
}

// one tab in a browser context; console errors and the hosts it contacts are recorded
async function tab(B, ctxId, opts = {}) {
  const { targetId } = await B.send('Target.createTarget', { url: 'about:blank', browserContextId: ctxId });
  const { sessionId } = await B.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => B.send(m, p, sessionId);
  const T = { sessionId, targetId, ctxId, errors: [], hosts: new Set(), requests: [], paused: null };
  B.on(msg => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') T.errors.push((msg.params.exceptionDetails.exception || {}).description || msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') T.errors.push(msg.params.args.map(a => a.value || a.description || '').join(' '));
    if (msg.method === 'Network.requestWillBeSent') { const u = msg.params.request.url; if (/^https?:/.test(u)) { T.hosts.add(new URL(u).host); T.requests.push(u); } }
    if (msg.method === 'Page.javascriptDialogOpening') s('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    // CSP violations and other security messages count as console errors
    if (msg.method === 'Log.entryAdded' && msg.params.entry.source === 'security') T.errors.push('security: ' + msg.params.entry.text);
    if (msg.method === 'Fetch.requestPaused') {
      // the page origin first: the CF-Access headers are added to its requests only (accessHeaders is null for any other origin)
      const h = ACCESS && accessHeaders(msg.params.request, ORIGIN, ACCESS);
      if (h) s('Fetch.continueRequest', { requestId: msg.params.requestId, headers: h }).catch(() => {});
      else if (T.paused) T.paused(msg.params);
      else s('Fetch.continueRequest', { requestId: msg.params.requestId }).catch(() => {});
    }
  });
  await s('Page.enable'); await s('Runtime.enable'); await s('Network.enable'); await s('Log.enable');
  if (ACCESS) await s('Fetch.enable', { patterns: fetchPatterns() });
  T.send = s;
  T.ev = async expr => {
    const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page script failed: ' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).split('\n')[0]);
    return r.result.value;
  };
  T.wait = async (expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await T.ev(expr)) return true; } catch (e) {} await sleep(150); } return false; };
  T.click = sel => T.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`);
  T.text = sel => T.ev(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||''`);
  T.has = sel => T.ev(`!!document.querySelector(${JSON.stringify(sel)})`);
  T.go = async url => { await s('Page.navigate', { url }); await T.wait('document.readyState==="complete"', 15000); };
  T.reload = async () => { await s('Page.reload', {}); await sleep(300); await T.wait('document.readyState==="complete"', 15000); };
  T.size = (width, height) => s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  T.theme = v => s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] });
  T.shot = async name => { const r = await s('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); return name + '.png'; };
  // real pointer input (CDP Input): a press at (x, y), released at (x2, y2); a hover; a touch swipe of dx px (touch emulation on for it)
  T.mouse = async (x, y, x2 = x, y2 = y) => { await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await s('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    if (x2 !== x || y2 !== y) for (let i = 1; i <= 5; i++) await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (x2 - x) * i / 5, y: y + (y2 - y) * i / 5, button: 'left', buttons: 1 });
    await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 }); };
  T.hover = (x, y) => s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  T.swipe = async (x, y, dx) => { await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }); await s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 5; i++) await s('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 5, y }] });
    await s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await s('Emulation.setTouchEmulationEnabled', { enabled: false }); };
  T.insert = async (sel, text) => { await T.ev(`document.querySelector(${JSON.stringify(sel)}).focus()`); await s('Input.insertText', { text }); };
  T.key = async (key, modifiers = 0) => {
    const k = KEYS[key], base = { modifiers, key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await s('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, base, k.text ? { text: k.text, unmodifiedText: k.text } : {}));
    await s('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  };
  // round 3: the first-login welcome is closed with Later unless a test keeps it (T.keepWelcome)
  // every page starts on the Matrix: a person's saved view (prefs.view, e.g. Review, maybe set by someone using the app meanwhile)
  // has no quadrant + buttons and no cards. Preferences are put back in cleanup
  T.ready = async () => {
    const ok = await T.wait('!document.querySelector(".gate") && !!document.querySelector(".matrix, .ar, .tl, .rvw")', 20000);
    if (ok && !T.keepWelcome) await T.ev('(document.getElementById("wl-later")?.click(),true)');
    if (ok && !(await T.has('.matrix'))) { await T.click('[data-view=matrix]'); await T.wait('!!document.querySelector(".matrix")', 5000); }
    return ok;
  };
  T.close = () => B.send('Target.closeTarget', { targetId });
  await T.size(opts.width || 1440, opts.height || 900);
  return T;
}
const ctx = async B => (await B.send('Target.createBrowserContext', { disposeOnDetach: true })).browserContextId;
const pageUrl = (q = '') => (ORIGIN ? ORIGIN + '/' : pathToFileURL(PAGE).href) + q;
// a page on the app's origin that runs no app code: seed.html beside the report, or the hosted version.json
const seedUrl = () => ORIGIN ? ORIGIN + '/version.json' : pathToFileURL(path.join(OUT, 'seed.html')).href;
const where = () => ORIGIN || 'file://';
const onlyHosts = () => ORIGIN ? 'only the Supabase host and the page origin are contacted' : 'only the Supabase host is contacted';
// a session made in Node, written into the page's own storage (same origin) before the app loads
async function seed(T, session, kind = 'local') {
  await T.go(seedUrl());
  await T.ev(`(()=>{localStorage.removeItem('td.auth');sessionStorage.removeItem('td.auth');${kind === 'local' ? 'localStorage' : 'sessionStorage'}.setItem('td.auth',${JSON.stringify(JSON.stringify({ refresh_token: session.refresh_token }))});return true})()`);
}
async function open(T, session, kind) { if (session) await seed(T, session, kind); await T.go(pageUrl()); return T.ready(); }
// Fetch patterns of a tab: the page origin while --access-env is on (headers added), plus a test's own pattern
function fetchPatterns(pattern) {
  return (ACCESS ? [{ urlPattern: ORIGIN + '/*', requestStage: 'Request' }] : []).concat(pattern ? [{ urlPattern: pattern, requestStage: 'Request' }] : []);
}
// answer the next requests matching a URL pattern: fn(params) returns { status, body } or null to let it through
async function intercept(T, pattern, fn) {
  await T.send('Fetch.enable', { patterns: fetchPatterns(pattern) });
  T.paused = async p => {
    // the CORS preflight is answered here, so an intercepted request never reaches the network at all
    if (p.request.method === 'OPTIONS') return T.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 204, body: '', responseHeaders: [
      { name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PATCH,OPTIONS' },
      { name: 'Access-Control-Allow-Headers', value: 'apikey,authorization,content-type,prefer,x-homeos-via,x-client-info' }, { name: 'Access-Control-Max-Age', value: '0' }] }).catch(() => {});
    const r = fn(p);
    if (!r) return T.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    return T.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: r.status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
      body: Buffer.from(JSON.stringify(r.body)).toString('base64') }).catch(() => {});
  };
}
const unintercept = async T => { T.paused = null; await (ACCESS ? T.send('Fetch.enable', { patterns: fetchPatterns() }) : T.send('Fetch.disable')).catch(() => {}); };

// ---- main ----
const usage = 'usage: node test/e2e.mjs --env <file> --out <dir> [--group …] [--smoke] [--url <https origin> [--access-env <file>]]';
if (typeof args.env !== 'string') { console.error(usage); process.exit(2); }
if (args.url !== undefined) { try { ORIGIN = hostedOrigin(args.url); } catch (e) { console.error(e.message); process.exit(2); } }
if (args['access-env'] !== undefined) {
  if (!ORIGIN || typeof args['access-env'] !== 'string') { console.error('--access-env <file> needs --url <https origin>\n' + usage); process.exit(2); }
  let a;
  try { a = accessCreds(args['access-env']); } catch (e) { console.error('--access-env: cannot read the file'); process.exit(2); }
  if (a.missing.length) { console.error('access env missing: ' + a.missing.join(', ')); process.exit(2); }
  ACCESS = a;
}
const env = readEnv(args.env);
const miss = OFFLINE ? [] : missingEnv(env, 'maksym').concat(missingEnv(env, 'anastasiia'), missingEnv(env, 'homeos-agent')).filter((x, i, a) => a.indexOf(x) === i);
if (miss.length) { console.error('env missing: ' + miss.join(', ')); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
if (!ORIGIN) fs.writeFileSync(path.join(OUT, 'seed.html'), '<!doctype html><title>seed</title>');
const core = loadCore(PAGE);
const SUPA = env.TASKSDB_URL ? new URL(env.TASKSDB_URL).host : null;
const cli = (...a) => spawnSync(process.execPath, [path.join(HERE, '..', 'cli', 'tasks.mjs'), ...a, '--env', args.env, '--run-id', RUN], { encoding: 'utf8' });

let B, MK, AN, ST, prefsSnap = {}, testLists = [], testTagLists = [];
// tags round: Maksym's own live tag lists' sort before the run (a list move writes tag_lists.sort; put back in cleanup), and the
// undo steps of the tags-round checks (share by name, Anastasiia's shared test tag list), run first in cleanup
let ownSortSnap = {};
const tagUndo = [];
const canon = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(y => [y, x[y]])) : x);
const clients = []; // every session this run made is logged out at the end
const grantFor = async who => { const c = await connect(env, who, { core, via: 'script:e2e', runId: RUN }); clients.push(c); return c.session; };
const mkItem = async (title, extra = {}) => {
  const r = await MK.rest('POST', 'items', Object.assign({ list_id: ST.id, category: 'task', title: `${RUN} ${title}`, quadrant: 'B', sort_key: Date.now() % 100000 }, extra), { Prefer: 'return=representation' });
  if (!r.ok) throw new Error('setup insert failed: ' + r.err.message);
  return r.json[0];
};
const item = async id => (await MK.rest('GET', 'items?select=*&id=eq.' + id)).json[0];
const until = async (fn, ms = 12000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(400); } return v; };

async function setup() {
  if (OFFLINE) return;
  MK = await connect(env, 'maksym', { core, via: 'script:e2e', runId: RUN });
  AN = await connect(env, 'anastasiia', { core, via: 'script:e2e', runId: RUN });
  clients.push(MK, AN);
  for (const [who, c] of [['maksym', MK], ['anastasiia', AN]]) {
    const r = await c.rest('GET', 'preferences?select=prefs&profile_id=eq.' + c.uid + '&app=eq.tasksdashboard');
    prefsSnap[who] = r.ok && r.json.length ? r.json[0].prefs : null;
  }
  const os0 = await MK.rest('GET', `tag_lists?select=id,sort&archived_at=is.null&owner_id=eq.${MK.uid}`);
  if (os0.ok) ownSortSnap = Object.fromEntries(os0.json.map(x => [x.id, x.sort]));
  if (want.includes('smoke')) return;
  const rl = cli('restore-list', '--list', '_selftest', '--as', 'maksym');
  check('setup', '_selftest restored with cli/tasks.mjs restore-list (exit 0, or 8 when not archived)', rl.status === 0 || rl.status === 8, 'exit ' + rl.status);
  ST = (await MK.rest('GET', 'lists?select=id,slug,name,archived_at&slug=eq._selftest')).json[0];
  await MK.rest('POST', 'list_members?on_conflict=list_id,profile_id', [{ list_id: ST.id, profile_id: AN.uid, role: 'editor' }], { Prefer: 'resolution=ignore-duplicates' });
  await MK.rest('PATCH', `list_members?list_id=eq.${ST.id}&profile_id=eq.${AN.uid}`, { role: 'editor' });
}
async function cleanup() {
  if (!MK) return;
  for (const undo of guestUndo.reverse()) { try { await undo(); } catch (e) { leftovers.push('guests cleanup step failed: ' + e.message); } }
  for (const undo of tagUndo.reverse()) { try { await undo(); } catch (e) { leftovers.push('tags-round cleanup step failed: ' + e.message); } }
  for (const [who, c] of [['maksym', MK], ['anastasiia', AN]]) {
    if (prefsSnap[who] === undefined) continue;
    if (prefsSnap[who] === null) { leftovers.push(`a preferences row for ${who} that did not exist before`); continue; }
    const want = core.rowFromPrefs(c.uid, prefsSnap[who]);
    const r = await c.rest('POST', 'preferences?on_conflict=profile_id,app', want, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    if (!r.ok) leftovers.push(`preferences of ${who} not restored: ${r.err.message}`);
    // read back: the whole row equals the snapshot (tagListFavs, tagListOrder, tagListOrderV, taskSwitcher, cardLayout included)
    const back = await c.rest('GET', 'preferences?select=prefs&profile_id=eq.' + c.uid + '&app=eq.tasksdashboard');
    const same = back.ok && back.json[0] && canon(back.json[0].prefs) === canon(want.prefs);
    rows.push(`| cleanup | preferences of ${who} read back equal the snapshot (incl. tagListFavs, tagListOrder, tagListOrderV, taskSwitcher, cardLayout) | ${same ? 'pass' : 'FAIL'} | |`);
    same ? pass++ : fail++;
  }
  // tags round: Maksym's own tag lists back to their sort before the run (a list move writes tag_lists.sort for own lists)
  const os1 = await MK.rest('GET', `tag_lists?select=id,sort&owner_id=eq.${MK.uid}&id=in.(${Object.keys(ownSortSnap).join(',') || '00000000-0000-0000-0000-000000000000'})`);
  const moved = os1.ok ? os1.json.filter(x => ownSortSnap[x.id] !== undefined && x.sort !== ownSortSnap[x.id]) : [];
  for (const x of moved) await MK.rest('PATCH', 'tag_lists?id=eq.' + x.id, { sort: ownSortSnap[x.id] });
  const os2 = await MK.rest('GET', `tag_lists?select=id,sort&owner_id=eq.${MK.uid}&id=in.(${Object.keys(ownSortSnap).join(',') || '00000000-0000-0000-0000-000000000000'})`);
  const sortsOk = os2.ok && os2.json.every(x => x.sort === ownSortSnap[x.id]);
  rows.push(`| cleanup | Maksym's own tag lists: sort as before the run (${moved.length} put back) | ${sortsOk ? 'pass' : 'FAIL'} | |`);
  if (!ST) return;
  await MK.rest('PATCH', `list_members?list_id=eq.${ST.id}&profile_id=eq.${AN.uid}`, { role: 'editor' });
  for (const l of [ST].concat(testLists)) {
    const lr = await MK.rest('GET', 'lists?select=id,archived_at&id=eq.' + l.id);
    if (lr.ok && lr.json[0] && lr.json[0].archived_at) await MK.rest('PATCH', 'lists?id=eq.' + l.id, { archived_at: null });
    const d = await MK.rest('PATCH', `items?list_id=eq.${l.id}&deleted_at=is.null`, { deleted_at: new Date().toISOString() }, { Prefer: 'return=representation' });
    const a = await MK.rest('PATCH', 'lists?id=eq.' + l.id, { archived_at: new Date().toISOString() }, { Prefer: 'return=representation' });
    rows.push(`| cleanup | ${l.slug || l.id}: ${d.ok ? d.json.length : 'n/a'} items soft-deleted, list archived | ${a.ok && a.json.length === 1 ? 'pass' : 'FAIL'} | |`);
    if (l !== ST) leftovers.push(`archived test list ${l.slug} (${l.name})`);
  }
  // round 3: test tag lists (Tags window) are archived; nothing is deleted
  for (const tl of testTagLists) {
    const r = await MK.rest('POST', 'rpc/set_tag_list_archived', { p_tag_list: tl.id, p_archived: true });
    rows.push(`| cleanup | tag list ${tl.name}: archived | ${r.ok ? 'pass' : 'FAIL'} | ${r.ok ? '' : r.err.message} |`);
    leftovers.push(`archived test tag list ${tl.name}`);
  }
}

// ---- groups ----
async function gAuth() {
  const G = 'auth';
  const c1 = await ctx(B), T = await tab(B, c1);
  // the form's own submit path: dummy credentials, Fetch answers (a real grant made in Node, then a 400, then a 429)
  await T.go(seedUrl()); await T.ev('localStorage.clear();sessionStorage.clear();true');
  await T.go(pageUrl());
  check(G, 'signed out: the form shows', await T.wait('!!document.getElementById("signin")'));
  const real = await grantFor('maksym');
  let seen = 0, sentDummy = false, next = 'grant';
  await intercept(T, '*auth/v1/token?grant_type=password*', p => {
    seen++;
    try { const b = JSON.parse(p.request.postData || '{}'); sentDummy = b.email === DUMMY.email && b.password === DUMMY.password; } catch (e) {}
    if (next === '400') return { status: 400, body: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } };
    if (next === '429') return { status: 429, body: { code: 429, error_code: 'over_request_rate_limit', msg: 'rate limit' } };
    return { status: 200, body: { access_token: real.access_token, refresh_token: real.refresh_token, expires_in: 3600, token_type: 'bearer', user: { id: real.user.id, email: real.user.email } } };
  });
  next = '400';
  await T.insert('#si-email', DUMMY.email); await T.insert('#si-pass', DUMMY.password);
  await T.ev('document.getElementById("signin").requestSubmit()');
  await T.wait('document.getElementById("si-msg").textContent.length > 0');
  const n400 = seen;
  await sleep(2500);
  check(G, 'a 400 shows "Email or password is wrong" and focuses the message; nothing more is sent', /wrong/.test(await T.text('#si-msg')) && await T.ev('document.activeElement.id==="si-msg"') && seen === n400 && n400 === 1, `requests ${seen}`);
  check(G, 'the form sent the typed dummy credentials (intercepted, nothing left the machine)', sentDummy);
  check(G, 'form attributes: email autocomplete=username, password current-password, Stay signed in ticked', await T.ev('document.getElementById("si-email").autocomplete==="username" && document.getElementById("si-pass").autocomplete==="current-password" && document.getElementById("si-stay").checked'));
  next = '429';
  await T.ev('document.getElementById("signin").requestSubmit()');
  check(G, 'a 429 shows the wait message', await T.wait('/Too many attempts/.test(document.getElementById("si-msg").textContent)'));
  next = 'grant';
  await T.ev('document.getElementById("signin").requestSubmit()');
  check(G, `a granted submit (Stay signed in) loads the board from ${where()}`, await T.ready());
  await unintercept(T);
  check(G, 'td.auth is kept in localStorage', await T.ev('!!localStorage.getItem("td.auth") && !sessionStorage.getItem("td.auth")'));
  await T.reload();
  check(G, 'a reload stays signed in', await T.ready());
  // a 401 on a REST call: one silent refresh and a retry
  let hit = 0;
  await intercept(T, '*rest/v1/preferences*', () => (hit++ === 0 ? { status: 401, body: { code: 'PGRST301', message: 'JWT expired' } } : null));
  await T.reload();
  check(G, 'a 401 refreshes silently (board loads, no form)', await T.ready() && hit >= 2 && !(await T.has('#signin')), `prefs requests ${hit}`);
  await unintercept(T);
  // two tabs in one context share the refresh (Web Lock + BroadcastChannel), both modes
  const T2 = await tab(B, c1);
  await T2.go(pageUrl());
  check(G, 'a second tab (Stay signed in) opens signed in', await T2.ready());
  let h1 = 0, h2 = 0;
  await intercept(T, '*rest/v1/items*', () => (h1++ === 0 ? { status: 401, body: { code: 'PGRST301' } } : null));
  await intercept(T2, '*rest/v1/items*', () => (h2++ === 0 ? { status: 401, body: { code: 'PGRST301' } } : null));
  await Promise.all([T.ev('dispatchEvent(new Event("focus")),true'), T2.ev('dispatchEvent(new Event("focus")),true')]);
  await sleep(4000);
  await unintercept(T); await unintercept(T2);
  check(G, 'both tabs refresh at the same time and stay signed in', !(await T.has('#signin')) && !(await T2.has('#signin')), `${h1}/${h2}`);
  await T2.close();
  // unticked: sessionStorage only; a new tab shows the form; a duplicated tab (same sessionStorage) keeps working
  const c2 = await ctx(B), U = await tab(B, c2);
  await U.go(seedUrl()); await U.ev('localStorage.clear();sessionStorage.clear();true'); await U.go(pageUrl());
  const real2 = await grantFor('maksym');
  await intercept(U, '*auth/v1/token?grant_type=password*', () => ({ status: 200, body: { access_token: real2.access_token, refresh_token: real2.refresh_token, expires_in: 3600, user: { id: real2.user.id, email: real2.user.email } } }));
  await U.wait('!!document.getElementById("signin")');
  await U.insert('#si-email', DUMMY.email); await U.insert('#si-pass', DUMMY.password);
  await U.ev('document.getElementById("si-stay").checked=false;document.getElementById("signin").requestSubmit();true');
  check(G, 'unticked: signs in, td.auth only in sessionStorage', await U.ready() && await U.ev('!localStorage.getItem("td.auth") && !!sessionStorage.getItem("td.auth")'));
  await unintercept(U);
  const U2 = await tab(B, c2);
  await U2.go(pageUrl());
  check(G, 'unticked: a new tab shows the form', await U2.wait('!!document.getElementById("signin")'));
  const copied = await U.ev('sessionStorage.getItem("td.auth")');
  await U2.go(seedUrl()); await U2.ev(`sessionStorage.setItem('td.auth', ${JSON.stringify(copied)});true`); await U2.go(pageUrl());
  const dupOk = await U2.ready();
  let hd = 0;
  await intercept(U, '*rest/v1/items*', () => (hd++ === 0 ? { status: 401, body: { code: 'PGRST301' } } : null));
  await U.ev('dispatchEvent(new Event("focus")),true'); await sleep(3000); await unintercept(U);
  check(G, 'a duplicated tab (copied sessionStorage) opens, and the first tab still refreshes after it', dupOk && !(await U.has('#signin')));
  await U2.close(); await U.close();
  // round 4, item 1: Anastasiia signed in once on this browser, then Maksym: the account menu has no other accounts and no
  // Add account (only Sign out), and Sign out shows the sign-in form
  const c3 = await ctx(B), S = await tab(B, c3);
  await open(S, await grantFor('anastasiia'));
  await S.wait('!!document.getElementById("profile")');
  await S.click('#profile'); await S.click('[data-signout]');
  await S.wait('!!document.getElementById("signin")');
  await open(S, await grantFor('maksym'));
  await S.click('#profile');
  await S.wait('!!document.querySelector("[data-signout]")');
  check(G, 'account menu: no Accounts on this browser, no Add account, Sign out only (round 4)', await S.ev('!document.querySelector("[data-switch],[data-forget],[data-addaccount]") && !/Accounts on this browser|Add account/.test(document.getElementById("pop")?.textContent||"")'));
  await S.click('[data-signout]');
  check(G, 'Sign out shows the sign-in form', await S.wait('!!document.getElementById("signin")'));
  check(G, 'sign-out removes td.auth', await S.ev('!localStorage.getItem("td.auth") && !sessionStorage.getItem("td.auth")'));
  // a second context stays signed in after the first signs out
  await T.click('#profile'); await T.click('[data-signout]');
  await T.wait('!!document.getElementById("signin")');
  const c4 = await ctx(B), V = await tab(B, c4);
  const okBefore = await open(V, await grantFor('maksym'));
  const W = await tab(B, c3);
  await open(W, await grantFor('maksym'));
  await W.click('#profile'); await W.click('[data-signout]'); await W.wait('!!document.getElementById("signin")');
  await V.reload();
  check(G, 'a second context stays signed in after the first signs out', okBefore && await V.ready());
  for (const x of [T, S, V, W]) await x.close().catch(() => {});
}

let MP = null; // Maksym's page for data / archive / errors
async function maksymPage() {
  if (MP) return MP;
  MP = await tab(B, await ctx(B));
  await open(MP, await grantFor('maksym'));
  return MP;
}
// a list chip may sit behind +N (five chips show): open that menu first
const pick = async (T, listId) => { if (!(await T.has(`.lists [data-list="${listId}"]`)) && await T.has('#more')) { await T.click('#more'); await T.wait(`!!document.querySelector('#pop [data-list="${listId}"]')`, 5000); } await T.click(`[data-list="${listId}"]`); await T.wait(`document.querySelector('[data-list="${listId}"]').getAttribute('aria-pressed')==="true"`); };
const undo = T => T.click('.toast button');
const toastText = T => T.text('.toast span');
async function dialogSave(T, fields) {
  if (!(await T.wait('!!document.querySelector("dialog[open] #fs")'))) throw new Error('the task window did not open; page errors: ' + (T.errors.slice(-2).join(' / ') || 'none'));
  await T.ev(`(()=>{const d=document.querySelector('dialog[open]');const f=${JSON.stringify(fields)};
    if(f.title!==undefined)d.querySelector('#ft').textContent=f.title; if(f.notes!==undefined)d.querySelector('#fn').textContent=f.notes;
    if(f.list)d.querySelector('#fl').value=f.list; d.querySelector('#fs').click();return true})()`);
}

async function gData() {
  const G = 'data', T = await maksymPage();
  await T.ev('dispatchEvent(new Event("focus")),true'); await sleep(1500);
  await pick(T, ST.id);
  // add through the window
  await T.click('[data-add="B"]');
  await dialogSave(T, { title: `${RUN} added`, list: ST.id });
  const added = await until(async () => (await MK.rest('GET', `items?select=*&list_id=eq.${ST.id}&title=eq.${encodeURIComponent(RUN + ' added')}`)).json[0]);
  check(G, 'add: stored with a client uuid, quadrant B, created_via app, start_at empty (task links: a new task starts blank)', added && added.quadrant === 'B' && added.created_via === 'app' && !added.start_at && typeof added.sort_key === 'number');
  await undo(T);
  check(G, 'undo add: soft-deleted', await until(async () => (await item(added.id)).deleted_at));
  // edit, quadrant move, undo
  const e = await mkItem('edit me', { quadrant: 'B' });
  await T.ev('dispatchEvent(new Event("focus")),true'); await T.wait(`!!document.querySelector('[data-card="${e.id}"]')`);
  await T.click(`[data-card="${e.id}"]`);
  await dialogSave(T, { title: `${RUN} edited`, notes: 'line one' });
  const ed = await until(async () => { const x = await item(e.id); return x.title === `${RUN} edited` && x.body_md === 'line one' && x; });
  check(G, 'edit: title and description saved, version up', ed && ed.version === e.version + 1);
  await undo(T);
  check(G, 'undo edit: the old title is back', await until(async () => (await item(e.id)).title === `${RUN} edit me`));
  await T.wait('!document.querySelector("dialog[open]")');
  // edit window, item 1: the task window has no Quadrant field; a quadrant is pinned by dragging the card into another quadrant
  await T.click(`[data-card="${e.id}"]`); await T.wait('!!document.querySelector("dialog[open] #ft")');
  check(G, 'the task window has no Quadrant field (edit window, item 1)', await T.ev('!document.querySelector("dialog[open] #fq")'));
  await closeDialogs(T);
  await T.ev(`(()=>{const src=document.querySelector('[data-card="${e.id}"]'),dst=document.querySelector('section.q[data-q="A"]');const dt=new DataTransfer();const r=dst.getBoundingClientRect();
    const fire=(el,type)=>el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+r.width/2,clientY:r.bottom-4}));
    fire(src,'dragstart');fire(dst,'dragover');fire(dst,'drop');fire(src,'dragend');return true})()`);
  check(G, 'quadrant move by drag: quadrant A, pin set (urgency by hand)', await until(async () => { const x = await item(e.id); return x.quadrant === 'A' && x.urgent_pin === true; }));
  await undo(T);
  check(G, 'undo move: back to B, pin cleared', await until(async () => { const x = await item(e.id); return x.quadrant === 'B' && x.urgent_pin === null; }));
  // reorder by drag: a, b, c in B; drop c before a
  const [a, b, c] = [await mkItem('order a', { sort_key: 10 }), await mkItem('order b', { sort_key: 20 }), await mkItem('order c', { sort_key: 30 })];
  await T.ev('dispatchEvent(new Event("focus")),true'); await T.wait(`!!document.querySelector('[data-card="${c.id}"]')`);
  await T.ev(`(()=>{const src=document.querySelector('[data-card="${c.id}"]'),dst=document.querySelector('[data-card="${a.id}"]');const dt=new DataTransfer();const r=dst.getBoundingClientRect();
    const fire=(el,type,y)=>el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+10,clientY:y}));
    fire(src,'dragstart',0);fire(dst,'dragover',r.top+2);fire(dst,'drop',r.top+2);fire(src,'dragend',0);return true})()`);
  const keys = await until(async () => { const [x, y] = [await item(a.id), await item(c.id)]; return y.sort_key < x.sort_key && [x.sort_key, y.sort_key]; });
  check(G, 'reorder: the dropped card gets a sort_key before its new neighbour', !!keys, JSON.stringify(keys));
  // drag lag fix (2026-10-29): the drop line is at full strength within 50 ms of the first dragover and does not slide when
  // the pointer moves from the upper to the lower half (no running transition on the card, only one marked card on the page)
  const line = await T.ev(`(async()=>{const src=document.querySelector('[data-card="${a.id}"]'),dst=document.querySelector('[data-card="${b.id}"]');if(!src||!dst)return null;const dt=new DataTransfer();const r=dst.getBoundingClientRect();
    const fire=(el,type,y)=>el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+20,clientY:y}));
    const st=()=>({cls:dst.classList.contains('drop-before')?'before':dst.classList.contains('drop-after')?'after':'',anim:dst.getAnimations().length,shadow:getComputedStyle(dst).boxShadow!=='none',marked:document.querySelectorAll('.drop-before,.drop-after').length});
    fire(src,'dragstart',0);fire(dst,'dragover',r.top+3);await new Promise(z=>setTimeout(z,50));const up=st();
    fire(dst,'dragover',r.bottom-3);await new Promise(z=>setTimeout(z,50));const down=st();fire(src,'dragend',0);return {up,down}})()`);
  check(G, 'drag: the drop line is full within 50 ms and does not slide (no transition, one marked card)', !!line && line.up.cls === 'before' && line.down.cls === 'after' &&
    line.up.anim === 0 && line.down.anim === 0 && line.up.shadow && line.down.shadow && line.up.marked === 1 && line.down.marked === 1, JSON.stringify(line));
  await T.reload(); await T.ready(); await pick(T, ST.id);
  const order = await T.ev(`[...document.querySelectorAll('section.q[data-q="B"] [data-card]')].map(x=>x.dataset.card).filter(id=>[${JSON.stringify(a.id)},${JSON.stringify(b.id)},${JSON.stringify(c.id)}].includes(id)).join()`);
  check(G, 'the card order survives a reload', order === [c.id, a.id, b.id].join(), order);
  await undo(T).catch(() => {});
  // done, restore (keeps proposed), cancel
  const p = await mkItem('proposed', { status: 'proposed' });
  await T.ev('dispatchEvent(new Event("focus")),true'); await T.wait(`!!document.querySelector('[data-done="${p.id}"]')`);
  await T.click(`[data-done="${p.id}"]`);
  check(G, 'done: status done, completed_at set', await until(async () => { const x = await item(p.id); return x.status === 'done' && x.completed_at; }));
  await undo(T);
  check(G, 'undo done: back to proposed', await until(async () => (await item(p.id)).status === 'proposed'));
  await T.wait(`!!document.querySelector('[data-done="${p.id}"]')`); await T.click(`[data-done="${p.id}"]`);
  await until(async () => (await item(p.id)).status === 'done');
  await T.click('[data-view="archive"]'); await T.wait(`!!document.querySelector('[data-restore="${p.id}"]')`);
  await T.click(`[data-restore="${p.id}"]`);
  check(G, 'restore from the archive keeps proposed (status before completion)', await until(async () => (await item(p.id)).status === 'proposed'));
  await T.click('[data-view="matrix"]');
  await T.wait(`!!document.querySelector('[data-card="${p.id}"]')`); await T.click(`[data-card="${p.id}"]`);
  await T.wait('!!document.querySelector("dialog[open] #fcancel")'); await T.click('dialog[open] #fcancel');
  check(G, 'cancel: status cancelled', await until(async () => (await item(p.id)).status === 'cancelled'));
  await undo(T);
  check(G, 'undo cancel: back to proposed', await until(async () => (await item(p.id)).status === 'proposed'));
  // list move (new num), into the Cyrillic test list made in errors, or a fresh one
  const target = testLists[0] || await newTestList(T, CYR_LIST);
  await T.ev('dispatchEvent(new Event("focus")),true'); await sleep(1500); await pick(T, ST.id);
  await T.wait(`!!document.querySelector('[data-card="${b.id}"]')`); await T.click(`[data-card="${b.id}"]`);
  await dialogSave(T, { list: target.id });
  const moved = await until(async () => { const x = await item(b.id); return x.list_id === target.id && x; });
  check(G, 'list move: the item takes the target list\'s next number', moved && moved.num !== b.num || (moved && moved.list_id === target.id), moved ? `num ${b.num} -> ${moved.num}` : '');
  await undo(T);
  check(G, 'undo list move: back in _selftest', await until(async () => (await item(b.id)).list_id === ST.id));
  // delete from the window, undo
  await T.wait('!document.querySelector("dialog[open]")'); await T.wait(`!!document.querySelector('[data-card="${a.id}"]')`);
  await T.click(`[data-card="${a.id}"]`); await T.wait('!!document.querySelector("dialog[open] #fdel")'); await T.click('dialog[open] #fdel');
  check(G, 'delete: soft delete (deleted_at)', await until(async () => !!(await item(a.id)).deleted_at));
  await undo(T);
  check(G, 'undo delete: restored', await until(async () => !(await item(a.id)).deleted_at));
  await T.reload(); await T.ready(); await pick(T, ST.id);
  check(G, 'everything survives a reload', await T.has(`[data-card="${a.id}"]`) && await T.has(`[data-card="${p.id}"]`) && !(await T.has(`[data-card="${added.id}"]`)));
}
async function newTestList(T, name) {
  await T.click('#newlist'); await T.wait('!!document.getElementById("nl-name")');
  await T.insert('#nl-name', name); await T.ev('performance.clearMarks();document.getElementById("nl-shared").checked=false;document.getElementById("nl-go").click();true');
  const l = await until(async () => (await MK.rest('GET', 'lists?select=id,slug,name&archived_at=is.null&order=created_at.desc&limit=1&name=eq.' + encodeURIComponent(name))).json[0]);
  if (l) testLists.push(l);
  // round 3: the page marks the RPC's answer (td:list-rpc) and the first frame after the chip is drawn (td:list-shown)
  if (l && await T.wait('performance.getEntriesByName("td:list-shown").length>0', 5000)) l.ms = await T.ev('Math.round(performance.getEntriesByName("td:list-shown")[0].startTime-performance.getEntriesByName("td:list-rpc")[0].startTime)');
  return l;
}

async function gSync() {
  const G = 'sync', M = await maksymPage();
  const A = await tab(B, await ctx(B));
  check(G, 'Anastasiia opens signed in', await open(A, await grantFor('anastasiia')));
  await pick(A, ST.id); await M.ev('dispatchEvent(new Event("focus")),true'); await pick(M, ST.id);
  const x = await mkItem('sync me'), y = await mkItem('sync two', { sort_key: 999999 });
  await M.ev('dispatchEvent(new Event("focus")),true'); await A.ev('dispatchEvent(new Event("focus")),true');
  await M.wait(`!!document.querySelector('[data-card="${x.id}"]')`); await A.wait(`!!document.querySelector('[data-card="${x.id}"]')`);
  await M.click(`[data-card="${x.id}"]`); await dialogSave(M, { title: `${RUN} by maksym` });
  await until(async () => (await item(x.id)).title === `${RUN} by maksym`);
  const t0 = Date.now(), poll = 30000;
  const seen = await A.wait(`(document.querySelector('[data-card="${x.id}"] .t')||{}).textContent==="${RUN} by maksym"`, poll + 8000);
  check(G, 'Maksym\'s edit shows for Anastasiia within one poll', seen, `${Math.round((Date.now() - t0) / 1000)} s`);
  // reorder by Maksym (REST is enough to show the shared order; the drag itself is in data)
  await MK.rest('PATCH', 'items?id=eq.' + y.id, { sort_key: -1e6 });
  await A.ev('dispatchEvent(new Event("focus")),true');
  check(G, 'a reorder shows for Anastasiia (shared sort_key)', await A.wait(`(document.querySelector('section.q[data-q="B"] [data-card]')||{}).dataset?.card===${JSON.stringify(y.id)}`, 8000));
  // conflict, no clash: Anastasiia changes the title; Maksym's page (old version) changes the description -> both land
  await AN.rest('PATCH', 'items?id=eq.' + x.id, { title: `${RUN} by anastasiia` });
  await M.wait('!document.querySelector("dialog[open]")');
  await M.click(`[data-card="${x.id}"]`); await dialogSave(M, { notes: 'note by maksym' });
  check(G, 'conflict without a clash: Maksym\'s change is re-applied on the new version, hers kept', await until(async () => { const r = await item(x.id); return r.body_md === 'note by maksym' && r.title === `${RUN} by anastasiia`; }));
  // conflict with a clash: both change the title -> hers saved, the window stays open with his text and a notice
  await M.ev('dispatchEvent(new Event("focus")),true'); await sleep(1500);
  await M.click(`[data-card="${x.id}"]`); await M.wait('!!document.querySelector("dialog[open] #fs")');
  await AN.rest('PATCH', 'items?id=eq.' + x.id, { title: `${RUN} hers again` });
  await dialogSave(M, { title: `${RUN} his text` });
  const kept = await M.wait(`!!document.querySelector('dialog[open] .note') && document.querySelector('dialog[open] #ft').textContent==="${RUN} his text"`, 10000);
  check(G, 'conflict with a clash: the window reopens with his text and says what changed', kept && (await item(x.id)).title === `${RUN} hers again`);
  await M.ev('document.querySelector("dialog[open]")?.close(),true');
  // a poll while the window is open: her change to another field arrives, his title still lands, hers stays
  await M.ev('dispatchEvent(new Event("focus")),true'); await sleep(1500);
  await M.click(`[data-card="${x.id}"]`); await M.wait('!!document.querySelector("dialog[open] #fs")');
  await AN.rest('PATCH', 'items?id=eq.' + x.id, { body_md: 'her note during his edit' });
  await M.ev('dispatchEvent(new Event("focus")),true'); await sleep(2500);
  await dialogSave(M, { title: `${RUN} after poll` });
  check(G, 'a poll while the window is open: his title and her description both land', await until(async () => { const r = await item(x.id); return r.title === `${RUN} after poll` && r.body_md === 'her note during his edit'; }));
  await M.ev('document.querySelector("dialog[open]")?.close(),true');
  // two quick edits both land
  await M.ev('dispatchEvent(new Event("focus")),true'); await sleep(1500);
  await M.click(`[data-done="${y.id}"]`); await M.click(`[data-card="${x.id}"]`); await dialogSave(M, { title: `${RUN} quick` });
  check(G, 'two quick edits both land', await until(async () => (await item(y.id)).status === 'done' && (await item(x.id)).title === `${RUN} quick`));
  // offline: a new item waits, then is sent once on reconnect
  await M.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await M.click('[data-add="D"]'); await dialogSave(M, { title: `${RUN} offline`, list: ST.id });
  const offTxt = await M.wait('/Offline: \\d+ change/.test((document.querySelector(".toast span")||{}).textContent||"")', 8000);
  await M.shot('sync-offline-toast');
  await M.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await M.ev('dispatchEvent(new Event("online")),true');
  const count = await until(async () => { const r = await MK.rest('GET', `items?select=id&list_id=eq.${ST.id}&title=eq.${encodeURIComponent(RUN + ' offline')}`); return r.json.length || 0; }, 15000);
  await sleep(2000);
  const again = (await MK.rest('GET', `items?select=id&list_id=eq.${ST.id}&title=eq.${encodeURIComponent(RUN + ' offline')}`)).json.length;
  check(G, 'offline: the toast counts waiting changes; on reconnect the item is stored once', offTxt && count === 1 && again === 1, `toast ${offTxt}, stored ${again}`);
  gSync.A = A;
}

async function gArchive() {
  const G = 'archive', T = await maksymPage();
  const z = await mkItem('in archived list');
  await T.ev('dispatchEvent(new Event("focus")),true'); await sleep(1500);
  await pick(T, ST.id);
  await T.click('#listmenu'); await T.wait('!!document.querySelector("[data-archive-list]")'); await T.click('[data-archive-list]');
  await T.wait('!!document.getElementById("cf-ok")'); await T.click('#cf-ok');
  check(G, 'the chip menu archives _selftest (archived_at set)', await until(async () => !!(await MK.rest('GET', 'lists?select=archived_at&id=eq.' + ST.id)).json[0].archived_at));
  await T.wait(`!document.querySelector('.lists [data-list="${ST.id}"]')`, 8000);
  check(G, 'it leaves the chips and All', !(await T.has(`[data-list="${ST.id}"]`)) && !(await T.has(`[data-card="${z.id}"]`)));
  await T.ev(`(()=>{const q=document.getElementById('q');q.value=${JSON.stringify(RUN + ' in archived')};q.dispatchEvent(new Event('input'));return true})()`);
  check(G, 'search finds nothing in it', await T.wait('/No matches/.test((document.getElementById("dd")||{}).textContent||"")', 5000));
  await T.click('#clear');
  const pr = await MK.rest('PATCH', 'items?id=eq.' + z.id, { title: 'thaw' });
  check(G, 'a PATCH of one of its items is refused (42501, list archived)', !pr.ok && pr.err.kind === 'denied' && /archived/.test(pr.err.message), pr.err && pr.err.message);
  await T.click('#profile'); await T.wait('!!document.querySelector("[data-menu=archived]")'); await T.click('[data-menu=archived]');
  check(G, 'it shows under Archived lists with Restore', await T.wait(`!!document.querySelector('[data-restore-list="${ST.id}"]')`));
  await T.click(`[data-restore-list="${ST.id}"]`);
  const rt = await T.wait(`!!document.querySelector('.lists [data-list="${ST.id}"]') || !!document.getElementById('more')`, 10000);
  // #more is there already when many lists overflow the chips, so wait for the database rather than the page alone
  check(G, 'Restore brings it back', rt && await until(async () => !(await MK.rest('GET', 'lists?select=archived_at&id=eq.' + ST.id)).json[0].archived_at),(await toastText(T)) + ' | dialogs ' + (await T.ev('document.querySelectorAll("dialog").length')) + ' | ' + T.errors.slice(-2).join(' / '));
  await pick(T, ST.id);
  await T.click('#listmenu'); await T.click('[data-archive-list]'); await T.wait('!!document.getElementById("cf-ok")'); await T.click('#cf-ok');
  check(G, 'archived again', await until(async () => !!(await MK.rest('GET', 'lists?select=archived_at&id=eq.' + ST.id)).json[0].archived_at));
  // the rest of the run needs it open
  await MK.rest('PATCH', 'lists?id=eq.' + ST.id, { archived_at: null });
  await T.ev('dispatchEvent(new Event("focus")),true'); await sleep(1500);
}

async function gErrors() {
  const G = 'errors', T = await maksymPage();
  await pick(T, ST.id);
  await T.click('[data-add="C"]');
  await dialogSave(T, { title: `${RUN} sensitive`, notes: 'pay 4111 1111 1111 1111', list: ST.id });
  const msg = await T.wait('/card number/.test((document.querySelector("dialog[open] #fe")||{}).textContent||"")', 10000);
  check(G, 'a card number in the body: the window stays open with the database\'s message', msg && await T.ev('/4111/.test(document.querySelector("dialog[open] #fn").textContent)'));
  await T.shot('errors-sensitive-maksym-1440x900');
  await T.ev('document.querySelector("dialog[open]")?.close(),true');
  const l = testLists[0] || await newTestList(T, CYR_LIST);
  check(G, 'a Cyrillic list name works (slug list-xxxxxx), the new list is selected', !!l && /^list-[a-z0-9]{6}$/.test(l.slug) && await T.wait(`document.querySelector('[data-list="${l.id}"]')?.getAttribute('aria-pressed')==="true"`, 8000), l && l.slug);
  // role-limited: Anastasiia as viewer on _selftest sees no add, done or drag controls there
  const A = gSync.A || await (async () => { const x = await tab(B, await ctx(B)); await open(x, await grantFor('anastasiia')); return x; })();
  const v = await mkItem('viewer sees');
  await MK.rest('PATCH', `list_members?list_id=eq.${ST.id}&profile_id=eq.${AN.uid}`, { role: 'viewer' });
  await A.ev('dispatchEvent(new Event("focus")),true'); await sleep(2500); await pick(A, ST.id);
  await A.wait(`!!document.querySelector('[data-card="${v.id}"]')`);
  check(G, 'viewer: no add, no done, not draggable; the window is read only', !(await A.has('[data-add]')) && !(await A.has(`[data-done="${v.id}"]`)) && await A.ev(`!document.querySelector('[data-card="${v.id}"]').draggable`));
  await A.click(`[data-card="${v.id}"]`);
  check(G, 'viewer: the task window has no Save', await A.wait('!!document.querySelector("dialog[open]") && !document.querySelector("dialog[open] #fs")'));
  await A.shot('errors-viewer-anastasiia-1440x900');
  await A.ev('document.querySelector("dialog[open]")?.close(),true');
  await MK.rest('PATCH', `list_members?list_id=eq.${ST.id}&profile_id=eq.${AN.uid}`, { role: 'editor' });
}

async function gUi() {
  const G = 'ui';
  // round 4: a reminder with a long description (Show more at 300), an end date (the small card's End line), a category badge
  const r4 = await mkItem('round 4 long description', { category: 'reminder', body_md: ('Round four ' + 'word '.repeat(90)).trim(), due_at: new Date(Date.now() + 3 * 864e5).toISOString() });
  const r4c = `document.querySelector('[data-card="${r4.id}"]')`;
  for (const [who, theme] of [['maksym', 'light'], ['anastasiia', 'dark']]) {
    const T = await tab(B, await ctx(B));
    await T.theme(theme);
    // round 3, adjustment 12, then 2026-10-29 (version 3): the welcome is one card (what is new, then the Urgency and Card
    // layout forms, then Later and Save); it shows once per person and version (prefs.welcomeVersion < 3; put back in cleanup)
    const c0 = who === 'maksym' ? MK : AN;
    const readPrefs = async () => { const r = await c0.rest('GET', 'preferences?select=prefs&profile_id=eq.' + c0.uid + '&app=eq.tasksdashboard'); return r.ok && r.json.length ? r.json[0].prefs : null; };
    const p0 = await readPrefs();
    if (p0) await c0.rest('POST', 'preferences?on_conflict=profile_id,app', core.rowFromPrefs(c0.uid, Object.assign({}, p0, { welcomeSeen: true, welcomeVersion: 2 })), { Prefer: 'resolution=merge-duplicates,return=minimal' });
    const P = core.prefsFromRow(p0), S = P.settings; // the person's values
    const WL = `document.getElementById('welcome')`;
    // the card's values as the page reads them, and where its parts sit
    const wlState = `(()=>{const el=${WL};if(!el)return null;const q=s=>el.querySelector(s),leg=[...el.querySelectorAll('legend')].map(l=>l.textContent);return {win:+q('[data-u=win]').value,th:+q('[data-u=th]').value,lim:+q('[data-u=lim]').value,
      sw:q('input[name=s-switch]:checked')?.value,mode:q('input[name=cl-mode]:checked')?.value,auto:+q('[data-cl-auto]').value,fields:${JSON.stringify(core.CARD_FIELDS)}.every(k=>q('[data-cl="'+k+'"]').checked===!!${JSON.stringify(P.cardLayout)}[k]),tags:q('input[name=cl-tags]:checked')?.value,
      cards:[...el.querySelectorAll('.wl-card h3')].map(h=>h.textContent),order:leg.indexOf('Moving between tasks')<leg.indexOf('Cards open')&&leg.indexOf('Cards open')>=0,text:el.textContent,
      focus:document.activeElement===q('[data-u=win]'),dialog:el.tagName==='DIALOG'||el.getAttribute('role')==='dialog',beacon:document.getElementById('profile').classList.contains('beacon'),old:!!q('#wl-next,#wl-back,#wl-urg,#wl-cl'),
      ids:[...el.querySelectorAll('[id]')].every(x=>document.querySelectorAll('#'+CSS.escape(x.id)).length===1)}})()`;
    T.keepWelcome = true;
    check(G, `${who}: opens signed in`, await open(T, await grantFor(who)));
    const w0 = (await T.wait(`!!${WL}`, 5000)) ? await T.ev(wlState) : null;
    check(G, `${who}: someone who closed the two-panel note (welcomeVersion 2) sees the welcome card once`, !!w0);
    check(G, `${who}: the welcome is one card: the new task window text, then Urgency and Card layout forms, no Next or Back, not a dialog, the profile menu highlighted`,
      !!w0 && JSON.stringify(w0.cards) === '["Urgency","Card layout"]' && /previous or next task/.test(w0.text) && /Do, then Plan, Delegate, Eliminate/.test(w0.text) && /Unsaved changes ask first/.test(w0.text) && !w0.old && !w0.dialog && w0.beacon && w0.ids,
      w0 && JSON.stringify({ cards: w0.cards, old: w0.old, dialog: w0.dialog, beacon: w0.beacon, ids: w0.ids }));
    check(G, `${who}: the card's forms hold the person's values (Urgency window, Due soon, Do limit, Moving between tasks, Cards open, Shorten, A card shows, Tags)`,
      !!w0 && w0.win === S.windowDays && w0.th === S.threshold && w0.lim === S.doLimit && w0.sw === P.taskSwitcher && w0.mode === P.cards.mode && w0.auto === P.cardLayout.autoCollapse && w0.fields && w0.tags === P.cardLayout.tags,
      w0 && JSON.stringify({ win: w0.win, th: w0.th, lim: w0.lim, sw: w0.sw, mode: w0.mode, auto: w0.auto, fields: w0.fields, tags: w0.tags }));
    await T.shot(`welcome-card-1440x900-${theme}`);
    const wlRow = n => `(()=>{const t=[...${WL}.querySelectorAll('input[name=${n}]')].map(i=>i.closest('label').getBoundingClientRect());return t.length===2&&Math.abs(t[0].top-t[1].top)<=2&&t[1].left>t[0].right})()`;
    check(G, `${who}: on the card Moving between tasks comes before Cards open, each radio group on one row; focus starts on the first field and Tab goes down`, !!w0 && w0.order && w0.focus &&
      await T.ev(wlRow('s-switch')) && await T.ev(wlRow('cl-mode')) && (await T.key('Tab'), await T.ev(`document.activeElement===${WL}.querySelector('[data-u=th]')`)));
    check(G, `${who}: at 1440 the card ends inside the screen, its body scrolls and Save stays in view`, await T.ev(`(()=>{const el=${WL},r=el.getBoundingClientRect(),b=el.querySelector('.wl-body'),s=el.querySelector('#wl-save').getBoundingClientRect();return r.bottom<=innerHeight&&s.bottom<=r.bottom&&s.top>=r.top&&(b.scrollHeight<=b.clientHeight||getComputedStyle(b).overflowY==='auto')})()`));
    await T.size(390, 844); await sleep(500);
    check(G, `${who}: at 390 px the card fits the screen, Save in view, nothing is wider than the screen or the card`, await T.ev(`(()=>{const el=${WL},r=el.getBoundingClientRect(),b=el.querySelector('.wl-body'),s=el.querySelector('#wl-save').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight+1&&s.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth&&b.scrollWidth<=b.clientWidth})()`));
    await T.shot(`welcome-card-390x844-${theme}`);
    await T.size(1440, 900); await sleep(300);
    // the board stays usable behind it: the search box takes focus and text while the card is open
    check(G, `${who}: the board stays usable while the card is open (search takes text)`, await T.ev(`(()=>{const s=document.querySelector('#q, input[type=search]');if(!s)return false;s.focus();return document.activeElement===s&&!!${WL}})()`));
    // Tasks Grouping asks first on the card too; Cancel puts the tick back and the card stays
    const grpWas = await T.ev(`${WL}.querySelector('[data-cl=group]').checked`);
    await T.click('#welcome [data-cl=group]');
    check(G, `${who}: changing Tasks Grouping on the card asks first; Cancel puts the tick back, the card stays`, await T.wait('!!document.querySelector("dialog[open] #grp-ok")', 2000) &&
      (await T.click('#grp-cancel'), await T.wait(`!document.querySelector('dialog[open]')&&!!${WL}&&${WL}.querySelector('[data-cl=group]').checked===${grpWas}`, 2000)));
    // a change on the card + Save is saved: settings and Card layout, read back from the database
    const lim0 = who === 'maksym' ? 8 : 5, auto0 = 280, sw0 = P.taskSwitcher === 'coverflow' ? 'standard' : 'coverflow';
    await T.ev(`(()=>{const el=${WL};el.querySelector('[data-u=lim]').value='${lim0}';el.querySelector('[data-cl-auto]').value='${auto0}';el.querySelector('input[name=s-switch][value=${sw0}]').checked=true;el.querySelector('#wl-save').click();return true})()`);
    check(G, `${who}: Save closes the card and the highlight goes`, await T.wait(`!${WL}&&!document.getElementById('profile').classList.contains('beacon')`, 3000));
    await sleep(2000);
    const pS = await readPrefs();
    check(G, `${who}: Save on the card saves both forms and marks it seen (Do limit ${lim0}, Shorten ${auto0}, ${sw0}, welcomeVersion 3, welcomeSeen true)`,
      !!pS && pS.settings.doLimit === lim0 && pS.settings.windowDays === S.windowDays && pS.cardLayout.autoCollapse === auto0 && pS.taskSwitcher === sw0 && pS.welcomeVersion === 3 && pS.welcomeSeen === true,
      pS ? JSON.stringify({ doLimit: pS.settings.doLimit, autoCollapse: pS.cardLayout.autoCollapse, taskSwitcher: pS.taskSwitcher, welcomeVersion: pS.welcomeVersion, welcomeSeen: pS.welcomeSeen }) : 'no row');
    // back to the person's own switcher (cleanup puts all preferences back too)
    await T.click('#profile'); await T.click('[data-menu=cardlayout]'); await T.wait('!!document.getElementById("cl-save")');
    await T.ev(`(()=>{const d=document.querySelector('dialog[open]');d.querySelector('input[name=s-switch][value=${P.taskSwitcher}]').checked=true;d.querySelector('#cl-save').click();return true})()`);
    // the board opens on the person's last list (a preference); the round-4 card checks need All lists
    await pick(T, 'all');
    await T.click('#profile'); await T.click('[data-menu=urgency]'); await T.wait('!!document.getElementById("s-lim")');
    const lim = who === 'maksym' ? 7 : 4;
    await T.ev(`document.getElementById('s-lim').value='${lim}';document.getElementById('s-save').click();true`);
    // round 3, adjustment 13: Card layout (cards open expanded, owner shown, auto-collapse 300)
    await T.click('#profile'); await T.click('[data-menu=cardlayout]'); await T.wait('!!document.getElementById("cl-save")');
    await T.shot(`ui-cardlayout-${who}-1440x900-${theme}`);
    // 2026-10-29: Moving between tasks above Cards open, and each radio group on one row
    check(G, `${who}: Card layout: Moving between tasks comes before Cards open, each radio group on one row at 1440`, await T.ev(`(()=>{const d=document.querySelector('dialog[open]'),leg=[...d.querySelectorAll('legend')].map(l=>l.textContent);
      const row=n=>{const t=[...d.querySelectorAll('input[name='+n+']')].map(i=>i.closest('label').getBoundingClientRect());return t.length===2&&Math.abs(t[0].top-t[1].top)<=2&&t[1].left>t[0].right};
      return leg.indexOf('Moving between tasks')===0&&leg.indexOf('Cards open')===1&&row('s-switch')&&row('cl-mode')})()`));
    await T.shot(`cardlayout-order-1440x900-${theme}`);
    const archivedTl = ((await c0.rest('GET', 'tag_lists?select=id&archived_at=not.is.null')).json || []).map(x => x.id);
    check(G, `${who}: Card layout has no "Who it is for" and lists no archived tag list (edit window, items 3, 4; ${archivedTl.length} archived)`,
      await T.ev(`(()=>{const d=document.querySelector('dialog[open]');const a=new Set(${JSON.stringify(archivedTl)});return !d.querySelector('[data-cl=owner]')&&!/Who it is for/.test(d.textContent)&&![...d.querySelectorAll('[data-cl-list]')].some(b=>a.has(b.dataset.clList))})()`));
    await T.ev(`(()=>{const d=document.querySelector('dialog[open]');d.querySelector('input[name=cl-mode][value=expanded]').checked=true;d.querySelector('[data-cl=creator]').checked=true;d.querySelector('#cl-auto').value='300';d.querySelector('#cl-save').click();return true})()`);
    check(G, `${who}: Card layout expanded: cards open; "By <name>" on cards`, await T.wait(`!document.querySelector('[data-card]') || document.querySelectorAll('[data-card].full').length>0`, 5000), 'By-lines: ' + await T.ev(`[...document.querySelectorAll('.card.full .details .row span')].filter(s=>/^By /.test(s.textContent)).length`));
    // round 4, item 4: an open card cuts the long description at 300 characters with Show more (and Show less); item 3: no category badge
    check(G, `${who}: an open card cuts a 400-character description at 300, Show more shows the rest (round 4, item 4)`, await T.wait(`!!${r4c}?.querySelector('[data-more]')`, 8000) &&
      await T.ev(`${r4c}.querySelector('.md').textContent.length<=302`) && (await T.click(`[data-more="${r4.id}"]`), await T.wait(`${r4c}.querySelector('.md').textContent.length>390&&/Show less/.test(${r4c}.querySelector('[data-more]').textContent)`, 3000)),
      await T.ev(`${r4c}?.querySelector('.md')?.textContent.length`));
    check(G, `${who}: no category badge on a card while Source is off (round 4, item 3)`, await T.ev(`!!${r4c}&&!${r4c}.querySelector('.tbs .tb:not(.ai)')`));
    await sleep(2000);
    await T.reload(); await T.ready();
    check(G, `${who}: the welcome does not come back after a reload`, await T.ev('!document.getElementById("welcome")'));
    // General settings → Welcome card: Show again brings the card back with the values saved since; Later saves nothing; Escape closes it
    T.keepWelcome = true;
    await T.click('#profile'); await T.click('[data-menu=general]'); await T.wait('!!document.getElementById("s-welcome")'); await T.click('#s-welcome');
    const w1 = (await T.wait(`!!${WL}`, 3000)) ? await T.ev(wlState) : null;
    check(G, `${who}: Show again brings the welcome card back, its forms holding the values saved since (Do limit ${lim}, Shorten 300, Expanded)`, !!w1 && w1.lim === lim && w1.auto === 300 && w1.mode === 'expanded' && w1.focus,
      w1 && JSON.stringify({ lim: w1.lim, auto: w1.auto, mode: w1.mode, focus: w1.focus }));
    await T.ev(`(()=>{const el=${WL};el.querySelector('[data-u=lim]').value='33';el.querySelector('[data-cl-auto]').value='111';return true})()`);
    await T.click('#wl-later');
    check(G, `${who}: Later closes the card`, await T.wait(`!${WL}`, 2000));
    await sleep(2000);
    const pL = await readPrefs();
    check(G, `${who}: Later saves nothing from the card and marks it seen (Do limit ${lim}, Shorten 300, welcomeVersion 3)`, !!pL && pL.settings.doLimit === lim && pL.cardLayout.autoCollapse === 300 && pL.welcomeVersion === 3,
      pL ? JSON.stringify({ doLimit: pL.settings.doLimit, autoCollapse: pL.cardLayout.autoCollapse, welcomeVersion: pL.welcomeVersion }) : 'no row');
    await T.click('#profile'); await T.click('[data-menu=general]'); await T.wait('!!document.getElementById("s-welcome")'); await T.click('#s-welcome');
    await T.wait(`!!${WL}`, 3000); await T.key('Escape');
    check(G, `${who}: Escape closes the welcome card`, await T.wait(`!${WL}`, 2000));
    T.keepWelcome = false;
    await T.click('#profile'); await T.click('[data-menu=cardlayout]'); await T.wait('!!document.getElementById("cl-save")');
    check(G, `${who}: Card layout survives a reload`, await T.ev(`(()=>{const d=document.querySelector('dialog[open]');return d.querySelector('input[name=cl-mode][value=expanded]').checked&&d.querySelector('[data-cl=creator]').checked&&d.querySelector('#cl-auto').value==='300'})()`));
// Tasks Grouping (2026-10-29): Reset that changes grouping asks first; the run applies it (grp-ok) so no confirm stays open
    await T.ev('document.getElementById("cl-reset").click();document.getElementById("grp-ok")?.click();document.getElementById("cl-save").click();true');
    // round 4, item 5: a small card shows its number and a second line with what Card layout switches on (by default End)
    check(G, `${who}: a small card shows its number and an End line (round 4, item 5)`, await T.wait(`!!${r4c}?.classList.contains('compact')&&!!${r4c}.querySelector('.ref')&&/End \\d{4}-/.test(${r4c}.querySelector('.sub')?.textContent||'')`, 5000),
      await T.ev(`${r4c}?.querySelector('.sub')?.textContent`));
    await T.ev(`(${r4c}.click(),true)`); await T.wait('!!document.querySelector("dialog[open] #ft")', 5000);
    check(G, `${who}: the task window shows the number (Card layout) and no Sources while Source is off (round 4, items 3, 5)`,
      await T.ev(`(document.getElementById('fwho')?.textContent||'')===${r4c}.querySelector('.ref').textContent&&!document.querySelector('dialog[open] #srcs')`), await T.ev(`document.getElementById('fwho')?.textContent`));
    // edit window, items 1-3: no Quadrant, no For; the number sits on the formatting row (right at 1440, under the buttons at 390)
    const rowAt = `(()=>{const d=document.querySelector('dialog[open]'),f=d.querySelector('.fbar .fmt'),w=d.querySelector('.fbar #fwho');if(!f||!w)return null;const a=f.getBoundingClientRect(),b=w.getBoundingClientRect();return {same:Math.abs((a.top+a.bottom)/2-(b.top+b.bottom)/2)<=4,below:b.top>=a.bottom-1,right:b.left>a.right,fits:d.scrollWidth<=d.clientWidth,fq:!!d.querySelector('#fq'),forText:d.querySelector('#fwho').textContent.split(' ').includes('For')}})()`;
    const wide = await T.ev(rowAt);
    check(G, `${who}: task window at 1440: no Quadrant, no For, the info line on the formatting row, right of the buttons (edit window, items 1-3)`, !!wide && wide.same && wide.right && !wide.fq && !wide.forText, JSON.stringify(wide));
    await sleep(400); await T.shot(`ui-edit-window-${who}-1440x900-${theme}`);
    await T.size(390, 844); await sleep(400);
    const narrow = await T.ev(rowAt);
    check(G, `${who}: task window at 390: the info line wraps under the buttons, no horizontal scroll (edit window, item 2)`, !!narrow && narrow.below && narrow.fits, JSON.stringify(narrow));
    await T.shot(`ui-edit-window-${who}-390x844-${theme}`);
    await T.size(1440, 900);
    await closeDialogs(T);
    // round 4, item 3: Source on shows the category badge and Sources with All lists, never with one list selected
    await T.click('#profile'); await T.click('[data-menu=cardlayout]'); await T.wait('!!document.getElementById("cl-save")');
    await T.ev('(document.querySelector("dialog[open] [data-cl=source]").checked=true,document.querySelector("dialog[open] #cl-save").click(),true)');
    check(G, `${who}: Source on, All lists: the card shows "Reminder" and the task window shows Sources (round 4, item 3)`, await T.wait(`/Reminder/.test(${r4c}?.querySelector('.tbs')?.textContent||'')`, 5000) &&
      (await T.ev(`(${r4c}.click(),true)`), await T.wait('!!document.querySelector("dialog[open] #srcs")', 5000)));
    await closeDialogs(T);
    // the app's state lives inside its script's closure (not page globals): select the list through its chip
    await pick(T, ST.id);
    check(G, `${who}: Source on, one list selected: no badge and no Sources (round 4, item 3)`, await T.wait(`!!${r4c}&&!${r4c}.querySelector('.tbs .tb:not(.ai)')`, 5000) &&
      (await T.ev(`(${r4c}.click(),true)`), await T.wait('!!document.querySelector("dialog[open] #ft")', 5000)) && await T.ev('!document.querySelector("dialog[open] #srcs")'),
      await T.ev(`JSON.stringify({pressed:document.querySelector('[data-list="${ST.id}"]')?.getAttribute('aria-pressed'),chip:!!document.querySelector('.lists [data-list="${ST.id}"]'),card:!!${r4c},tbs:(${r4c}?.querySelector('.tbs')?.textContent||'').slice(0,80),dlg:!!document.querySelector('dialog[open] #ft'),srcs:!!document.querySelector('dialog[open] #srcs')})`));
    await closeDialogs(T);
    // round 4, item 2: an owner's list menu has Share and no People; a member's has People and no Share
    const owns = (await MK.rest('GET', `lists?select=owner_id&id=eq.${ST.id}`)).json[0]?.owner_id === (who === 'maksym' ? MK : AN).uid;
    await T.click('#listmenu');
    check(G, `${who}: the _selftest list menu shows ${owns ? 'Share and no People (owner)' : 'People and no Share (member)'} (round 4, item 2)`,
      await T.ev(owns ? `!!document.querySelector('#pop [data-share-list]')&&!document.querySelector('#pop [data-people-list]')` : `!!document.querySelector('#pop [data-people-list]')&&!document.querySelector('#pop [data-share-list]')`));
    await pick(T, 'all');
    await T.click('#profile'); await T.click('[data-menu=cardlayout]'); await T.wait('!!document.getElementById("cl-save")');
    await T.ev('document.getElementById("cl-reset").click();document.getElementById("grp-ok")?.click();document.getElementById("cl-save").click();true');
    await T.click('#profile'); await T.click('[data-menu=urgency]'); await T.wait('!!document.getElementById("s-lim")');
    check(G, `${who}: settings and preferences survive a reload (Do limit ${lim})`, await T.ev(`document.getElementById('s-lim').value==='${lim}'`));
    check(G, `${who}: Urgency settings hold only window, due soon % and Do limit`, await T.ev('!!document.getElementById("s-win")&&!!document.getElementById("s-th")&&!document.getElementById("s-wd")&&!document.getElementById("s-hpd")&&!document.getElementById("s-name")'));
    await T.ev('document.querySelector("dialog[open]")?.close(),true');
    // round 3, adjustment 7: rail tabs Matrix, Archive, Review; task links: Timeline is the fourth tab
    check(G, `${who}: rail tabs are Matrix, Archive, Review (Timeline is in the account menu since 2026-10-29)`, await T.ev(`[...document.querySelectorAll('.views [role=tab]')].map(b=>b.dataset.view).join()==='matrix,archive,review'`));
    await T.click('[data-view=review]');
    // round 3, adjustment 8: the Weekly review view. Ten ISO weeks, this one picked and marked; Ctrl and Shift pick several
    check(G, `${who}: Review shows the week strip (10 weeks, this week picked and marked "now") and the hint`, await T.wait('document.querySelectorAll(".rvw .wk").length===10', 5000) &&
      await T.ev(`(()=>{const n=document.querySelector('.wk.now');return !!n&&n.getAttribute('aria-pressed')==='true'&&/W\\d+/.test(n.textContent)&&/Ctrl-click or Shift-click/.test(document.querySelector('.rv-hint').textContent)})()`));
    check(G, `${who}: the orange week line (--week) has at least 3:1 against the panel`, await T.ev(`(()=>{const rgb=c=>c.match(/[\\d.]+/g).slice(0,3).map(Number),L=c=>{const v=rgb(c).map(x=>x/255).map(x=>x<=.03928?x/12.92:((x+.055)/1.055)**2.4);return .2126*v[0]+.7152*v[1]+.0722*v[2]};const w=getComputedStyle(document.querySelector('.wk'),'::before').backgroundColor,p=getComputedStyle(document.querySelector('.rvw')).backgroundColor,a=L(w),b=L(p);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=3})()`),
      await T.ev(`getComputedStyle(document.querySelector('.wk'),'::before').backgroundColor`));
    const wk = await T.ev(`[...document.querySelectorAll('.wk')].map(b=>b.dataset.wk)`), cur = wk.indexOf(await T.ev('document.querySelector(".wk.now").dataset.wk'));
    const clickWk = (k, m) => T.ev(`(document.querySelector('[data-wk="${k}"]').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:${!!m.ctrl},shiftKey:${!!m.shift}})),true)`);
    const picked = () => T.ev(`[...document.querySelectorAll('.wk[aria-pressed=true]')].map(b=>b.dataset.wk).join()`);
    await clickWk(wk[cur - 3], { ctrl: true });
    const two = await picked();
    await clickWk(wk[cur - 1], { shift: true });
    const range = await picked();
    await clickWk(wk[cur], {});
    check(G, `${who}: Ctrl-click adds a week, Shift-click picks the range from it, a click picks one`, two === [wk[cur - 3], wk[cur]].join() && range === wk.slice(cur - 3, cur).join() && await picked() === wk[cur], `${two} / ${range}`);
    await clickWk(wk[cur - 1], { shift: true });
    check(G, `${who}: tasks of the picked weeks by quadrant (four sections), rows open their task`, await T.ev('document.querySelectorAll(".rvq").length===4||!!document.querySelector(".rv-empty")') &&
      (await T.ev('!document.querySelector(".rv-r")') || (await T.click('.rv-r'), await T.wait('!!document.querySelector("dialog[open] #ft")', 5000))));
    await closeDialogs(T);
    // round 3 P1: U9 compact week tiles (one line, short); F3 no test list in the review; F4 list chips like files in Windows
    check(G, `${who}: week tiles are one compact line (≤ 34 px high) and keep the orange line (U9)`, await T.ev(`[...document.querySelectorAll('.rvw .wk')].every(b=>b.getBoundingClientRect().height<=34&&getComputedStyle(b,'::before').height==='2px')`),
      await T.ev(`Math.round(document.querySelector('.rvw .wk').getBoundingClientRect().height)+' px'`));
    check(G, `${who}: the review's list chips leave out test lists (_selftest) (F3)`, await T.ev(`![...document.querySelectorAll('[data-rvl]')].some(b=>b.dataset.rvl==='${ST.id}')`));
    const rvl = await T.ev(`[...document.querySelectorAll('[data-rvl]')].map(b=>b.dataset.rvl).filter(v=>v!=='all')`);
    if (rvl.length >= 3) {
      const clickL = (k, m) => T.ev(`(document.querySelector('[data-rvl="${k}"]').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:${!!m.ctrl},shiftKey:${!!m.shift}})),true)`);
      const pickedL = () => T.ev(`[...document.querySelectorAll('[data-rvl][aria-pressed=true]')].map(b=>b.dataset.rvl).join()`);
      await clickL(rvl[0], {}); await clickL(rvl[2], { shift: true });
      const range = await pickedL();
      await clickL(rvl[1], { ctrl: true });
      const less = await pickedL();
      check(G, `${who}: list chips: a click picks one, Shift-click the range, Ctrl-click drops one (F4)`, range === rvl.slice(0, 3).join() && less === [rvl[0], rvl[2]].join(), `${range} / ${less}`);
      await T.click('[data-rvl="all"]');
    } else skip(G, `${who}: list chips Shift-click (F4)`, 'fewer than 3 lists');
    // round 4 wave B, item 7 (D6): the API rpc/review_report (db/016) for the picked weeks gives the rows the Review shows: the
    // same ids, kinds and quadrants, as this person, in under 2 s. The page's rows come from the DOM (its state is in a closure);
    // cancelled rows may move once the page has read their cancel times, so the comparison is retried for a few seconds
    const rvWeeks = (await picked()).split(',').filter(Boolean);
    const pageRows = () => T.ev(`[...document.querySelectorAll('.rvw .rvq')].flatMap(s=>[...s.querySelectorAll('.rv-r')].map(b=>s.dataset.q+':'+b.dataset.open+':'+['done','cancelled','overdue','due'].find(k=>b.classList.contains(k)))).sort()`);
    const t0r = Date.now(), rr = await c0.rest('POST', 'rpc/review_report', { p_weeks: rvWeeks }), rpcMs = Date.now() - t0r;
    const apiRows = rr.ok ? rr.json.groups.flatMap(g => g.lists.flatMap(l => (l.rows || []).map(r => g.q + ':' + r.id + ':' + r.kind))).sort() : null;
    const same = async () => { const p = await pageRows(); return apiRows && JSON.stringify(p) === JSON.stringify(apiRows) ? p : null; };
    const pr0 = await until(same, 8000);
    const diff = apiRows && !pr0 ? (pg => { const a = new Set(apiRows), b = new Set(pg); return 'api only: ' + apiRows.filter(x => !b.has(x)).slice(0, 4).join(' ') + '; page only: ' + pg.filter(x => !a.has(x)).slice(0, 4).join(' '); })(await pageRows()) : '';
    check(G, `${who}: rpc/review_report matches the Review for the picked weeks (ids, kinds, quadrants) in under 2 s (round 4 wave B, D6)`, !!pr0 && rpcMs < 2000,
      rr.ok ? `${apiRows.length} rows, ${rvWeeks.join(' ')}, ${rpcMs} ms${diff ? '; ' + diff : ''}` : 'rpc failed: ' + (rr.err && rr.err.message));
    reviewApiTimes.push({ who, ms: rpcMs, rows: apiRows ? apiRows.length : null, weeks: rvWeeks.join(' ') });
    // round 4, item 6 (replaces round 3 U10): Visuals (the KPI) are open on entering the Review, above the tasks, a --- line between
    check(G, `${who}: Visuals open on entering the Review, named Visuals, above the tasks with a line between (round 4, item 6)`, await T.ev(`(()=>{const k=document.getElementById('kpi'),hr=document.querySelector('.rvw hr.rv-sep'),t=document.querySelector('.rvw .rvq,.rvw .rv-empty,.rvw .rv-none');return !!k&&k.open&&/^Visuals/.test(k.querySelector('summary').textContent)&&!!hr&&!!(k.compareDocumentPosition(hr)&Node.DOCUMENT_POSITION_FOLLOWING)&&(!t||!!(hr.compareDocumentPosition(t)&Node.DOCUMENT_POSITION_FOLLOWING))})()`));
    // round 3 P1, U11: one block; Period | All time (or "All time = the same days"); three charts under their questions
    check(G, `${who}: KPI is one block with three charts under their questions, the dates beside the range (U11)`, await T.wait('document.querySelectorAll(".kpi-g").length===1 && !!document.querySelector(".kpi-g .kpi-area svg") && !!document.querySelector(".kpi-g .kpi-qs") && !!document.querySelector(".kpi-g .kpi-left")', 30000) &&
      await T.ev(`[...document.querySelectorAll('.kpi-qn')].map(f=>f.textContent).join('|')==='Is my open work growing, and where?|Where is my work, and how much is done?|How did tasks leave the board?'&&/\\d{4}/.test(document.querySelector('.kpi-per').textContent)&&!document.querySelector('.kpi-pie')`));
    const seg = await T.ev('document.querySelectorAll("[data-kpir]").length');
    if (seg) {
      await T.click('[data-kpir=all]');
      check(G, `${who}: the Period | All time switch shows All time (U11)`, await T.wait('document.querySelector(".kpi-g")?.dataset.kpi==="all"&&document.querySelector("[data-kpir=all]").getAttribute("aria-pressed")==="true"', 5000));
    } else check(G, `${who}: without a switch the KPI says "All time = the same days" (U11)`, await T.ev('/All time = the same days/.test(document.querySelector(".kpi-same")?.textContent||"")||!document.querySelector(".kpi-top .kpi-seg")'));
    check(G, `${who}: the line chart's date ticks are unique (F6)`, await T.ev(`(()=>{const t=[...document.querySelectorAll('.kpi-area .kx')].map(x=>x.textContent);return t.length>0&&new Set(t).size===t.length})()`),
      await T.ev(`[...document.querySelectorAll('.kpi-area .kx')].map(x=>x.textContent).join(', ')`));
    check(G, `${who}: the KPI's list chips leave out test lists, archived ones too (F3)`, await T.ev(`(document.getElementById('kpi-arch')?.getAttribute('aria-expanded')==='false'&&document.getElementById('kpi-arch').click(),true)`) &&
      await T.ev(`!document.querySelector('[data-kpil="${ST.id}"]')`));
    // the read time (ms), items, events and lists of the KPI, from the section's data-read (set once the read is done)
    const kt = await T.ev(`(()=>{const d=document.getElementById('kpi').dataset.read;if(!d)return null;const p=d.split(',');return {ms:+p[0],items:+p[1],events:+p[2],lists:+p[3],via:p[4]}})()`);
    kpiTimes.push(Object.assign({ who }, kt || {}));
    check(G, `${who}: KPI read (items and item_events, all lists) under 2 s`, !!kt && kt.ms < 2000, kt ? `${kt.ms} ms, ${kt.items} items, ${kt.events} events, ${kt.lists} lists, via ${kt.via}` : 'no data');
    check(G, `${who}: each quadrant row reads "Plan · n open · n closed · n%" and carries the exact numbers on hover (U11)`, await T.ev(`[...document.querySelectorAll('.kq')].length===4&&[...document.querySelectorAll('.kq')].every(r=>/· \\d+ open · \\d+ closed · \\d+%/.test(r.textContent)&&/\\d+ open, \\d+ closed; \\d+ of \\d+ \\(\\d+%\\)/.test(r.title))`));
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      await T.size(w, h); await sleep(500); await T.shot(`ui-review-${who}-${w}x${h}-${theme}`);
      await T.ev('(document.getElementById("kpi").scrollIntoView(),true)'); await sleep(200); await T.shot(`ui-kpi-${who}-${w}x${h}-${theme}`);
      await T.ev('scrollTo(0,0),true');
    }
    await T.size(1440, 900);
    // round 4, item 6: folded Visuals open again after the view changes
    await T.ev('(document.querySelector("#kpi summary").click(),true)'); await T.wait('!document.getElementById("kpi").open', 3000);
    await T.click('[data-view=matrix]'); await T.click('[data-view=review]');
    check(G, `${who}: folded Visuals are open again after leaving the Review and coming back (round 4, item 6)`, await T.wait('!!document.getElementById("kpi")?.open', 5000) && await T.wait('!!document.querySelector(".kpi-g")', 30000));
    if (who === 'maksym') {
      // Download: one self-contained HTML file (no script, no network) with the review and the KPI charts
      const dlDir = OUT; // flat: the saved file lands next to the report
      await B.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, browserContextId: T.ctxId });
      await T.click('#rv-dl');
      let file = null;
      for (let i = 0; i < 60 && !file; i++) { await sleep(250); file = fs.readdirSync(dlDir).find(f => /^tasks-review-.*\.html$/.test(f)); }
      const html = file ? fs.readFileSync(path.join(dlDir, file), 'utf8') : '';
      check(G, 'Download saves one HTML file: the review, the KPI charts as SVG, print styles, no script, no network', !!file && /<h1>Weekly review<\/h1>/.test(html) && /class="kpi-g"/.test(html) && /<svg/.test(html) && /@media print/.test(html) && !/<script/i.test(html) && !/(src|href)="https?:/i.test(html), file || 'no file');
      check(G, 'the saved file has the redesigned KPI (the three questions, quadrant rows) and no test list rows (U11, F3)', /Is my open work growing, and where\?/.test(html) && /class="kpi-qs"/.test(html) && !html.includes('kpi-pie') && !html.includes('_selftest'));
      check(G, 'the saved file puts Visuals first, then the line, then the tasks (round 4, item 6)', /<h2>Visuals<\/h2>/.test(html) && html.indexOf('class="kpi"') < html.indexOf('class="rv-sep"') && (html.indexOf('class="rvq') < 0 || html.indexOf('class="rv-sep"') < html.indexOf('class="rvq')));
      if (file) {
        const E = await tab(B, await ctx(B));
        await E.go(pathToFileURL(path.join(dlDir, file)).href); await sleep(300);
        for (const [w, h] of [[1440, 900], [390, 844]]) { await E.size(w, h); await sleep(300); await E.shot(`ui-export-${w}x${h}`); }
        check(G, 'the saved file opens with no console errors and no horizontal scroll at 390 px', !E.errors.length && await E.ev('document.documentElement.scrollWidth<=innerWidth'));
        await E.close();
      }
    }
    await T.click('#profile');
    check(G, `${who}: the account menu has General settings and Urgency settings, and Timeline, no Weekly review`, await T.ev(`(()=>{const t=document.getElementById('pop').textContent;return /General settings/.test(t)&&/Urgency settings/.test(t)&&/Timeline/.test(t)&&!/Weekly review/.test(t)})()`));
    await T.click('[data-menu=timeline]');
    check(G, `${who}: the account menu's Timeline opens the Timeline view; the Matrix tab stays reachable`, await T.wait('!!document.querySelector(".tl")', 5000) && await T.ev(`document.querySelector('.views [data-view=matrix]').tabIndex===0`));
    await T.click('#profile'); await T.click('[data-menu=general]');
    check(G, `${who}: General settings hold display name and time zone`, await T.wait('!!document.getElementById("s-name")&&!!document.getElementById("s-tz")&&!document.getElementById("s-lim")', 5000));
    await T.ev('document.querySelector("dialog[open]")?.close(),true');
    await T.click('[data-view=matrix]');
    // round 3, adjustments 5 and 6, then the tags round: Account menu → Tags shows every tag list as an open tray in my one order,
    // each live one with a grip and a ★ toggle (favourite), no "default" wording; the task window's tags grouped by tag list
    await T.click('#profile'); await T.click('[data-menu=tags]');
    const tgw = (await T.wait('!!document.querySelector("dialog[open] .tgl")', 5000)) ? await T.ev(`(()=>{const d=document.querySelector('dialog[open]'),live=[...d.querySelectorAll('.tgl:not(.arch)')];
      const attrs=[...d.querySelectorAll('[title],[aria-label]')].map(e=>(e.getAttribute('title')||'')+' '+(e.getAttribute('aria-label')||'')).join(' ');
      return {n:live.length,grip:live.every(s=>!!s.querySelector('.tgl-grip[data-grip]')),star:live.every(s=>{const b=s.querySelector('button.tgl-star[data-fav]');return !!b&&['true','false'].includes(b.getAttribute('aria-pressed'))&&b.title==='Favourite: opens in the task window'}),
        open:live.every(s=>{const t=s.querySelector('.tgl-tags');return !!t&&t.getBoundingClientRect().height>0})&&!d.querySelector('.tgl.shut'),noDefault:!/default/i.test(d.textContent+' '+attrs)}})()`) : null;
    check(G, `${who}: Tags shows every tag list as an open tray, each live one with a grip and a ★ toggle (aria-pressed); no "default" wording (tags round)`, !!tgw && tgw.n > 0 && tgw.grip && tgw.star && tgw.open && tgw.noDefault, JSON.stringify(tgw));
    for (const [w, h] of [[1440, 900], [390, 844]]) { await T.size(w, h); await sleep(400); await T.shot(`ui-tags-${who}-${w}x${h}-${theme}`); }
    await T.size(1440, 900); await closeDialogs(T);
    // a saved list with no open card (prefs.list, maybe set by someone using the app meanwhile): look in All
    if (!(await T.has('[data-card]')) && await T.has('[data-list="all"]')) { await T.click('[data-list="all"]'); await sleep(400); }
    const anyCard = await T.ev('document.querySelector("[data-card]")?.dataset.card||""');
    if (anyCard) {
      await T.click(`[data-card="${anyCard}"]`);
      // tags round: my favourites (★ on the head) start open, every other group closed; the order is my one order (prefs tagListOrder)
      // (a row from before the tags round is migrated and saved by the page on load: wait for tagListOrderV 2)
      const favs = core.prefsFromRow(await until(async () => { const p = await readPrefs(); return p && p.tagListOrderV === core.TAG_LIST_ORDER_V ? p : null; }, 8000) || await readPrefs()).tagListFavs;
      check(G, `${who}: the task window groups tags under their tag lists; my ${favs.length} favourite(s) open with ★, the others closed; the title wraps (two lines at most)`,
        await T.wait('document.querySelectorAll("dialog[open] .tgg[data-tgg]").length>0', 5000) &&
        await T.ev(`(()=>{const f=new Set(${JSON.stringify(favs)});return [...document.querySelectorAll('dialog[open] .tgg[data-tgg]')].every(g=>g.classList.contains('shut')===!f.has(g.dataset.tgg)&&!!g.querySelector('.tgg-h .star')===f.has(g.dataset.tgg))})()`) &&
        await T.ev(`getComputedStyle(document.querySelector('dialog[open] #ft')).whiteSpace!=='nowrap'`),
        await T.ev(`[...document.querySelectorAll('dialog[open] .tgg[data-tgg]')].map(g=>(g.classList.contains('shut')?'-':'+')+(g.querySelector('.tgg-h .star')?'*':'')).join('')`));
      // round 3 P1: no "Tags" label, a search box (U1, U6); names above chips, not buttons (U2, U4); wider window (U5); the tag box
      // scrolls inside about 40% of the height and Save stays in view (U8); at 1440 Title and End are in view too
      for (const [w, h] of [[1440, 900], [390, 844]]) {
        await T.size(w, h); await sleep(400); await T.shot(`ui-task-${who}-${w}x${h}-${theme}`);
        const m = await T.ev(`(()=>{const d=document.querySelector('dialog[open]'),r=(d.querySelector('.tk-card')||d).getBoundingClientRect(),b=d.querySelector('.tagbox'),cs=getComputedStyle(b),inV=e=>{if(!e)return false;const x=e.getBoundingClientRect();return x.top>=r.top-1&&x.bottom<=r.bottom+1&&x.bottom<=innerHeight+1};
          const g=d.querySelector('.tgg:not(.shut)'),gh=g&&g.querySelector('.tgg-h').getBoundingClientRect(),gc=g&&g.querySelector('.tgg-c').getBoundingClientRect();
          return {w:Math.round(r.width),maxH:parseFloat(cs.maxHeight),oy:cs.overflowY,vh:innerHeight,save:inV(d.querySelector('#fs')||d.querySelector('.actions button:last-child')),title:inV(d.querySelector('#ft')),end:inV(d.querySelector('#fd')),
            noX:d.scrollWidth<=d.clientWidth&&document.documentElement.scrollWidth<=innerWidth,label:[...d.querySelectorAll('.flabel')].some(x=>x.textContent.trim()==='Tags'),search:!!d.querySelector('#tg-q'),
            bulk:!!d.querySelector('[data-bulk]'),nameBtn:!!d.querySelector('.tgg-h > button:not(.tgg-t)'),above:!g||gc.top>=gh.bottom-1}})()`);
        const at = `${who} ${w}x${h}`;
        check(G, `${at}: the task window has no "Tags" label and a search box over the tags (U1, U6)`, !m.label && m.search);
        check(G, `${at}: each tag list's name sits above its chips and is not a button (U2, U4)`, m.above && !m.bulk && !m.nameBtn);
        check(G, `${at}: the task window is ${w > 700 ? 'about 720 px wide' : 'inside the screen'}, no horizontal scroll (U5)`, (w > 700 ? m.w >= 700 && m.w <= 730 : m.w <= w) && m.noX, m.w + ' px');
        check(G, `${at}: the tag box scrolls inside ≤ 40% of the height; Save in view${w > 700 ? '; Title and End in view' : ''} (U8)`, m.oy === 'auto' && m.maxH <= 0.41 * m.vh && m.save && (w < 700 || (m.title && m.end)), `max-height ${m.maxH} of ${m.vh}, save ${m.save}, title ${m.title}, end ${m.end}`);
      }
      await T.size(1440, 900); await closeDialogs(T);
    } else skip(G, `${who}: the task window's grouped tags`, 'no card on the board');
    // counts on the chips equal the database (open, live items on lists that are not archived)
    const c = who === 'maksym' ? MK : AN;
    const lists = (await c.rest('GET', 'lists?select=id,name&archived_at=is.null')).json;
    const items = (await c.getAll('items?select=list_id&deleted_at=is.null&status=not.in.(done,cancelled)')).json;
    const chips = await T.ev(`Object.fromEntries([...document.querySelectorAll('.lists [data-list]')].map(b=>[b.dataset.list,+b.querySelector('.n').textContent]))`);
    const bad = lists.filter(l => chips[l.id] !== undefined && chips[l.id] !== items.filter(i => i.list_id === l.id).length).map(l => l.name);
    check(G, `${who}: chip counts equal REST counts`, !bad.length && chips.all === items.filter(i => lists.some(l => l.id === i.list_id)).length, bad.join(', '));
    for (const [w, h] of [[1440, 900], [390, 844]]) { await T.size(w, h); await sleep(600); await T.shot(`ui-${who}-${w}x${h}-${theme}`); }
    await T.size(390, 844); await sleep(400);
    for (const v of ['matrix', 'review']) { await T.click(`[data-view=${v}]`); await sleep(300); check(G, `${who}: no horizontal scroll at 390 px (${v})`, await T.ev('document.documentElement.scrollWidth<=innerWidth'), await T.ev('document.documentElement.scrollWidth+" / "+innerWidth')); }
    await T.click('[data-view=matrix]');
    check(G, `${who}: no card overflows at 390 px (round 4: the small card's second line)`, await T.ev('[...document.querySelectorAll(".card")].every(c=>c.scrollWidth<=c.clientWidth+1)'),
      await T.ev(`(()=>{const c=${r4c};return c?Math.round(c.getBoundingClientRect().height)+' px high (round-4 card)':'no round-4 card'})()`));
    await T.size(1440, 900);
    check(G, `${who}: ${onlyHosts()}`, !strayHosts(T.hosts, SUPA, ORIGIN).length, [...T.hosts].join(', '));
    check(G, `${who}: no console errors`, !T.errors.length, T.errors.slice(0, 2).join(' / '));
    await T.close();
  }
  // a low-confidence item from the CLI as homeos-agent: marker and filter
  const T = await maksymPage();
  // round 3, adjustments 1 and 2: the new list is selected at once from the RPC's answer; the same name again is refused here
  const nl = await newTestList(T, `${RUN} list`);
  check(G, 'new list: selected, its chip drawn ≤ 300 ms after the RPC answers', !!nl && nl.ms !== undefined && nl.ms <= 300 && await T.ev(`document.querySelector('[data-list="${nl && nl.id}"]')?.getAttribute('aria-pressed')==="true"`), nl ? nl.ms + ' ms' : 'no list');
  await T.click('#newlist'); await T.wait('!!document.getElementById("nl-name")');
  const rpcs = () => T.requests.filter(u => /rpc\/create_list/.test(u)).length, sent = rpcs();
  await T.insert('#nl-name', `${RUN} LIST `); await T.click('#nl-go');
  check(G, 'the same name again (case, spaces): "You already have a list named …", no RPC sent', await T.wait('/You already have a list named/.test(document.getElementById("nl-e")?.textContent||"")', 5000) && rpcs() === sent);
  await T.shot('ui-newlist-clash-maksym-1440x900');
  await closeDialogs(T);
  // round 3 P1, F1: Enter in the name (a real key press) creates the list like Create, instead of closing the window
  await T.click('#newlist'); await T.wait('!!document.getElementById("nl-name")');
  await T.ev('(document.getElementById("nl-shared")&&(document.getElementById("nl-shared").checked=false),true)');
  const enterName = `${RUN} enter`;
  await T.insert('#nl-name', enterName); await T.key('Enter');
  const el = await until(async () => (await MK.rest('GET', 'lists?select=id,slug,name&archived_at=is.null&name=eq.' + encodeURIComponent(enterName))).json[0]);
  if (el) testLists.push(el);
  check(G, 'New list: Enter in the name creates the list, closes the window and selects it (F1)', !!el && await T.wait('!document.querySelector("dialog[open]")', 5000) &&
    await T.wait(`document.querySelector('[data-list="${el && el.id}"]')?.getAttribute('aria-pressed')==="true"`, 5000));
  await closeDialogs(T);
  // round 3 P1, F5: a cancelled task is listed in the Weekly review by when it was cancelled (its item_events row), not by a later
  // write that moved updated_at. On the test list made above (the review leaves _selftest out, F3)
  if (nl) {
    const ci = (await MK.rest('POST', 'items', { list_id: nl.id, category: 'task', title: `${RUN} cancel date`, quadrant: 'B', sort_key: 1000 }, { Prefer: 'return=representation' })).json[0];
    await MK.rest('PATCH', 'items?id=eq.' + ci.id, { status: 'cancelled' });
    await sleep(2500);
    await MK.rest('PATCH', 'items?id=eq.' + ci.id, { title: `${RUN} cancel date (edited later)` });
    const ev = (await MK.rest('GET', `item_events?select=at&item_id=eq.${ci.id}&diff->status->>new=eq.cancelled`)).json[0];
    const upd = (await item(ci.id)).updated_at;
    await T.ev('dispatchEvent(new Event("focus")),true'); await sleep(1500);
    await T.click('[data-view=review]'); await T.click('[data-rvl="all"]');
    // the cancel times are read after the first render of the row (loadCancelTimes), which then renders again
    await T.wait(`!!document.querySelector('.rv-r[data-open="${ci.id}"]')`, 10000);
    if (ev) await T.wait(`+document.querySelector('.rv-r[data-open="${ci.id}"]')?.dataset.at===${Date.parse(ev.at)}`, 8000);
    const shown = await T.ev(`+(document.querySelector('.rv-r[data-open="${ci.id}"]')?.dataset.at||0)||null`);
    check(G, 'Weekly review: a cancelled task is listed at its cancel event, not at a later updated_at (F5)', !!ev && shown === Date.parse(ev.at) && Date.parse(upd) - Date.parse(ev.at) >= 2000, `shown ${shown}, event ${ev && Date.parse(ev.at)}, updated ${Date.parse(upd)}`);
    await T.click('[data-view=matrix]');
  } else skip(G, 'Weekly review cancel date (F5)', 'the test list was not made');
  await gUiTags(G, T);
  // the items edited just now stay shown through filters until a reload (st.keep): start the next checks fresh
  await T.reload(); await T.ready();
  const r = cli('add-task', '--as', 'homeos-agent', '--for', 'maksym', '--list', '_selftest', '--title', `${RUN} low confidence`, '--q', 'C', '--confidence', '0.42', '--needs-review', '--json');
  const low = r.status === 0 ? JSON.parse(r.stdout)[0] : null;
  check(G, 'CLI add-task as homeos-agent (needs review, confidence 0.42)', !!low, 'exit ' + r.status);
  if (low) {
    await T.ev('dispatchEvent(new Event("focus")),true'); await pick(T, ST.id);
    const lowSel = `!!document.querySelector('[data-card="${low.id}"].lowc .tb.ai')`;
    let lowOk = await T.wait(lowSel, 8000), lowNote = '';
    if (!lowOk) { // a card the poll has not brought yet: one reload (noted)
      lowNote = 'before reload: ' + await T.ev(`(()=>{const c=document.querySelector('[data-card="${low.id}"]');return c?'card '+c.className:'no card; list '+(document.querySelector('.lists [aria-pressed=true]')?.dataset.list===${JSON.stringify(ST.id)}?'_selftest':'other')})()`);
      await T.reload(); await T.ready(); await pick(T, ST.id); lowOk = await T.wait(lowSel, 8000);
      lowNote += '; after reload: ' + (lowOk ? 'shown' : await T.ev(`(()=>{const c=document.querySelector('[data-card="${low.id}"]');return c?'card '+c.className:'no card'})()`));
    }
    check(G, 'the low-confidence marker shows on the card', lowOk, lowNote);
    await T.click('#lowc');
    check(G, 'the "To check" filter shows only those items', await T.ev(`[...document.querySelectorAll('[data-card]')].every(c=>c.classList.contains('lowc')) && !!document.querySelector('[data-card="${low.id}"]')`));
    await T.click('#lowc');
  }
  // time zone: the same instant shown in New York
  const tz = await mkItem('time zone', { due_at: '2026-11-20T15:00:00Z' });
  const N = await tab(B, await ctx(B));
  await N.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
  await open(N, await grantFor('maksym')); await pick(N, ST.id);
  await N.wait(`!!document.querySelector('[data-card="${tz.id}"]')`); await N.click(`[data-card="${tz.id}"]`);
  check(G, 'time zone override: the end shows in the browser zone (10:00 in New York for 15:00 UTC)', await N.wait('document.querySelector("dialog[open] #fd")?.value==="2026-11-20T10:00"'));
  await N.close();
}

// ---- links (task links, db/018), Maksym's page, all in _selftest: a parent with subtasks made in the task window (one found by
// the search, one created there), a predecessor chain and a parent by rpc/link_items, a loop left out of the picker, Start and
// Priority saved; badges and Group by parent on the board (a faded parent heads its child in another quadrant); the Timeline's
// tree, arrows (one late) and fold; 200 rows drawn in under 100 ms; screenshots at both widths, light and dark.
async function gLinks() {
  const G = 'links';
  const T = await tab(B, await ctx(B));
  await T.theme('light');
  check(G, 'opens signed in', await open(T, await grantFor('maksym')));
  const ready = await MK.rest('POST', 'rpc/unlink_items', { p_from: ST.id, p_to: ST.id, p_kind: 'parent' });
  if (!ready.ok && ready.status === 404) { skip(G, 'task links', 'rpc/unlink_items is missing: db/018 is not applied'); await T.close(); return; }
  const day = n => { const d = new Date(Date.now() + n * 864e5); d.setHours(12, 0, 0, 0); return d.toISOString(); };
  const par = await mkItem('links parent', { quadrant: 'A', start_at: day(0), due_at: day(9) });
  const k1 = await mkItem('links child one', { quadrant: 'A', start_at: day(0), due_at: day(3) });
  const k2 = await mkItem('links child two', { quadrant: 'B', start_at: day(2), due_at: day(6) });
  const k3 = await mkItem('links child three', { quadrant: 'A', start_at: day(4), due_at: day(8) });
  const L = (f, t, k) => MK.rest('POST', 'rpc/link_items', { p_from: f, p_to: t, p_kind: k });
  const rs = [await L(k2.id, k1.id, 'depends_on'), await L(k3.id, k2.id, 'depends_on'), await L(k3.id, par.id, 'parent'), await L(k2.id, par.id, 'parent')];
  check(G, 'rpc/link_items: two predecessors and two parents', rs.every(r => r.ok), rs.map(r => r.ok ? 'ok' : r.err.message).join(', '));
  const loop = await L(k1.id, k3.id, 'depends_on');
  check(G, 'rpc/link_items refuses a loop (22023, no titles in the text)', !loop.ok && /loop/.test(loop.err.message) && !loop.err.message.includes(RUN), loop.ok ? 'ok' : loop.err.message);
  await T.reload(); await T.ready(); await pick(T, ST.id);
  await T.wait(`!!document.querySelector('[data-card="${par.id}"]')`, 10000);
  // the task window: + Subtask by search, + Subtask by Create, a loop left out, Start and Priority
  await T.click(`[data-card="${par.id}"]`);
  check(G, 'the task window has Start and the Links block, no Priority (priority by position)', await T.wait('!!document.querySelector("dialog[open] #fsd")&&!document.querySelector("dialog[open] #fp")&&!!document.querySelector("dialog[open] #lk")', 5000));
  check(G, 'the window lists the stored subtasks (two), each with the subtask colour and glyph, and one row of add buttons: + Predecessor, + Next, + Subtask, + Parent', await T.ev(`(()=>{const c=[...document.querySelectorAll('#lk .lk-chip.lk-child[data-role=child]')];const b=[...document.querySelectorAll('#lk .lk-adds [data-lk-add]')];return c.length===2&&c.every(x=>x.querySelector('.lk-g').textContent==='↓')&&b.map(x=>x.dataset.lkAdd).join()==='pred,next,child,parent'&&new Set(b.map(x=>Math.round(x.getBoundingClientRect().top))).size===1&&getComputedStyle(c[0]).borderTopColor!==getComputedStyle(document.querySelector('#lk .lk-adds')).borderTopColor})()`));
  await T.shot('ui-links-window-1440x900-light');
  await T.click('#lk [data-lk-add=child]');
  await T.insert('#lk-q', 'links child one');
  check(G, 'the search finds the task by title words', await T.wait(`(document.querySelector('#lk-opts li[data-i="0"]')||{}).textContent?.includes('links child one')`, 4000));
  await T.key('Enter');
  check(G, 'Enter picks it: a chip under Subtasks, the box closed', await T.wait(`!!document.querySelector('#lk [data-lk-del="child|${k1.id}"]')&&!document.getElementById('lk-q')`, 3000));
  await T.click('#lk [data-lk-add=child]');
  await T.insert('#lk-q', `${RUN} links child new`);
  await T.wait('!!document.querySelector("#lk-opts li.create")', 3000);
  await T.click('#lk-opts li.create');
  check(G, 'Create adds a new subtask chip', await T.wait('!!document.querySelector("#lk .lk-chip.new")', 3000));
  await T.click('#lk [data-lk-add=parent]');
  await T.insert('#lk-q', 'links child');
  check(G, 'the parent search leaves out the subtasks (each would make a loop)', await T.wait('document.querySelectorAll("#lk-opts li[data-i]").length===0', 3000));
  await T.key('Escape');
  check(G, 'Escape closes the search box and keeps the window', await T.wait('!document.getElementById("lk-q")&&!!document.querySelector("dialog[open] #lk")', 3000));
  // tags round (1): Links shows the chips only (no "Waiting for" note, no "N subtasks still open" line)
  check(G, 'Links: chips only, no "Waiting for" note and no "subtasks still open" line (tags round)', await T.ev(`(()=>{const k=document.querySelector('dialog[open] #lk');return !!k&&!k.querySelector('.lk-wait,.lk-open')&&!/still open|Waiting for/i.test(k.textContent)&&k.querySelectorAll('.lk-chip').length>=2})()`));
  for (const [w, h] of [[1440, 900], [390, 844]]) { await T.size(w, h); await sleep(400); await T.shot(`links-window-maksym-${w}x${h}-light`); }
  await T.size(1440, 900);
  await T.ev(`(()=>{const e=document.getElementById('fsd');e.value='${day(1).slice(0, 10)}T09:00';e.dispatchEvent(new Event('input'));return true})()`);
  await T.click('dialog[open] #fs');
  const kids = await until(async () => { const r = await MK.rest('GET', `item_links?select=from_item&kind=eq.parent&removed_at=is.null&to_item=eq.${par.id}`); return r.ok && r.json.length === 4 ? r.json : null; });
  check(G, 'Save sends the links: four subtasks stored (two old, the picked one, the created one)', !!kids, kids ? '' : 'not 4');
  const nk = await until(async () => { const r = await MK.rest('GET', `items?select=id,quadrant,list_id&title=eq.${encodeURIComponent(RUN + ' links child new')}`); return r.ok && r.json.length ? r.json[0] : null; });
  check(G, 'the created subtask is in the same list and quadrant as its parent', !!nk && nk.list_id === ST.id && nk.quadrant === 'A');
  const ps = await item(par.id);
  check(G, 'Start is saved (start_at)', !!ps.start_at && new Date(ps.start_at).getDate() === new Date(day(1)).getDate(), ps.start_at);
  // tags round (1): child two waits for child one (open): its predecessor chip is .waiting with the title "Not done yet: this task
  // waits for it"; its parent chip is not
  await closeDialogs(T); await T.wait(`!!document.querySelector('[data-card="${k2.id}"]')`, 8000); await T.click(`[data-card="${k2.id}"]`);
  await T.wait('!!document.querySelector("dialog[open] #lk .lk-chip")', 5000);
  check(G, 'Links: an open predecessor\'s chip is amber (.waiting) with the title "Not done yet: this task waits for it"; the parent chip is not; no note (tags round)', await T.ev(`(()=>{const k=document.querySelector('dialog[open] #lk'),w=[...k.querySelectorAll('.lk-chip.waiting')];return w.length===1&&w[0].classList.contains('lk-pred')&&w[0].title==='Not done yet: this task waits for it'&&!k.querySelector('.lk-chip.lk-parent.waiting')&&!!k.querySelector('.lk-chip.lk-parent')&&!k.querySelector('.lk-wait,.lk-open')&&getComputedStyle(w[0]).borderTopStyle==='dashed'})()`));
  await T.ev('(document.querySelector("dialog[open] #lk")?.scrollIntoView({block:"center"}),true)'); await sleep(300); await T.shot('links-chips-1440x900-light');
  await closeDialogs(T);
  // the board: badges, then Group by parent
  // the badges need Waiting for and Subtask progress on and Tasks Grouping off, whatever the account stored (cleanup puts the preferences back);
  // set without a click, so the grouping confirm does not open
  await T.click('#profile'); await T.click('[data-menu=cardlayout]'); await T.wait('!!document.querySelector("dialog[open] #cl-save")', 4000);
  await T.ev("(()=>{const d=document.querySelector('dialog[open]');d.querySelector('[data-cl=waiting]').checked=true;d.querySelector('[data-cl=progress]').checked=true;d.querySelector('[data-cl=group]').checked=false;d.querySelector('#cl-save').click();return true})()");
  await T.wait(`!!document.querySelector('[data-card="${par.id}"] .tb.pg')`, 8000);
  check(G, 'badges: no P badge and the progress 0/4 on the parent, "Waiting for 1" on a task with an open predecessor', await T.ev(`(()=>{const p=document.querySelector('[data-card="${par.id}"]');const w=document.querySelector('[data-card="${k2.id}"] .tb.wt');return !p.querySelector('.tb.pr')&&p.querySelector('.tb.pg').textContent==='0/4'&&!!w&&w.querySelector('.wl').textContent.trim()==='Waiting for'&&w.textContent.endsWith('1')})()`));
  await T.click('#profile'); await T.click('[data-menu=cardlayout]'); await T.wait('!!document.querySelector("[data-cl=group]")', 4000);
  check(G, 'Card layout lists the three link switches (no Priority), grouping off by default', await T.ev(`['group','waiting','progress'].every(k=>!!document.querySelector('[data-cl='+k+']'))&&!document.querySelector('[data-cl=priority]')`) && core.CARD_LAYOUT_DEFAULTS.group === false); // the default, not the account's stored choice
  // Tasks Grouping (2026-10-29): the switch has the new name; a tick asks first, Cancel puts it back, Apply keeps it
  check(G, 'Card layout names the switch Tasks Grouping', await T.ev("document.querySelector('[data-cl=group]').closest('label').textContent.trim()==='Tasks Grouping'"));
  const g0 = await T.ev("document.querySelector('[data-cl=group]').checked");
  await T.click('[data-cl=group]');
  check(G, 'ticking or unticking Tasks Grouping opens a confirm that says the stored order changes on drags, with no way back', await T.wait('!!document.getElementById("grp-ok")', 3000) &&
    await T.ev(`/no automatic way back/.test(document.querySelector(".grp-ask").textContent)&&/Turn ${g0 ? 'off' : 'on'} Tasks Grouping/.test(document.querySelector(".grp-ask strong").textContent)`));
  for (const [w, h] of [[1440, 900], [390, 844]]) for (const theme of ['light', 'dark']) { await T.size(w, h); await T.theme(theme); await T.ev(`(document.documentElement.dataset.theme='${theme}',true)`); await sleep(350); await T.shot(`ui-grouping-confirm-${w}x${h}-${theme}`); }
  await T.size(1440, 900); await T.theme('light'); await T.ev("(document.documentElement.dataset.theme='light',true)");
  await T.click('#grp-cancel');
  check(G, 'Cancel puts the switch back', await T.wait(`!document.getElementById("grp-ok")&&document.querySelector("[data-cl=group]").checked===${g0}`, 3000));
  await T.click('[data-cl=group]'); await T.wait('!!document.getElementById("grp-ok")', 3000); await T.click('#grp-ok');
  check(G, 'Apply keeps the change', await T.wait(`!document.getElementById("grp-ok")&&document.querySelector("[data-cl=group]").checked===${!g0}`, 3000));
  await T.ev(`(document.querySelector('[data-cl=group]').checked=true,true)`); await T.click('#cl-save');
  await T.wait(`!!document.querySelector('[data-card="${k1.id}"].lk-kid')`, 5000);
  check(G, 'Group by parent: the parent first, its subtasks indented after it in Do', await T.ev(`(()=>{const ids=[...document.querySelectorAll('[data-body=A] [data-card]')].map(c=>c.dataset.card);const i=ids.indexOf('${par.id}');return i>=0&&ids.indexOf('${k1.id}')>i&&ids.indexOf('${k3.id}')>i&&document.querySelector('[data-card="${k3.id}"]').classList.contains('lk-kid')})()`));
  check(G, 'a subtask in another quadrant sits under a faded copy of its parent (not a card)', await T.ev(`(()=>{const g=document.querySelector('[data-body=B] .lk-ghost[data-open="${par.id}"]');const c=document.querySelector('[data-body=B] [data-card="${k2.id}"]');return !!g&&!!c&&c.classList.contains('lk-kid')&&!g.hasAttribute('data-card')&&(g.compareDocumentPosition(c)&4)>0})()`));
  // priority by position (2026-10-29): with grouping on, a drop lands where the board shows it and a parent takes its subtasks
  const gx = await mkItem('links drag x', { quadrant: 'A' });
  await T.ev('dispatchEvent(new Event("focus")),true'); await T.wait(`!!document.querySelector('[data-body=A] [data-card="${gx.id}"]')`, 8000);
  const drop = (src, dst, low) => T.ev(`(()=>{const a=document.querySelector('[data-card="'+${JSON.stringify(src)}+'"]'),b=document.querySelector('[data-card="'+${JSON.stringify(dst)}+'"]');const dt=new DataTransfer();const r=b.getBoundingClientRect();const y=${low ? 'r.bottom-3' : 'r.top+3'};
    const fire=(el,type)=>el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+20,clientY:y}));fire(a,'dragstart');fire(b,'dragover');fire(b,'drop');fire(a,'dragend');return true})()`);
  const keysOf = async ids => Object.fromEntries((await MK.rest('GET', 'items?select=id,sort_key&id=in.(' + ids.join(',') + ')')).json.map(r => [r.id, r.sort_key]));
  await drop(par.id, gx.id, true);
  const kp = await until(async () => { const k = await keysOf([par.id, k1.id, k3.id, gx.id]); return k[par.id] > k[gx.id] && k; });
  check(G, 'grouped drag: the parent dropped below a task moves there and its subtasks follow it (keys after it)', !!kp && kp[k1.id] > kp[par.id] && kp[k3.id] > kp[par.id], JSON.stringify(kp));
  await drop(gx.id, par.id, true);
  const kx = await until(async () => { const k = await keysOf([par.id, k1.id, k3.id, gx.id]); return k[gx.id] > k[par.id] && k; });
  check(G, 'grouped drag: a task dropped on a parent\'s lower half lands after its whole subtree, where the board shows it', !!kx && kx[gx.id] > kx[k1.id] && kx[gx.id] > kx[k3.id] &&
    await T.wait(`(()=>{const ids=[...document.querySelectorAll('[data-body=A] [data-card]')].map(c=>c.dataset.card);return ids.indexOf('${gx.id}')>ids.indexOf('${k1.id}')&&ids.indexOf('${gx.id}')>ids.indexOf('${k3.id}')})()`, 4000), JSON.stringify(kx));
  // the task deck (edit-nav plan, 2026-10-29): the band left / right of the window (between its top and bottom edge) switches task,
  // the bands above and below close it, a side with no neighbour closes; one modal for the whole session, no ‹ › buttons; unsaved
  // changes ask first (zones, bands, Esc); Alt+arrows; on a phone the edge tabs and a swipe on the header. Standard (default) first, then Coverflow
  const shown = async () => T.ev(`[...document.querySelectorAll('[data-body=A] [data-card]')].map(c=>c.dataset.card)`);
  const titleOf = id => T.ev(`document.querySelector('[data-card="${id}"]').getAttribute('aria-label')`);
  const openTitle = () => T.ev(`(document.querySelector('dialog[open] #ft')||{}).textContent||''`);
  const isOpen = async id => T.wait(`(document.querySelector('dialog[open] #ft')||{}).textContent===${JSON.stringify(await titleOf(id))}`, 4000);
  const zoneAt = z => T.ev(`(()=>{const r=document.querySelector('dialog[open] [data-zone=${z}]').getBoundingClientRect();return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)]})()`);
  const press = async z => { const [x, y] = await zoneAt(z); await T.mouse(x, y); };
  const closed = () => T.wait('!document.querySelector("dialog[open]")', 3000);
  // the run starts in Standard whatever Maksym chose (cleanup puts his preferences back): Card layout → Moving between tasks
  await T.click('#profile'); await T.click('[data-menu=cardlayout]'); await T.wait('!!document.querySelector("dialog[open] input[name=s-switch]")', 5000);
  await T.click('dialog[open] input[name=s-switch][value=standard]'); await T.click('#cl-save'); await T.wait('!document.querySelector("dialog[open]")', 3000); await sleep(300);
  let ids = await shown();
  await T.click(`[data-card="${ids[0]}"]`); await T.wait('!!document.querySelector("dialog.tk-deck[open] #ft")', 5000);
  // Standard is the default (prefs.taskSwitcher, Card layout): each side with a neighbour is a shadow over its whole zone, from
  // the card's edge (under its rounded edge) to the screen edge, darkest at the card, a big arrow near the card; no copies, no dots
  check(G, 'window at 1440 (Standard, the default): the next side is a shadow band beside the card with an arrow, the first card\'s left side is an empty close zone, "1 of n in A Do", no ‹ › buttons',
    await T.wait('!!document.querySelector("dialog[open] [data-zone=next][data-act=switch] .tk-g[data-nav=next]")', 3000) &&
    await T.ev(`(()=>{const d=document.querySelector('dialog[open]');return d.dataset.switcher==='standard'&&d.querySelector('[data-zone=prev]').dataset.act==='close'&&!d.querySelector('[data-zone=prev]').textContent.trim()&&!d.querySelector('.tk-nav')&&d.querySelector('#tk-pos').textContent==='1 of ${ids.length} in A Do'})()`),
    await T.text('dialog[open] #tk-pos'));
  await sleep(450); // the window's pop animation (scale) has ended
  const band = await T.ev(`(()=>{const d=document.querySelector('dialog[open]'),g=d.querySelector('.tk-g[data-nav=next]'),b=g.getBoundingClientRect(),c=d.querySelector('.tk-card').getBoundingClientRect(),v=g.querySelector('svg').getBoundingClientRect();return {left:Math.round(b.left-c.right),out:Math.round(b.right-c.right),dt:Math.round(b.top-c.top),db:Math.round(b.bottom-c.bottom),scr:Math.round(innerWidth-b.right),svg:Math.round(v.width),ax:Math.round(v.left+v.width/2-c.right),bg:/gradient/.test(getComputedStyle(g).backgroundImage),tl:(()=>{const k=d.querySelector('.tk-card'),p=document.createElement('i');p.style.color='var(--c)';k.append(p);const col=getComputedStyle(p).color;p.remove();return d.dataset.q==='A'&&getComputedStyle(k).backgroundImage.includes(col)})(),label:g.getAttribute('aria-label'),keys:g.getAttribute('aria-keyshortcuts'),pv:[...d.querySelectorAll('.tk-pv')].every(p=>p.hidden),dots:d.querySelector('.tk-dots').hidden}})()`);
  check(G, 'Standard: the shadow starts under the card\'s edge and reaches the screen edge, as tall as the card, a 40 px arrow near the card; aria-label "Next task: …", arrow shortcuts; no copies, no dots; the card\'s top line in the quadrant colour',
    band.left < 0 && Math.abs(band.scr) <= 1 && Math.abs(band.dt) <= 1 && Math.abs(band.db) <= 1 && band.svg === 40 && band.ax >= 30 && band.ax <= 80 && band.bg && band.tl &&
    /^Next task: /.test(band.label) && band.keys === 'ArrowRight Alt+ArrowRight Alt+PageDown' && band.pv && band.dots, JSON.stringify(band));
  await T.hover(720, 450); await sleep(400); await T.shot('std-1440x900-light'); await T.shot('ui-nav-1440x900-light');
  await T.theme('dark'); await T.ev("(document.documentElement.dataset.theme='dark',true)"); await sleep(350); await T.shot('std-1440x900-dark');
  await T.theme('light'); await T.ev("(document.documentElement.dataset.theme='light',true)"); await sleep(250);
  // a sampler for every frame: the same dialog node, never a frame without the modal, no close event while switching
  await T.ev(`(()=>{const d0=document.querySelector('dialog[open]');window.__nav={gaps:0,other:0,closes:0,frames:0,card:d0.querySelector('.tk-card'),turns:0};d0.addEventListener('close',()=>__nav.closes++);const f=()=>{const d=document.querySelector('dialog[open]');__nav.frames++;if(!d)__nav.gaps++;else if(d!==d0)__nav.other++;if(document.getAnimations().some(a=>a.id==='deck-move'))__nav.turns++;if(!__nav.stop)requestAnimationFrame(f)};requestAnimationFrame(f);return true})()`);
  // the pointer far out in the zone (not on the band): the whole zone is the hit area, the band darkens and its arrow nudges outward
  const [hx, hy] = await zoneAt('next'); await T.hover(hx, hy); await sleep(350); await T.shot('std-hover-next-1440x900-light'); await T.shot('ui-nav-hover-next-1440x900-light');
  check(G, 'Standard: hovering anywhere in the right zone darkens the band and moves its arrow outward', await T.ev(`(()=>{const g=document.querySelector('dialog[open] .tk-g[data-nav=next]');const m=new DOMMatrix(getComputedStyle(g.querySelector('svg')).transform);return +getComputedStyle(g,'::after').opacity>0.9&&m.m41>=3})()`));
  await press('next');
  check(G, 'a click in the zone right of the window opens the next card of the quadrant (shown order), "2 of n"', await isOpen(ids[1]) && await T.text('dialog[open] #tk-pos') === `2 of ${ids.length} in A Do`, await openTitle());
  await T.key('ArrowLeft', 1);
  check(G, 'Alt+← goes back', await isOpen(ids[0]), await openTitle());
  await T.ev("(document.querySelector('dialog[open] .tk-h').focus(),true)"); await T.key('ArrowRight');
  check(G, 'a plain → (focus outside the fields) goes on', await isOpen(ids[1]), await openTitle());
  await T.ev("(document.querySelector('dialog[open] #ft').focus(),true)"); await T.key('ArrowLeft'); await sleep(400);
  check(G, 'a plain ← while typing in the title moves the caret, not the window', await isOpen(ids[1]), await openTitle());
  await T.key('ArrowLeft', 1); await isOpen(ids[0]);
  await T.key('PageDown', 1);
  check(G, 'Alt+PageDown goes on', await isOpen(ids[1]), await openTitle());
  await press('prev'); await isOpen(ids[0]);
  const nav = await T.ev('(()=>{__nav.stop=true;const c=document.querySelector("dialog[open] .tk-card");return {gaps:__nav.gaps,other:__nav.other,closes:__nav.closes,frames:__nav.frames,turns:__nav.turns,sameCard:c===__nav.card}})()');
  check(G, 'switching keeps one modal: the same dialog node and card, no frame without it, no close event; Standard never turns the row', nav.gaps === 0 && nav.other === 0 && nav.closes === 0 && nav.frames > 10 && nav.sameCard && nav.turns === 0, JSON.stringify(nav));
  const fn = await T.ev(`(()=>{const r=document.querySelector('dialog[open] #fn').getBoundingClientRect();return [Math.round(r.left+20),Math.round(r.top+r.height/2)]})()`);
  await T.mouse(fn[0], fn[1], hx, hy); await sleep(400);
  check(G, 'a text selection dragged from the description into the right zone does not switch', await openTitle() === await titleOf(ids[0]), await openTitle());
  await T.ev("(()=>{const f=document.querySelector('dialog[open] #fn');f.textContent=f.textContent+' unsaved';return true})()");
  await press('top');
  check(G, 'unsaved changes: the band above asks first (Save and close, Discard and close, Stay)', await T.wait('!!document.querySelector("dialog[open] .tk-ask [data-ask=discard]")', 3000) &&
    await T.ev('[...document.querySelectorAll("dialog[open] .tk-ask [data-ask]")].map(b=>b.dataset.ask+":"+b.textContent).join()==="save:Save and close,discard:Discard and close,stay:Stay"'));
  await sleep(200); await T.shot('ui-nav-ask-close-1440x900-light');
  check(G, 'unsaved changes: the question is in view and on top (its middle is not covered by the button row), focus on its first button', await T.ev(`(()=>{const b=document.querySelector('dialog[open] .tk-ask'),r=b.getBoundingClientRect(),c=document.querySelector('dialog[open] .tk-card').getBoundingClientRect();const el=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return r.top>=c.top&&r.bottom<=c.bottom+1&&!!el&&b.contains(el)&&b.contains(document.activeElement)})()`));
  await T.click('dialog[open] .tk-ask [data-ask=stay]');
  await T.key('Escape');
  check(G, 'unsaved changes: Esc asks too, Stay keeps the window', await T.wait('!!document.querySelector("dialog[open] .tk-ask")', 3000) &&
    (await T.click('dialog[open] .tk-ask [data-ask=stay]'), await T.ev('!!document.querySelector("dialog[open]")&&!document.querySelector("dialog[open] .tk-ask")')));
  await press('next');
  check(G, 'unsaved changes: the zone right of it asks Save and go, Discard and go, Stay', await T.wait('!!document.querySelector("dialog[open] .tk-ask [data-ask=discard]")', 3000) &&
    await T.ev('[...document.querySelectorAll("dialog[open] .tk-ask [data-ask]")].map(b=>b.textContent).join()==="Save and go,Discard and go,Stay"'));
  await T.click('dialog[open] .tk-ask [data-ask=discard]');
  check(G, 'Discard and go opens the next card and saves nothing', await isOpen(ids[1]) &&
    !/unsaved/.test((await MK.rest('GET', 'items?select=body_md&id=eq.' + ids[0])).json[0].body_md || ''));
  await press('bottom');
  check(G, 'a click in the band below the window closes it', await closed());
  // to the end of the board by Alt+→ (the window moves A Do → B Plan → C Delegate → D Eliminate): on the way, the last task of one
  // quadrant leads to the first task of the next non-empty one; at the very end the right side is a close zone
  ids = await shown(); await sleep(300);
  await T.click(`[data-card="${ids[0]}"]`); await T.wait('!!document.querySelector("dialog[open] #ft")', 5000);
  const where = () => T.ev('(document.querySelector("dialog[open] #tk-pos")?.textContent||"")');
  let crossed = null;
  for (let i = 0; i < 40 && await T.ev('document.querySelector("dialog[open] [data-zone=next]")?.dataset.act==="switch"'); i++) {
    const a = await where(); await T.key('ArrowRight', 1); await sleep(250); const b = await where();
    if (!crossed && /^(\d+) of \1 in A /.test(a) && / in [BCD] /.test(b)) crossed = [a, b];
  }
  const qs = await T.ev('[..."BCD"].filter(q=>document.querySelector("[data-body="+q+"] [data-card]"))');
  check(G, 'across quadrants: after the last task in A Do, Alt+→ opens the first task of the next non-empty quadrant ("1 of n in B Plan")', !qs.length || (!!crossed && /^1 of \d+ in [BCD] /.test(crossed[1])), JSON.stringify(crossed) + ' ' + qs.join(''));
  check(G, 'the last task of the board: its right side is an empty close zone with no band, a click there closes', await T.ev('!document.querySelector("dialog[open] [data-zone=next]").textContent.trim()&&!document.querySelector("dialog[open] .tk-g[data-nav=next]")') &&
    (await press('next'), await closed()), await T.ev('JSON.stringify([document.querySelector("dialog[open] #tk-pos")?.textContent,document.querySelector("dialog[open] [data-zone=next]")?.textContent,!!document.querySelector("dialog[open]")])') + ' ' + ids.length);
  await T.size(390, 844); await sleep(500);
  await T.click(`[data-card="${ids[0]}"]`); await T.wait('!!document.querySelector("dialog[open] #ft")', 5000); await sleep(400);
  check(G, 'window at 390: the next card is an edge tab at the screen edge (24 px wide, 44 px or taller, the band\'s ink and arrow), it moves on', await T.ev(`(()=>{const g=document.querySelector('dialog[open] .tk-g[data-nav=next]'),r=g.getBoundingClientRect();return r.width<=30&&r.height>=44&&r.right>=innerWidth-1&&!!g.querySelector('svg')&&g.querySelector('svg').getBoundingClientRect().width>8})()`) &&
    (await T.click('dialog[open] .tk-g[data-nav=next]'), await isOpen(ids[1])));
  const hd = await T.ev(`(()=>{const r=document.querySelector('dialog[open] .tk-head').getBoundingClientRect();return [Math.round(r.left+40),Math.round(r.top+r.height/2)]})()`);
  await T.swipe(hd[0], hd[1], 140);
  check(G, 'window at 390: a swipe right on the header goes back', await isOpen(ids[0]), await openTitle());
  await sleep(300); await T.shot('std-390x844-light'); await T.shot('ui-nav-390x844-light');
  for (const theme of ['dark']) { await T.theme(theme); await T.ev(`(document.documentElement.dataset.theme='${theme}',true)`); await sleep(300); await T.shot(`ui-nav-390x844-${theme}`); await T.size(1440, 900); await sleep(500); await T.shot(`ui-nav-1440x900-${theme}`); await T.theme('light'); await T.ev("(document.documentElement.dataset.theme='light',true)"); }
  check(G, 'no ‹ › buttons anywhere in the window', await T.ev('!document.querySelector("dialog[open] .tk-nav")'));
  await T.size(1440, 900); await closeDialogs(T); await sleep(300);
  await T.click('[data-add="A"]'); await T.wait('!!document.querySelector("dialog[open] #ft")', 4000);
  await press('prev');
  check(G, 'a new task: a click beside the window closes it', await closed());
  // Coverflow (the other choice): Card layout → Moving between tasks, saved in prefs (taskSwitcher), read when a window opens
  const savedSwitcher = async v => !!(await until(async () => { const r = await MK.rest('GET', 'preferences?select=prefs&profile_id=eq.' + MK.uid + '&app=eq.tasksdashboard'); return r.ok && r.json[0] && (r.json[0].prefs.taskSwitcher || 'standard') === v; }, 8000));
  const pickSwitcher = async v => {
    await T.click('#profile'); await T.click('[data-menu=cardlayout]'); await T.wait('!!document.querySelector("dialog[open] input[name=s-switch]")', 5000);
    await T.click(`dialog[open] input[name=s-switch][value=${v}]`); await sleep(150);
    if (v === 'coverflow') await T.shot('settings-switcher-1440x900-light');
    await T.click('#cl-save'); await T.wait('!document.querySelector("dialog[open]")', 3000);
  };
  await T.click('#profile'); await T.click('[data-menu=cardlayout]');
  check(G, 'Card layout: "Moving between tasks" with Standard (chosen) and Coverflow carousel', await T.wait('!!document.querySelector("dialog[open] input[name=s-switch]")', 5000) &&
    await T.ev(`(()=>{const f=document.querySelector('dialog[open] .s-switch');return /Moving between tasks/.test(f.querySelector('legend').textContent)&&[...f.querySelectorAll('label')].map(l=>l.textContent.trim()).join()==='Standard,Coverflow carousel'&&f.querySelector('input[value=standard]').checked})()`));
  await closeDialogs(T); await sleep(200);
  await pickSwitcher('coverflow');
  check(G, 'Card layout: Coverflow carousel is saved to the preferences row (taskSwitcher)', await savedSwitcher('coverflow'));
  ids = await shown(); await sleep(300);
  await T.click(`[data-card="${ids[0]}"]`); await T.wait('!!document.querySelector("dialog.tk-deck[open] #ft")', 5000);
  check(G, 'Coverflow at 1440: the whole window of the next task is a read-only copy beside the card (inert, aria-hidden, no ids, same title), set aside by a transform; no previous copy at the first card; no band',
    await T.wait('document.querySelector("dialog[open]").dataset.switcher==="coverflow"', 3000) &&
    await T.ev(`(()=>{const d=document.querySelector('dialog[open]'),p=d.querySelector('.tk-pv[data-side=next]'),q=d.querySelector('.tk-pv[data-side=prev]');const want=document.querySelector('[data-card="${ids[1]}"]').getAttribute('aria-label');return !!p&&!p.hidden&&p.inert&&p.getAttribute('aria-hidden')==='true'&&!p.querySelector('[id]')&&!!p.querySelector('.tagbox')&&p.querySelector('.rt.one').textContent===want&&getComputedStyle(p).transform!=='none'&&q.hidden&&p.dataset.q==='A'&&getComputedStyle(d.querySelector('.tk-g[data-nav=next] .chev')).display==='none'})()`));
  const far = ids[Math.min(2, ids.length - 1)], farN = ids.indexOf(far) + 1;
  check(G, 'Coverflow: dots under the window, buttons "Go to task k of n: …", the current one aria-current, at most 9, below the card',
    await T.ev(`(()=>{const d=document.querySelector('dialog[open]'),b=[...d.querySelectorAll('.tk-dots .tk-dot')],c=d.querySelector('.tk-card').getBoundingClientRect(),r=d.querySelector('.tk-dots').getBoundingClientRect();return b.length===Math.min(9,${ids.length})&&b[0].getAttribute('aria-current')==='true'&&b.filter(x=>x.getAttribute('aria-current')==='true').length===1&&/^Go to task 1 of ${ids.length}: /.test(b[0].getAttribute('aria-label'))&&r.top>=c.bottom-1&&r.top<c.bottom+24})()`));
  await T.hover(720, 450); await sleep(450); await T.shot('coverflow-1440x900-light');
  await T.send('Animation.enable');
  await T.send('Animation.setPlaybackRate', { playbackRate: 0.02 });
  await press('next'); await sleep(300);
  const mid = await T.ev(`(()=>{const a=document.getAnimations().filter(x=>x.id==='deck-move');a.forEach(x=>{x.pause();x.currentTime=x.effect.getTiming().duration*0.35});return a.length})()`);
  await T.hover(720, 20); await sleep(150); await T.shot('coverflow-midswitch');
  await T.send('Animation.setPlaybackRate', { playbackRate: 1 });
  await T.ev(`(document.getAnimations().filter(x=>x.id==='deck-move').forEach(x=>x.finish()),true)`);
  check(G, 'Coverflow: a click right of the window turns the row (copy in, card out, previous copy away), then the next task is the window', mid >= 3 && await isOpen(ids[1]) && await T.ev('!document.querySelector("dialog[open].is-moving")'), String(mid));
  await T.key('ArrowLeft', 1); await isOpen(ids[0]); await sleep(400);
  const dxy = await T.ev(`(()=>{const r=document.querySelector('dialog[open] .tk-dot[data-dot="${far}"]').getBoundingClientRect();return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)]})()`);
  await T.mouse(dxy[0], dxy[1]);
  check(G, 'Coverflow: a dot click goes to that task ("k of n"), its dot becomes the current one, the window stays open', await isOpen(far) && await T.text('dialog[open] #tk-pos') === `${farN} of ${ids.length} in A Do` &&
    await T.ev(`document.querySelector('dialog[open] .tk-dot[data-dot="${far}"]').getAttribute('aria-current')==='true'`), await openTitle());
  await closeDialogs(T); await sleep(300);
  // back to Standard (the default; cleanup puts the person's own prefs back as well)
  await pickSwitcher('standard');
  await T.click(`[data-card="${ids[0]}"]`); await T.wait('!!document.querySelector("dialog.tk-deck[open] #ft")', 5000);
  check(G, 'Card layout: back to Standard, saved, and the next window opens in Standard', await savedSwitcher('standard') && await T.ev('document.querySelector("dialog[open]").dataset.switcher==="standard"&&document.querySelector("dialog[open] .tk-dots").hidden'));
  await closeDialogs(T); await sleep(200);
  for (const theme of ['light', 'dark']) {
    await T.theme(theme);
    await T.ev(`(document.documentElement.dataset.theme='${theme}',true)`);
    for (const [w, h] of [[1440, 900], [390, 844]]) { await T.size(w, h); await sleep(500); await T.shot(`links-board-maksym-${w}x${h}-${theme}`); }
  }
  await T.size(390, 844); await sleep(300);
  check(G, 'no card is wider than itself at 390 px (grouped)', await T.ev(`[...document.querySelectorAll('[data-card],.lk-ghost')].every(c=>c.scrollWidth<=c.clientWidth+1)`));
  await T.size(1440, 900); await T.theme('light');
  // the Timeline
  await T.click('#profile'); await T.click('[data-menu=timeline]');
  check(G, 'Timeline: one row per task, the subtasks after their parent and indented', await T.wait(`!!document.querySelector('.tl-row[data-tl="${par.id}"]')`, 5000) &&
    await T.ev(`(()=>{const ids=[...document.querySelectorAll('.tl-row')].map(r=>r.dataset.tl);const i=ids.indexOf('${par.id}');const ind=id=>+getComputedStyle(document.querySelector('.tl-row[data-tl="'+id+'"] .tl-name')).getPropertyValue('--ind');return i>=0&&ids.indexOf('${k1.id}')>i&&ids.indexOf('${k2.id}')>i&&ind('${k1.id}')===ind('${par.id}')+1&&new Set(ids).size===ids.length})()`));
  check(G, 'Timeline: an arrow per predecessor link in view, the one that starts too early dashed red', await T.ev(`(()=>{const p=[...document.querySelectorAll('.tl-links > path')];return p.length>=2&&p.filter(x=>x.classList.contains('late')).length>=1})()`));
  check(G, 'Timeline: the parent has a span over its tree', await T.has(`.tl-row[data-tl="${par.id}"] .tl-sum`));
  for (const theme of ['light', 'dark']) {
    await T.theme(theme);
    await T.ev(`(document.documentElement.dataset.theme='${theme}',true)`);
    for (const [w, h] of [[1440, 900], [390, 844]]) { await T.size(w, h); await sleep(500); await T.shot(`links-timeline-maksym-${w}x${h}-${theme}`); }
  }
  await T.size(390, 844); await sleep(300);
  check(G, 'Timeline at 390 px: the page does not scroll sideways (the day track scrolls inside)', await T.ev('document.documentElement.scrollWidth<=innerWidth+1'));
  await T.size(1440, 900); await T.theme('light');
  await T.click(`[data-tlcol="${par.id}"]`);
  check(G, 'Timeline: the chevron folds the parent (its subtasks and their arrows go)', await T.wait(`!document.querySelector('.tl-row[data-tl="${k1.id}"]')&&document.querySelector('[data-tlcol="${par.id}"]').getAttribute('aria-expanded')==='false'`, 3000));
  await T.click(`[data-tlcol="${par.id}"]`);
  // 200 rows: one bulk insert in _selftest (soft-deleted by cleanup), 20 parents of 9 subtasks each
  const many = [...Array(200)].map((_, i) => ({ list_id: ST.id, category: 'task', title: `${RUN} links bulk ${i}`, quadrant: 'D', sort_key: 500000 + i, start_at: day(i % 9), due_at: day(i % 9 + 2) }));
  const bulk = await MK.rest('POST', 'items', many, { Prefer: 'return=representation' });
  if (bulk.ok) {
    const ids = bulk.json.map(r => r.id);
    for (let p = 0; p < 20; p++) for (let c = 1; c < 10; c++) await L(ids[p * 10 + c], ids[p * 10], 'parent');
    for (let p = 0; p < 20; p++) await L(ids[p * 10 + 2], ids[p * 10 + 1], 'depends_on');
    await T.reload(); await T.ready(); await pick(T, ST.id); await T.click('#profile'); await T.click('[data-menu=timeline]');
    await T.wait(`document.querySelectorAll('.tl-row').length>=200`, 10000);
    await T.click('#tl-today'); await sleep(300);
    const ms = await T.ev('window.tdTimelineMs||0'), n = await T.ev(`document.querySelectorAll('.tl-row').length`);
    timelineTimes.push({ rows: n, ms: Math.round(ms) });
    check(G, `Timeline: ${n} rows drawn in under 100 ms (render to bind, td:tl-render)`, n >= 200 && ms > 0 && ms < 100, Math.round(ms) + ' ms');
  } else skip(G, 'Timeline with 200 rows', 'bulk insert failed: ' + bulk.err.message);
  await T.click('[data-view=matrix]');
  // Card layout back to the person's own (prefs are put back in cleanup too)
  await T.click('#profile'); await T.click('[data-menu=cardlayout]'); await T.wait('!!document.querySelector("[data-cl=group]")', 4000);
  await T.ev(`(document.querySelector('[data-cl=group]').checked=false,true)`); await T.click('#cl-save');
  check(G, 'no console errors', !T.errors.length, T.errors.slice(0, 2).join(' / '));
  await T.close();
}

// round 3, A5-A7 (Maksym's page): a test tag list through the Tags window (create, a tag, rename, delete = archive, Archived tags
// read only with Restore); in the task window (P1) a closed group, the search, the chevron and its saved state, Alt+Up and drag on
// two test tag lists; Alt+arrows move a side-menu row into the next quadrant; a first share of a test list to Anastasiia joins her at
// once with a note, Maksym's open Share window drops her after her Leave. Everything is archived.
async function gUiTags(G, T) {
  const name = `${RUN} tags`;
  await T.click('#profile'); await T.click('[data-menu=tags]'); await T.wait('!!document.getElementById("tgl-new")', 5000);
  await T.insert('#tgl-new', name); await T.click('#tgl-add');
  const tl = await until(async () => (await MK.rest('GET', 'tag_lists?select=id,name,archived_at&name=eq.' + encodeURIComponent(name))).json[0]);
  if (tl) testTagLists.push(tl);
  check(G, 'Tags: Create list makes a tag list (create_tag_list) and shows its tray', !!tl && await T.wait(`!!document.querySelector('dialog[open] .tgl[data-tgl="${tl && tl.id}"]')`, 5000));
  if (!tl) return;
  await T.click(`[data-tl-addtag="${tl.id}"]`); await T.insert('dialog[open] .tgm-body input.tag-new', 'e2e-a');
  await T.ev('document.querySelector("dialog[open] .tgm-body input.tag-new").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})),true');
  const tag = await until(async () => (await MK.rest('GET', `tags?select=id,name&tag_list_id=eq.${tl.id}&deleted_at=is.null`)).json[0]);
  check(G, 'Tags: + in a tray adds a tag to that tag list', !!tag && await T.wait(`!!document.querySelector('dialog[open] .tgl[data-tgl="${tl.id}"] [data-tag-menu]')`, 5000));
  await T.click(`dialog[open] [data-tag-menu="${tag && tag.id}"]`);
  check(G, 'Tags: a tag opens its menu (Rename, Move to list, Count as Mine, Delete)', await T.wait('!!document.querySelector("dialog[open] .tgm-menu [data-m=mine]")', 3000) &&
    await T.ev('!!document.querySelector("dialog[open] .tgm-menu [data-m=rename]")&&!!document.querySelector("dialog[open] .tgm-menu [data-m=delete]")&&!!document.querySelector("dialog[open] .tgm-menu [data-m=move]")'));
  await T.shot('ui-tags-menu-maksym-1440x900');
  await T.ev('document.querySelector("dialog[open] .tgm-menu")?.remove(),true');
  // tags round (5): a double-click on a tag renames it in place (the single click's menu waits ~250 ms and does not open); Enter saves
  let tn = 'e2e-a';
  if (tag) {
    await T.ev(`(()=>{const b=document.querySelector('dialog[open] [data-tag-menu="${tag.id}"]'),o=d=>({bubbles:true,cancelable:true,detail:d});b.dispatchEvent(new MouseEvent('click',o(1)));b.dispatchEvent(new MouseEvent('click',o(2)));b.dispatchEvent(new MouseEvent('dblclick',o(2)));return true})()`);
    const inPlace = await T.wait('document.activeElement?.matches("dialog[open] .tgm-body input.tag-new")', 2000);
    await sleep(400);
    const noMenu = await T.ev('!document.querySelector("dialog[open] .tgm-menu")');
    await T.ev(`(()=>{const i=document.activeElement;i.value='e2e-r';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true})()`);
    const renamed = await until(async () => (await MK.rest('GET', `tags?select=name&id=eq.${tag.id}`)).json[0]?.name === 'e2e-r');
    check(G, 'Tags: a double-click on a tag renames it in place (no menu after the clicks); Enter saves the new name', inPlace && noMenu && !!renamed && await T.wait(`document.querySelector('dialog[open] [data-tag-menu="${tag.id}"]')?.textContent==='e2e-r'`, 3000),
      JSON.stringify({ inPlace, noMenu, renamed: !!renamed }));
    if (renamed) tn = 'e2e-r';
  }
  await T.ev(`(()=>{const i=document.querySelector('dialog[open] [data-tgl-name="${tl.id}"]');i.value=${JSON.stringify(name + ' 2')};i.dispatchEvent(new Event('change'));return true})()`);
  check(G, 'Tags: renaming a tray renames the tag list', !!(await until(async () => (await MK.rest('GET', 'tag_lists?select=id&name=eq.' + encodeURIComponent(name + ' 2'))).json[0])));
  tl.name = name + ' 2';
  // a second test tag list, right after the first, for the moves in the task window (U3)
  await T.insert('#tgl-new', `${RUN} tags b`); await T.click('#tgl-add');
  const bl = await until(async () => (await MK.rest('GET', 'tag_lists?select=id,name,sort&name=eq.' + encodeURIComponent(`${RUN} tags b`))).json[0]);
  if (bl) testTagLists.push(bl);
  await closeDialogs(T);
  // round 3 P1 (U3, U6, U7): the task window. The test tag list is not used on the task: it starts closed as one row
  const it = await mkItem('tags header');
  await T.ev('dispatchEvent(new Event("focus")),true'); await sleep(1200);
  const G1 = `dialog[open] .tgg[data-tgg="${tl.id}"]`, GB = `dialog[open] .tgg[data-tgg="${bl && bl.id}"]`;
  check(G, 'task window: the test task opens with the test tag list among its groups', await openCard(T, it.id, G1), await T.ev('document.querySelector("dialog[open]")?.className||"no dialog"'));
  check(G, 'task window: a tag list that is not a favourite starts closed: one row "name · 1" and a chevron, no chips (tags round)', await T.ev(`(()=>{const g=document.querySelector('${G1}');return !!g&&g.classList.contains('shut')&&!g.querySelector('.tagchip')&&g.querySelector('[data-tgg-open]').getAttribute('aria-expanded')==='false'&&/· 1$/.test(g.querySelector('.tgg-k').textContent)&&g.getBoundingClientRect().height<=48})()`));
  // tags round: only my favourites start open (prefs tagListFavs, restored after the run; Maksym's are Assignee and My tags)
  // (a row from before the tags round is migrated by the page on load and saved: read the stored row once it has tagListOrderV 2)
  const rp = async () => (await MK.rest('GET', 'preferences?select=prefs&profile_id=eq.' + MK.uid + '&app=eq.tasksdashboard')).json?.[0]?.prefs || null;
  const favs0 = core.prefsFromRow(await until(async () => { const p = await rp(); return p && p.tagListOrderV === core.TAG_LIST_ORDER_V ? p : null; }, 8000) || await rp()).tagListFavs;
  const grpState = await T.ev(`[...document.querySelectorAll('dialog[open] .tgg[data-tgg]')].map(g=>[g.dataset.tgg,!g.classList.contains('shut')])`);
  check(G, `task window: my ${favs0.length} favourite tag list(s) start open, every other list closed (tags round)`, grpState.length > 0 && grpState.every(([id, open]) => open === favs0.includes(id)) && favs0.some(id => grpState.some(g => g[0] === id)),
    grpState.map(g => (g[1] ? '+' : '-') + (favs0.includes(g[0]) ? '*' : '')).join(''));
  await T.insert('dialog[open] #tg-q', tn);
  check(G, 'task window: the search shows only matching chips, across groups, closed ones included (U6)', await T.wait(`(()=>{const c=[...document.querySelectorAll('dialog[open] .tagbox .tagchip')];return c.length>0&&c.every(b=>b.textContent.includes(${JSON.stringify(tn)}))&&!!document.querySelector('dialog[open] .tagchip[data-t="${tag && tag.id}"]')})()`, 3000));
  await T.shot('ui-task-search-maksym-1440x900');
  await T.key('Enter');
  check(G, 'task window: Enter in the search picks the first hit; the window stays open (U6)', await T.wait(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog[open] .tagchip[data-t="${tag && tag.id}"]')?.getAttribute('aria-pressed')==='true'`, 3000));
  await T.key('Escape');
  check(G, 'task window: Escape clears the search, the window stays, the picked tag\'s list stays open (U6)', await T.wait(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog[open] #tg-q').value===''&&!document.querySelector('${G1}').classList.contains('shut')&&document.querySelector('dialog[open] .tagchip[data-t="${tag && tag.id}"]')?.getAttribute('aria-pressed')==='true'`, 3000));
  await T.click(`${G1} [data-tgg-open]`);
  const closed = await T.ev(`document.querySelector('${G1}').classList.contains('shut')`);
  await T.click(`${G1} [data-tgg-open]`);
  await sleep(1500);
  const pc = (await MK.rest('GET', 'preferences?select=prefs&profile_id=eq.' + MK.uid + '&app=eq.tasksdashboard')).json?.[0]?.prefs || {};
  check(G, 'task window: the chevron closes and opens a list within the window only (no tagListsOpen saved, favourites unchanged) (tags round)', closed && await T.ev(`!document.querySelector('${G1}').classList.contains('shut')`) &&
    pc.tagListsOpen === undefined && canon(pc.tagListFavs || []) === canon(favs0), JSON.stringify({ closed, tagListsOpen: pc.tagListsOpen !== undefined, favs: (pc.tagListFavs || []).length }));
  // U3: Alt+Up on the second list's chevron puts it above the first (tag_lists.sort, the order of the Tags window); only those two change
  const sorts = async () => Object.fromEntries((await MK.rest('GET', 'tag_lists?select=id,sort&archived_at=is.null&owner_id=eq.' + MK.uid)).json.map(r => [r.id, r.sort]));
  const s0 = await sorts();
  if (bl) {
    await T.ev(`document.querySelector('${GB} [data-tgg-open]').focus()`); await T.key('ArrowUp', 1);
    const s1 = await until(async () => { const s = await sorts(); return s[bl.id] < s[tl.id] ? s : null; });
    // tags round: the move writes my one order (prefs tagListOrder) and tag_lists.sort of my own live lists in their relative place
    // in it (C.tagListOwnSorts); lists whose sort already followed that order keep it
    const ord = await until(async () => { const p = (await MK.rest('GET', 'preferences?select=prefs&profile_id=eq.' + MK.uid + '&app=eq.tasksdashboard')).json?.[0]?.prefs; const o = p && p.tagListOrder || []; return o.indexOf(bl.id) >= 0 && o.indexOf(bl.id) < o.indexOf(tl.id) ? o : null; });
    const s2 = s1 && await until(async () => { const s = await sorts(); const own = (ord || []).filter(id => s[id] !== undefined); return own.every((id, i) => !i || s[own[i - 1]] < s[id]) ? s : null; }, 5000);
    const same = !!s2;
    check(G, 'task window: Alt+Up moves my tag list up: my order (prefs tagListOrder) and tag_lists.sort of my own lists follow it (U3, tags round)', !!s1 && !!ord && same && await T.wait(`(()=>{const a=[...document.querySelectorAll('dialog[open] .tgg[data-tgg]')].map(g=>g.dataset.tgg);return a.indexOf('${bl.id}')===a.indexOf('${tl.id}')-1})()`, 3000),
      s1 ? `${s0[tl.id]},${s0[bl.id]} → ${s1[tl.id]},${s1[bl.id]}` : 'no change');
    await T.ev(`(()=>{const dt=new DataTransfer(),g=document.querySelector('${G1} [data-tgg-grip]'),t=document.querySelector('${GB}'),r=t.getBoundingClientRect(),o={bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+20,clientY:r.top+2};g.dispatchEvent(new DragEvent('dragstart',o));t.dispatchEvent(new DragEvent('dragover',o));t.dispatchEvent(new DragEvent('drop',o));g.dispatchEvent(new DragEvent('dragend',o));return true})()`);
    check(G, 'task window: dragging a list by its grip onto another moves it back above (U3)', !!(await until(async () => { const s = await sorts(); return s[tl.id] < s[bl.id]; })));
  } else skip(G, 'task window: moving tag lists (U3)', 'the second test tag list was not made');
  await T.click('dialog[open] #fs');
  check(G, 'task window: Save writes the tag (item_tags)', !!(await until(async () => (await MK.rest('GET', `item_tags?select=tag_id&item_id=eq.${it.id}&tag_id=eq.${tag && tag.id}&removed_at=is.null`)).json[0])));
  // tags round: the next task opens both test lists closed again (the chevron is the window's own; neither is a favourite)
  const it2 = await mkItem('tags open');
  await T.ev('dispatchEvent(new Event("focus")),true'); await sleep(1200);
  await closeDialogs(T); await openCard(T, it2.id, G1);
  check(G, 'task window: the next task opens the list I opened with the chevron closed again, the other test list closed too (tags round)', await T.wait(`!!document.querySelector('${G1}.shut')&&!!document.querySelector('${GB}.shut')`, 5000));
  for (const [w, h] of [[1440, 900], [390, 844]]) { await T.size(w, h); await sleep(400); await T.shot(`ui-task-groups-maksym-${w}x${h}`); }
  await T.size(1440, 900); await closeDialogs(T);
  // tags round: favourites and one free order with a shared tag list; Card layout's tag filter; share by name
  if (bl) await gTagsFavs(G, T, tl, bl); else skip(G, 'tags round: favourites and order', 'the second test tag list was not made');
  await gCardFilter(G, T, tl, tag);
  await gShareByName(G, T);
  // Delete list = archive: its chip leaves the card; Archived tags shows it read only with Restore
  await T.click('#profile'); await T.click('[data-menu=tags]'); await T.wait(`!!document.querySelector('dialog[open] [data-tl-del="${tl.id}"]')`, 5000);
  await T.click(`dialog[open] [data-tl-del="${tl.id}"]`); await T.wait('!!document.getElementById("cf-ok")', 3000); await T.click('#cf-ok');
  check(G, 'Tags: Delete list archives the tag list (set_tag_list_archived)', !!(await until(async () => (await MK.rest('GET', `tag_lists?select=id&id=eq.${tl.id}&archived_at=not.is.null`)).json[0])));
  await closeDialogs(T); await sleep(300);
  check(G, 'its tags leave the cards', await T.ev(`![...document.querySelectorAll('[data-card="${it.id}"] .tagtxt')].some(x=>x.textContent===${JSON.stringify(tn)})`));
  await T.click('#profile'); await T.click('[data-menu=tags]'); await T.wait('!!document.getElementById("tgm-switch")', 5000); await T.click('#tgm-switch');
  check(G, 'Archived tags: the list read only (chips disabled, no rename) with Restore', await T.wait(`!!document.querySelector('dialog[open] [data-tl-restore="${tl.id}"]')`, 5000) &&
    await T.ev(`[...document.querySelectorAll('dialog[open] .tgl[data-tgl="${tl.id}"] .tagchip')].every(b=>b.disabled) && !document.querySelector('dialog[open] [data-tgl-name="${tl.id}"]')`));
  for (const [w, h] of [[1440, 900], [390, 844]]) { await T.size(w, h); await sleep(400); await T.shot(`ui-tags-archived-maksym-${w}x${h}`); }
  await T.size(1440, 900);
  await T.click(`dialog[open] [data-tl-restore="${tl.id}"]`);
  check(G, 'Restore brings the tag list back', !!(await until(async () => (await MK.rest('GET', `tag_lists?select=id&id=eq.${tl.id}&archived_at=is.null`)).json[0])));
  await closeDialogs(T);
  // side menu: Alt+Down past the end of Plan moves the row into Delegate (C), like a card drag
  const mv = await mkItem('menu move', { quadrant: 'B' });
  await T.ev('dispatchEvent(new Event("focus")),true'); await sleep(1200); await pick(T, ST.id);
  if (await T.wait(`!!document.querySelector('.mrow[data-open="${mv.id}"]')`, 6000)) {
    for (let i = 0; i < 40 && (await T.ev(`document.querySelector('.mrow[data-open="${mv.id}"]')?.dataset.mq`)) === 'B'; i++) {
      await T.ev(`document.querySelector('.mrow[data-open="${mv.id}"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',altKey:true,bubbles:true})),true`); await sleep(150);
    }
    check(G, 'side menu: Alt+Down past the end of Plan moves the row into Delegate (stored quadrant C)', !!(await until(async () => (await MK.rest('GET', `items?select=id&id=eq.${mv.id}&quadrant=eq.C`)).json[0])));
  } else skip(G, 'side menu: Alt+arrows', 'the Plan group is collapsed in the preferences');
  // first share without Accept (db/012): a test list to Anastasiia joins her at once; her note offers Keep, Leave, Block; Leave ends it
  const sl = await mkList(MK, `${RUN} shared`, true);
  const sh = await MK.rest('POST', 'rpc/share_list', { p_list: sl.id, p_email: env.TASKSDB_ANASTASIIA_EMAIL, p_role: 'viewer', p_join: true });
  check(G, 'first share: share_list with p_join answers ok', sh.ok, sh.ok ? '' : sh.err.message);
  // F2: Maksym's Share window of that list, open while Anastasiia leaves, drops her without a click (read on every tick while open)
  await T.reload(); await T.ready();
  await T.click('#profile'); await T.click('[data-menu=sharing]'); await T.wait(`!!document.querySelector('dialog[open] [data-share-list="${sl.id}"]')`, 5000);
  await T.click(`dialog[open] [data-share-list="${sl.id}"]`);
  const shareShows = await T.wait(`!!document.querySelector('#sh-people [data-remove="${AN.uid}"]')`, 8000);
  const A = await tab(B, await ctx(B)); await A.theme('dark');
  await open(A, await grantFor('anastasiia'));
  const seen = await A.wait(`[...document.querySelectorAll('#notices .ntc p')].some(p=>p.textContent.includes(${JSON.stringify(sl.name)}))`, 10000);
  check(G, 'first share: Anastasiia joined without Accept and sees "… shared the list … with you" with Keep, Leave and Block', seen &&
    await A.ev('!!document.querySelector("#notices [data-ntc=seen]")&&!!document.querySelector("#notices [data-ntc=leave]")&&!!document.querySelector("#notices [data-ntc=block]")') && await A.has(`.lists [data-list="${sl.id}"], #more`));
  for (const [w, h] of [[1440, 900], [390, 844]]) { await A.size(w, h); await sleep(400); await A.shot(`ui-notice-anastasiia-${w}x${h}-dark`); }
  if (seen) {
    await A.ev(`[...document.querySelectorAll('#notices .ntc')].find(n=>n.textContent.includes(${JSON.stringify(sl.name)})).querySelector('[data-ntc=leave]').click(),true`);
    check(G, 'first share: Leave takes the list away and closes the note', !!(await until(async () => !(await AN.rest('GET', `list_members?select=list_id&list_id=eq.${sl.id}&profile_id=eq.${AN.uid}`)).json.length)) &&
      await A.wait(`![...document.querySelectorAll('#notices .ntc p')].some(p=>p.textContent.includes(${JSON.stringify(sl.name)}))`, 5000));
    const t0 = Date.now(), gone = await T.wait(`!!document.getElementById('sh-people')&&!document.querySelector('#sh-people [data-remove="${AN.uid}"]')`, 15000);
    check(G, 'Share window: it showed Anastasiia; after she leaves it drops her while open, no click (F2)', shareShows && gone, gone ? `${Math.round((Date.now() - t0) / 1000)} s` : 'still shown');
  } else skip(G, 'Share window refresh (F2)', 'the first-share note did not show');
  await closeDialogs(T);
  check(G, 'anastasiia (notice page): no console errors', !A.errors.length, A.errors.slice(0, 2).join(' / '));
  await A.close();
}

// tags round (3)-(4), V11: Anastasiia's test tag list shared to Maksym by id (share_tag_list_with, db/022). In the Tags window ★ on a
// test list and on the shared one (prefs tagListFavs); the shared list dragged between my two test lists (prefs tagListOrder v2,
// my own tag_lists.sort in the same relative order). The task window opens exactly the favourites, in that order, also after a
// reload; the chevron is the window's own; unstar closes. Undone in cleanup (membership removed, the tag list archived, prefs and
// sorts put back)
async function gTagsFavs(G, T, tl, bl) {
  const readP = async () => (await MK.rest('GET', 'preferences?select=prefs&profile_id=eq.' + MK.uid + '&app=eq.tasksdashboard')).json?.[0]?.prefs || null;
  const sn = `${RUN} shared tags`;
  const cr = await AN.rest('POST', 'rpc/create_tag_list', { p_name: sn });
  const sl = cr.ok ? (Array.isArray(cr.json) ? cr.json[0] : cr.json) : null;
  if (!sl || !sl.id) { skip(G, 'tags round: a shared tag list among my own', 'create_tag_list as anastasiia failed: ' + (cr.err ? cr.err.message : 'no id')); return; }
  const S = sl.id;
  tagUndo.push(async () => {
    for (const n of (await MK.rest('GET', `shared_notices?select=id&tag_list_id=eq.${S}&seen_at=is.null`)).json || []) await MK.rest('POST', 'rpc/answer_shared_notice', { p_notice: n.id, p_action: 'seen' });
    await AN.rest('DELETE', `tag_list_members?tag_list_id=eq.${S}&profile_id=eq.${MK.uid}`);
    const left = (await AN.rest('GET', `tag_list_members?select=profile_id&tag_list_id=eq.${S}&profile_id=eq.${MK.uid}`)).json;
    const a = await AN.rest('POST', 'rpc/set_tag_list_archived', { p_tag_list: S, p_archived: true });
    rows.push(`| cleanup | Anastasiia's test tag list ${sn}: Maksym removed (read back), list archived | ${a.ok && left && !left.length ? 'pass' : 'FAIL'} | ${a.ok ? '' : a.err.message} |`);
    leftovers.push(`archived test tag list ${sn} (Anastasiia's)`);
  });
  await AN.rest('POST', 'tags', { tag_list_id: S, name: 'e2e-s', sort: 1 });
  const sh = await AN.rest('POST', 'rpc/share_tag_list_with', { p_tag_list: S, p_profile: MK.uid, p_role: 'viewer' });
  const joined = await until(async () => ((await MK.rest('GET', `tag_list_members?select=role&tag_list_id=eq.${S}&profile_id=eq.${MK.uid}`)).json || [])[0], 6000);
  check(G, 'tags round: Anastasiia shares a test tag list with Maksym by id (share_tag_list_with answers {"ok": true}; Maksym a viewer at once)', sh.ok && !!sh.json && sh.json.ok === true && !!joined && joined.role === 'viewer', sh.ok ? JSON.stringify(sh.json) : sh.err.message);
  if (!joined) return;
  const sSort = async () => (await MK.rest('GET', `tag_lists?select=sort&id=eq.${S}`)).json?.[0]?.sort;
  const sSort0 = await sSort();
  await closeDialogs(T); await T.reload(); await T.ready(); await T.theme('light'); await T.ev("(document.documentElement.dataset.theme='light',true)");
  const openTagsW = async () => { await closeDialogs(T); await T.click('#profile'); await T.click('[data-menu=tags]'); return T.wait(`!!document.querySelector('dialog[open] .tgl[data-tgl="${S}"]')`, 8000); };
  const tagsDom = () => T.ev(`[...document.querySelectorAll('dialog[open] .tgl[data-tgl]')].map(s=>s.dataset.tgl)`);
  const trio = o => { const a = o.indexOf(tl.id), b = o.indexOf(S), c = o.indexOf(bl.id); return a >= 0 && b === a + 1 && c === b + 1; };
  check(G, 'Tags window: the shared tag list shows with a grip and a ★ toggle', await openTagsW() && await T.ev(`!!document.querySelector('dialog[open] .tgl[data-tgl="${S}"] .tgl-grip[data-grip]')&&!!document.querySelector('dialog[open] [data-fav="${S}"][aria-pressed]')`));
  // ★ on my test list and on the shared one
  for (const id of [tl.id, S]) if (await T.ev(`document.querySelector('dialog[open] [data-fav="${id}"]')?.getAttribute('aria-pressed')==='false'`)) { await T.click(`dialog[open] [data-fav="${id}"]`); await sleep(250); }
  const fv = await until(async () => { const f = ((await readP()) || {}).tagListFavs || []; return f.includes(tl.id) && f.includes(S) ? f : null; });
  check(G, 'Tags window: ★ on two lists (mine and the shared one): both pressed, saved in prefs tagListFavs', !!fv && await T.ev(`[${JSON.stringify(tl.id)},${JSON.stringify(S)}].every(id=>document.querySelector('dialog[open] [data-fav="'+id+'"]').getAttribute('aria-pressed')==='true')`), fv ? fv.length + ' favourites' : 'not saved');
  for (const [w, h] of [[1440, 900], [390, 844]]) { await T.size(w, h); await sleep(400); await T.ev(`(document.querySelector('dialog[open] .tgl[data-tgl="${S}"]')?.scrollIntoView({block:'center'}),true)`); await sleep(150); await T.shot(`tags-favs-${w}x${h}-light`); }
  await T.size(1440, 900); await sleep(300);
  // drag the shared list by its grip onto the upper half of my second test list: it lands between my two test lists
  const before = await tagsDom();
  await T.ev(`(()=>{const dt=new DataTransfer(),g=document.querySelector('dialog[open] [data-grip="${S}"]'),t=document.querySelector('dialog[open] .tgl[data-tgl="${bl.id}"]');t.scrollIntoView({block:'center'});const r=t.getBoundingClientRect(),o={bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+20,clientY:r.top+2};g.dispatchEvent(new DragEvent('dragstart',o));t.dispatchEvent(new DragEvent('dragover',o));t.dispatchEvent(new DragEvent('drop',o));g.dispatchEvent(new DragEvent('dragend',o));return true})()`);
  const po = await until(async () => { const p = await readP(); return p && trio(p.tagListOrder || []) ? p : null; });
  check(G, 'Tags window: the shared list dragged by its grip between my two test lists lands there, on screen and in prefs tagListOrder (v2)', !!po && po.tagListOrderV === 2 && trio(await tagsDom()) && !trio(before), po ? `order of ${po.tagListOrder.length} lists` : 'not saved; before ' + before.indexOf(S) + '/' + before.length);
  const so = await until(async () => { const s = Object.fromEntries(((await MK.rest('GET', `tag_lists?select=id,sort&id=in.(${tl.id},${bl.id})`)).json || []).map(r => [r.id, r.sort])); return s[tl.id] < s[bl.id] ? s : null; }, 6000);
  check(G, 'Tags window: my own lists keep tag_lists.sort in that relative order; the shared list\'s sort is not written', !!so && await sSort() === sSort0, JSON.stringify(so));
  await T.ev(`(document.querySelector('dialog[open] .tgl[data-tgl="${S}"]')?.scrollIntoView({block:'center'}),true)`); await sleep(200);
  await T.shot('tags-window-1440x900-light');
  // the task window: exactly the favourites open, in the Tags window's order
  await closeDialogs(T);
  const it3 = await mkItem('tags favourites');
  await T.ev('dispatchEvent(new Event("focus")),true'); await sleep(1200); await pick(T, ST.id);
  const openTask = async () => { await closeDialogs(T); return openCard(T, it3.id, `dialog[open] .tgg[data-tgg="${S}"]`); };
  const twState = () => T.ev(`[...document.querySelectorAll('dialog[open] .tgg[data-tgg]')].map(g=>({id:g.dataset.tgg,open:!g.classList.contains('shut'),star:!!g.querySelector('.tgg-h .star')}))`);
  const favOk = (s, f) => s.length > 0 && s.every(g => g.open === f.includes(g.id) && g.star === f.includes(g.id));
  const sh3 = s => s.map(g => (g.open ? '+' : '-') + (g.star ? '*' : '')).join('');
  await openTask();
  let st = await twState();
  check(G, 'task window: both ★ lists (mine and the shared one) open with ★ on their heads, every other list closed (V11)', !!fv && favOk(st, fv) && !!st.find(g => g.id === S)?.open && !!st.find(g => g.id === tl.id)?.open && !st.find(g => g.id === bl.id)?.open, sh3(st));
  check(G, 'task window: the same order as the Tags window (the shared list between my two test lists)', trio(st.map(g => g.id)));
  await T.theme('dark'); await T.ev("(document.documentElement.dataset.theme='dark',true)"); await sleep(350);
  await T.ev(`(document.querySelector('dialog[open] .tgg[data-tgg="${S}"]')?.scrollIntoView({block:'center'}),true)`); await sleep(150);
  await T.shot('tagpick-favs-1440x900-dark');
  await T.click(`dialog[open] .tgg[data-tgg="${bl.id}"] [data-tgg-open]`);
  check(G, 'task window: the chevron opens a closed list in this window', await T.wait(`!document.querySelector('dialog[open] .tgg[data-tgg="${bl.id}"]').classList.contains('shut')`, 2000));
  await T.ev(`(document.querySelector('dialog[open] .tgg[data-tgg="${bl.id}"]')?.scrollIntoView({block:'center'}),true)`); await sleep(150);
  await T.shot('tagpick-open-1440x900-dark');
  await T.theme('light'); await T.ev("(document.documentElement.dataset.theme='light',true)");
  // after a reload: the same order in both windows, the same favourites open, the list opened by the chevron closed again
  await closeDialogs(T); await sleep(1500); await T.reload(); await T.ready(); await pick(T, ST.id);
  await openTask(); st = await twState();
  check(G, 'after a reload: the task window keeps the order and opens the ★ lists only (the chevron-opened list is closed again) (V11)', trio(st.map(g => g.id)) && !!fv && favOk(st, fv), sh3(st));
  check(G, 'after a reload: the Tags window keeps the shared list between my two test lists, every tray open', await openTagsW() && trio(await tagsDom()) && await T.ev('!document.querySelector("dialog[open] .tgl.shut")'));
  // unstar the shared list: it starts closed in the next task window
  await T.click(`dialog[open] [data-fav="${S}"]`);
  const fv2 = await until(async () => { const f = ((await readP()) || {}).tagListFavs || []; return !f.includes(S) && f.includes(tl.id) ? f : null; });
  await openTask(); st = await twState();
  const sg = st.find(g => g.id === S), tg = st.find(g => g.id === tl.id);
  check(G, 'unstar: the shared list starts closed (no ★) in the next task window; my starred test list still open', !!fv2 && !!sg && !sg.open && !sg.star && !!tg && tg.open, sh3(st));
  await closeDialogs(T);
}

// tags round (6), V6: Card layout "Only from these tag lists" with My tags unticked: none of its tags on cards or in the Coverflow
// previews; another person's list is labelled "name — owner". Items in _selftest carry an existing My tags tag (nothing is written
// to My tags) and the run's test tag. Card layout and the switcher come back with the prefs in cleanup; set back here too
async function gCardFilter(G, T, tl, tag) {
  const dfl = (await MK.rest('GET', `tag_lists?select=id,name&is_default=eq.true&owner_id=eq.${MK.uid}&archived_at=is.null`)).json?.[0];
  const mt = dfl ? (await MK.rest('GET', `tags?select=id,name&tag_list_id=eq.${dfl.id}&deleted_at=is.null&order=sort&limit=1`)).json?.[0] : null;
  if (!mt || !tag) { skip(G, 'Card layout filter with My tags unticked (V6)', !dfl ? 'no landing tag list' : !mt ? 'My tags has no tag to put on a test item' : 'no test tag'); return; }
  const tName = (await MK.rest('GET', `tags?select=name&id=eq.${tag.id}`)).json?.[0]?.name || tag.name;
  const a = await mkItem('card filter a', { quadrant: 'A', sort_key: 1 }), b = await mkItem('card filter b', { quadrant: 'A', sort_key: 2 }), c = await mkItem('card filter c', { quadrant: 'A', sort_key: 3 });
  const ins = await MK.rest('POST', 'item_tags', [{ item_id: b.id, tag_id: mt.id }, { item_id: b.id, tag_id: tag.id }], { Prefer: 'return=minimal' });
  if (!ins.ok) { skip(G, 'Card layout filter with My tags unticked (V6)', 'item_tags insert failed: ' + ins.err.message); return; }
  const is = (n, x) => `(${x}===${JSON.stringify(n)}||${x}.startsWith(${JSON.stringify(n + ' ')}))`;
  const has = (list, n) => list.some(x => x === n || x.startsWith(n + ' '));
  await closeDialogs(T); await T.reload(); await T.ready(); await pick(T, ST.id);
  await T.wait(`!!document.querySelector('[data-card="${b.id}"]')`, 8000);
  // Card layout: Only from these tag lists, every offered list ticked but My tags; another person's list says whose it is
  await T.click('#profile'); await T.click('[data-menu=cardlayout]'); await T.wait('!!document.querySelector("dialog[open] [data-cl-list]")', 5000);
  const lab = await T.ev(`(()=>{const r={};document.querySelectorAll('dialog[open] [data-cl-list]').forEach(b=>{r[b.dataset.clList]=b.closest('label').textContent.trim()});return r})()`);
  const others = ((await MK.rest('GET', `tag_lists?select=id,name,owner_id&archived_at=is.null&owner_id=neq.${MK.uid}`)).json || []).filter(l => lab[l.id]);
  check(G, `Card layout: another person's tag list is labelled "name — owner", mine without (${others.length} of others' lists shown)`, others.every(l => lab[l.id].startsWith(l.name) && /— \S/.test(lab[l.id])) &&
    Object.keys(lab).filter(id => !others.some(l => l.id === id)).every(id => !lab[id].includes('—')), others.map(l => lab[l.id]).join(' / ').slice(0, 150));
  await T.ev(`(()=>{const d=document.querySelector('dialog[open]'),r=d.querySelector('input[name=cl-tags][value=lists]');r.checked=true;r.dispatchEvent(new Event('change',{bubbles:true}));d.querySelectorAll('[data-cl-list]').forEach(x=>{x.disabled=false;x.checked=x.dataset.clList!==${JSON.stringify(dfl.id)}});d.querySelector('#cl-save').click();return true})()`);
  await T.wait('!document.querySelector("dialog[open]")', 3000);
  const cardOk = await T.wait(`(()=>{const t=[...document.querySelectorAll('[data-card="${b.id}"] .tagtxt')].map(x=>x.textContent.trim());return t.some(x=>${is(tName, 'x')})&&!t.some(x=>${is(mt.name, 'x')})})()`, 5000);
  check(G, 'Card layout filter, My tags unticked: the card shows the test tag and no tag from My tags (V6)', cardOk, await T.ev(`[...document.querySelectorAll('[data-card="${b.id}"] .tagtxt')].length+' tags on the card'`));
  await T.ev(`(document.querySelector('[data-card="${b.id}"]')?.scrollIntoView({block:'center'}),true)`); await sleep(300);
  await T.shot('cardlayout-filter-1440x900-light');
  // the Coverflow previews follow the same filter (cardTags)
  const setSwitcher = async v => { await T.click('#profile'); await T.click('[data-menu=cardlayout]'); await T.wait('!!document.querySelector("dialog[open] input[name=s-switch]")', 5000); await T.click(`dialog[open] input[name=s-switch][value=${v}]`); await T.click('#cl-save'); await T.wait('!document.querySelector("dialog[open]")', 3000); await sleep(300); };
  await setSwitcher('coverflow');
  const pv = async id => { await closeDialogs(T); await sleep(200); await T.click(`[data-card="${id}"]`); await T.wait('!!document.querySelector("dialog.tk-deck[open] #ft")', 5000); await sleep(600);
    return T.ev(`(()=>{const p=document.querySelector('dialog[open] .tk-pv[data-id="${b.id}"]:not([hidden])');return p?[...p.querySelectorAll('.pv-tag')].map(x=>x.textContent.trim()):null})()`); };
  let pt = await pv(a.id); if (!pt) pt = await pv(c.id);
  check(G, 'Card layout filter, My tags unticked: the Coverflow preview of the card shows the test tag and no tag from My tags (V6)', !!pt && has(pt, tName) && !has(pt, mt.name), pt ? pt.length + ' tags in the preview' : 'no preview of the card');
  await T.hover(720, 450); await sleep(300); await T.shot('cardlayout-filter-preview-1440x900-light');
  await closeDialogs(T);
  await setSwitcher('standard');
  await T.click('#profile'); await T.click('[data-menu=cardlayout]'); await T.wait('!!document.querySelector("dialog[open] input[name=cl-tags]")', 5000);
  await T.ev(`(()=>{const d=document.querySelector('dialog[open]');d.querySelector('input[name=cl-tags][value=all]').checked=true;d.querySelector('#cl-save').click();return true})()`);
  await T.wait('!document.querySelector("dialog[open]")', 3000);
}

// tags round (2), V4: the Share window's one box "Name or email" suggests whitelisted people by name (rpc/shareable_profiles, db/022:
// never an email); arrows and Enter pick; Share shares by id (share_list_with); text that is neither gives the error; people
// already on the list are left out. On a test list the run makes; the membership is removed in cleanup and read back there
async function gShareByName(G, T) {
  const pp = await MK.rest('POST', 'rpc/shareable_profiles', {});
  const an = pp.ok ? pp.json.find(p => p.id === AN.uid) : null;
  check(G, 'rpc/shareable_profiles as Maksym: id and display name only (no email), Anastasiia listed, never me', pp.ok && !!an && pp.json.every(p => Object.keys(p).sort().join() === 'display_name,id' && p.id !== MK.uid && !String(p.display_name).includes('@')), pp.ok ? `${pp.json.length} row(s)` : pp.err.message);
  if (!an || !an.display_name) return;
  const l = await mkList(MK, `${RUN} by name`, true);
  tagUndo.push(async () => {
    for (const n of (await AN.rest('GET', `shared_notices?select=id&list_id=eq.${l.id}&seen_at=is.null`)).json || []) await AN.rest('POST', 'rpc/answer_shared_notice', { p_notice: n.id, p_action: 'seen' });
    await MK.rest('DELETE', `list_members?list_id=eq.${l.id}&profile_id=eq.${AN.uid}`);
    const left = (await MK.rest('GET', `list_members?select=profile_id&list_id=eq.${l.id}&profile_id=eq.${AN.uid}`)).json;
    rows.push(`| cleanup | share by name: Anastasiia's membership of ${l.slug} removed (read back ${left ? left.length : 'n/a'} rows) | ${left && !left.length ? 'pass' : 'FAIL'} | |`);
  });
  await closeDialogs(T); await T.reload(); await T.ready(); await T.theme('light');
  await T.click('#profile'); await T.click('[data-menu=sharing]'); await T.wait(`!!document.querySelector('dialog[open] [data-share-list="${l.id}"]')`, 8000);
  await T.click(`dialog[open] [data-share-list="${l.id}"]`);
  const box = await T.wait('!!document.getElementById("sh-email")', 5000);
  check(G, 'Share window: one box "Name or email", a combobox (aria-controls sh-opts)', box && await T.ev(`(()=>{const e=document.getElementById('sh-email');return e.getAttribute('role')==='combobox'&&e.getAttribute('aria-controls')==='sh-opts'&&/Name or email/.test(e.closest('label').textContent)})()`));
  if (!box) return;
  const setBox = v => T.ev(`(()=>{const e=document.getElementById('sh-email');e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('input'));e.focus();return true})()`);
  const q = an.display_name.slice(0, 3);
  await T.wait('!document.querySelector("#sh-people")?.textContent.includes("Loading")', 5000); await sleep(600); // shareable_profiles answered
  await T.insert('#sh-email', q);
  const sug = await T.wait(`[...document.querySelectorAll('#sh-opts li[role=option]')].length>0&&!document.getElementById('sh-opts').hidden`, 5000)
    ? await T.ev(`(()=>{const e=document.getElementById('sh-email'),o=[...document.querySelectorAll('#sh-opts li[role=option]')];return {names:o.map(x=>x.textContent),ids:o.map(x=>x.id),exp:e.getAttribute('aria-expanded'),act:e.getAttribute('aria-activedescendant')}})()`) : null;
  check(G, `Share window: typing "${q}" suggests the person by name (options sh-o<i>, aria-expanded, aria-activedescendant), never an email`, !!sug && sug.names.includes(an.display_name) && sug.names.every(n => !n.includes('@')) && sug.ids[0] === 'sh-o0' && sug.exp === 'true' && sug.act === 'sh-o0', JSON.stringify(sug && { n: sug.names.length, exp: sug.exp, act: sug.act }));
  for (const [w, h] of [[1440, 900], [390, 844]]) { await T.size(w, h); await sleep(400); await T.shot(`share-name-${w}x${h}-light`); }
  await T.size(1440, 900); await sleep(300);
  const shares = () => T.requests.filter(u => /rpc\/share_list/.test(u)).length, s0 = shares();
  await setBox(''); await T.insert('#sh-email', 'zz no such person'); await T.click('#sh-go');
  check(G, 'Share window: text that is neither a name from the list nor an email gives "Pick a name from the list or enter an email"; nothing is sent', await T.wait(`document.getElementById('sh-e').textContent==='Pick a name from the list or enter an email'`, 3000) && shares() === s0);
  await setBox(''); await T.insert('#sh-email', q); await T.wait('!document.getElementById("sh-opts").hidden', 3000);
  const idx = await T.ev(`[...document.querySelectorAll('#sh-opts li[role=option]')].findIndex(x=>x.textContent===${JSON.stringify(an.display_name)})`);
  for (let i = 0; i < idx; i++) await T.key('ArrowDown');
  await T.key('Enter');
  const pickedOk = await T.wait(`document.getElementById('sh-email').value===${JSON.stringify(an.display_name)}&&document.getElementById('sh-opts').hidden`, 2000);
  await T.click('#sh-go');
  const toastOk = await T.wait(`(document.querySelector('.toast span')||{}).textContent===${JSON.stringify('Shared with ' + an.display_name + ' as Viewer')}`, 6000);
  const mem = await until(async () => ((await MK.rest('GET', `list_members?select=role&list_id=eq.${l.id}&profile_id=eq.${AN.uid}`)).json || [])[0], 6000);
  check(G, 'Share window: arrows and Enter pick the name, Share shares by id (share_list_with): toast "Shared with … as Viewer", the member read back as a viewer', pickedOk && toastOk && mem?.role === 'viewer' && T.requests.some(u => /rpc\/share_list_with/.test(u)),
    JSON.stringify({ pickedOk, toastOk, role: mem && mem.role, err: await T.text('#sh-e') }));
  await T.wait(`(document.getElementById('sh-people')?.textContent||'').includes(${JSON.stringify(an.display_name)})`, 5000);
  await setBox(''); await T.insert('#sh-email', q); await sleep(800);
  check(G, 'Share window: a person already on the list is not suggested again', await T.ev(`![...document.querySelectorAll('#sh-opts li[role=option]')].some(x=>x.textContent===${JSON.stringify(an.display_name)})`));
  await closeDialogs(T);
}

async function gSmoke() {
  const G = 'smoke', T = await tab(B, await ctx(B));
  check(G, 'opens signed in from ' + (ORIGIN || path.basename(path.dirname(PAGE))), await open(T, await grantFor('maksym')));
  const lists = (await MK.rest('GET', 'lists?select=id,name&archived_at=is.null')).json;
  const items = (await MK.getAll('items?select=list_id&deleted_at=is.null&status=not.in.(done,cancelled)')).json;
  const chips = await T.ev(`Object.fromEntries([...document.querySelectorAll('.lists [data-list]')].map(b=>[b.dataset.list,+b.querySelector('.n').textContent]))`);
  check(G, 'chip counts equal REST counts', lists.every(l => chips[l.id] === undefined || chips[l.id] === items.filter(i => i.list_id === l.id).length), JSON.stringify(Object.values(chips)));
  check(G, 'four quadrants render', await T.ev('document.querySelectorAll("section.q").length===4'));
  await T.shot('smoke-maksym-1440x900');
  check(G, onlyHosts(), !strayHosts(T.hosts, SUPA, ORIGIN).length, [...T.hosts].join(', '));
  check(G, 'no console errors', !T.errors.length, T.errors.slice(0, 2).join(' / '));
  await T.close();
}

// ---- guests (multi-user, db/009-011): guest logins from the env (TASKSDB_GUEST_A_*, TASKSDB_GUEST_B_*), Maksym as the household side.
// A missing login skips its checks (named in the report), never fails. Guests only ever see test lists this group makes; the
// household's tags never reach a guest (the tag-list share goes from the guest to Maksym). Every step is undone in cleanup().
const guestUndo = [];
const closeDialogs = T => T.ev('document.querySelectorAll("dialog[open]").forEach(d=>d.close()),true');
// a card in _selftest opened in its task window; a card the poll has not brought yet gets one reload. ready: what the open window must show
async function openCard(T, id, ready) {
  for (let i = 0; i < 2; i++) {
    if (i) { await closeDialogs(T); await T.reload(); await T.ready(); }
    await pick(T, ST.id);
    if (await T.wait(`!!document.querySelector('[data-card="${id}"]')`, 8000)) { await T.click(`[data-card="${id}"]`); if (await T.wait(`!!document.querySelector(${JSON.stringify(ready)})`, 5000)) return true; }
  }
  return false;
}
const rpcOf = async (c, fn, body) => { const r = await c.rest('POST', 'rpc/' + fn, body || {}); return r.ok ? r.json : null; };
async function mkList(c, name, own) {
  const r = await c.rest('POST', 'rpc/create_list', { p_name: name, p_shared: false });
  if (!r.ok) throw new Error('create_list failed: ' + r.err.message);
  const l = (await c.rest('GET', 'lists?select=id,slug,name&id=eq.' + r.json)).json[0];
  if (own) testLists.push(l); // Maksym's: archived by cleanup() with its items
  return l;
}
// everything a login can read that matters for isolation (guests have few rows: one page is enough)
async function snapshotOf(c) {
  const g = async p => { const r = await c.rest('GET', p); return r.ok ? r.json : null; };
  return { lists: await g('lists?select=id,slug,owner_id'), items: await g('items?select=id,list_id&deleted_at=is.null'), categories: await g('categories?select=slug'),
    profiles: await g('profiles?select=id,handle'), tagLists: await g('tag_lists?select=id,owner_id'), tags: await g('tags?select=id,tag_list_id,name&deleted_at=is.null'),
    itemTags: await g('item_tags?select=item_id,tag_id&removed_at=is.null') };
}
// leaks of a guest: anything outside its own lists and tag lists plus the ones it accepted (extra)
async function leaksOf(c, extra) {
  const s = await snapshotOf(c);
  const failed = Object.keys(s).filter(k => !s[k]);
  if (failed.length) return ['read failed: ' + failed.join(', ')];
  return guestLeaks(s, { uid: c.uid, lists: s.lists.filter(l => l.owner_id === c.uid).map(l => l.id).concat([...extra.lists]),
    tagLists: s.tagLists.filter(t => t.owner_id === c.uid).map(t => t.id).concat([...extra.tagLists]) });
}
// the Share dialog of a list from its chip menu, or of my Default from Account menu, Tags
async function openListShare(T, listId) {
  await closeDialogs(T); await T.ev('dispatchEvent(new Event("focus")),true'); await sleep(1200);
  await pick(T, listId);
  await T.click('#listmenu'); await T.wait('!!document.querySelector("#pop [data-share-list]")', 5000); await T.click('#pop [data-share-list]');
  return T.wait('!!document.getElementById("sh-email")', 8000);
}
async function shareInDialog(T, email, role) {
  await T.ev('document.getElementById("sh-email").value="";document.getElementById("sh-e").textContent="";true');
  await T.insert('#sh-email', email);
  await T.ev(`document.getElementById('sh-role').value=${JSON.stringify(role)};document.getElementById('sh-go').click();true`);
}
async function openSharingMenu(T, inviteId) {
  await closeDialogs(T); await T.ev('dispatchEvent(new Event("focus")),true');
  await T.wait(`INVITES.some(i=>i.id===${JSON.stringify(inviteId)})`, 10000);
  await T.click('#profile'); await T.wait('!!document.querySelector("[data-menu=sharing]")', 5000); await T.click('[data-menu=sharing]');
  return T.wait(`!!document.querySelector('[data-accept="${inviteId}"]')`, 8000);
}
const guestCheck = async (G, who, c, extra, what) => { const l = await leaksOf(c, extra); check(G, `${who}: ${what}`, !l.length, l.slice(0, 6).join(', ')); };
async function loginGuest(G, handle, label) {
  const c = await connect(env, handle, { core, via: 'script:e2e', runId: RUN }); clients.push(c);
  const p = (await c.rest('GET', 'profiles?select=id,is_household&id=eq.' + c.uid)).json;
  const ok = Array.isArray(p) && p[0] && p[0].is_household === false;
  check(G, `${label} is a guest login (is_household false)`, ok, ok ? '' : 'stopped: not a guest login');
  return ok ? c : null;
}

async function gGuests() {
  const G = 'guests', M = await maksymPage();
  const [ga, gb] = guestLogins(env);
  // owner side, no guest needed: my own address is refused; an address nobody has shows as pending; Revoke withdraws it
  const L1 = await mkList(MK, 'Guests e2e ' + RUN, true);
  const it1 = (await MK.rest('POST', 'items', { list_id: L1.id, category: 'task', title: `${RUN} guest sees this`, quadrant: 'B' }, { Prefer: 'return=representation' })).json[0];
  const mDef = ((await MK.rest('GET', `tag_lists?select=id&is_default=eq.true&owner_id=eq.${MK.uid}`)).json || [])[0];
  const mTag = mDef && ((await MK.rest('GET', `tags?select=id,name&deleted_at=is.null&limit=1&tag_list_id=eq.${mDef.id}`)).json || [])[0];
  if (mTag) await MK.rest('POST', 'item_tags', { item_id: it1.id, tag_id: mTag.id });
  check(G, 'owner: the Share dialog opens from the list chip menu', await openListShare(M, L1.id));
  await shareInDialog(M, MK.session.user.email, 'viewer');
  check(G, 'owner: sharing with my own address is refused in the dialog', await M.wait('(document.getElementById("sh-e")||{}).textContent.length>0', 8000), await M.text('#sh-e'));
  const nobody = `${RUN}-nobody@example.invalid`;
  await shareInDialog(M, nobody, 'viewer');
  const people = async (c, id) => (await rpcOf(c, 'list_people', { p_list: id })) || [];
  const pending = await until(async () => (await people(MK, L1.id)).find(p => p.state === 'pending' && p.email === nobody));
  check(G, 'owner: an invitation by email shows as pending (Viewer); nothing is sent', !!pending && pending.role === 'viewer');
  check(G, 'owner: the Share dialog lists it with Revoke', !!pending && await M.wait(`!!document.querySelector('#sh-people [data-revoke="${pending.invite_id}"]')`, 8000));
  await M.shot('guests-share-dialog-maksym-1440x900');
  check(G, 'a household member who is not on the list sees nobody on it (list_people)', (await people(AN, L1.id)).length === 0);
  if (pending) await M.click(`#sh-people [data-revoke="${pending.invite_id}"]`);
  check(G, 'owner: Revoke withdraws the invitation', await until(async () => !(await people(MK, L1.id)).some(p => p.email === nobody)));
  await closeDialogs(M);

  if (ga.missing.length) {
    skip(G, 'guest A: isolation, a first share joins at once with a note (Keep), no household tags, tag-list share to Maksym, decline and block, removal, a re-share needs Accept (both widths)', 'env missing: ' + ga.missing.join(', '));
    skip(G, 'guest A and guest B: list share through the UI (first share joins, a re-share needs Accept), tags only after the Default is shared, removal gives 0 rows', 'needs guest A and guest B');
    return;
  }
  const A = await loginGuest(G, 'guest-a', 'guest A');
  if (!A) return;
  const aEmail = A.session.user.email, xA = { lists: new Set(), tagLists: new Set() };
  const aDef = ((await A.rest('GET', `tag_lists?select=id,name&is_default=eq.true&owner_id=eq.${A.uid}`)).json || [])[0];
  const s0 = await snapshotOf(A);
  check(G, 'guest A: has its own lists (My tasks) and a Default tag list', !!aDef && (s0.lists || []).some(l => l.owner_id === A.uid), `lists ${(s0.lists || []).length}, live tags ${(s0.tags || []).length}`);
  await guestCheck(G, 'guest A', A, xA, 'reads no household list, item, category, profile or tag');
  const AP = await tab(B, await ctx(B));
  check(G, 'guest A: opens signed in from ' + where(), await open(AP, await grantFor('guest-a')));
  check(G, 'guest A: the page holds only its own lists and tags, task and reminder categories, nobody else\'s name',
    await AP.ev(`LISTS.every(l=>l.owner_id===me.id) && Object.values(TAG).every(t=>(TAG_LISTS[t.tag_list_id]||{}).owner_id===me.id) && Object.keys(CATS).every(c=>c==='task'||c==='reminder') && Object.keys(NAMES).every(id=>id===me.id)`));
  for (const [w, h] of [[1440, 900], [390, 844]]) { await AP.size(w, h); await sleep(600); await AP.shot(`guests-a-board-${w}x${h}`); }
  await AP.size(1440, 900);

  // round 3 (db/012): the Share dialog sends p_join, so Maksym's first share of L1 with A joins A at once, with a one-time note
  await openListShare(M, L1.id); await shareInDialog(M, aEmail, 'viewer');
  xA.lists.add(L1.id);
  guestUndo.push(() => MK.rest('DELETE', `list_members?list_id=eq.${L1.id}&profile_id=eq.${A.uid}`));
  guestUndo.push(async () => { for (const p of await people(MK, L1.id)) if (p.state === 'pending') await rpcOf(MK, 'revoke_invite', { p_invite: p.invite_id }); });
  check(G, 'guest A: a first share joins at once (no Accept): the list and its item', await until(async () => ((await A.rest('GET', 'items?select=id&list_id=eq.' + L1.id)).json || []).length === 1));
  check(G, 'owner: the Share dialog\'s people list A as a member (Viewer), not pending', (await people(MK, L1.id)).some(p => p.state === 'member' && p.profile_id === A.uid && p.role === 'viewer'));
  check(G, 'guest A: no invitation to accept for it', !((await rpcOf(A, 'my_invitations')) || []).some(i => i.target_name === L1.name));
  const n1 = await until(async () => ((await A.rest('GET', `shared_notices?select=id,seen_at&list_id=eq.${L1.id}&seen_at=is.null`)).json || [])[0]);
  check(G, 'guest A: a one-time note in shared_notices', !!n1);
  await closeDialogs(AP); await AP.ev('dispatchEvent(new Event("focus")),true');
  check(G, 'guest A: the page shows the note with Keep, Leave and Block', !!n1 && await AP.wait(`!!document.querySelector('#notices [data-notice="${n1.id}"] [data-ntc=leave]') && !!document.querySelector('#notices [data-notice="${n1.id}"] [data-ntc=block]')`, 10000));
  await AP.shot('guests-a-notice-1440x900');
  if (n1) await AP.click(`#notices [data-notice="${n1.id}"] [data-ntc=seen]`);
  check(G, 'guest A: Keep marks the note seen and keeps the list', !!n1 && await until(async () => !!((await A.rest('GET', 'shared_notices?select=seen_at&id=eq.' + n1.id)).json || [{}])[0].seen_at) && ((await A.rest('GET', 'lists?select=id&id=eq.' + L1.id)).json || []).length === 1);
  check(G, 'guest A: none of Maksym\'s tags on the shared item', ((await A.rest('GET', 'item_tags?select=tag_id&item_id=eq.' + it1.id)).json || [1]).length === 0, mTag ? 'the item carries one of his tags' : 'Maksym has no tag to put on it');
  await guestCheck(G, 'guest A', A, xA, 'after the share: still no household row, only the shared list added');
  check(G, 'guest A: names visible = Maksym only (visible_profiles)', JSON.stringify(((await rpcOf(A, 'visible_profiles')) || []).map(p => p.id)) === JSON.stringify([MK.uid]));
  await closeDialogs(AP); await AP.ev('dispatchEvent(new Event("focus")),true');
  check(G, 'guest A: the list shows, read only (Viewer), with no tag of Maksym on the page', await AP.wait(`!!document.querySelector('[data-list="${L1.id}"]')`, 10000) &&
    await AP.ev(`Object.values(TAG).every(t=>(TAG_LISTS[t.tag_list_id]||{}).owner_id===me.id) && !document.querySelector('[data-done="${it1.id}"]')`));

  // A shares A's Default with Maksym (never the other way): Maksym sees A's tags only after Accept, then leaves
  const aTagName = (RUN + '-a').slice(0, 40);
  await closeDialogs(AP); await AP.click('#profile'); await AP.click('[data-menu=tags]'); await AP.wait('!!document.getElementById("tg-new")', 8000);
  await AP.insert('#tg-new', aTagName); await AP.click('#tg-add');
  const aTag = await until(async () => ((await A.rest('GET', `tags?select=id,name&deleted_at=is.null&name=eq.${encodeURIComponent(aTagName)}&tag_list_id=eq.${aDef.id}`)).json || [])[0]);
  if (aTag) guestUndo.push(() => A.rest('PATCH', 'tags?id=eq.' + aTag.id, { deleted_at: new Date().toISOString() }));
  check(G, 'guest A: a new tag from Account menu, Tags lands in A\'s Default', !!aTag);
  await AP.wait(`!!document.querySelector('[data-share-tags="${aDef.id}"]')`, 8000); await AP.click(`[data-share-tags="${aDef.id}"]`);
  await AP.wait('!!document.getElementById("sh-email")', 8000); await shareInDialog(AP, MK.session.user.email, 'viewer');
  guestUndo.push(async () => { await rpcOf(MK, 'leave_tag_list', { p_tag_list: aDef.id }); for (const p of (await rpcOf(A, 'tag_list_people', { p_tag_list: aDef.id })) || []) if (p.state === 'pending') await rpcOf(A, 'revoke_invite', { p_invite: p.invite_id }); });
  const joinedTags = async () => ((await MK.rest('GET', 'tag_lists?select=id&id=eq.' + aDef.id)).json || []).length === 1;
  const inv2 = await until(async () => ((await rpcOf(MK, 'my_invitations')) || []).find(i => i.kind === 'tag_list' && i.target_name === aDef.name) || (await joinedTags() ? 'joined' : null));
  if (inv2 && inv2 !== 'joined') {
    check(G, 'Maksym: a re-share of A\'s Default (left in an earlier run) is an invitation: none of A\'s tags before Accept', ((await MK.rest('GET', 'tags?select=id&tag_list_id=eq.' + aDef.id)).json || [1]).length === 0);
    check(G, 'Maksym: Accept in Account menu, Sharing', await openSharingMenu(M, inv2.id));
    await M.click(`[data-accept="${inv2.id}"]`);
  } else check(G, 'Maksym: a first share of A\'s Default joins at once (no Accept)', inv2 === 'joined');
  check(G, 'Maksym: A\'s tags are readable', await until(async () => ((await MK.rest('GET', 'tags?select=name&deleted_at=is.null&tag_list_id=eq.' + aDef.id)).json || []).some(t => t.name === aTagName)));
  await closeDialogs(M); await M.ev('dispatchEvent(new Event("focus")),true'); await sleep(1500);
  await M.click('#profile'); await M.click('[data-menu=tags]');
  check(G, 'Maksym: Account menu, Tags lists A\'s Default under Shared with me', await M.wait(`!!document.querySelector('[data-tl-leave="${aDef.id}"]') && document.querySelector('dialog[open]').textContent.includes(${JSON.stringify(aTagName)})`, 8000));
  await M.shot('guests-maksym-tags-shared-1440x900');
  await guestCheck(G, 'guest A', A, xA, 'sharing its Default gives it nothing of Maksym\'s');
  await M.click(`[data-tl-leave="${aDef.id}"]`); await M.wait('!!document.getElementById("cf-ok")', 5000); await M.click('#cf-ok');
  check(G, 'Maksym: Leave takes A\'s tags away again', await until(async () => ((await MK.rest('GET', 'tags?select=id&tag_list_id=eq.' + aDef.id)).json || [1]).length === 0));
  await closeDialogs(M);

  // decline and block a second invitation (the 3-argument share_list keeps the invitation flow): A sees nothing more from Maksym
  const L2 = await mkList(MK, 'Guests e2e block ' + RUN, true);
  await rpcOf(MK, 'share_list', { p_list: L2.id, p_email: aEmail, p_role: 'viewer' });
  const inv3 = await until(async () => ((await rpcOf(A, 'my_invitations')) || []).find(i => i.target_name === L2.name));
  guestUndo.push(async () => { await A.rest('DELETE', `invite_blocks?profile_id=eq.${A.uid}&blocked_id=eq.${MK.uid}`); for (const p of await people(MK, L2.id)) if (p.state === 'pending') await rpcOf(MK, 'revoke_invite', { p_invite: p.invite_id }); });
  check(G, 'guest A: Decline and block asks first', !!inv3 && await openSharingMenu(AP, inv3.id) && (await AP.click(`[data-block="${inv3.id}"]`), await AP.wait('!!document.getElementById("cf-ok")', 5000)));
  await AP.click('#cf-ok');
  check(G, 'guest A: the block is stored (invite_blocks, own row)', await until(async () => ((await A.rest('GET', `invite_blocks?select=blocked_id&profile_id=eq.${A.uid}`)).json || []).some(b => b.blocked_id === MK.uid)));
  check(G, 'Maksym: the declined invitation still reads "pending" (S4)', (await people(MK, L2.id)).some(p => p.state === 'pending' && p.email === aEmail.toLowerCase()));
  const again = await rpcOf(MK, 'share_list', { p_list: L2.id, p_email: aEmail, p_role: 'editor' });
  check(G, 'Maksym: inviting again answers the same; guest A sees no invitation and nothing of the list', !!again && again.ok === true && !((await rpcOf(A, 'my_invitations')) || []).some(i => i.target_name === L2.name) && ((await A.rest('GET', 'lists?select=id&id=eq.' + L2.id)).json || [1]).length === 0);
  await A.rest('DELETE', `invite_blocks?profile_id=eq.${A.uid}&blocked_id=eq.${MK.uid}`);
  check(G, 'guest A: may delete its own block (admin-free unblock over REST)', ((await A.rest('GET', `invite_blocks?select=blocked_id&profile_id=eq.${A.uid}`)).json || [1]).every(b => b.blocked_id !== MK.uid));

  // Maksym removes A from L1 in the Share dialog: 0 rows for A
  await openListShare(M, L1.id);
  check(G, 'owner: the Share dialog lists A as a member with Remove', await M.wait(`!!document.querySelector('#sh-people [data-remove="${A.uid}"]')`, 8000));
  await M.click(`#sh-people [data-remove="${A.uid}"]`);
  xA.lists.delete(L1.id);
  check(G, 'guest A: after removal, 0 rows of the list and its items', await until(async () => ((await A.rest('GET', 'lists?select=id&id=eq.' + L1.id)).json || [1]).length === 0 && ((await A.rest('GET', 'items?select=id&list_id=eq.' + L1.id)).json || [1]).length === 0));
  // a re-share after removal is an invitation again (an earlier one exists): nothing of the list before Accept; cleanup revokes it
  await closeDialogs(M); await openListShare(M, L1.id); await shareInDialog(M, aEmail, 'viewer');
  const inv4 = await until(async () => ((await rpcOf(A, 'my_invitations')) || []).find(i => i.kind === 'list' && i.target_name === L1.name));
  check(G, 'guest A: a re-share after removal needs Accept (an invitation); nothing of the list before it', !!inv4 && ((await A.rest('GET', 'lists?select=id&id=eq.' + L1.id)).json || [1]).length === 0);
  await closeDialogs(M);
  await guestCheck(G, 'guest A', A, xA, 'at the end: only its own rows');
  await closeDialogs(AP); await AP.ev('dispatchEvent(new Event("focus")),true');
  check(G, 'guest A: the list leaves the page', await AP.wait(`!document.querySelector('[data-list="${L1.id}"]') && LISTS.every(l=>l.owner_id===me.id)`, 10000));
  check(G, `guest A: ${onlyHosts()}`, !strayHosts(AP.hosts, SUPA, ORIGIN).length, [...AP.hosts].join(', '));
  check(G, 'guest A: no console errors', !AP.errors.length, AP.errors.slice(0, 2).join(' / '));
  await AP.close();

  // A ↔ B: two guests never meet except through a share A makes in the UI
  if (gb.missing.length) {
    skip(G, 'guest A and guest B: list share through the UI, nothing before Accept, tags only after the Default is shared, removal gives 0 rows', 'env missing: ' + gb.missing.join(', '));
    return;
  }
  const Bc = await loginGuest(G, 'guest-b', 'guest B');
  if (!Bc) return;
  const bEmail = Bc.session.user.email, xB = { lists: new Set(), tagLists: new Set() };
  await guestCheck(G, 'guest B', Bc, xB, 'reads nothing of A or the household');
  // one list for every run (slug guests-e2e-a), restored here and archived again by cleanup: guest_lists_total stays untouched
  let LA = ((await A.rest('GET', `lists?select=id,slug,name,archived_at&slug=eq.guests-e2e-a&owner_id=eq.${A.uid}`)).json || [])[0];
  if (LA && LA.archived_at) await A.rest('PATCH', 'lists?id=eq.' + LA.id, { archived_at: null });
  if (!LA) { const r = await A.rest('POST', 'rpc/create_list', { p_name: 'Guests e2e A', p_slug: 'guests-e2e-a', p_shared: false }); if (!r.ok) throw new Error('create_list failed: ' + r.err.message); LA = { id: r.json, slug: 'guests-e2e-a', name: 'Guests e2e A' }; }
  guestUndo.push(async () => { await A.rest('PATCH', `items?list_id=eq.${LA.id}&deleted_at=is.null`, { deleted_at: new Date().toISOString() }); await A.rest('PATCH', 'lists?id=eq.' + LA.id, { archived_at: new Date().toISOString() }); });
  const itA = (await A.rest('POST', 'items', { list_id: LA.id, category: 'task', title: `${RUN} A to B`, quadrant: 'B' }, { Prefer: 'return=representation' })).json[0];
  if (aTag) await A.rest('POST', 'item_tags', { item_id: itA.id, tag_id: aTag.id });
  const AP2 = await tab(B, await ctx(B));
  await open(AP2, await grantFor('guest-a'));
  await openListShare(AP2, LA.id); await shareInDialog(AP2, bEmail, 'viewer');
  // a first share joins B at once; B had an invitation for this list in an earlier run, so then it is one again and needs Accept
  guestUndo.push(async () => { for (const p of await people(A, LA.id)) if (p.state === 'pending') await rpcOf(A, 'revoke_invite', { p_invite: p.invite_id }); });
  guestUndo.push(() => A.rest('DELETE', `list_members?list_id=eq.${LA.id}&profile_id=eq.${Bc.uid}`));
  const BP = await tab(B, await ctx(B), { width: 390, height: 844 });
  check(G, 'guest B: opens signed in at 390×844', await open(BP, await grantFor('guest-b')));
  const invB = await until(async () => ((await rpcOf(Bc, 'my_invitations')) || []).find(i => i.target_name === LA.name) || (((await Bc.rest('GET', 'lists?select=id&id=eq.' + LA.id)).json || []).length ? 'joined' : null));
  if (invB && invB !== 'joined') {
    check(G, 'guest B: a re-share of A\'s list is an invitation; before Accept nothing of the list', ((await Bc.rest('GET', 'items?select=id&list_id=eq.' + LA.id)).json || [1]).length === 0 && ((await Bc.rest('GET', 'lists?select=id&id=eq.' + LA.id)).json || [1]).length === 0);
    check(G, 'guest B: Accept in Account menu, Sharing', await openSharingMenu(BP, invB.id));
    await BP.click(`[data-accept="${invB.id}"]`);
  } else check(G, 'guest B: A\'s first share joins B at once (no Accept)', invB === 'joined');
  xB.lists.add(LA.id);
  check(G, 'guest B: A\'s list and item, and none of A\'s tags', await until(async () => ((await Bc.rest('GET', 'items?select=id&deleted_at=is.null&list_id=eq.' + LA.id)).json || []).length === 1) && ((await Bc.rest('GET', 'item_tags?select=tag_id&item_id=eq.' + itA.id)).json || [1]).length === 0);
  await guestCheck(G, 'guest B', Bc, xB, 'only A\'s shared list added');
  await rpcOf(A, 'share_tag_list', { p_tag_list: aDef.id, p_email: bEmail, p_role: 'viewer', p_join: true });
  const invBt = await until(async () => ((await rpcOf(Bc, 'my_invitations')) || []).find(i => i.kind === 'tag_list') || (((await Bc.rest('GET', 'tag_lists?select=id&id=eq.' + aDef.id)).json || []).length ? 'joined' : null));
  guestUndo.push(() => rpcOf(Bc, 'leave_tag_list', { p_tag_list: aDef.id }));
  if (invBt && invBt !== 'joined') await rpcOf(Bc, 'accept_invite', { p_invite: invBt.id });
  xB.tagLists.add(aDef.id);
  check(G, 'guest B: A\'s tag shows on the shared item once A\'s Default is shared', !aTag || await until(async () => ((await Bc.rest('GET', 'item_tags?select=tag_id&removed_at=is.null&item_id=eq.' + itA.id)).json || []).some(x => x.tag_id === aTag.id)));
  await guestCheck(G, 'guest B', Bc, xB, 'still no household row');
  await closeDialogs(BP); await BP.ev('dispatchEvent(new Event("focus")),true'); await BP.wait(`!!document.querySelector('[data-list="${LA.id}"]')`, 10000);
  for (const [w, h] of [[390, 844], [1440, 900]]) { await BP.size(w, h); await sleep(600); await BP.shot(`guests-b-board-${w}x${h}`); }
  await A.rest('DELETE', `list_members?list_id=eq.${LA.id}&profile_id=eq.${Bc.uid}`);
  await rpcOf(Bc, 'leave_tag_list', { p_tag_list: aDef.id });
  check(G, 'guest B: after A removes B, 0 rows of the list, its items and A\'s tags', ((await Bc.rest('GET', 'items?select=id&list_id=eq.' + LA.id)).json || [1]).length === 0 && ((await Bc.rest('GET', 'tags?select=id&tag_list_id=eq.' + aDef.id)).json || [1]).length === 0);
  check(G, 'guest B: no console errors', !BP.errors.length, BP.errors.slice(0, 2).join(' / '));
  await BP.close(); await AP2.close();
}

// ---- request: the public access-request page (request.html, access-backup-plan A1-A3) ----
// Every state, with Supabase Auth and the two RPCs answered by Fetch interception: nothing reaches the database and no login is
// needed. Without --url the page is served from 127.0.0.1 (Google sign-in needs an http(s) origin) with the deploy's CSP for
// request.html, so a second inline script or a stray host shows up as a security error.
const REQ_EMAIL = 'stranger@example.invalid';
const REQ_AT = '2026-10-28T21:41:00.000Z', REQ_DECIDED = '2026-10-29T08:05:00.000Z';
const reqDir = () => path.dirname(PAGE);
// the host the page talks to: the config next to the page (the same values the deploy publishes)
function reqSupaHost() {
  const box = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(reqDir(), 'config', 'tasksdashboard.config.js'), 'utf8'), box, { timeout: 1000 });
  return new URL(box.window.TD_CONFIG.supabaseUrl).host;
}
function serveRequestPage(supa) {
  const html = fs.readFileSync(path.join(reqDir(), 'request.html'), 'utf8');
  const hashes = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi)].filter(m => !/\ssrc\s*=/i.test(m[1] || ''))
    .map(m => `'sha256-${crypto.createHash('sha256').update(m[2].replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`);
  const csp = `default-src 'none'; script-src 'self' ${hashes.join(' ')}; style-src 'unsafe-inline'; img-src 'self' data:; connect-src https://${supa}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`;
  const files = { '/request': ['request.html', 'text/html; charset=utf-8'], '/request.html': ['request.html', 'text/html; charset=utf-8'],
    '/config/tasksdashboard.config.js': [path.join('config', 'tasksdashboard.config.js'), 'text/javascript; charset=utf-8'] };
  const srv = http.createServer((q, r) => {
    const f = files[new URL(q.url, 'http://x').pathname];
    if (!f) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'Content-Type': f[1], 'Content-Security-Policy': csp, 'Cache-Control': 'no-store' });
    r.end(fs.readFileSync(path.join(reqDir(), f[0])));
  });
  return new Promise(res => srv.listen(0, '127.0.0.1', () => res({ srv, origin: 'http://127.0.0.1:' + srv.address().port, scripts: hashes.length })));
}
// S: { back, token(), mine(), request(), hold, calls } - each answer is [status, body]; body undefined = empty
async function stubRequestApi(T, S, supa) {
  await T.send('Fetch.enable', { patterns: fetchPatterns(`https://${supa}/*`) });
  T.paused = async p => {
    const cors = [{ name: 'Access-Control-Allow-Origin', value: '*' }];
    if (p.request.method === 'OPTIONS') return T.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 204, body: '', responseHeaders: cors.concat([
      { name: 'Access-Control-Allow-Methods', value: 'GET,POST,OPTIONS' }, { name: 'Access-Control-Allow-Headers', value: 'apikey,authorization,content-type' }, { name: 'Access-Control-Max-Age', value: '0' }]) }).catch(() => {});
    const reply = ([status, body], extra = []) => T.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: status,
      responseHeaders: cors.concat(body === undefined ? [] : [{ name: 'Content-Type', value: 'application/json' }], extra),
      ...(body === undefined ? {} : { body: Buffer.from(JSON.stringify(body)).toString('base64') }) }).catch(() => {});
    const u = new URL(p.request.url), h = p.request.headers || {};
    S.calls.push({ path: u.pathname, search: u.search, body: p.request.postData || '', bearer: h.Authorization || h.authorization || '', apikey: !!(h.apikey || h.Apikey) });
    if (u.pathname === '/auth/v1/authorize') { S.authorize = u; return reply([302], [{ name: 'Location', value: S.back + '?code=e2e-code' }]); }
    if (u.pathname === '/auth/v1/token') return reply(S.token());
    if (u.pathname === '/auth/v1/logout') return reply([204]);
    if (u.pathname === '/rest/v1/rpc/my_access_request') return reply(S.mine());
    if (u.pathname === '/rest/v1/rpc/request_access') { if (S.hold) await S.hold; return reply(S.request()); }
    return reply([404, { message: 'not stubbed in e2e' }]);
  };
}
// the local time the page prints (same machine, same zone)
const reqLocal = t => { const d = new Date(t), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
async function reqShots(T, G, name) {
  const wide = [];
  for (const theme of ['light', 'dark']) {
    await T.theme(theme);
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      await T.size(w, h); await sleep(250);
      await T.shot(`request-${name}-${theme}-${w}x${h}`);
      if (w === 390 && !(await T.ev('document.documentElement.scrollWidth<=innerWidth'))) wide.push(theme + ' ' + await T.ev('document.documentElement.scrollWidth'));
    }
  }
  await T.theme('light'); await T.size(1440, 900);
  check(G, `${name}: screenshots at 1440x900 and 390x844, light and dark; no horizontal scroll at 390 px`, !wide.length, wide.join(', '));
}
async function gRequest() {
  const G = 'request';
  const supa = reqSupaHost();
  const local = ORIGIN ? null : await serveRequestPage(supa);
  const base = ORIGIN || local.origin, page = base + '/request';
  const is = s => `document.getElementById("app")?.dataset.state===${JSON.stringify(s)}`;
  const T = await tab(B, await ctx(B));
  const pending = { id: '00000000-0000-4000-8000-00000000a001', status: 'pending', email: REQ_EMAIL, requested_at: REQ_AT, decided_at: null };
  const grant = { access_token: 'e2e-access', refresh_token: 'e2e-refresh', token_type: 'bearer', expires_in: 3600, user: { id: '00000000-0000-4000-8000-0000000000e2', email: REQ_EMAIL } };
  const rpcs = () => S.calls.filter(c => c.path.startsWith('/rest/v1/rpc/')).map(c => c.path.slice(13));
  const S = { back: page, calls: [], hold: null, token: () => [200, grant], mine: () => [200, []], request: () => [200, pending] };
  // my_access_request answers none until request_access ran, then the pending row
  const fresh = () => { let made = false; S.mine = () => [200, made ? [pending] : []]; S.request = () => { made = true; return [200, pending]; }; };
  const signIn = async () => { S.calls.length = 0; await T.click('[data-act=google]'); };
  try {
    await stubRequestApi(T, S, supa);
    await T.go(page);
    check(G, 'signed out: Ask for access and an enabled Continue with Google', await T.wait(is('signedout')) && await T.ev('!document.querySelector("[data-act=google]").disabled'));
    if (local) check(G, 'the page has exactly one inline script, and it runs under the deploy\'s CSP', local.scripts === 1 && !T.errors.length, T.errors.slice(0, 2).join(' / '));
    await T.theme('dark'); await sleep(150);
    check(G, 'dark: the system theme switches the page to the dark tokens', (await T.ev('getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()')).toUpperCase() === '#05060C');
    await T.theme('light');
    await reqShots(T, G, 'signed-out');

    // sign in; request_access is held so the sending state can be photographed
    fresh();
    let release; S.hold = new Promise(r => { release = r; });
    await signIn();
    const sending = await T.wait(is('sending'), 15000);
    const a = S.authorize;
    check(G, 'Continue with Google: /auth/v1/authorize with provider google, redirect_to /request and an s256 challenge',
      !!a && a.searchParams.get('provider') === 'google' && a.searchParams.get('redirect_to') === page && a.searchParams.get('code_challenge_method') === 's256' && /^[A-Za-z0-9_-]{43}$/.test(a.searchParams.get('code_challenge') || ''),
      a ? 'redirect_to ' + a.searchParams.get('redirect_to') : 'no authorize request');
    const tok = S.calls.find(c => c.path === '/auth/v1/token');
    let body = {}; try { body = JSON.parse(tok ? tok.body : '{}'); } catch (e) {}
    check(G, 'the code is swapped with grant_type=pkce and the verifier, and leaves the address bar', !!tok && /grant_type=pkce/.test(tok.search) && body.auth_code === 'e2e-code' && /^[A-Za-z0-9_-]{43,128}$/.test(body.code_verifier || '') && await T.ev('location.search===""&&location.pathname==="/request"'));
    check(G, 'sending: shown while request_access is on its way', sending);
    await reqShots(T, G, 'sending');
    release(); S.hold = null;
    const sent = await T.wait(is('sent'), 15000);
    const txt = await T.text('#app');
    check(G, 'sent: the coffee break, "Your request is sent. We\'ll let you in soon." and the request time', sent && await T.has('#app svg.coffee') && txt.includes('Your request is sent. We\'ll let you in soon.') && txt.includes(reqLocal(REQ_AT)) && txt.includes(REQ_EMAIL), txt.slice(0, 120));
    check(G, 'sent: my_access_request, request_access, my_access_request, each with the user\'s token and the publishable key',
      rpcs().join() === 'my_access_request,request_access,my_access_request' && S.calls.filter(c => c.path.startsWith('/rest/')).every(c => c.bearer === 'Bearer e2e-access' && c.apikey), rpcs().join());
    check(G, 'no board data is read (only auth and the two access RPCs)', S.calls.every(c => /^\/auth\/v1\/(authorize|token|logout)$/.test(c.path) || /^\/rest\/v1\/rpc\/(my_access_request|request_access)$/.test(c.path)), S.calls.map(c => c.path).join(' '));
    await reqShots(T, G, 'sent');

    // a reload keeps the session (this tab) and writes nothing
    S.calls.length = 0; S.mine = () => [200, [pending]];
    await T.reload();
    check(G, 'reload: the pending request again, without a second request_access', await T.wait(is('sent')) && rpcs().join() === 'my_access_request', rpcs().join());

    S.mine = () => [200, Object.assign({}, pending, { status: 'approved', decided_at: REQ_DECIDED })];
    await T.reload();
    const appr = await T.wait(is('approved'));
    check(G, 'approved (a row, not an array): You\'re in, the approval time and a link to /', appr && (await T.text('#app h1')) === 'You\'re in' && (await T.text('#app')).includes(reqLocal(REQ_DECIDED)) && await T.ev(`document.querySelector("[data-act=open]").getAttribute("href")===${JSON.stringify('/')}`));
    await reqShots(T, G, 'approved');

    S.mine = () => [200, [Object.assign({}, pending, { status: 'declined', decided_at: REQ_DECIDED })]];
    await T.reload();
    check(G, 'declined: Request declined with the decision time', await T.wait(is('declined')) && (await T.text('#app')).includes(reqLocal(REQ_DECIDED)));
    await reqShots(T, G, 'declined');

    // Use another account: logout, the tab forgets the session
    S.calls.length = 0;
    await T.click('[data-act=signout]');
    check(G, 'Use another account: signed out, logout sent, the session gone from this tab', await T.wait(is('signedout')) && await until(async () => S.calls.some(c => c.path === '/auth/v1/logout'), 5000) && await T.ev('sessionStorage.getItem("td.request.auth")===null'));

    // the caps of db/015 (54000): try later
    S.mine = () => [200, []]; S.request = () => [400, { code: '54000', message: 'access requests are capped', details: null, hint: null }];
    await signIn();
    check(G, 'cap reached (54000): Try again later', await T.wait(is('cap'), 15000) && /Try again tomorrow/.test(await T.text('#app')));
    await reqShots(T, G, 'cap');

    // db/015 answers null when there is no request; a household member is refused with 22023
    await T.click('[data-act=signout]'); await T.wait(is('signedout'));
    S.mine = () => [200, null]; S.request = () => [400, { code: '22023', message: 'household members already have access', details: null, hint: null }];
    await signIn();
    check(G, 'a household member (22023 "already have access", my_access_request null): You\'re in', await T.wait(is('approved'), 15000) && rpcs().join() === 'my_access_request,request_access', rpcs().join());

    // a server error, then Try again
    await T.click('[data-act=signout]'); await T.wait(is('signedout'));
    S.request = () => [500, { code: 'XX000', message: 'e2e server error' }];
    await signIn();
    check(G, 'error: the server\'s message and Try again', await T.wait(is('error'), 15000) && (await T.text('#app .msg')).includes('e2e server error') && await T.has('[data-act=retry]'));
    await reqShots(T, G, 'error');
    fresh();
    await T.click('[data-act=retry]');
    check(G, 'Try again: the request goes through and shows as sent', await T.wait(is('sent'), 15000));

    // refusals on the way back from Google
    await T.click('[data-act=signout]'); await T.wait(is('signedout'));
    await T.go(page + '?error=access_denied&error_description=The+user+cancelled+the+sign-in');
    check(G, 'Google cancelled: signed out with the reason, the address cleaned', await T.wait(is('signedout')) && /cancelled/.test(await T.text('#app .msg')) && await T.ev('location.search===""'));
    await T.go(page + '?error=server_error&error_code=unexpected_failure&error_description=TasksDashboard+is+full+right+now');
    check(G, 'the sign-up cap of the hook: Try again later with its message', await T.wait(is('cap')) && /full right now/.test(await T.text('#app')));
    await T.go(page + '?code=stale-code');
    check(G, 'a code without a verifier in this tab: signed out, sign-in expired', await T.wait(is('signedout')) && /expired/.test(await T.text('#app .msg')));

    check(G, 'no console errors or CSP violations', !T.errors.length, T.errors.slice(0, 2).join(' / '));
    const hosts = [...T.hosts].filter(h => h !== supa && h !== new URL(base).host);
    check(G, `only ${supa} and the page origin are contacted`, !hosts.length, hosts.join(', '));
  } finally {
    await unintercept(T).catch(() => {});
    if (!ORIGIN) {
      // file://: no origin to come back to, so the button is off and the page says where to open it
      try {
        await T.go(pathToFileURL(path.join(reqDir(), 'request.html')).href);
        check(G, 'file://: Continue with Google is off, with the https hint', await T.wait(is('signedout')) && await T.ev('document.querySelector("[data-act=google]").disabled') && /https address/.test(await T.text('#app')));
      } catch (e) { check(G, 'file:// page opens', false, e.message); }
    }
    await T.close().catch(() => {});
    if (local) local.srv.close();
  }
}

const t0 = Date.now();
try {
  await setup();
  B = await launch();
  const run = { auth: gAuth, data: gData, sync: gSync, archive: gArchive, errors: gErrors, ui: gUi, links: gLinks, guests: gGuests, request: gRequest, smoke: gSmoke };
  // errors creates the Cyrillic list that data moves an item into, so errors runs before data when both are asked for
  const order = ['smoke', 'auth', 'errors', 'data', 'sync', 'archive', 'ui', 'links', 'guests', 'request'].filter(g => want.includes(g));
  for (const g of order) {
    try { await run[g](); } catch (e) { check(g, 'group ran to the end', false, e.message); }
  }
} catch (e) {
  check('setup', 'setup', false, e.message);
} finally {
  // the browser goes first: an open page saving its preferences late would undo the restore in cleanup
  if (B) { B.close(); await sleep(800); }
  try { await cleanup(); } catch (e) { leftovers.push('cleanup failed: ' + e.message); }
  for (const c of clients.reverse()) await c.close();
  const report = ['# TasksDashboard e2e', '', `Run \`${RUN}\`, ${new Date().toISOString()}, ${Math.round((Date.now() - t0) / 1000)} s. Page \`${ORIGIN ? ORIGIN + '/' + (ACCESS ? '` (Access service token)' : '`') : PAGE + '`'}. Groups: ${want.join(', ')}. Logins from the env file; no values printed.`, '',
    `**${pass} of ${pass + fail} passed${skipped ? `, ${skipped} skipped` : ''}.**`, '', '| Group | Check | Result | Note |', '|---|---|---|---|', ...rows, '', '## Leftovers', '', ...(leftovers.length ? leftovers.map(x => '- ' + x) : ['- none']), '',
    ...(reviewApiTimes.length ? ['## Review API (rpc/review_report)', '', '| Login | ms | rows | weeks |', '|---|---|---|---|', ...reviewApiTimes.map(k => `| ${k.who} | ${k.ms} | ${k.rows} | ${k.weeks} |`), ''] : []),
    ...(timelineTimes.length ? ['## Timeline render (td:tl-render)', '', '| rows | ms |', '|---|---|', ...timelineTimes.map(k => `| ${k.rows} | ${k.ms} |`), ''] : []),
    ...(kpiTimes.length ? ['## KPI read', '', '| Login | ms | items | events | lists | via |', '|---|---|---|---|---|---|', ...kpiTimes.map(k => `| ${k.who} | ${k.ms} | ${k.items} | ${k.events} | ${k.lists} | ${k.via} |`), ''] : []),
    'Screenshots: the `*.png` files next to this report.'].join('\n');
  fs.writeFileSync(path.join(OUT, 'e2e-report.md'), report + '\n');
  console.log(`${pass} of ${pass + fail} passed${skipped ? `, ${skipped} skipped` : ''}; report ${path.join(OUT, 'e2e-report.md')}`);
  process.exitCode = fail ? 1 : 0;
}
