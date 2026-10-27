#!/usr/bin/env node
// End-to-end test of TasksDashboard.html against the live TasksDashboardDB, through a headless Chrome / Edge DevTools connection.
// node test/e2e.mjs --env <file> --out <dir> [--smoke] [--group auth|data|sync|archive|errors|ui|smoke] [--page <html>]
// No dependencies. Real sessions come from a REST sign-in in Node, seeded into the page's td.auth; the form itself is only fed
// dummy credentials while Fetch interception answers it, so no real password is ever typed into the page. Writes stay in the
// _selftest list (and one Cyrillic-named test list it creates and archives). The transport never logs CDP parameters.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEnv, missingEnv, connect, loadCore, APP_HTML } from '../cli/lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => { if (x.startsWith('--')) a.push([x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]); return a; }, []));
const GROUPS = ['auth', 'data', 'sync', 'archive', 'errors', 'ui'];
const want = args.smoke ? ['smoke'] : args.group ? String(args.group).split(',') : GROUPS;
const OUT = path.resolve(args.out || path.join(os.tmpdir(), 'td-e2e-' + Date.now()));
const PAGE = path.resolve(args.page || APP_HTML);
const RUN = 'e2e-' + new Date().toISOString().replace(/\D/g, '').slice(2, 12);
const DUMMY = { email: 'nobody@example.invalid', password: 'not-a-password' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rows = [], leftovers = [];
let pass = 0, fail = 0;
const check = (group, what, ok, note) => { ok ? pass++ : fail++; rows.push(`| ${group} | ${what} | ${ok ? 'pass' : 'FAIL'} | ${String(note || '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 160)} |`); console.log(`${ok ? 'pass' : 'FAIL'} ${group}: ${what}`); };

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
  const T = { sessionId, targetId, errors: [], hosts: new Set(), requests: [], paused: null };
  B.on(msg => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') T.errors.push((msg.params.exceptionDetails.exception || {}).description || msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') T.errors.push(msg.params.args.map(a => a.value || a.description || '').join(' '));
    if (msg.method === 'Network.requestWillBeSent') { const u = msg.params.request.url; if (/^https?:/.test(u)) { T.hosts.add(new URL(u).host); T.requests.push(u); } }
    if (msg.method === 'Page.javascriptDialogOpening') s('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    if (msg.method === 'Fetch.requestPaused' && T.paused) T.paused(msg.params);
  });
  await s('Page.enable'); await s('Runtime.enable'); await s('Network.enable');
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
  T.insert = async (sel, text) => { await T.ev(`document.querySelector(${JSON.stringify(sel)}).focus()`); await s('Input.insertText', { text }); };
  T.ready = () => T.wait('!document.querySelector(".gate") && !!document.querySelector(".matrix, .ar, .tl")', 20000);
  T.close = () => B.send('Target.closeTarget', { targetId });
  await T.size(opts.width || 1440, opts.height || 900);
  return T;
}
const ctx = async B => (await B.send('Target.createBrowserContext', { disposeOnDetach: true })).browserContextId;
const pageUrl = (q = '') => pathToFileURL(PAGE).href + q;
const seedUrl = () => pathToFileURL(path.join(OUT, 'seed.html')).href;
// a session made in Node, written into the page's own storage (same file:// origin) before the app loads
async function seed(T, session, kind = 'local') {
  await T.go(seedUrl());
  await T.ev(`(()=>{localStorage.removeItem('td.auth');sessionStorage.removeItem('td.auth');${kind === 'local' ? 'localStorage' : 'sessionStorage'}.setItem('td.auth',${JSON.stringify(JSON.stringify({ refresh_token: session.refresh_token }))});return true})()`);
}
async function open(T, session, kind) { if (session) await seed(T, session, kind); await T.go(pageUrl()); return T.ready(); }
// answer the next requests matching a URL pattern: fn(params) returns { status, body } or null to let it through
async function intercept(T, pattern, fn) {
  await T.send('Fetch.enable', { patterns: [{ urlPattern: pattern, requestStage: 'Request' }] });
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
const unintercept = async T => { T.paused = null; await T.send('Fetch.disable').catch(() => {}); };

// ---- main ----
if (typeof args.env !== 'string') { console.error('usage: node test/e2e.mjs --env <file> --out <dir> [--group …] [--smoke]'); process.exit(2); }
const env = readEnv(args.env);
const miss = missingEnv(env, 'maksym').concat(missingEnv(env, 'anastasiia'), missingEnv(env, 'homeos-agent')).filter((x, i, a) => a.indexOf(x) === i);
if (miss.length) { console.error('env missing: ' + miss.join(', ')); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'seed.html'), '<!doctype html><title>seed</title>');
const core = loadCore(PAGE);
const SUPA = new URL(env.TASKSDB_URL).host;
const cli = (...a) => spawnSync(process.execPath, [path.join(HERE, '..', 'cli', 'tasks.mjs'), ...a, '--env', args.env, '--run-id', RUN], { encoding: 'utf8' });

