/* The Eisenhower Harness page on the web (/harness/, HomeOS task #45 plan v4). The other four files of this folder are byte-equal copies
   of HomeOS-TasksBoardHarness/viewer/ (tools/copy-viewer-to-app.js there); this file is the only app-only one. It sets
   window.HarnessTransport before harness.js runs, so the page asks TasksDashboardDB instead of a local server:
     getJson   /api/runs, /api/runs/<ts>, /api/runs/<ts>/feed/<name>, /api/budget  -> selects on harness_heads / harness_parts (db/031);
               /api/config and /api/limits (db/041, 2026-11-13): the person's own harness row (rpc/harness_prefs_read), the board's lists,
               budgets read now with their sign-in, and what a PC last published (harness_configs, household only);
               it never waits for a PC or a run head
     postJson  /api/action  -> rpc/harness_request, then the command's state until the PC that owns the run reports it;
               /api/limits -> rpc/harness_prefs_write on the person's own row (PT409 stale: read again, retried once); each PC syncs it
     events    polls the head's seq every 5 s while the page is visible (60 s hidden) and calls the page's change / runs handlers
     can       greys what the web cannot carry out now (decisions 2 and 5): "Run local version" with the reason
   Sign-in: the board's session (td.auth, Web Lock td.refresh, BroadcastChannel td.auth); signed out on a hosted origin it goes to
   /signin?next=/harness/. Network: only TD_CONFIG.supabaseUrl. Text from the database reaches the page only through harness.js,
   which renders agent text with textContent or its escaping helpers. */
