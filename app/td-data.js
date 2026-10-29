// The phone app's data layer (app/): sign-in, REST, load, poll, the versioned write queue with its durable copy in IndexedDB,
// links, tags, lists, sharing, preferences and the access gate. A twin of the data code in TasksDashboard.html's main script:
// each part names the web function it was ported from ("web: name"). No DOM, no system clock (opts.now), no network but
// opts.fetch to config.supabaseUrl. The rules come from TDCore (app/td-core.js, generated from the page's core block).
// Browser: a classic script after td-core.js, window.TDData.create(opts). Node tests: require('../app/td-data.js').create(opts)
// with fakes for fetch, storage, idb, locks, broadcast and timers.
(function (root, factory) { const m = factory(); if (typeof module === 'object' && module.exports) module.exports = m; else root.TDData = m; })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- storage keys (shared with the web page on the same origin unless noted) ----
  const AUTH_KEY = 'td.auth';          // { refresh_token, uid }, localStorage (Stay signed in) or sessionStorage (web: AUTH_KEY)
  const PKCE_KEY = 'td.app.pkce';      // app only, localStorage: { verifier, stay, at } of a Google sign-in in flight
  const PKCE_TTL_MS = 10 * 60 * 1000;  // an installed iOS app may come back in a new page: the verifier lives 10 minutes, used once
  const LOCK_REFRESH = 'td.refresh', LOCK_QUEUE = 'td.queue', CHANNEL = 'td.auth';
  const IDB_NAME = 'td-app', IDB_STORE = 'queue';
  // the app's localStorage keys that belong to the signed-in person (list ids, a Google sign-in in flight): gone on sign-out
  const USER_KEYS = ['td.app.list', 'td.app.lastList', PKCE_KEY];
  const PREFS_DELAY_MS = 1000;         // web: PREFS_DELAY_MS
  const LINK_RETRY_MS = 3000;          // web: runLinks retry pause
  const VIA = { 'x-homeos-via': 'app' };
  // the fields a queued write may carry (web: FIELDS); qStored is the stored quadrant, written as "q"
  const FIELDS = ['title', 'notes', 'tags', 'qStored', 'pin', 'deadline', 'start', 'status', 'sortKey', 'list', 'deleted'];
  const NOTICES_PATH = 'shared_notices?select=*&seen_at=is.null&order=created_at';
  const LINK_COLS = 'item_links?select=from_item,to_item,kind,removed_at,changed_at&kind=in.(depends_on,parent)';
  const LINK_LIVE = 'item_links?select=from_item,to_item,kind,removed_at,changed_at,f:items!item_links_from_item_fkey!inner(id),t:items!item_links_to_item_fkey!inner(id)' +
    '&kind=in.(depends_on,parent)&removed_at=is.null&f.deleted_at=is.null&t.deleted_at=is.null';
  const QN = { A: 'Do', B: 'Plan', C: 'Delegate', D: 'Eliminate' };
  const CLASH_NAMES = { title: 'title', notes: 'description', tags: 'tags', qStored: 'quadrant', pin: 'urgency', deadline: 'end', status: 'status', sortKey: 'order', list: 'list', deleted: 'deleted', start: 'start' };

  const dbField = f => f === 'qStored' ? 'q' : f;
  const val = (t, f) => f === 'tags' ? (t.tags || []).slice() : t[f];
  const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  const plain = s => String(s || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(?!\s)(.+?)\*/g, '$1').replace(/^\s*(?:[-*]|\d+[.)])\s+/gm, '');
  const rowOf = d => (Array.isArray(d) ? d[0] : d) || null;

  // ---- durable queue: pure parts (tested in test/app-data.test.js) ----
  // values are stored as JSON: a Date as { d: ms }, undefined as { u: 1 } (pin undefined = "no hand-set urgency")
  const enc = v => v instanceof Date ? { d: v.getTime() } : v === undefined ? { u: 1 } : Array.isArray(v) ? v.slice() : v;
  const dec = v => v && typeof v === 'object' && !Array.isArray(v) ? ('d' in v ? new Date(v.d) : 'u' in v ? undefined : v) : Array.isArray(v) ? v.slice() : v;
  const TASK_KEYS = ['id', 'list', 'num', 'qStored', 'q', 'title', 'notes', 'tags', 'ownerId', 'deadline', 'start', 'status', 'doneAt', 'pin', 'sortKey', 'category', 'reviewState', 'aiConfidence', 'createdBy', 'version', 'deleted', 'updatedAt', 'createdAt'];
  function encTask(t) { const o = {}; TASK_KEYS.forEach(k => { o[k] = enc(t[k]); }); return o; }
  function decTask(o) { const t = {}; TASK_KEYS.forEach(k => { t[k] = dec(o[k]); }); t.tags = Array.isArray(t.tags) ? t.tags : []; return t; }
  // one queue entry -> its IndexedDB record. e.sending holds fields of a write in flight: they stay in the record until it lands.
  function queueRecord(uid, t, e) {
    const fields = new Set(e.fields || []), base = Object.assign({}, e.sending ? e.sending.base : {}, e.base || {});
    if (e.sending) e.sending.fields.forEach(f => fields.add(f));
    const values = {}, b = {};
    fields.forEach(f => { values[f] = enc(val(t, f)); if (f in base) b[f] = enc(base[f]); });
    return { key: uid + ':' + t.id, uid, id: t.id, create: !!e.create, fields: [...fields], base: b, values, version: t.version || 1, origin: e.origin || null,
      task: e.create ? encTask(t) : null };
  }
  // a record back onto the loaded task (or a new one for a create). The persisted version is kept, so a versioned PATCH misses when
  // someone else saved meanwhile and conflict() merges field by field. existing: the task loadAll read, or null
  function queueRestore(rec, existing) {
    if (!rec || typeof rec.id !== 'string' || !Array.isArray(rec.fields)) return null;
    const fields = rec.fields.filter(f => FIELDS.includes(f));
    let t = existing, create = false;
    if (rec.create && rec.task && !existing) { t = decTask(rec.task); create = true; }
    else if (rec.create && existing) {
      // the insert landed before the app was closed (its answer was lost): only the fields queued after it still go out
      if (!fields.length) return null;
      fields.forEach(f => { t[f] = dec(rec.values[f]); });
    } else {
      if (!existing) return null; // the item is gone (deleted, or a list I lost): nothing to send
      fields.forEach(f => { t[f] = dec(rec.values[f]); });
      if (typeof rec.version === 'number') t.version = rec.version;
    }
    if (fields.includes('qStored') && t.qStored) t.q = t.qStored;
    const base = {}; Object.keys(rec.base || {}).forEach(f => { if (fields.includes(f)) base[f] = dec(rec.base[f]); });
    return { task: t, entry: { fields: new Set(fields), base, create: create || null, inflight: false, origin: rec.origin || null }, isNew: create };
  }

  // IndexedDB adapter: { all(uid), put(rec), del(key), clear(uid) }, all Promises. Missing or throwing IndexedDB -> null (fail open)
  function idbQueueStore(idb) {
    if (!idb || typeof idb.open !== 'function') return null;
    let dbp = null;
    const db = () => dbp || (dbp = new Promise((res, rej) => {
      let r;
      try { r = idb.open(IDB_NAME, 1); } catch (e) { rej(e); return; }
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains(IDB_STORE)) d.createObjectStore(IDB_STORE, { keyPath: 'key' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const tx = (mode, fn) => db().then(d => new Promise((res, rej) => {
      const t = d.transaction(IDB_STORE, mode), s = t.objectStore(IDB_STORE);
      let out; const req = fn(s);
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    }));
    return {
      all: uid => tx('readonly', s => s.getAll()).then(rows => (rows || []).filter(r => r.uid === uid)),
      put: rec => tx('readwrite', s => s.put(rec)),
      del: key => tx('readwrite', s => s.delete(key)),
      clear: uid => tx('readwrite', s => { const q = s.openCursor(); q.onsuccess = () => { const c = q.result; if (!c) return; if (!uid || c.value.uid === uid) c.delete(); c.continue(); }; return null; }),
    };
  }

  // ---- the access gate (pure): what the phone app shows after sign-in ----
  // board: a household member, an approved request, or a member of a list someone else shares with me. Otherwise the request flow.
  function gateFrom(o) {
    if (o.household) return 'board';
    if (o.shared) return 'board';
    const row = o.request;
    if (row && row.status === 'approved') return 'board';
    if (o.failed) return 'error';
    if (!row || row.status === 'removed') return 'none';
    return row.status === 'declined' ? 'declined' : 'pending';
  }

  // ---- sync pill (pure): saved, saving, offline(n), conflict, ended ----
  function syncStateOf(s) {
    if (s.ended) return { state: 'ended', n: s.pending, text: 'Session ended' + (s.pending ? ': ' + s.pending + ' waiting' : '') };
    if (s.offline) return { state: 'offline', n: s.pending, text: 'Offline' + (s.pending ? ': ' + s.pending + ' waiting' : '') };
    if (s.conflict) return { state: 'conflict', n: s.pending, text: 'Changed by someone else' };
    if (s.pending) return { state: 'saving', n: s.pending, text: 'Saving' };
    return { state: 'saved', n: 0, text: 'Saved' };
  }

  function create(opts) {
    const o = opts || {};
    const C = o.core || (typeof TDCore !== 'undefined' ? TDCore : null); // eslint-disable-line no-undef
    if (!C) throw new Error('TDData needs TDCore (load app/td-core.js first)');
    const cfgRead = C.readAppConfig(o.config);
    const CFG = cfgRead.config;
    const fetchFn = o.fetch || (typeof fetch === 'function' ? fetch.bind(null) : null);
    const now = o.now || (() => Date.now());
    const nowDate = () => new Date(now());
    const T = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: id => clearTimeout(id), setInterval: (f, ms) => setInterval(f, ms), clearInterval: id => clearInterval(id) };
    const sleep = ms => new Promise(r => T.setTimeout(r, ms));
    const wrap = s => ({ get: k => { try { return s ? s.getItem(k) : null; } catch (e) { return null; } }, set: (k, v) => { try { if (s) s.setItem(k, v); } catch (e) {} }, del: k => { try { if (s) s.removeItem(k); } catch (e) {} } });
    const st = o.storage || {};
    const ls = wrap(st.local !== undefined ? st.local : safe(() => localStorage)), ss = wrap(st.session !== undefined ? st.session : safe(() => sessionStorage));
    const locks = o.locks !== undefined ? o.locks : safe(() => navigator.locks);
    const withLock = (name, fn) => locks && typeof locks.request === 'function' ? locks.request(name, fn) : fn();
    const bc = typeof o.broadcast === 'function' ? o.broadcast(CHANNEL) : o.broadcast === undefined && typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null; // eslint-disable-line no-undef
    let qstore = o.idb !== undefined ? (o.idb && typeof o.idb.open === 'function' ? idbQueueStore(o.idb) : o.idb) : idbQueueStore(safe(() => indexedDB)); // eslint-disable-line no-undef
    const loc = o.location || safe(() => location) || { origin: '', href: '', pathname: '/app/' };
    const navigate = o.navigate || (url => loc.assign(url));
    const replaceUrl = o.replaceUrl || (url => { try { history.replaceState(null, '', url); } catch (e) {} }); // eslint-disable-line no-undef
    const appUrl = o.appUrl || (loc.origin + '/app/');
    const cryptoObj = o.crypto || safe(() => crypto); // eslint-disable-line no-undef
    const uuid = o.uuid || (() => cryptoObj.randomUUID());
    let visible = o.visible || (() => true);

    // ---- events: change, sync, session, conflict, toast ----
    const handlers = {};
    const on = (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); return () => { handlers[name] = handlers[name].filter(f => f !== fn); }; };
    const emit = (name, payload) => (handlers[name] || []).slice().forEach(fn => { try { fn(payload); } catch (e) {} });
    const toast = (msg, more) => emit('toast', Object.assign({ msg, kind: 'info' }, more || {}));
    const changed = reason => emit('change', { reason });
    let lastSync = '';
    const syncChanged = () => { const s = syncState(); const k = s.state + s.n; if (k !== lastSync) { lastSync = k; emit('sync', s); } };

    // ---- state (web: the main IIFE's globals) ----
    let session = null, storeKind = null, me = null, sessionProvider = null, ended = false;
    let LISTS = [], LIST = {}, ROLE = {}, CATS = {}, HIDDEN_LISTS = [], NAMES = {}, TAG_LISTS = {}, TAG = {}, LABEL = {}, TAG_NAME = {}, INVITES = [], NOTICES = [];
    let tasks = [], maxSeen = 0, maxTagSeen = 0, maxTagDefSeen = 0, TAGS_UPDATED = false;
    let LINKS = new Map(), LINKS_READY = false, maxLinkSeen = 0;
    let prefs = C.prefsFromRow(null), settings = C.readSettings(null), cardLayout = C.readCardLayout(null), prefsExists = false, lastWritten = null, prefsTimer = 0;
    const NOTICE_TRIED = new Set();
    const Q = new Map(); const LQ = []; let lqBusy = false;
    let offline = false, conflictFlag = false, durable = !!qstore, pollTimer = 0, polling = false, loaded = false;

    const noticeKnown = n => n.list_id ? !!LIST[n.list_id] || HIDDEN_LISTS.some(l => l.id === n.list_id) : !!TAG_LISTS[n.tag_list_id];
    const find = id => tasks.find(t => t.id === id);
    const derive = t => { t.q = C.deriveQuadrant(t, settings, now()); return t; };
    // live items of lists I read, each with its display quadrant (web: all() + the t.q of render())
    const all = () => tasks.filter(t => !t.deleted && LIST[t.list]).map(derive);
    const canDo = (action, t, list) => C.can(ROLE[t ? t.list : list], action, t, me && me.id);
    const myDefault = () => Object.values(TAG_LISTS).find(l => l.owner_id === (me && me.id) && l.is_default) || null;
    const label = l => LIST[l] ? LIST[l].name : '?';

    function syncState() { return syncStateOf({ ended, offline, conflict: conflictFlag, pending: Q.size + LQ.length }); }

    // ---- session (web: readRefresh, saveRefresh, clearAuth, bc.onmessage, authCall, refreshSession, rest, getAll) ----
    function readRefresh(uid) {
      const order = storeKind === 'local' ? [['local', ls], ['session', ss]] : [['session', ss], ['local', ls]];
      for (const [kind, s] of order) {
        try {
          const v = JSON.parse(s.get(AUTH_KEY) || 'null');
          if (v && typeof v.refresh_token === 'string' && (!uid || !v.uid || v.uid === uid)) return { kind, token: v.refresh_token, uid: v.uid || null };
        } catch (e) {}
      }
      return null;
    }
    const saveRefresh = (token, uid) => (storeKind === 'local' ? ls : ss).set(AUTH_KEY, JSON.stringify({ refresh_token: token, uid: uid || (session && session.user.id) || null }));
    const clearAuth = () => { ls.del(AUTH_KEY); ss.del(AUTH_KEY); };
    if (bc) bc.onmessage = e => {
      const m = (e && e.data) || {};
      if (m.type === 'session' && session && m.session && m.session.user && m.session.user.id === session.user.id) { session = m.session; if (storeKind) saveRefresh(session.refresh_token, session.user.id); }
      else if (m.type === 'signout' && session && m.uid === session.user.id) { session = null; storeKind = null; stopPolling(); emit('session', { state: 'signin', msg: 'Signed out in another tab.' }); }
    };
    async function authCall(path, body, token) {
      let r;
      try { r = await fetchFn(CFG.supabaseUrl + '/auth/v1/' + path, { method: 'POST', headers: C.headers(CFG.publishableKey, token ? { access_token: token } : null), body: body ? JSON.stringify(body) : undefined }); }
      catch (e) { return { status: 0, json: null }; }
      let json = null; try { json = await r.json(); } catch (e) {}
      return { status: r.status, json };
    }
    function refreshSession(force, failedToken) {
      return withLock(LOCK_REFRESH, async () => {
        if (!force && session && !C.needsRefresh(session, now())) return { ok: true };
        if (force && failedToken && session && session.access_token !== failedToken && !C.needsRefresh(session, now())) return { ok: true };
        const stored = readRefresh(session && session.user.id);
        const token = stored && (!session || stored.token !== session.refresh_token || force) ? stored.token : session && session.refresh_token;
        if (!token) return { ok: false, err: C.restError(400, { error_code: 'session_not_found' }) };
        const r = await authCall('token?grant_type=refresh_token', { refresh_token: token });
        const s = r.status === 200 && C.sessionFromGrant(r.json, now());
        if (!s) return { ok: false, err: C.restError(r.status, r.json) };
        session = s;
        if (stored) storeKind = stored.kind;
        if (storeKind) saveRefresh(s.refresh_token, s.user.id);
        if (bc) bc.postMessage({ type: 'session', session: s });
        return { ok: true };
      });
    }
    // every REST call: one refresh and one retry on a 401, then "Session ended" with the queue kept (web: rest)
    async function rest(method, path, body, extra) {
      if (!session) return { ok: false, status: 401, json: null, err: C.restError(401, null) };
      const go = async () => {
        let r;
        try { r = await fetchFn(CFG.supabaseUrl + '/rest/v1/' + path, { method, headers: C.headers(CFG.publishableKey, session, Object.assign({}, VIA, extra || {})), body: body === undefined ? undefined : JSON.stringify(body) }); }
        catch (e) { return { status: 0, json: null }; }
        const text = await r.text(); let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = text; }
        return { status: r.status, json };
      };
      if (C.needsRefresh(session, now())) await refreshSession(false);
      if (!session) return { ok: false, status: 401, json: null, err: C.restError(401, null) };
      const used = session.access_token;
      let res = await go();
      const authFail = x => x.status === 401 || (x.json && (x.json.code === 'PGRST301' || x.json.code === 'PGRST303'));
      if (authFail(res)) {
        const rf = await refreshSession(true, used);
        if (!rf.ok) {
          if (rf.err.kind === 'network' || rf.err.kind === 'server') return { ok: false, status: 0, json: null, err: rf.err };
          sessionEnded();
          return { ok: false, status: 401, json: null, err: C.restError(401, null) };
        }
        res = await go();
      }
      res.ok = res.status >= 200 && res.status < 300;
      if (!res.ok) res.err = C.restError(res.status, res.json);
      return res;
    }
    const rpc = (name, body) => rest('POST', 'rpc/' + name, body || {});
    async function getAll(path, order) {
      const out = [];
      for (let off = 0; ; off += C.PAGE) {
        const r = await rest('GET', path + (path.includes('?') ? '&' : '?') + C.pageParams(off, order));
        if (!r.ok) return r;
        out.push(...r.json);
        if (r.json.length < C.PAGE) return { ok: true, json: out };
      }
    }
    const noteMax = rows => rows.forEach(r => { const u = Date.parse(r.updated_at); if (u > maxSeen) maxSeen = u; });

    // web: sessionEnded. The queue stays (memory and IndexedDB) and is sent after the next sign-in of the same person
    function sessionEnded() {
      if (!session) return;
      session = null; ended = true; stopPolling();
      emit('session', { state: 'ended', msg: 'Session ended. Sign in again.' + (Q.size ? ' ' + Q.size + (Q.size === 1 ? ' change waits' : ' changes wait') + ' and are sent after you sign in.' : '') });
      syncChanged();
    }
    // web: adopt. Another person's queue and items never carry over
    function adopt(s, stay, provider) {
      if (me && me.id !== s.user.id) { Q.clear(); LQ.length = 0; tasks = []; me = null; }
      session = s; ended = false; clearAuth(); storeKind = stay ? 'local' : 'session'; saveRefresh(s.refresh_token, s.user.id); sessionProvider = provider;
    }
    // web: signIn
    async function signIn(email, password, stay) {
      if (!CFG) return { kind: 'config', message: cfgRead.errors.join('; ') };
      const r = await authCall('token?grant_type=password', { email, password });
      const s = r.status === 200 && C.sessionFromGrant(r.json, now());
      if (!s) return C.restError(r.status, r.json);
      adopt(s, stay !== false, 'email');
      emit('session', { state: 'signedin' });
      return null;
    }
    // web: startGoogle. The verifier goes to localStorage with its time (not sessionStorage): an installed iOS app may come back
    // from Google in a new page. Back to the app's own /app/ address
    async function startGoogle(o2) {
      const p = o2 || {};
      const verifier = C.pkceVerifier(cryptoObj.getRandomValues(new Uint8Array(48)));
      const challenge = await C.pkceChallenge(verifier, cryptoObj.subtle);
      ls.set(PKCE_KEY, JSON.stringify({ verifier, stay: p.stay !== false, at: now() }));
      const url = C.authorizeUrl(CFG.supabaseUrl, { redirectTo: appUrl, challenge, selectAccount: !!p.pick, loginHint: p.loginHint || undefined });
      navigate(url);
      return url;
    }
    // the stored verifier, once: deleted on read, refused after PKCE_TTL_MS
    function takeVerifier() {
      let saved = null; try { saved = JSON.parse(ls.get(PKCE_KEY) || 'null'); } catch (e) {}
      ls.del(PKCE_KEY);
      if (!saved || typeof saved.verifier !== 'string' || typeof saved.at !== 'number' || now() - saved.at > PKCE_TTL_MS || now() < saved.at - 60000) return null;
      return saved;
    }
    // web: finishGoogle. Returns null when signed in, else { state, msg }
    async function finishGoogle(cb) {
      replaceUrl(cb.cleanUrl);
      const saved = takeVerifier();
      if (!cb.code) return { state: 'signin', msg: C.oauthMessage(cb) };
      if (!saved) return { state: 'signin', msg: 'The Google sign-in expired. Try again.' };
      const r = await authCall('token?grant_type=pkce', C.pkceBody(cb.code, saved.verifier));
      const s = r.status === 200 && C.sessionFromGrant(r.json, now());
      if (!s) {
        const err = C.restError(r.status, r.json);
        if (err.kind === 'network' || err.kind === 'server') return { state: 'unreachable', msg: err.message };
        return { state: 'signin', msg: err.kind === 'rate' ? err.message : C.oauthMessage(r.json) };
      }
      adopt(s, saved.stay !== false, 'google');
      return null;
    }
    // web: start. The first call of the app: config, the Google callback, a stored session. Resolves { state: signedin | signin |
    // unreachable | config, msg }; it does not load the board (the UI asks gate() first, then loadAll())
    async function start() {
      if (!CFG) return report({ state: 'config', msg: cfgRead.errors.join('; ') });
      const cb = C.isHostedOrigin(loc.origin) ? C.readCallback(loc.href) : null;
      if (cb) { const f = await finishGoogle(cb); return report(f || { state: 'signedin' }); }
      const stored = readRefresh(null);
      if (!stored) return report({ state: 'signin', msg: '' });
      storeKind = stored.kind;
      const r = await refreshSession(true);
      if (!r.ok) {
        if (r.err.kind === 'network' || r.err.kind === 'server') return report({ state: 'unreachable', msg: r.err.message });
        clearAuth();
        return report({ state: 'signin', msg: r.err.kind === 'rate' ? r.err.message : 'Session ended. Sign in again.' });
      }
      return report({ state: 'signedin' });
    }
    const report = x => { emit('session', x); return x; };
    // web: signOut. force drops changes that are not saved yet
    async function signOut(force) {
      if (Q.size || LQ.length) {
        await flushAll();
        if ((Q.size || LQ.length) && !force) return { ok: false, pending: Q.size + LQ.length, msg: (Q.size + LQ.length) + ' changes are not saved yet.' };
      }
      await writePrefs();
      if (session && C.needsRefresh(session, now())) await refreshSession(false);
      const token = session && session.access_token, uid = queueUid();
      if (token) await authCall('logout?scope=local', null, token);
      clearAuth(); storeKind = null; session = null; ended = false;
      if (bc && uid && session) bc.postMessage({ type: 'signout', uid });
      Q.clear(); LQ.length = 0; tasks = []; stopPolling(); NOTICES = []; loaded = false;
      if (qstore && uid) { try { await qstore.clear(uid); } catch (e) { durable = false; } }
      USER_KEYS.forEach(k => ls.del(k));
      me = null;
      emit('session', { state: 'signin', msg: '' }); syncChanged();
      return { ok: true };
    }

    // ---- the access gate: household, an approved request, or a list someone else shares with me; else the request flow ----
    let accessRow = null;
    async function gate() {
      if (!session) return 'none';
      const uid = session.user.id;
      const [prof, mem, req] = await Promise.all([
        rest('GET', 'profiles?select=id,is_household&id=eq.' + uid),
        rest('GET', 'list_members?select=list_id&profile_id=eq.' + uid),
        rpc('my_access_request'),
      ]);
      const household = prof.ok && Array.isArray(prof.json) && prof.json[0] && prof.json[0].is_household === true;
      let shared = false, failed = !prof.ok || !mem.ok;
      if (!household && mem.ok && mem.json.length) {
        const ids = mem.json.map(m => m.list_id).filter(Boolean);
        const ls2 = await rest('GET', 'lists?select=id,owner_id&id=in.(' + ids.join(',') + ')');
        if (ls2.ok) shared = ls2.json.some(l => l.owner_id && l.owner_id !== uid); else failed = true;
      }
      accessRow = req.ok ? rowOf(req.json) : null;
      if (!req.ok) failed = true;
      return gateFrom({ household, shared, request: accessRow, failed });
    }
    const accessRequest = () => accessRow;
    // web twin: request.html check(). { state: pending | declined | board | cap | error, row, message }
    async function requestAccess() {
      const fail = r => {
        const code = String((r.json && r.json.code) || ''), msg = String((r.json && r.json.message) || '');
        if (code === '54000') return { state: 'cap', message: 'Too many requests are waiting right now. Try again tomorrow.' };
        if (code === '22023' && /already have access/i.test(msg)) return { state: 'board' };
        return { state: 'error', message: r.err ? r.err.message : 'The request did not go through.' };
      };
      let r = await rpc('my_access_request');
      if (!r.ok) return fail(r);
      let row = rowOf(r.json);
      if (!row || row.status === 'removed') {
        const q = await rpc('request_access');
        if (!q.ok) return fail(q);
        r = await rpc('my_access_request');
        if (!r.ok) return fail(r);
        row = rowOf(r.json) || (rowOf(q.json) && typeof rowOf(q.json) === 'object' ? rowOf(q.json) : null) || { status: 'pending' };
      }
      accessRow = row;
      const s = String(row.status || 'pending');
      return { state: s === 'approved' ? 'board' : s === 'declined' ? 'declined' : 'pending', row };
    }

    // ---- load (web: loadMeta, relabel, loadItemTags, takeTagDefs, loadLinks, loadAll, refreshMeta) ----
    async function loadMeta() {
      const uid = session.user.id;
      const [lists, members, cats, profs, vis, tls, tlm, tags, inv, ntc] = await Promise.all([
        getAll('lists?select=id,slug,name,default_category,sort,owner_id&archived_at=is.null'),
        rest('GET', 'list_members?select=list_id,role,hidden_at&profile_id=eq.' + uid),
        rest('GET', 'categories?select=slug,name,default_list_id&archived_at=is.null'),
        rest('GET', 'profiles?select=' + C.PROFILE_COLUMNS + ',is_household'),
        rpc('visible_profiles'),
        rest('GET', 'tag_lists?select=id,owner_id,name,is_default,sort,archived_at'),
        rest('GET', 'tag_list_members?select=tag_list_id,role,hidden_at&profile_id=eq.' + uid),
        getAll('tags?select=*&deleted_at=is.null'),
        rpc('my_invitations'),
        rest('GET', NOTICES_PATH),
      ]);
      const bad = [lists, members, cats, profs, vis, tls, tlm, tags, inv, ntc].find(r => !r.ok);
      if (bad) return bad;
      ROLE = {}; const hidden = new Set();
      members.json.forEach(m => { ROLE[m.list_id] = m.role; if (m.hidden_at) hidden.add(m.list_id); });
      const order = LISTS.slice();
      LIST = {}; HIDDEN_LISTS = [];
      lists.json.forEach(l => { if (hidden.has(l.id)) HIDDEN_LISTS.push(l); else LIST[l.id] = l; });
      LISTS = lists.json.filter(l => LIST[l.id]).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)).map(l => l.id);
      if (order.length) LISTS.sort((a, b) => (order.indexOf(a) + 1 || 1e6) - (order.indexOf(b) + 1 || 1e6));
      CATS = {}; cats.json.forEach(c => { CATS[c.slug] = c; });
      me = profs.json.find(p => p.id === uid) || null;
      NAMES = {}; profs.json.concat(vis.json || []).forEach(p => { NAMES[p.id] = p.display_name; });
      const tlRole = {}, tlHidden = new Set();
      tlm.json.forEach(m => { tlRole[m.tag_list_id] = m.role; if (m.hidden_at) tlHidden.add(m.tag_list_id); });
      TAG_LISTS = {}; tls.json.forEach(l => { TAG_LISTS[l.id] = Object.assign({}, l, { role: tlRole[l.id] || null, hidden: tlHidden.has(l.id) }); });
      TAG = {}; tags.json.forEach(x => { if (TAG_LISTS[x.tag_list_id]) TAG[x.id] = { id: x.id, tag_list_id: x.tag_list_id, name: x.name, sort: x.sort }; });
      if (tags.json.length) TAGS_UPDATED = 'updated_at' in tags.json[0];
      noteTagDefMax(tags.json);
      relabel();
      INVITES = inv.json || [];
      NOTICES = (ntc.json || []).filter(noticeKnown);
      return { ok: true, added: LISTS.filter(id => !order.includes(id)) };
    }
    function relabel() {
      const shown = Object.values(TAG).filter(x => !TAG_LISTS[x.tag_list_id].hidden && !TAG_LISTS[x.tag_list_id].archived_at);
      LABEL = C.tagLabels(shown, TAG_LISTS, NAMES, me && me.id);
      TAG_NAME = {}; shown.forEach(x => { TAG_NAME[x.id] = x.name; });
    }
    const pendingTags = () => new Set([...Q.keys()].filter(id => Q.get(id).fields.has('tags') || Q.get(id).create));
    async function loadItemTags() {
      const r = await getAll('item_tags?select=item_id,tag_id,changed_at&removed_at=is.null', 'item_id,tag_id');
      if (!r.ok) return r;
      noteTagMax(r.json);
      C.mergeTagRows(tasks, r.json, { pending: pendingTags() });
      return r;
    }
    const noteTagMax = rows => rows.forEach(r => { const u = Date.parse(r.changed_at); if (u > maxTagSeen) maxTagSeen = u; });
    const noteTagDefMax = rows => rows.forEach(r => { const u = Date.parse(r.updated_at); if (u > maxTagDefSeen) maxTagDefSeen = u; });
    async function takeTagDefs(rows) {
      noteTagDefMax(rows);
      const m = C.mergeTagDefs(TAG, rows, Object.keys(TAG_LISTS));
      TAG = m.tags;
      if (m.unknownLists.length) { await refreshMeta(); return true; }
      if (m.changed) relabel();
      return m.changed > 0;
    }
    const noteLinkMax = rows => rows.forEach(r => { const u = Date.parse(r.changed_at); if (u > maxLinkSeen) maxLinkSeen = u; });
    async function loadLinks() {
      let r = await getAll(LINK_LIVE, 'from_item,to_item,kind');
      if (!r.ok) r = await getAll(LINK_COLS + '&removed_at=is.null', 'from_item,to_item,kind');
      LINKS_READY = r.ok;
      if (!r.ok) { LINKS = new Map(); return r; }
      noteLinkMax(r.json);
      if (!maxLinkSeen) maxLinkSeen = now();
      LINKS = C.mergeLinkRows(null, r.json).links;
      return r;
    }
    async function pollLinks() {
      if (!LINKS_READY) return 0;
      const r = await getAll(LINK_COLS + '&' + C.linkPollFilter(maxLinkSeen || now()), 'from_item,to_item,kind');
      if (!r.ok) return 0;
      noteLinkMax(r.json);
      const pending = new Set(LQ.map(x => C.linkKey({ from_item: x.l.from, to_item: x.l.to, kind: x.l.kind })));
      const m = C.mergeLinkRows(LINKS, r.json.filter(x => !pending.has(C.linkKey(x))));
      LINKS = m.links;
      return m.changed;
    }
    // web: loadAll. Resolves { ok } or { ok: false, state: unreachable | error, msg }. The durable queue is read back here,
    // before the first flush, under the Web Lock td.queue (two tabs never send the same record twice at once)
    async function loadAll() {
      if (!session) return { ok: false, state: 'signin', msg: '' };
      emit('session', { state: 'loading' });
      const keep = new Map([...Q.keys()].map(id => [id, find(id)]).filter(x => x[1]));
      LISTS = [];
      const meta = await loadMeta();
      if (!meta.ok) return loadFailed(meta);
      if (!me) return loadFailed({ err: { kind: 'other', message: 'This login has no profile in the database.' } });
      const [items, pr] = await Promise.all([
        getAll('items?select=*&deleted_at=is.null'),
        rest('GET', 'preferences?select=prefs&profile_id=eq.' + me.id + '&app=eq.tasksdashboard'),
      ]);
      if (!items.ok) return loadFailed(items);
      if (!pr.ok) return loadFailed(pr);
      noteMax(items.json);
      const live = new Set(LISTS.concat(HIDDEN_LISTS.map(l => l.id)));
      tasks = items.json.filter(r => live.has(r.list_id)).map(C.rowToTask).map(t => keep.get(t.id) || t);
      keep.forEach(t => { if (!tasks.includes(t)) tasks.push(t); });
      maxTagSeen = 0;
      const it = await loadItemTags();
      if (!it.ok) return loadFailed(it);
      if (!maxTagSeen) maxTagSeen = now();
      maxLinkSeen = 0;
      await loadLinks();
      prefsExists = pr.json.length > 0;
      applyPrefs(C.prefsFromRow(prefsExists ? pr.json[0].prefs : null, { listIds: LISTS, itemIds: tasks.map(t => t.id), tagListIds: Object.keys(TAG_LISTS) }));
      lastWritten = prefsExists ? JSON.stringify(prefs) : null;
      if (!prefsExists) savePrefsSoon();
      loaded = true;
      await withLock(LOCK_QUEUE, async () => { await rehydrate(); await flushQueued(); });
      startPolling();
      emit('session', { state: 'ready' });
      changed('load'); syncChanged();
      return { ok: true, welcome: C.welcomeDue(prefs) && me.kind === 'human' };
    }
    function loadFailed(r) {
      if (!session) return { ok: false, state: 'signin', msg: '' };
      const x = r.err && (r.err.kind === 'network' || r.err.kind === 'server') ? { ok: false, state: 'unreachable', msg: r.err.message } : { ok: false, state: 'error', msg: r.err ? r.err.message : 'Loading failed.' };
      emit('session', x);
      return x;
    }
    async function refreshMeta() {
      const before = new Set(LISTS), tagListsBefore = Object.keys(TAG_LISTS).filter(id => !TAG_LISTS[id].hidden).sort().join();
      const meta = await loadMeta();
      if (!meta.ok) return meta;
      const live = new Set(LISTS.concat(HIDDEN_LISTS.map(l => l.id)));
      tasks = tasks.filter(t => live.has(t.list) || Q.has(t.id));
      const fresh = LISTS.filter(l => !before.has(l));
      if (fresh.length) {
        const r = await getAll('items?select=*&deleted_at=is.null&list_id=in.(' + fresh.join(',') + ')');
        if (r.ok) { noteMax(r.json); const have = new Set(tasks.map(t => t.id)); r.json.forEach(row => { if (!have.has(row.id)) tasks.push(C.rowToTask(row)); }); }
      }
      if (fresh.length || Object.keys(TAG_LISTS).filter(id => !TAG_LISTS[id].hidden).sort().join() !== tagListsBefore) await loadItemTags();
      if (fresh.length && LINKS_READY) await loadLinks();
      changed('meta');
      return { ok: true };
    }

    // ---- durable queue (analysis §4): every change is mirrored to IndexedDB td-app/queue, keyed uid:itemId ----
    const LINKS_KEY = uid => uid + ':links';
    // whose queue this is: the signed-in person, or after "Session ended" the person it ended for (edits made meanwhile wait in
    // IndexedDB too, so a Google sign-in, which leaves the page, does not lose them)
    const queueUid = () => session ? session.user.id : ended && me ? me.id : null;
    function persist(id) {
      const uid = queueUid();
      if (!qstore || !durable || !uid) return;
      const e = Q.get(id), t = find(id);
      const p = e && t && (e.create || e.fields.size || e.sending) ? qstore.put(queueRecord(uid, t, e)) : qstore.del(uid + ':' + id);
      Promise.resolve(p).catch(() => { durable = false; });
    }
    function persistLinks() {
      const uid = queueUid();
      if (!qstore || !durable || !uid) return;
      const p = LQ.length ? qstore.put({ key: LINKS_KEY(uid), uid, id: null, links: LQ.map(x => ({ op: x.op, l: x.l })) }) : qstore.del(LINKS_KEY(uid));
      Promise.resolve(p).catch(() => { durable = false; });
    }
    async function rehydrate() {
      if (!qstore || !durable) return 0;
      let recs;
      try { recs = await qstore.all(session.user.id); } catch (e) { durable = false; return 0; }
      let n = 0;
      for (const rec of recs) {
        if (rec.key === LINKS_KEY(session.user.id)) {
          (rec.links || []).forEach(x => { if (x && x.l && !LQ.some(y => y.op === x.op && C.linkKey({ from_item: y.l.from, to_item: y.l.to, kind: y.l.kind }) === C.linkKey({ from_item: x.l.from, to_item: x.l.to, kind: x.l.kind }))) linkOp(x.op, x.l, true); });
          continue;
        }
        if (Q.has(rec.id)) continue; // this page still holds it in memory
        const r = queueRestore(rec, find(rec.id));
        if (!r) { Promise.resolve(qstore.del(rec.key)).catch(() => {}); continue; }
        if (r.isNew) tasks.unshift(r.task);
        Q.set(rec.id, r.entry); n++;
      }
      if (n) changed('queue');
      return n;
    }

    // ---- writes (web: edit, create, writeTags, flushAll, settle, applyRow, flush, conflict, failed) ----
    function edit(tOrId, mutate, eo) {
      const t = typeof tOrId === 'string' ? find(tOrId) : tOrId;
      if (!t) return null;
      const before = {}; FIELDS.forEach(f => { before[f] = val(t, f); });
      mutate(t);
      const ch = FIELDS.filter(f => !same(before[f], val(t, f)));
      if (!ch.length) return null;
      if (ch.includes('status')) t.doneAt = C.CLOSED.includes(t.status) ? (t.doneAt || nowDate()) : null;
      if (ch.includes('qStored') && t.qStored) t.q = t.qStored;
      const e = Q.get(t.id) || { fields: new Set(), base: {}, create: null, inflight: false };
      ch.forEach(f => { if (!(f in e.base)) e.base[f] = before[f]; e.fields.add(f); });
      e.origin = eo && eo.origin || null;
      Q.set(t.id, e);
      conflictFlag = false;
      persist(t.id);
      flush(t.id);
      changed('edit'); syncChanged();
      return { before, fields: ch };
    }
    // a new task as the web's task window builds it (web: openTask save, applyLinks): new tasks go on top of their quadrant
    function makeTask(f) {
      const p = f || {};
      const list = p.list, q = C.QS.includes(p.q) ? p.q : 'B';
      const cat = p.category || (LIST[list] && LIST[list].default_category) || 'task';
      return { id: p.id || uuid(), list, num: 0, qStored: q, q, title: String(p.title || ''), notes: String(p.notes || ''), tags: Array.isArray(p.tags) ? p.tags.slice() : [],
        deadline: p.deadline || null, start: p.start || null, status: 'open', doneAt: null, pin: undefined, sortKey: topKey(list, q), category: cat,
        reviewState: 'none', aiConfidence: null, createdAt: nowDate(), createdBy: me && me.id, ownerId: me && me.kind === 'human' ? me.id : null, version: 1, deleted: false, updatedAt: null };
    }
    // web: create. Accepts a full task or the fields makeTask takes; returns the task and an undo (delete) when the role allows it
    function createTask(tf, eo) {
      const t = tf && tf.version ? tf : makeTask(tf);
      tasks.unshift(t);
      Q.set(t.id, { fields: new Set(t.tags.length ? ['tags'] : []), base: t.tags.length ? { tags: [] } : {}, create: true, inflight: false, origin: eo && eo.origin || null });
      persist(t.id);
      flush(t.id);
      changed('create'); syncChanged();
      return { task: t, msg: 'Added to ' + label(t.list) + ': ' + plain(t.title), undo: canDo('delete', null, t.list) ? () => removeTask(t.id, true) : null };
    }
    async function writeTags(t, before, after) {
      const d = C.tagDiff(before, after), at = 'item_tags?item_id=eq.' + t.id + '&tag_id=eq.';
      for (const id of d.remove) { const r = await rest('PATCH', at + id, { removed_at: nowDate().toISOString() }); if (!r.ok) return r; }
      for (const id of d.add) {
        let r = await rest('PATCH', at + id, { removed_at: null }, { Prefer: 'return=representation' });
        if (r.ok && !r.json.length) r = await rest('POST', 'item_tags', { item_id: t.id, tag_id: id }, { Prefer: 'return=minimal' });
        if (!r.ok && r.err.kind !== 'duplicate') return r;
      }
      return { ok: true };
    }
    // the queue under the Web Lock (start, online, visible, every poll)
    function flushAll() { return withLock(LOCK_QUEUE, flushQueued); }
    async function flushQueued() { await Promise.all([...Q.keys()].map(flush)); runLinks(); }
    function settle(id) {
      const e = Q.get(id);
      if (e && !e.inflight && !e.create && !e.fields.size) Q.delete(id);
      persist(id);
      if (!Q.size && offline) { offline = false; toast('Back online: changes saved'); }
      syncChanged();
    }
    function applyRow(t, row, keepFields) {
      const fresh = C.rowToTask(row);
      if (!Array.isArray(row.item_tags)) delete fresh.tags;
      Object.keys(fresh).forEach(k => { if (!keepFields.has(k) && !(k === 'q' && keepFields.has('qStored'))) t[k] = fresh[k]; });
      t.version = fresh.version; t.num = fresh.num;
      noteMax([row]);
    }
    async function flush(id) {
      const e = Q.get(id), t = find(id);
      if (!e || e.inflight || !t || !session) return;
      e.inflight = true;
      let res, sending = null;
      if (e.create) {
        const body = Object.assign({ id: t.id, list_id: t.list, category: t.category, owner_id: t.ownerId || null }, C.taskToPatch(t, ['title', 'notes', 'q', 'pin', 'deadline', 'start', 'status', 'sortKey']));
        res = await rest('POST', 'items', body, { Prefer: 'return=representation' });
        if (!res.ok && res.err.kind === 'duplicate') res = await rest('GET', 'items?select=*&id=eq.' + t.id);
        if (res.ok && res.json.length === 1) { e.create = null; applyRow(t, res.json[0], e.fields); }
        else if (res.ok) res = { ok: false, status: 403, err: C.restError(403, {}) };
      } else {
        sending = { fields: new Set(e.fields), base: Object.assign({}, e.base) };
        e.sending = sending; e.fields.clear(); e.base = {};
        if (!sending.fields.size) { e.inflight = false; e.sending = null; settle(id); return; }
        const itemFields = [...sending.fields].filter(f => f !== 'tags');
        const tagSend = sending.fields.has('tags') ? { base: (sending.base.tags || []).slice(), now: t.tags.slice() } : null;
        if (itemFields.length) {
          const patch = C.taskToPatch(t, itemFields.map(dbField), nowDate().toISOString());
          res = await rest('PATCH', 'items?id=eq.' + t.id + '&version=eq.' + t.version, patch, { Prefer: 'return=representation' });
          if (res.ok && res.json.length === 1) applyRow(t, res.json[0], e.fields);
          else if (res.ok) res = await conflict(t, e, { fields: new Set(itemFields), base: sending.base });
        } else res = { ok: true };
        if (res.ok && tagSend) {
          const tr = await writeTags(t, tagSend.base, tagSend.now);
          if (!tr.ok) {
            if (tr.err.retry || tr.status === 401) { e.fields.add('tags'); if (!('tags' in e.base)) e.base.tags = tagSend.base; res = tr; sending = null; }
            else { if (!e.fields.has('tags')) t.tags = tagSend.base; toast(tr.err.message, { kind: 'refused', id: t.id }); changed('refused'); }
          }
        }
      }
      e.inflight = false; e.sending = null;
      if (!res.ok) {
        if (res.err.retry || res.status === 401) {
          if (sending) sending.fields.forEach(f => { e.fields.add(f); if (!(f in e.base)) e.base[f] = sending.base[f]; });
          if (res.err.retry && !offline) offline = true;
          persist(id);
          if (res.err.retry) toast((res.err.kind === 'rate' ? 'The database is busy: ' : 'Offline: ') + Q.size + (Q.size === 1 ? ' change waiting' : ' changes waiting'), { kind: 'offline' });
          syncChanged();
          return;
        }
        failed(t, e, sending, res.err);
      }
      if (Q.get(id) && (e.fields.size || e.create)) { persist(id); return flush(id); }
      settle(id);
      if (res.ok) changed('saved');
    }
    // a PATCH matched 0 rows: someone else saved first, or this login may not edit the item (web: conflict)
    async function conflict(t, e, sending) {
      const r = await rest('GET', 'items?select=*&id=eq.' + t.id);
      if (!r.ok) return r;
      const row = r.json[0];
      if (!row || row.version <= t.version) {
        if (row) applyRow(t, row, e.fields); else { t.deleted = true; e.fields.clear(); }
        toast('You can\'t edit this item here', { kind: 'refused', id: t.id });
        return { ok: true };
      }
      const remote = C.rowToTask(row);
      // app only (not in the web's conflict): a field the row already holds with my value has landed (the same queued change sent
      // by a second tab, or restored from IndexedDB after it went out): it is neither a clash nor sent again
      const open = [...sending.fields].filter(f => !same(val(remote, f), val(t, f)));
      const clash = open.filter(f => !same(val(remote, f), sending.base[f]));
      if (!clash.length) {
        const mine = {}; open.forEach(f => { mine[f] = val(t, f); });
        applyRow(t, row, e.fields);
        Object.assign(t, mine);
        open.forEach(f => { e.fields.add(f); if (!(f in e.base)) e.base[f] = sending.base[f]; });
        return { ok: true };
      }
      const draft = { title: t.title, notes: t.notes };
      applyRow(t, row, e.fields);
      const what = clash.map(f => CLASH_NAMES[f] || f).join(', ');
      conflictFlag = true;
      emit('conflict', { id: t.id, fields: clash, what, draft, origin: e.origin || null,
        msg: e.origin === 'dialog' ? 'Changed by someone else while you edited: ' + what + '. Their version is saved; your text is below. Save again to replace it.' : 'Changed by someone else: ' + what });
      changed('conflict');
      return { ok: true };
    }
    // a write the database refused: the fields go back (unless changed again since), and the person is told why (web: failed)
    function failed(t, e, sending, err) {
      if (e.create) {
        Q.delete(t.id); tasks = tasks.filter(x => x !== t);
        toast(err.message, { kind: 'refused', id: t.id, origin: e.origin || null, error: err, draft: { title: t.title, notes: t.notes, list: t.list, tags: t.tags, deadline: t.deadline, start: t.start, q: t.qStored } });
        changed('refused'); return;
      }
      const draft = { title: t.title, notes: t.notes };
      if (sending) sending.fields.forEach(f => { if (!e.fields.has(f)) { t[f] = sending.base[f]; if (f === 'status') t.doneAt = C.CLOSED.includes(t.status) ? t.doneAt || nowDate() : null; } });
      toast(err.message, { kind: 'refused', id: t.id, origin: e.origin || null, error: err, draft });
      changed('refused');
    }
    const undoEdit = (t, r) => () => { if (r) edit(t, x => r.fields.forEach(f => { x[f] = Array.isArray(r.before[f]) ? r.before[f].slice() : r.before[f]; })); };

    // ---- actions with undo (web: the [data-done] handler, #fcancel, removeTask, restoreTask) ----
    function markDone(id) { const t = find(id); if (!t) return null; const r = edit(t, x => { x.status = 'done'; }); return r && { msg: 'Completed: ' + plain(t.title), undo: undoEdit(t, r) }; }
    function cancelTask(id) { const t = find(id); if (!t) return null; const r = edit(t, x => { x.status = 'cancelled'; }); return r && { msg: 'Cancelled: ' + plain(t.title), undo: undoEdit(t, r) }; }
    function removeTask(id) { const t = find(id); if (!t) return null; const r = edit(t, x => { x.deleted = true; }); return r && { msg: 'Deleted: ' + plain(t.title), undo: () => edit(t, x => { x.deleted = false; }) }; }
    async function restoreTask(id) {
      const t = find(id); if (!t) return null;
      let prev = 'open';
      const r = await rest('GET', 'item_events?select=diff&item_id=eq.' + t.id + '&order=id.desc&limit=50');
      if (r.ok) { const ev = r.json.find(x => x.diff && x.diff.status && x.diff.status.new === t.status); if (ev && C.STATUSES.includes(ev.diff.status.old) && !C.CLOSED.includes(ev.diff.status.old)) prev = ev.diff.status.old; }
      const u = edit(t, x => { x.status = prev; });
      return u && { msg: 'Restored: ' + plain(t.title), undo: undoEdit(t, u) };
    }
    // fields from a form or a sheet: { title, notes, tags, deadline, start, list }. A list change puts the task on top of its quadrant
    function saveTask(id, f, eo) {
      const t = find(id); if (!t) return null;
      const moved = f.list !== undefined && f.list !== t.list;
      const key = moved ? topKey(f.list, derive(t).q) : t.sortKey;
      const r = edit(t, x => {
        ['title', 'notes', 'tags', 'deadline', 'start'].forEach(k => { if (f[k] !== undefined) x[k] = Array.isArray(f[k]) ? f[k].slice() : f[k]; });
        if (moved) x.list = f.list;
        x.sortKey = key;
      }, eo || { origin: 'dialog' });
      return r && { msg: moved ? 'Moved to ' + label(f.list) : 'Saved', undo: undoEdit(t, r) };
    }
    function moveToList(id, list) { return saveTask(id, { list }, { origin: null }); }

    // ---- order (web: placeIn, topKey, moveTask, moveGrouped). Priority = position; a new task goes on top ----
    function placeIn(t, q, targetId, before) {
      const peers = all().filter(x => !x.doneAt && x.list === t.list && x.q === q && x !== t).sort(C.byOrder);
      const tg = targetId ? find(targetId) : null;
      let i = peers.length;
      if (tg) { const j = peers.indexOf(tg); i = j >= 0 ? j + (before ? 0 : 1) : peers.filter(x => C.byOrder(x, tg) < 0).length; }
      const prev = peers[i - 1], next = peers[i];
      if (peers.some(x => x.sortKey === null) || (prev && next && C.gapTooSmall(prev.sortKey, next.sortKey))) {
        const order = peers.slice(); order.splice(i, 0, t);
        const keys = C.renumber(order.map(x => x.id));
        keys.forEach(({ id, sortKey }) => { const x = find(id); if (x !== t && x.sortKey !== sortKey) edit(x, y => { y.sortKey = sortKey; }); });
        return keys[i].sortKey;
      }
      return C.sortBetween(prev ? prev.sortKey : null, next ? next.sortKey : null);
    }
    function topKey(list, q) { const keys = all().filter(x => !x.doneAt && x.list === list && x.q === q && x.sortKey !== null).map(x => x.sortKey); return keys.length ? C.sortBetween(null, Math.min(...keys)) : 0; }
    function linkIx() { const by = {}; all().forEach(t => { by[t.id] = t; }); return { ix: C.linkIndex(LINKS, by), by }; }
    const grouped = () => cardLayout.group && LINKS_READY;
    // the cards of a quadrant in the order the board shows them (web: byShownOrder over C.byOrder, Group by parent)
    function shownOrder(cards) { if (!grouped()) return cards.slice().sort(C.byOrder); const R = linkIx(), by = {}; cards.forEach(t => { by[t.id] = t; }); return C.groupedIds(cards.slice().sort(C.byOrder), R.ix, R.by).map(id => by[id]); }
    function moveTask(id, q, targetId, before) {
      const t = find(id); if (!t || !canDo('edit', t)) return null;
      const from = derive(t).q;
      if (grouped()) return moveGrouped(t, q, targetId, before, from);
      const key = placeIn(t, q, targetId, before);
      const r = edit(t, x => { if (q !== from) { if (C.URGENT[q] !== C.URGENT[from]) x.pin = C.URGENT[q]; x.qStored = q; } x.sortKey = key; });
      return r && { msg: q !== from ? 'Moved to ' + QN[q] : 'Order changed', undo: undoEdit(t, r) };
    }
    function moveGrouped(t, q, targetId, before, from) {
      const R = linkIx();
      const drawn = x => shownOrder(all().filter(y => !y.doneAt && y.list === t.list && y.q === x));
      const src = drawn(from), i = src.indexOf(t);
      const under = id => { const seen = new Set(); for (let p = R.ix.parentOf[id]; p && !seen.has(p); p = R.ix.parentOf[p]) { if (p === t.id) return true; seen.add(p); } return false; };
      let k = i + 1; while (i >= 0 && k < src.length && under(src[k].id)) k++;
      const moving = i >= 0 ? src.slice(i, k) : [t], order = drawn(q).filter(y => !moving.includes(y));
      const tg = targetId ? find(targetId) : null;
      if (tg && !order.includes(tg) && !moving.includes(tg)) { const nx = order.find(y => C.byOrder(tg, y) < 0); targetId = nx ? nx.id : null; before = !!nx; }
      const w = C.placeGrouped(order, moving, targetId, before, R.ix.parentOf);
      if (!w) return null;
      const done = [];
      w.forEach(({ id: wid, sortKey }) => {
        const x = find(wid), mv = moving.includes(x);
        if (!x || (!mv && x.sortKey === sortKey)) return;
        const r = edit(x, y => { if (mv && q !== from) { if (C.URGENT[q] !== C.URGENT[from]) y.pin = C.URGENT[q]; y.qStored = q; } y.sortKey = sortKey; });
        if (r) done.push([x, r]);
      });
      const kids = moving.length - 1;
      return { msg: (q !== from ? 'Moved to ' + QN[q] : 'Order changed') + (kids ? ' with ' + kids + (kids === 1 ? ' subtask' : ' subtasks') : ''), undo: () => done.slice().reverse().forEach(([x, r]) => undoEdit(x, r)()) };
    }

    // ---- links (web: linkOp, waitCreated, runLinks, pollLinks). Shown at once, sent in order, put back when refused ----
    function linkOp(op, l, restoring) {
      const key = C.linkKey({ from_item: l.from, to_item: l.to, kind: l.kind });
      const before = new Map(LINKS);
      if (op === 'add') {
        if (l.kind === 'parent') [...LINKS].forEach(([k, x]) => { if (x.kind === 'parent' && x.from === l.from) LINKS.delete(k); });
        LINKS.set(key, { from: l.from, to: l.to, kind: l.kind });
      } else LINKS.delete(key);
      LQ.push({ op, l: { from: l.from, to: l.to, kind: l.kind }, before });
      persistLinks();
      if (!restoring) { changed('link'); syncChanged(); runLinks(); }
    }
    const waitCreated = async id => { for (let i = 0; i < 150 && Q.get(id) && Q.get(id).create; i++) await sleep(200); };
    async function runLinks() {
      if (lqBusy || !session) return;
      lqBusy = true;
      try {
        while (LQ.length) {
          const x = LQ[0];
          await waitCreated(x.l.from); await waitCreated(x.l.to);
          const r = await rpc(x.op === 'add' ? 'link_items' : 'unlink_items', { p_from: x.l.from, p_to: x.l.to, p_kind: x.l.kind });
          if (!r.ok && (r.err.retry || r.status === 401)) { if (r.err.retry && !offline) { offline = true; syncChanged(); } await sleep(LINK_RETRY_MS); if (!session) return; continue; }
          LQ.shift(); persistLinks();
          if (!r.ok) {
            const key = C.linkKey({ from_item: x.l.from, to_item: x.l.to, kind: x.l.kind });
            if (x.op === 'add') { LINKS.delete(key); x.before.forEach((v, k) => { if (v.kind === 'parent' && v.from === x.l.from && x.l.kind === 'parent') LINKS.set(k, v); }); }
            else if (x.before.has(key)) LINKS.set(key, x.before.get(key));
            toast(r.err.message, { kind: 'refused' });
          }
        }
      } finally { lqBusy = false; }
      if (!Q.size && offline) { offline = false; toast('Back online: changes saved'); }
      changed('link'); syncChanged();
    }

    // ---- polling (web: startPolling, poll). Every pollMs while visible, and on focus with the lists ----
    function startPolling() { stopPolling(); pollTimer = T.setInterval(() => { if (visible()) poll(false); }, CFG.pollMs); }
    function stopPolling() { if (pollTimer) T.clearInterval(pollTimer); pollTimer = 0; }
    async function poll(meta) {
      if (polling || !session || !loaded) return;
      polling = true;
      try {
        flushAll();
        if (meta) await refreshMeta();
        else {
          const nr = await rest('GET', NOTICES_PATH);
          if (nr.ok) {
            const fresh = nr.json.filter(n => !noticeKnown(n) && !NOTICE_TRIED.has(n.id));
            if (fresh.length) { fresh.forEach(n => NOTICE_TRIED.add(n.id)); await refreshMeta(); }
            NOTICES = nr.json.filter(noticeKnown);
          }
        }
        const r = await getAll('items?select=*&' + C.pollFilter(maxSeen || now()));
        if (!r.ok) return;
        noteMax(r.json);
        const known = () => LISTS.concat(HIDDEN_LISTS.map(l => l.id));
        let m = C.mergePoll(tasks, r.json, { pending: new Set(Q.keys()), knownLists: known() });
        if (m.unknownLists.length && !meta) { await refreshMeta(); m = C.mergePoll(tasks, r.json, { pending: new Set(Q.keys()), knownLists: known() }); }
        tasks = m.tasks;
        const tr = await getAll('item_tags?select=item_id,tag_id,removed_at,changed_at&' + C.tagPollFilter(maxTagSeen || now()), 'item_id,tag_id');
        let tm = { changed: 0, unknownTags: [] }, defs = false;
        if (tr.ok) {
          noteTagMax(tr.json);
          tm = C.mergeTagRows(tasks, tr.json, { pending: new Set(Q.keys()), knownTags: Object.keys(TAG) });
          if (tm.unknownTags.length) {
            const u = await rest('GET', 'tags?select=*&id=in.(' + tm.unknownTags.join(',') + ')');
            if (u.ok) defs = await takeTagDefs(u.json);
          }
        }
        if (TAGS_UPDATED) {
          const d = await getAll('tags?select=*&' + C.tagDefsFilter(maxTagDefSeen || now()));
          if (d.ok && d.json.length) defs = (await takeTagDefs(d.json)) || defs;
        }
        const lc = await pollLinks();
        if (m.changed || tm.changed || tm.unknownTags.length || defs || meta || lc) changed('poll');
      } finally { polling = false; }
    }

    // ---- preferences v2: the shared row (app tasksdashboard), written 1 s after a change when it differs (web: writePrefs) ----
    function applyPrefs(p) {
      prefs = p;
      LISTS.sort((a, b) => (p.listOrder.indexOf(a) + 1 || 1e6) - (p.listOrder.indexOf(b) + 1 || 1e6));
      settings = C.readSettings(p.settings);
      cardLayout = p.cardLayout;
    }
    // patch: any keys of PREFS_DEFAULTS (settings, cardLayout, theme, list, listOrder, welcomeVersion, tagListOrder, …)
    function setPrefs(patch) {
      const next = Object.assign(JSON.parse(JSON.stringify(prefs)), patch || {});
      if (patch && patch.listOrder) LISTS = patch.listOrder.filter(id => LIST[id]).concat(LISTS.filter(id => !patch.listOrder.includes(id)));
      next.listOrder = LISTS.slice();
      applyPrefs(C.prefsFromRow(next, { listIds: LISTS, tagListIds: Object.keys(TAG_LISTS) }));
      changed('prefs');
      savePrefsSoon();
      return prefs;
    }
    function savePrefsSoon() { if (!me) return; T.clearTimeout(prefsTimer); prefsTimer = T.setTimeout(writePrefs, PREFS_DELAY_MS); }
    async function writePrefs() {
      T.clearTimeout(prefsTimer);
      if (!me || !session) return { ok: true };
      const text = JSON.stringify(prefs);
      if (text === lastWritten) return { ok: true };
      const r = await rest('POST', 'preferences?on_conflict=profile_id,app', C.rowFromPrefs(me.id, prefs), { Prefer: 'resolution=merge-duplicates,return=minimal' });
      if (r.ok) { lastWritten = text; prefsExists = true; }
      else if (!r.err.retry && r.status !== 401) toast('Preferences not saved: ' + r.err.message, { kind: 'refused' });
      return r;
    }

    // ---- lists (web: openNewList create, archiveList, restoreList, openArchivedLists, hideList, leaveList, moveList) ----
    async function afterMembership() { const r = await refreshMeta(); if (prefs.list !== 'all' && !LIST[prefs.list]) setPrefs({ list: 'all' }); return r; }
    async function createList(name, shared) {
      const n = String(name || '').trim();
      if (!n) return { ok: false, err: { kind: 'invalid', message: 'Enter a name' } };
      const arch = await rest('GET', 'lists?select=id,name,owner_id,archived_at&archived_at=not.is.null&owner_id=eq.' + me.id);
      const clash = C.listNameClash(n, Object.values(LIST).concat(HIDDEN_LISTS, arch.ok ? arch.json : []), me.id);
      if (clash.live) return { ok: false, err: { kind: 'duplicate', message: 'You already have a list named ' + clash.live.name + '.' } };
      if (clash.archived) return { ok: false, archived: clash.archived, freeName: C.freeListName(n, Object.values(LIST).concat(HIDDEN_LISTS, arch.json).map(l => l.name)), err: { kind: 'duplicate', message: 'You already have an archived list named ' + clash.archived.name + '.' } };
      const r = await rpc('create_list_row', { p_name: n, p_shared: !!(me.is_household && shared) });
      if (!r.ok) { if (r.err.kind === 'duplicate') await refreshMeta(); return r; }
      const l = C.createdList(r.json, { name: n, slug: null, ownerId: me.id, sort: Math.max(0, ...Object.values(LIST).filter(y => y.owner_id === me.id).map(y => y.sort || 0)) + 1 });
      if (!l) return { ok: false, err: { kind: 'other', message: 'The list was made, but the answer was not understood. Reload the app.' } };
      LIST[l.id] = l; ROLE[l.id] = 'owner';
      if (!LISTS.includes(l.id)) LISTS.push(l.id);
      setPrefs({ list: l.id });
      return { ok: true, list: l, msg: 'List created: ' + l.name };
    }
    // no web twin: the web has no list rename; PATCH lists.name as the owner (RLS decides)
    async function renameList(id, name) {
      const r = await rest('PATCH', 'lists?id=eq.' + id, { name: String(name || '').trim() }, { Prefer: 'return=representation' });
      if (!r.ok || r.json.length !== 1) return { ok: false, err: r.ok ? { kind: 'denied', message: 'Only an owner renames a list' } : r.err };
      LIST[id] = Object.assign({}, LIST[id], r.json[0]); changed('meta');
      return { ok: true, msg: 'Renamed to ' + r.json[0].name };
    }
    function reorderLists(ids) { setPrefs({ listOrder: ids.slice() }); return LISTS.slice(); }
    async function archiveList(id) {
      const name = label(id);
      const r = await rest('PATCH', 'lists?id=eq.' + id, { archived_at: nowDate().toISOString() }, { Prefer: 'return=representation' });
      if (!r.ok || r.json.length !== 1) return { ok: false, err: r.ok ? { kind: 'denied', message: 'Only an owner archives a list' } : r.err };
      await writePrefs(); await afterMembership();
      return { ok: true, msg: 'Archived: ' + name, undo: () => restoreList(id) };
    }
    async function restoreList(id) {
      const r = await rest('PATCH', 'lists?id=eq.' + id, { archived_at: null }, { Prefer: 'return=representation' });
      if (!r.ok || r.json.length !== 1) return { ok: false, err: r.ok ? { kind: 'denied', message: 'Only an owner restores a list' } : r.err };
      await refreshMeta();
      return { ok: true, msg: 'Restored list: ' + r.json[0].name };
    }
    async function archivedLists() { const r = await rest('GET', 'lists?select=id,name,archived_at,owner_id&archived_at=not.is.null&order=archived_at.desc'); return r.ok ? { ok: true, lists: r.json.map(l => Object.assign({}, l, { canRestore: ROLE[l.id] === 'owner' && me.kind === 'human' })) } : r; }
    async function hideList(id, hide) { const r = await rpc('set_list_hidden', { p_list: id, p_hidden: !!hide }); if (!r.ok) return r; await afterMembership(); return { ok: true, msg: hide ? 'Hidden for you. Me, Hidden lists brings it back.' : 'Shown again' }; }
    async function leaveList(id) { const l = LIST[id] || HIDDEN_LISTS.find(x => x.id === id); const r = await rpc('leave_list', { p_list: id }); if (!r.ok) return r; await afterMembership(); return { ok: true, msg: 'Left ' + (l ? l.name : 'the list') }; }

    // ---- sharing (web: openShare, openSharing, answerNotice). kind 'list' or 'tag_list' ----
    const memberAt = (kind, id, pid) => (kind === 'list' ? 'list_members?list_id=eq.' : 'tag_list_members?tag_list_id=eq.') + id + '&profile_id=eq.' + pid;
    async function people(kind, id) { return rpc(kind === 'list' ? 'list_people' : 'tag_list_people', kind === 'list' ? { p_list: id } : { p_tag_list: id }); }
    async function share(kind, id, email, role) {
      const r = await rpc(kind === 'list' ? 'share_list' : 'share_tag_list', kind === 'list' ? { p_list: id, p_email: email, p_role: role, p_join: true } : { p_tag_list: id, p_email: email, p_role: role, p_join: true });
      return r.ok ? { ok: true, msg: 'Shared with ' + email } : r;
    }
    async function setRole(kind, id, pid, role) { const r = await rest('PATCH', memberAt(kind, id, pid), { role }, { Prefer: 'return=representation' }); return r.ok && r.json.length ? { ok: true, msg: 'Role changed' } : r.ok ? { ok: false, err: { kind: 'denied', message: 'Not allowed' } } : r; }
    async function removeMember(kind, id, pid) { const r = await rest('DELETE', memberAt(kind, id, pid), undefined, { Prefer: 'return=representation' }); return r.ok && r.json.length ? { ok: true, msg: 'Removed' } : r.ok ? { ok: false, err: { kind: 'denied', message: 'Not allowed' } } : r; }
    async function revokeInvite(inviteId) { const r = await rpc('revoke_invite', { p_invite: inviteId }); return r.ok ? { ok: true, msg: 'Invitation revoked' } : r; }
    async function acceptInvite(inviteId) { const r = await rpc('accept_invite', { p_invite: inviteId }); if (!r.ok) return r; await afterMembership(); return { ok: true, msg: 'Accepted' }; }
    async function declineInvite(inviteId, block) { const r = await rpc('decline_invite', { p_invite: inviteId, p_block: !!block }); if (!r.ok) return r; await afterMembership(); return { ok: true, msg: block ? 'Declined and blocked' : 'Declined' }; }
    async function answerNotice(noticeId, action) {
      const n = NOTICES.find(x => x.id === noticeId); if (!n) return { ok: false, err: { kind: 'other', message: 'This note is no longer open.' } };
      const r = await rpc('answer_shared_notice', { p_notice: noticeId, p_action: action });
      if (!r.ok) return r;
      NOTICES = NOTICES.filter(x => x.id !== noticeId && !(action === 'block' && x.invited_by === n.invited_by));
      if (action !== 'seen') await afterMembership(); else changed('notice');
      return { ok: true, msg: action === 'block' ? 'Blocked ' + n.inviter_name + '. You left what they shared with you.' : action === 'leave' ? 'Left “' + n.target_name + '”' : '' };
    }

    // ---- tags and tag lists (web: ensureTags, renameTagDb, deleteTagDb, openTags) ----
    async function ensureTags(items) {
      const d = myDefault(), out = [], errors = [];
      for (const { list, name } of items) {
        const tl = list || (d && d.id);
        if (!tl) { errors.push('This login has no default tag list'); continue; }
        const own = Object.values(TAG).find(x => x.tag_list_id === tl && x.name.toLowerCase() === name.toLowerCase());
        if (own) { out.push(own.id); continue; }
        const sort = Math.max(0, ...Object.values(TAG).filter(x => x.tag_list_id === tl).map(x => x.sort || 0)) + C.SPACING;
        let r = await rest('POST', 'tags', { tag_list_id: tl, name, sort }, { Prefer: 'return=representation' });
        if (!r.ok && r.err.kind === 'duplicate') {
          const g = await rest('GET', 'tags?select=id,tag_list_id,name,sort,deleted_at&tag_list_id=eq.' + tl);
          const old = g.ok && g.json.find(x => x.name.toLowerCase() === name.toLowerCase());
          if (old) r = await rest('PATCH', 'tags?id=eq.' + old.id, { deleted_at: null }, { Prefer: 'return=representation' });
        }
        if (!r.ok || !Array.isArray(r.json) || !r.json.length) { errors.push('Tag “' + name + '” not added: ' + (r.err ? r.err.message : 'refused')); continue; }
        const x = r.json[0];
        TAG[x.id] = { id: x.id, tag_list_id: x.tag_list_id, name: x.name, sort: x.sort };
        out.push(x.id);
      }
      relabel();
      errors.forEach(m => toast(m, { kind: 'refused' }));
      return out;
    }
    function setTags(id, tagIds) { const t = find(id); if (!t) return null; const r = edit(t, x => { x.tags = tagIds.slice(); }); return r && { msg: 'Tags saved', undo: undoEdit(t, r) }; }
    async function renameTag(id, name) {
      const r = await rest('PATCH', 'tags?id=eq.' + id, { name }, { Prefer: 'return=representation' });
      if (!r.ok || !r.json.length) return { ok: false, err: r.ok ? { kind: 'denied', message: 'You can\'t rename this tag' } : r.err.kind === 'duplicate' ? { kind: 'duplicate', message: 'A tag with this name exists' } : r.err };
      TAG[id].name = r.json[0].name; relabel(); changed('tags');
      return { ok: true };
    }
    async function deleteTag(id) {
      const at = nowDate().toISOString();
      const r = await rest('PATCH', 'tags?id=eq.' + id, { deleted_at: at }, { Prefer: 'return=representation' });
      if (!r.ok || !r.json.length) return { ok: false, err: r.ok ? { kind: 'denied', message: 'You can\'t delete this tag' } : r.err };
      await rest('PATCH', 'item_tags?tag_id=eq.' + id + '&removed_at=is.null', { removed_at: at });
      const n = tasks.filter(t => t.tags.includes(id)).length;
      tasks.forEach(t => { if (t.tags.includes(id)) t.tags = t.tags.filter(x => x !== id); });
      delete TAG[id]; relabel(); changed('tags');
      return { ok: true, msg: 'Deleted the tag' + (n ? ' and took it off ' + n + (n === 1 ? ' item' : ' items') : '') };
    }
    async function sortTag(id, sort) { const r = await rest('PATCH', 'tags?id=eq.' + id, { sort }, { Prefer: 'return=representation' }); if (r.ok && r.json.length) { TAG[id].sort = sort; changed('tags'); } return r; }
    async function moveTags(ids, toTagList) { const r = await rpc('move_tags', { p_tags: ids, p_to: toTagList }); if (r.ok) await refreshMeta(); return r; }
    async function createTagList(name) { const r = await rpc('create_tag_list', { p_name: name }); if (r.ok) await refreshMeta(); return r; }
    async function renameTagList(id, name) { const r = await rest('PATCH', 'tag_lists?id=eq.' + id, { name }, { Prefer: 'return=representation' }); if (r.ok && r.json.length) { TAG_LISTS[id].name = r.json[0].name; relabel(); changed('tags'); } return r; }
    async function sortTagList(id, sort) { const r = await rest('PATCH', 'tag_lists?id=eq.' + id, { sort }, { Prefer: 'return=representation' }); if (r.ok && r.json.length) { TAG_LISTS[id].sort = sort; changed('tags'); } return r; }
    async function setDefaultTagList(id) { const r = await rpc('set_default_tag_list', { p_tag_list: id }); if (r.ok) await refreshMeta(); return r; }
    async function archiveTagList(id, archived) { const r = await rpc('set_tag_list_archived', { p_tag_list: id, p_archived: !!archived }); if (r.ok) await refreshMeta(); return r; }
    async function hideTagList(id, hidden) { const r = await rpc('set_tag_list_hidden', { p_tag_list: id, p_hidden: !!hidden }); if (r.ok) await refreshMeta(); return r; }
    async function leaveTagList(id) { const r = await rpc('leave_tag_list', { p_tag_list: id }); if (r.ok) await refreshMeta(); return r; }
    // web: openSettings General. display_name and timezone are the profile's own columns; NAMES follows the new name
    async function saveProfile(patch) {
      const p = {}; if (patch && typeof patch.display_name === 'string') p.display_name = patch.display_name.replace(/[\u0000-\u001f\u007f]/g, '').trim(); if (patch && typeof patch.timezone === 'string' && patch.timezone.trim()) p.timezone = patch.timezone.trim();
      if (p.display_name === '') return { ok: false, err: { kind: 'invalid', message: 'Enter a name' } };
      if (!Object.keys(p).length) return { ok: true, msg: 'Settings saved' };
      const r = await rest('PATCH', 'profiles?id=eq.' + me.id, p, { Prefer: 'return=representation' });
      if (!r.ok || !r.json.length) return { ok: false, err: r.ok ? { kind: 'denied', message: 'Not allowed' } : r.err };
      Object.assign(me, p); NAMES[me.id] = me.display_name; changed('me');
      return { ok: true, msg: 'Settings saved' };
    }
    async function setMineTags(ids) { const r = await rest('PATCH', 'profiles?id=eq.' + me.id, { mine_tag_ids: [...ids] }, { Prefer: 'return=representation' }); if (r.ok && r.json.length) { me.mine_tag_ids = r.json[0].mine_tag_ids; changed('me'); } return r; }

    // ---- wiring to the page: online, visibility, focus (the UI calls attach(window, document) once) ----
    function attach(win, doc) {
      if (doc) visible = () => doc.visibilityState === 'visible';
      if (win && win.addEventListener) {
        win.addEventListener('online', () => { if (session) flushAll(); });
        win.addEventListener('focus', () => { if (session && loaded) poll(true); });
        // only when the queue lives in memory alone (no IndexedDB): leaving would lose it
        win.addEventListener('beforeunload', e => { if ((Q.size || LQ.length) && !durable) { e.preventDefault(); e.returnValue = ''; } });
      }
      if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', () => { if (session && visible()) { flushAll(); if (loaded) poll(false); } else writePrefs(); });
    }

    const api = {
      on, attach, syncState, config: CFG, configErrors: cfgRead.errors, core: C,
      // session
      start, signIn, startGoogle, finishGoogle, signOut, gate, requestAccess, accessRequest,
      // data
      loadAll, refreshMeta, poll, startPolling, stopPolling, rest, rpc, getAll,
      get session() { return session ? { uid: session.user.id, email: session.user.email } : null; },
      get me() { return me; }, get tasks() { return tasks; }, get lists() { return LISTS.slice(); }, get listById() { return LIST; }, get roles() { return ROLE; },
      get categories() { return CATS; }, get hiddenLists() { return HIDDEN_LISTS; }, get names() { return NAMES; }, get tagLists() { return TAG_LISTS; },
      get tags() { return TAG; }, get labels() { return LABEL; }, get tagNames() { return TAG_NAME; }, get invites() { return INVITES; }, get notices() { return NOTICES; },
      get links() { return LINKS; }, get linksReady() { return LINKS_READY; }, get prefs() { return prefs; }, get settings() { return settings; }, get cardLayout() { return cardLayout; },
      get durable() { return durable; }, get pending() { return Q.size + LQ.length; },
      all, find, canDo, myDefault, linkIx, shownOrder, derive,
      // writes
      edit, makeTask, create: createTask, saveTask, flush, flushAll, undoEdit, markDone, cancelTask, removeTask, restoreTask, moveTask, moveToList, placeIn, topKey,
      linkOp, setTags, ensureTags, renameTag, deleteTag, sortTag, moveTags, createTagList, renameTagList, sortTagList, setDefaultTagList, archiveTagList, hideTagList, leaveTagList, setMineTags, saveProfile,
      createList, renameList, reorderLists, archiveList, restoreList, archivedLists, hideList, leaveList,
      people, share, setRole, removeMember, revokeInvite, acceptInvite, declineInvite, answerNotice,
      setPrefs, writePrefs,
    };
    return api;
  }

  function safe(fn) { try { return fn(); } catch (e) { return null; } }

  return { create, queueRecord, queueRestore, idbQueueStore, gateFrom, syncStateOf, encTask, decTask, PKCE_KEY, PKCE_TTL_MS, AUTH_KEY, IDB_NAME, IDB_STORE, FIELDS, USER_KEYS };
});