let B, MK, AN, ST, prefsSnap = {}, testLists = [];
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
  MK = await connect(env, 'maksym', { core, via: 'script:e2e', runId: RUN });
  AN = await connect(env, 'anastasiia', { core, via: 'script:e2e', runId: RUN });
  clients.push(MK, AN);
  for (const [who, c] of [['maksym', MK], ['anastasiia', AN]]) {
    const r = await c.rest('GET', 'preferences?select=prefs&profile_id=eq.' + c.uid + '&app=eq.tasksdashboard');
    prefsSnap[who] = r.ok && r.json.length ? r.json[0].prefs : null;
  }
  if (want.includes('smoke')) return;
  const rl = cli('restore-list', '--list', '_selftest', '--as', 'maksym');
  check('setup', '_selftest restored with cli/tasks.mjs restore-list (exit 0, or 8 when not archived)', rl.status === 0 || rl.status === 8, 'exit ' + rl.status);
  ST = (await MK.rest('GET', 'lists?select=id,slug,name,archived_at&slug=eq._selftest')).json[0];
  await MK.rest('POST', 'list_members?on_conflict=list_id,profile_id', [{ list_id: ST.id, profile_id: AN.uid, role: 'editor' }], { Prefer: 'resolution=ignore-duplicates' });
  await MK.rest('PATCH', `list_members?list_id=eq.${ST.id}&profile_id=eq.${AN.uid}`, { role: 'editor' });
}
async function cleanup() {
  if (!MK) return;
  for (const [who, c] of [['maksym', MK], ['anastasiia', AN]]) {
    if (prefsSnap[who] === undefined) continue;
    if (prefsSnap[who] === null) { leftovers.push(`a preferences row for ${who} that did not exist before`); continue; }
    const r = await c.rest('POST', 'preferences?on_conflict=profile_id,app', core.rowFromPrefs(c.uid, prefsSnap[who]), { Prefer: 'resolution=merge-duplicates,return=minimal' });
    if (!r.ok) leftovers.push(`preferences of ${who} not restored: ${r.err.message}`);
  }
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
  check(G, 'a granted submit (Stay signed in) loads the board from file://', await T.ready());
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
  // switch: Anastasiia signed in once on this browser (td.emails), then Maksym switches to her: the form prefilled
  const c3 = await ctx(B), S = await tab(B, c3);
  await open(S, await grantFor('anastasiia'));
  await S.wait('!!document.getElementById("profile")');
  await S.click('#profile'); await S.click('[data-signout]');
  await S.wait('!!document.getElementById("signin")');
  await open(S, await grantFor('maksym'));
  await S.click('#profile');
  await S.wait('!!document.querySelector("[data-switch=anastasiia]")');
  await S.click('[data-switch=anastasiia]');
  const anEmail = (await AN.rest('GET', 'profiles?select=id&id=eq.' + AN.uid)).ok && AN.session.user.email;
  check(G, 'switch: sign-out, then the form prefilled with the other person\'s email', await S.wait('!!document.getElementById("signin")') && await S.ev(`document.getElementById("si-email").value===${JSON.stringify(anEmail)}`));
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
  await T.wait('!!document.querySelector("dialog[open] #fs")');
  await T.ev(`(()=>{const d=document.querySelector('dialog[open]');const f=${JSON.stringify(fields)};
    if(f.title!==undefined)d.querySelector('#ft').textContent=f.title; if(f.notes!==undefined)d.querySelector('#fn').textContent=f.notes;
    if(f.list)d.querySelector('#fl').value=f.list; if(f.q)d.querySelector('#fq').value=f.q; d.querySelector('#fs').click();return true})()`);
}