(function () {
  'use strict';
  var AUTH_KEY = 'td.auth', HANDOVER_KEY = 'td.request.auth', STAY_KEY = 'td.signin.stay', DEV_KEY = 'eis.web.device';
  var SILENT_MS = 3 * 60000, POLL_MS = 5000, POLL_HIDDEN_MS = 60000, WAIT_MS = 150000;
  var EMPTY = {
    board_history: [], day: { done: [], not_taken: [], waiting: [], cost: 0, no_price: [] }, escalations: [], links: [], wakes: [], master_decisions: [], mother_decisions: {},
    planned: {}, stopped_at: null, prices: {}, ts: null, at: null, approval: null, start: null, inputs: null, usage_start: null, usage: [], stop: null, decisions: [], live: false,
    sessions: [], tasks: [], board: null, day_report: null, tokens_md: null
  };
  var LIST_ARRAYS = ['sessions', 'tasks', 'escalations', 'wakes', 'board_history'];

  // ---------- pure: the same merge as HomeOS-TasksBoardHarness/lib/run-snapshot.js (test/harness-remote.test.js keeps them equal) ----------
  function merge(parts) {
    var hh = parts.household || null, out = {}, k;
    if (hh) for (k in hh) out[k] = hh[k];
    else for (k in EMPTY) out[k] = JSON.parse(JSON.stringify(EMPTY[k]));
    var lists = Object.keys(parts).filter(function (x) { return x.indexOf('list:') === 0; }).map(function (x) { return parts[x]; });
    var join = function (home, extra) { return (home || []).concat(extra).sort(function (a, b) { return a._i - b._i; }).map(function (x) { return x.e; }); };
    LIST_ARRAYS.forEach(function (key) {
      var extra = [].concat.apply([], lists.map(function (l) { return l[key] || []; }));
      if (hh && Object.prototype.hasOwnProperty.call(hh, key) && !Array.isArray(hh[key]) && !extra.length) { out[key] = hh[key]; return; }
      out[key] = join(hh && Array.isArray(hh[key]) ? hh[key] : [], extra);
    });
    var items = join(hh && hh.board ? hh.board.items : [], [].concat.apply([], lists.map(function (l) { return l.board_items || []; })));
    if (hh && hh.board) out.board = Object.assign({}, hh.board, { items: items });
    else if (items.length) out.board = { items: items, lists: [], counts: {}, suspects: [], at: null, file: null };
    var md = Object.assign({}, (hh && hh.mother_decisions) || {});
    lists.forEach(function (l) { Object.assign(md, l.mother_decisions || {}); });
    out.mother_decisions = md;
    return out;
  }
  function mergeFeed(name, chunks) {
    var sorted = chunks.slice().sort(function (a, b) { return a.k - b.k; }), last = sorted[sorted.length - 1];
    return { name: name, entries: [].concat.apply([], sorted.map(function (c) { return c.entries || []; })), last_index: last ? last.last_index : -1,
      dropped: sorted.reduce(function (n, c) { return n + (c.dropped || 0); }, 0) };
  }
  // session name -> list id, from the list parts a reader could select (the head's own index is not readable, db/031)
  function sessionLists(rows) {
    var out = {};
    rows.forEach(function (r) { if (r.part.indexOf('list:') === 0) ((r.body && r.body.sessions) || []).forEach(function (x) { if (x && x.e && x.e.name) out[x.e.name] = r.part.slice(5); }); });
    return out;
  }
  // the limits a whole-form Save changes, one command per scope (decision 2): [{ scope_list, payload, base_hash }]
  function limitScopes(view, form) {
    var out = [], same = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
    if (form && form.scope === 'machine') {   // Workload "mothers at once" (db/036): always one command, the local page's POST body as { machine }
      var n = form.payload && form.payload.max_mothers;
      return [{ scope: 'machine', scope_list: null, payload: { machine: { max_mothers: n } }, base_hash: form.base_hash || (view.base_hash || {}).machine }];
    }
    var pick = function (r) { return { enabled: r.enabled, max_sessions: r.max_sessions, max_agents_per_session: r.max_agents_per_session }; };
    if (!same(view.defaults, form.defaults)) out.push({ scope: 'defaults', scope_list: null, payload: { defaults: form.defaults }, base_hash: (view.base_hash || {}).defaults });
    (view.rows || []).forEach(function (r) {
      var was = r.source === 'list' ? pick(r) : null, now = form.lists && Object.prototype.hasOwnProperty.call(form.lists, r.slug) ? pick(form.lists[r.slug]) : null;
      if (!same(was, now)) out.push({ scope: 'list:' + r.slug, scope_list: r.list_id || null, payload: { slug: r.slug, row: now }, base_hash: (view.base_hash || {})['list:' + r.slug] });
    });
    return out;
  }
  // may this reader press this control now? null = yes, else the reason after "Run local version" (decisions 2 and 5)
  function verdict(ctx, action, s, extra) {
    var dev = ctx.device, label = dev ? dev.label : 'the PC';
    if (action === 'claude') return 'needs this computer (run the local page)';
    if (action === 'copy') return null;   // the command text is in the published model; copying it needs no PC
    if (!dev) return 'no PC publishes this run';
    var silent = !dev.beat_at || ctx.now - Date.parse(dev.beat_at) > SILENT_MS || dev.state !== 'running';
    if (silent) return label + ' is silent';
    if (!dev.controls) return 'remote control is off on ' + label;
    var ownsPc = dev.owner_id && dev.owner_id === ctx.me, ownsList = function (id) { return !!id && ctx.roles[id] === 'owner'; };
    if (action === 'limits') {
      var sc = extra && extra.scope;
      if (sc === 'machine') return ownsPc ? null : 'only the owner of ' + label + ' may change mothers at once';
      if (sc === 'defaults') return ownsPc ? null : 'only the owner of ' + label + ' may change the default limits';
      if (sc && sc.indexOf('list:') === 0) { var row = (ctx.limits && ctx.limits.rows || []).filter(function (r) { return 'list:' + r.slug === sc; })[0]; return ownsList(row && row.list_id) ? null : 'only the owners of this list may change its limits'; }
      return ownsPc || (ctx.limits && ctx.limits.rows || []).some(function (r) { return ownsList(r.list_id); }) ? null : 'only the owners of a list may change limits';
    }
    if (s && s.role === 'master') return ownsPc ? null : 'only the owner of ' + label + ' may control its master';
    var id = s ? ctx.sessionList[s.name] : null;
    if (s && !id) return 'this session belongs to no list you own';
    return ownsList(id) ? null : 'only the owners of ' + (s && s.list ? s.list : 'this list') + ' may';
  }

  // ---------- pure: Workload limits from the person's own row (db/041) ----------
  var LIMIT_DEFAULTS = { max_sessions: 2, max_agents_per_session: 2 }, LIMIT_MAX = { max_sessions: 10, max_agents_per_session: 20 };
  // row: { prefs, version, updated_at } or null; lists: the board's lists; pubRows: the live counts a PC last published
  function limitsFromRow(row, lists, pubRows) {
    var p = (row && row.prefs) || {}, def = p.defaults || LIMIT_DEFAULTS, own = p.lists || {}, live = {}, by = {};
    (pubRows || []).forEach(function (r) { live[r.slug] = r.live || 0; });
    (lists || []).forEach(function (l) { by[l.slug] = l; });
    var slugs = (lists || []).map(function (l) { return l.slug; });
    Object.keys(own).forEach(function (x) { if (slugs.indexOf(x) < 0) slugs.push(x); });
    return { state: 'ok', source: 'db', version: row ? row.version : null, updated_at: row ? row.updated_at : null, errors: [], file: '', board: 'ok', defaults: def, max: LIMIT_MAX, base_hash: {}, ignored: [],
      rows: slugs.map(function (x) { var r = own[x] || def, l = by[x]; return { slug: x, name: l ? l.name : x, list_id: l ? l.id : null, on_board: !!l, source: own[x] ? 'list' : 'defaults', enabled: r.enabled !== false, max_sessions: r.max_sessions, max_agents_per_session: r.max_agents_per_session, live: live[x] || 0 }; }) };
  }
  // the row after a Workload save: { defaults, lists } (the whole form; other lists kept) or { scope: 'machine', payload: { max_mothers } } for one PC
  function rowAfterSave(prefs, form, device) {
    var p = JSON.parse(JSON.stringify(prefs || {}));
    p.version = 1; p.defaults = p.defaults || LIMIT_DEFAULTS; p.lists = p.lists || {}; p.devices = p.devices || {};
    if (form && form.scope === 'machine') { if (!device) throw new Error('no PC of yours is known yet: run the harness on it once'); p.devices[device] = Object.assign({}, p.devices[device], { max_mothers: form.payload && form.payload.max_mothers }); return p; }
    if (form && form.defaults) p.defaults = form.defaults;
    if (form && form.lists) Object.keys(form.lists).forEach(function (x) { p.lists[x] = form.lists[x]; });
    return p;
  }
  // what GET /api/config answers on the web. pub: a harness_configs row or null; fresh: { row, lists, budgets, device, error, at }
  function configAnswer(pub, fresh, label) {
    var c = (pub && pub.config) || {}, b = Object.assign({}, c.board || {}), f = fresh || {}, old = {};
    ((c.board && c.board.lists) || []).forEach(function (l) { old[l.id] = l; });
    if (f.lists) b.lists = f.lists.map(function (l) { var o = old[l.id] || {}, same = o.mode === l.mode; return Object.assign({}, l, { effective: same && o.effective ? o.effective : l.mode, why: same ? o.why || [] : [], overrides: o.overrides || 0, set_by: o.set_by || null, owner: o.owner || null }); });
    else if (!b.lists) b.lists = [];
    if (f.budgets) b.budgets = Object.assign({}, b.budgets || {}, { rows: f.budgets });
    var mine = f.row && f.row.prefs && f.row.prefs.devices && f.device ? f.row.prefs.devices[f.device] : null;
    var machine = Object.assign({}, c.machine || {}, mine && mine.max_mothers != null ? { max_mothers_set: mine.max_mothers } : {});
    return { device: c.device || label, limits: limitsFromRow(f.row, b.lists, c.limits && c.limits.rows), board: b, board_error: f.error || null, board_at: f.at || c.board_at || null, machine: machine, published_at: pub ? pub.published_at : null };
  }

  // ---------- the browser side ----------
  if (typeof window === 'undefined' || !window.document) { if (typeof module === 'object') module.exports = { merge: merge, mergeFeed: mergeFeed, sessionLists: sessionLists, limitScopes: limitScopes, verdict: verdict, configAnswer: configAnswer, limitsFromRow: limitsFromRow, rowAfterSave: rowAfterSave }; return; }
  var W = window, CFG = null, session = null, me = null, device = null, devices = {}, heads = [], roles = {}, lastLimits = null, sessionList = {}, headAt = {};
  var store = function (s) { try { return s(); } catch (e) { return null; } };
  var ls = { get: function (k) { return store(function () { return localStorage.getItem(k); }); }, set: function (k, v) { store(function () { localStorage.setItem(k, v); }); } };
  var ss = { get: function (k) { return store(function () { return sessionStorage.getItem(k); }); }, set: function (k, v) { store(function () { sessionStorage.setItem(k, v); }); }, del: function (k) { store(function () { sessionStorage.removeItem(k); }); } };
  var bc = store(function () { return new BroadcastChannel('td.auth'); });
  var hosted = /^https:/.test(location.origin) && !/^https:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(location.origin);

  function loadConfig() {
    if (W.TD_CONFIG) return Promise.resolve(W.TD_CONFIG);
    return new Promise(function (resolve, reject) {
      var sc = document.createElement('script');
      sc.src = '/config/tasksdashboard.config.js';
      sc.onload = function () { W.TD_CONFIG ? resolve(W.TD_CONFIG) : reject(new Error('the app config has no values')); };
      sc.onerror = function () { reject(new Error('the app config could not be loaded')); };
      document.head.appendChild(sc);
    });
  }
  function readRefresh() {
    var hand = ss.get(HANDOVER_KEY);
    if (hand) {   // back from /signin: its session becomes this origin's td.auth, as the board does
      ss.del(HANDOVER_KEY);
      try { var h = JSON.parse(hand); if (h && h.refresh_token) { var t = { refresh_token: h.refresh_token, uid: null }; (ls.get(STAY_KEY) === '0' ? ss : ls).set(AUTH_KEY, JSON.stringify(t)); return { kind: ls.get(STAY_KEY) === '0' ? 'session' : 'local', token: h.refresh_token }; } } catch (e) {}
    }
    var pairs = [['local', ls], ['session', ss]];
    for (var i = 0; i < pairs.length; i++) { try { var v = JSON.parse(pairs[i][1].get(AUTH_KEY) || 'null'); if (v && typeof v.refresh_token === 'string') return { kind: pairs[i][0], token: v.refresh_token }; } catch (e) {} }
    return null;
  }
  function withLock(fn) { var l = store(function () { return navigator.locks; }); return l ? l.request('td.refresh', fn) : fn(); }
  function refresh(force) {
    return withLock(function () {
      if (!force && session && session.expires_at - Date.now() > 60000) return session;
      var st = readRefresh();
      if (!st) return null;
      return fetch(CFG.supabaseUrl + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: CFG.publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: st.token }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) {
          if (!x.ok || !x.j.access_token) return null;
          session = { access_token: x.j.access_token, refresh_token: x.j.refresh_token, expires_at: Date.now() + (x.j.expires_in || 3600) * 1000, user: x.j.user };
          (st.kind === 'session' ? ss : ls).set(AUTH_KEY, JSON.stringify({ refresh_token: session.refresh_token, uid: session.user && session.user.id }));
          if (bc) bc.postMessage({ type: 'session', session: session });
          return session;
        });
    });
  }
  if (bc) bc.onmessage = function (e) { var m = (e && e.data) || {}; if (m.type === 'session' && m.session && (!session || (m.session.user && session.user && m.session.user.id === session.user.id))) session = m.session; };

  function rest(path, opt, retried) {
    opt = opt || {};
    return refresh(false).then(function (s) {
      if (!s) throw new Error('not signed in');
      return fetch(CFG.supabaseUrl + '/rest/v1/' + path, { method: opt.method || 'GET', headers: { apikey: CFG.publishableKey, Authorization: 'Bearer ' + s.access_token, 'Content-Type': 'application/json', 'x-homeos-via': 'app:harness' },
        body: opt.body === undefined ? undefined : JSON.stringify(opt.body) });
    }).then(function (r) {
      if (r.status === 401 && !retried) return refresh(true).then(function () { return rest(path, opt, true); });
      return r.text().then(function (t) { var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; } if (!r.ok) { var err = new Error((j && j.message) || ('HTTP ' + r.status)); err.code = j && j.code; err.status = r.status; throw err; } return j; });
    });
  }
  var rpc = function (name, args) { return rest('rpc/' + name, { method: 'POST', body: args }); };
  var q = encodeURIComponent;

  function loadDevices() {
    return rest('harness_devices?select=device,label,owner_id,beat_at,state,controls').then(function (rows) { devices = {}; (rows || []).forEach(function (d) { devices[d.device] = d; }); });
  }
  function loadHeads() {
    return rest('harness_heads?select=device,run_ts,seq,live,head,updated_at&order=run_ts.desc').then(function (rows) {
      heads = rows || [];
      var hm = /[#&]device=([A-Za-z0-9_-]{1,40})/.exec(location.hash), want = hm ? hm[1] : ss.get(DEV_KEY);
      var has = function (d) { return heads.some(function (h) { return h.device === d; }); };
      if (!want || !has(want)) { var live = heads.filter(function (h) { return h.live; })[0]; want = (live || heads[0] || {}).device || null; }
      device = want; if (want) ss.set(DEV_KEY, want);
    });
  }
  var myHeads = function () { return heads.filter(function (h) { return h.device === device; }); };
  var headOf = function (ts) { return myHeads().filter(function (h) { return h.run_ts === ts; })[0] || null; };

  var ready = loadConfig().then(function (c) { CFG = c; return refresh(false); }).then(function (s) {
    if (!s) {
      if (hosted) { location.replace('/signin?next=/harness/'); return new Promise(function () {}); }
      throw new Error('not signed in. Sign in on the board (/board/) in this browser, then reload this page');
    }
    me = s.user && s.user.id;
    return Promise.all([loadDevices(), loadHeads(), rest('list_members?select=list_id,role&profile_id=eq.' + q(me)).then(function (r) { roles = {}; (r || []).forEach(function (m) { roles[m.list_id] = m.role; }); }).catch(function () { roles = {}; })]);
  });

  function household(ts, field) {
    return rest('harness_parts?select=v:body->' + field + '&device=eq.' + q(device) + '&run_ts=eq.' + q(ts) + '&part=eq.household').then(function (r) { return r && r[0] ? r[0].v : null; });
  }
  function readRun(ts) {
    return rest('harness_parts?select=part,list_id,seq,body&device=eq.' + q(device) + '&run_ts=eq.' + q(ts) + '&part=not.like.' + q('feed:*')).then(function (rows) {
      var h = headOf(ts), want = h && h.head && Array.isArray(h.head.parts) ? h.head.parts : null, parts = {};
      rows = (rows || []).filter(function (r) { return !want || want.indexOf(r.part) >= 0; });   // C3: only the parts the head names
      rows.forEach(function (r) { parts[r.part] = r.body; });
      Object.assign(sessionList, sessionLists(rows));
      var m = merge(parts);
      if (m.limits_view) lastLimits = m.limits_view;
      delete m.budget; delete m.limits_view; delete m.config;   // config: GET /api/config reads it on its own
      m.ts = m.ts || ts; m.at = h && h.head ? h.head.at || null : null; headAt[ts] = h ? h.seq : null;
      if (!rows.length) throw new Error('no data of this run on the web yet');
      return m;
    });
  }
  function readFeed(ts, name, after) {
    return rest('harness_parts?select=part,body&device=eq.' + q(device) + '&run_ts=eq.' + q(ts) + '&part=like.' + q('feed:' + name + ':*')).then(function (rows) {
      var f = mergeFeed(name, (rows || []).map(function (r) { return r.body; }));
      if (after >= 0) f.entries = f.entries.filter(function (e) { return e.i > after; });
      return f;
    });
  }
  function getJson(u) {
    return ready.then(function () {
      var m;
      if (u === '/api/runs') return loadHeads().then(function () { return myHeads().map(function (h) { return Object.assign({ ts: h.run_ts }, (h.head && h.head.run) || {}, { ts: h.run_ts, device: (devices[h.device] || {}).label || h.device }); }); });
      if (u === '/api/budget') { var n = myHeads()[0]; return n ? household(n.run_ts, 'budget').then(function (b) { return b || {}; }) : Promise.resolve({}); }
      if (u === '/api/limits') return webConfig().then(function (c) { return c.limits; });
      if ((m = /^\/api\/runs\/([0-9a-z_-]+)\/feed\/([a-z0-9_-]+)(?:\?after=(-?\d+))?$/.exec(u))) return readFeed(m[1], m[2], m[3] ? Number(m[3]) : -1);
      if ((m = /^\/api\/runs\/([0-9a-z_-]+)$/.exec(u))) return readRun(m[1]);
      if (u === '/api/config' || u === '/api/config?fresh=1') return webConfig();
      throw new Error('not on the web: ' + u);
    });
  }

  // db/041: the person's own row, the board read now, and what a PC last published; no PC or run head needed
  var LCOLS = 'id,slug,name,owner_id,autonomy,e2e_self,notify_telegram,project_dir,brief_decisions,brief_naming,brief_instruction,brief_concept';
  var readRow = function () { return rpc('harness_prefs_read', {}); };
  function myDevice() {
    if (device) return device;
    var own = Object.keys(devices).filter(function (k) { return devices[k].owner_id === me; });
    return own[0] || null;
  }
  function webConfig() {
    return ready.then(function () {
    var f = { device: myDevice(), at: new Date().toISOString() }, label = (devices[f.device] || {}).label || f.device || 'the PC';
    return Promise.all([
      rest('harness_configs?select=device,config,published_at&order=published_at.desc').catch(function () { return []; }),
      readRow().catch(function () { return null; }),
      rest('lists?select=' + LCOLS + '&archived_at=is.null&order=name').catch(function (e) { f.error = friendly(e); return null; }),
      rpc('budget_status', { p_list: null }).catch(function () { return null; })
    ]).then(function (x) {
      var pubs = x[0] || [], pub = pubs.filter(function (p) { return p.device === f.device; })[0] || pubs[0] || null;
      f.row = x[1];
      f.lists = x[2] ? x[2].map(function (l) { return { id: l.id, slug: l.slug, name: l.name, owner_id: l.owner_id, mode: l.autonomy || 'guided', intake: { e2e_self: l.e2e_self, notify_telegram: l.notify_telegram }, project_dir: l.project_dir || null,
        brief_texts: { decisions: l.brief_decisions || '', naming: l.brief_naming || '', instruction: l.brief_instruction || '', concept: l.brief_concept || '' } }; }) : null;
      var overall = x[3];
      var per = overall && f.lists ? Promise.all(f.lists.map(function (l) { return rpc('budget_status', { p_list: l.id }).catch(function () { return []; }); })) : Promise.resolve([]);
      return per.then(function (lists) {
        if (overall) {
          var rows = overall.filter(function (r) { return r.scope === 'overall'; }).slice();
          lists.forEach(function (rs, i) { (rs || []).filter(function (r) { return r.list_id === f.lists[i].id; }).forEach(function (r) { rows.push(Object.assign({}, r, { slug: f.lists[i].slug })); }); });
          f.budgets = rows;
        }
        var a = configAnswer(pub, f, label); lastLimits = a.limits; return a;
      });
    });
    });
  }

  function idem() { var a = new Uint8Array(12); (W.crypto || {}).getRandomValues ? W.crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; }); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function friendly(e) {
    if (e.code === '28000') return 'Sign in again: a note or a limits change needs a sign-in from the last 15 minutes. Sign out and in on the board, then press again.';
    return String(e.message || e);
  }
  function request(args) {
    return rpc('harness_request', Object.assign({ p_device: device, p_idem_key: idem() }, args)).then(function (c) {
      var until = Date.now() + WAIT_MS;
      var look = function () {
        return rest('harness_commands?select=state,result&id=eq.' + q(c.id)).then(function (r) {
          var x = (r && r[0]) || c;
          if (x.state === 'pending' || x.state === 'taken') { if (Date.now() > until) return { state: 'expired', result: 'no answer from the PC' }; return new Promise(function (ok) { setTimeout(ok, 2000); }).then(look); }
          return x;
        });
      };
      return look();
    });
  }
  function postJson(u, body) {
    return ready.then(function () {
      var label = (devices[device] || {}).label || device;
      if (u === '/api/action') {
        return request({ p_run_ts: body.run, p_action: body.action, p_name: body.name, p_note: body.note || null, p_expect_state: body.expect_state || null }).then(function (x) {
          return x.state === 'done' ? { ok: true, status: 200, json: { queued: label + ': ' + (x.result || 'done') + '.' } } : { ok: false, status: 409, json: { error: x.state + (x.result ? ': ' + x.result : '') } };
        }, function (e) { return { ok: false, status: 400, json: { error: friendly(e) } }; });
      }
      if (u === '/api/limits') {
        var write = function (again) {
          return readRow().then(function (row) {
            return rpc('harness_prefs_write', { p_prefs: rowAfterSave(row && row.prefs, body, myDevice()), p_expected: row ? row.version : null });
          }).catch(function (e) { if (!again && (e.status === 409 || e.code === 'PT409')) return write(true); throw e; });
        };
        return write(false).then(function () { return getJson('/api/limits'); }).then(function (v) { return { ok: true, status: 200, json: v }; },
          function (e) { return { ok: false, status: e.status || 400, json: { error: 'not saved', errors: [friendly(e)] } }; });
      }
      return { ok: false, status: 404, json: { error: 'not on the web' } };
    });
  }

  function events(ts, h) {
    var lastSeq = null, lastList = null, lastDev = null, timer = 0;
    var tick = function () {
      ready.then(function () { return Promise.all([loadHeads(), loadDevices()]); }).then(function () {
        var head = headOf(ts), d = devices[device];
        var list = myHeads().map(function (x) { return x.run_ts + (x.live ? '*' : ''); }).join(',');
        if (lastList !== null && list !== lastList) h.runs();
        lastList = list;
        if (head && lastSeq !== null && head.seq !== lastSeq) h.change();
        if (head) lastSeq = head.seq;
        var silent = !d || !d.beat_at || Date.now() - Date.parse(d.beat_at) > SILENT_MS || d.state !== 'running';
        var devSig = silent + '|' + !!(d && d.controls);   // the PC fell silent, came back or switched its controls: render the buttons again
        if (lastDev !== null && devSig !== lastDev) h.change();
        lastDev = devSig;
        if (silent) h.error('No data from ' + (d ? d.label : 'the PC') + (d && d.beat_at ? ' for ' + Math.round((Date.now() - Date.parse(d.beat_at)) / 60000) + ' min' : '') + '. Buttons need the local version.');
        else h.open();
        if (!document.hidden) rpc('harness_view', { p_device: device }).catch(function () {});
      }).catch(function (e) { h.error('The web copy cannot be read: ' + friendly(e)); }).then(function () {
        timer = setTimeout(tick, document.hidden ? POLL_HIDDEN_MS : POLL_MS);
      });
    };
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { clearTimeout(timer); tick(); } });
    tick();
  }

  function can(action, s, extra) {
    if (action === 'limits') return me ? { ok: true } : { ok: false, why: 'sign in on the board' };   // db/041: the reader's own row
    var why = verdict({ device: devices[device] || null, me: me, roles: roles, sessionList: sessionList, limits: lastLimits, now: Date.now() }, action, s, extra);
    return why ? { ok: false, why: why } : { ok: true };
  }

  // what the buttons depend on besides the session (the PC's beat, its controls switch): harness.js renders the open panel again when it changes
  function stamp() { var d = devices[device]; return d ? [!d.beat_at || Date.now() - Date.parse(d.beat_at) > SILENT_MS || d.state !== 'running', !!d.controls, me].join('|') : ''; }

  // rpc and ready: for bridge.js only (the local harness page writes Autonomy and budgets with this origin's sign-in through it)
  W.HarnessTransport = { getJson: getJson, postJson: postJson, events: events, can: can, stamp: stamp, rpc: rpc, ready: ready, whoami: function () { return me; } };
})();