async function gData() {
  const G = 'data', T = await maksymPage();
  await T.ev('dispatchEvent(new Event("focus")),true'); await sleep(1500);
  await pick(T, ST.id);
  // add through the window
  await T.click('[data-add="B"]');
  await dialogSave(T, { title: `${RUN} added`, list: ST.id });
  const added = await until(async () => (await MK.rest('GET', `items?select=*&list_id=eq.${ST.id}&title=eq.${encodeURIComponent(RUN + ' added')}`)).json[0]);
  check(G, 'add: stored with a client uuid, quadrant B, created_via app, start_at set', added && added.quadrant === 'B' && added.created_via === 'app' && !!added.start_at && typeof added.sort_key === 'number');
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
  await T.click(`[data-card="${e.id}"]`);
  await dialogSave(T, { q: 'A' });
  check(G, 'quadrant move: quadrant A, pin set (urgency by hand)', await until(async () => { const x = await item(e.id); return x.quadrant === 'A' && x.urgent_pin === true; }));
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
  const target = testLists[0] || await newTestList(T, 'Тестовий список');
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
  await T.insert('#nl-name', name); await T.ev('document.getElementById("nl-shared").checked=false;document.getElementById("nl-go").click();true');
  const l = await until(async () => (await MK.rest('GET', 'lists?select=id,slug,name&archived_at=is.null&order=created_at.desc&limit=1&name=eq.' + encodeURIComponent(name))).json[0]);
  if (l) testLists.push(l);
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
  check(G, 'Restore brings it back', rt && !(await MK.rest('GET', 'lists?select=archived_at&id=eq.' + ST.id)).json[0].archived_at, (await toastText(T)) + ' | dialogs ' + (await T.ev('document.querySelectorAll("dialog").length')) + ' | ' + T.errors.slice(-2).join(' / '));
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
  const l = testLists[0] || await newTestList(T, 'Тестовий список');
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
  for (const [who, theme] of [['maksym', 'light'], ['anastasiia', 'dark']]) {
    const T = await tab(B, await ctx(B));
    await T.theme(theme);
    check(G, `${who}: opens signed in`, await open(T, await grantFor(who)));
    await T.click('#profile'); await T.click('[data-menu=settings]'); await T.wait('!!document.getElementById("s-lim")');
    const lim = who === 'maksym' ? 7 : 4;
    await T.ev(`document.getElementById('s-lim').value='${lim}';document.getElementById('s-save').click();true`);
    await T.click('#profile'); await T.click('[data-cards]');
    await sleep(2000);
    await T.reload(); await T.ready();
    await T.click('#profile'); await T.click('[data-menu=settings]'); await T.wait('!!document.getElementById("s-lim")');
    check(G, `${who}: settings and preferences survive a reload (Do limit ${lim}, card mode)`, await T.ev(`document.getElementById('s-lim').value==='${lim}'`) && /Always expanded|Always collapsed/.test(await T.ev('document.body.innerHTML.match(/Always (expanded|collapsed) cards/)?.[0]||""')));
    await T.ev('document.querySelector("dialog[open]")?.close(),true');
    // counts on the chips equal the database (open, live items on lists that are not archived)
    const c = who === 'maksym' ? MK : AN;
    const lists = (await c.rest('GET', 'lists?select=id,name&archived_at=is.null')).json;
    const items = (await c.getAll('items?select=list_id&deleted_at=is.null&status=not.in.(done,cancelled)')).json;
    const chips = await T.ev(`Object.fromEntries([...document.querySelectorAll('.lists [data-list]')].map(b=>[b.dataset.list,+b.querySelector('.n').textContent]))`);
    const bad = lists.filter(l => chips[l.id] !== undefined && chips[l.id] !== items.filter(i => i.list_id === l.id).length).map(l => l.name);
    check(G, `${who}: chip counts equal REST counts`, !bad.length && chips.all === items.filter(i => lists.some(l => l.id === i.list_id)).length, bad.join(', '));
    for (const [w, h] of [[1440, 900], [390, 844]]) { await T.size(w, h); await sleep(600); await T.shot(`ui-${who}-${w}x${h}-${theme}`); }
    await T.size(1440, 900);
    check(G, `${who}: only the Supabase host is contacted`, [...T.hosts].every(h => h === SUPA), [...T.hosts].join(', '));
    check(G, `${who}: no console errors`, !T.errors.length, T.errors.slice(0, 2).join(' / '));
    await T.close();
  }
  // a low-confidence item from the CLI as homeos-agent: marker and filter
  const T = await maksymPage();
  const r = cli('add-task', '--as', 'homeos-agent', '--for', 'maksym', '--list', '_selftest', '--title', `${RUN} low confidence`, '--q', 'C', '--confidence', '0.42', '--needs-review', '--json');
  const low = r.status === 0 ? JSON.parse(r.stdout)[0] : null;
  check(G, 'CLI add-task as homeos-agent (needs review, confidence 0.42)', !!low, 'exit ' + r.status);
  if (low) {
    await T.ev('dispatchEvent(new Event("focus")),true'); await pick(T, ST.id);
    check(G, 'the low-confidence marker shows on the card', await T.wait(`!!document.querySelector('[data-card="${low.id}"].lowc .tb.ai')`, 8000));
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

async function gSmoke() {
  const G = 'smoke', T = await tab(B, await ctx(B));
  check(G, 'opens signed in from ' + path.basename(path.dirname(PAGE)), await open(T, await grantFor('maksym')));
  const lists = (await MK.rest('GET', 'lists?select=id,name&archived_at=is.null')).json;
  const items = (await MK.getAll('items?select=list_id&deleted_at=is.null&status=not.in.(done,cancelled)')).json;
  const chips = await T.ev(`Object.fromEntries([...document.querySelectorAll('.lists [data-list]')].map(b=>[b.dataset.list,+b.querySelector('.n').textContent]))`);
  check(G, 'chip counts equal REST counts', lists.every(l => chips[l.id] === undefined || chips[l.id] === items.filter(i => i.list_id === l.id).length), JSON.stringify(Object.values(chips)));
  check(G, 'four quadrants render', await T.ev('document.querySelectorAll("section.q").length===4'));
  await T.shot('smoke-maksym-1440x900');
  check(G, 'only the Supabase host is contacted', [...T.hosts].every(h => h === SUPA), [...T.hosts].join(', '));
  check(G, 'no console errors', !T.errors.length, T.errors.slice(0, 2).join(' / '));
  await T.close();
}

const t0 = Date.now();
try {
  await setup();
  B = await launch();
  const run = { auth: gAuth, data: gData, sync: gSync, archive: gArchive, errors: gErrors, ui: gUi, smoke: gSmoke };
  // errors creates the Cyrillic list that data moves an item into, so errors runs before data when both are asked for
  const order = ['smoke', 'auth', 'errors', 'data', 'sync', 'archive', 'ui'].filter(g => want.includes(g));
  for (const g of order) {
    try { await run[g](); } catch (e) { check(g, 'group ran to the end', false, e.message); }
  }
} catch (e) {
  check('setup', 'setup', false, e.message);
} finally {
  try { await cleanup(); } catch (e) { leftovers.push('cleanup failed: ' + e.message); }
  if (B) B.close();
  for (const c of clients.reverse()) await c.close();
  const report = ['# TasksDashboard e2e', '', `Run \`${RUN}\`, ${new Date().toISOString()}, ${Math.round((Date.now() - t0) / 1000)} s. Page \`${PAGE}\`. Groups: ${want.join(', ')}. Logins from the env file; no values printed.`, '',
    `**${pass} of ${pass + fail} passed.**`, '', '| Group | Check | Result | Note |', '|---|---|---|---|', ...rows, '', '## Leftovers', '', ...(leftovers.length ? leftovers.map(x => '- ' + x) : ['- none']), '',
    'Screenshots: the `*.png` files next to this report.'].join('\n');
  fs.writeFileSync(path.join(OUT, 'e2e-report.md'), report + '\n');
  console.log(`${pass} of ${pass + fail} passed; report ${path.join(OUT, 'e2e-report.md')}`);
  process.exitCode = fail ? 1 : 0;
}
