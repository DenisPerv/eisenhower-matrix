/* Eisenhower harness viewer: the Configurations page (harness-configurations-plan.md T11, UI spec references/homeos/harness-configurations/ui/
   configurations-page-spec.md, winner p1 with the p2 changes). Tabs Workload, Autonomy, Budgets, Model routing (read only: config/routing.json);
   Notifications and Machine removed and the mothers cap moved to Workload (Maksym, 2026-11-11).
   Reads GET /api/config. Writes this device's limits file through the page's own POST /api/limits (Workload: mothers, lists, Reset all), and
   Autonomy and budgets with the person's own board sign-in: set_autonomy and set_budget through the board bridge (a hidden frame of
   http://localhost:8788/harness/bridge.html), or straight through HarnessTransport.rpc on the web copy (never the bridge there). homeos-agent never
   writes them. On the web /api/config is what the PC last published (harness-web.js, about once a minute while viewed): a saved change is
   applied to the shown data at once (S.opt) and kept until a read newer than the save shows the board's own value.
   Uses what harness.js hands over (its UI object): el, $, panelHead, panelBody, openPanel, getJson, postJson, renderLimits, restoreSize, markSel, setLit, state, PO, canDo. */
(function () {
  'use strict';
  var el, $, panelHead, panelBody, openPanel, getJson, postJson, renderLimits, restoreSize, markSel, setLit, state, PO, canDo;   // from harness.js (UI), set on open
  var SVGNS = 'http://www.w3.org/2000/svg';
  var BOARD = 'http://localhost:8788/';
  var DAY = 864e5;
  var MODES = {
    manual: { n: 'Manual (old)', does: 'Agent does: nothing.', you: 'Comes to you: everything. No longer offered: pick another mode.' },
    project_rules: { n: 'Project rules', does: "Agent does: what the project's rules allow; with no rules, as Mixed.", you: 'Comes to you: anything the rules do not cover.' },
    guided: { n: 'Mixed', does: "Agent does: plans and work; the list's mother approves plans.", you: 'Comes to you: every question and every result check.' },
    ai_brain: { n: 'AI Brain', does: 'Agent does: plans, side questions and checks, with your past answers.', you: 'Comes to you: security, data structure and E0.' }
  };
  var ORDER = ['project_rules', 'guided', 'ai_brain'];   // the modes a person picks (Maksym 2026-11-11: Project rules, Mixed, AI Brain); 'guided' is Mixed in the DB
  var TABS = [['workload', 'Workload'], ['autonomy', 'Autonomy'], ['budgets', 'Budgets'], ['routing', 'Model routing']];
  var S = { tab: 'workload', filter: 'all', series: 'overall', range: 'month', data: null, error: null, cursor: null, opt: { mode: {}, cap: {} } };
  var web = function () { return !!(window.HarnessTransport && typeof window.HarnessTransport.rpc === 'function'); };
  var WEBST = function () { return S.data && S.data.web && S.data.web.state ? S.data.web : null; };

  function sv(tag, attrs, txt) { var e = document.createElementNS(SVGNS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (txt != null) e.textContent = txt; return e; }
  function money(v) { return '$' + (Number(v) || 0).toFixed(2); }
  function moneyShort(v) { v = Number(v) || 0; return '$' + (Math.round(v * 100) % 100 ? v.toFixed(2) : String(Math.round(v))); }
  function ymd(t, time) { var d = new Date(t), p = function (n) { return String(n).padStart(2, '0'); }; var s = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); return time ? s + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) : s; }
  function cell(tr, label, cls, txt) { var c = el('td', cls || null, txt == null ? null : txt); c.setAttribute('data-l', label); tr.appendChild(c); return c; }
  function table(cap, heads) { var t = el('table', 'cfg-t stack'); var c = el('caption', 'vh', cap); t.appendChild(c); var th = el('thead'), r = el('tr'); heads.forEach(function (h) { var x = el('th', h[1] || null, h[0]); x.scope = 'col'; r.appendChild(x); }); th.appendChild(r); t.appendChild(th); t.appendChild(el('tbody')); return t; }
  function modeMark(m) {
    var s = sv('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' }), c = '#aab6cc';
    if (m === 'manual') s.appendChild(sv('rect', { x: 1.5, y: 1.5, width: 9, height: 9, fill: 'none', stroke: c, 'stroke-width': 1.5 }));
    else if (m === 'project_rules') s.appendChild(sv('path', { d: 'M6 1.5 10.5 10.5h-9z', fill: 'none', stroke: c, 'stroke-width': 1.5 }));
    else if (m === 'ai_brain') s.appendChild(sv('circle', { cx: 6, cy: 6, r: 5, fill: '#c4b5ff' }));
    else s.appendChild(sv('circle', { cx: 6, cy: 6, r: 4.5, fill: 'none', stroke: c, 'stroke-width': 1.5 }));
    return s;
  }
  function modeEl(m) { var w = el('span', 'cfg-mode'); w.appendChild(modeMark(m)); w.appendChild(document.createTextNode((MODES[m] || MODES.guided).n)); return w; }
  function skel() { var w = el('div'); w.setAttribute('aria-busy', 'true'); w.appendChild(el('p', 'vh', 'Loading the harness data.')); ['w8', 'w6', 'w8', 'w4'].forEach(function (c) { w.appendChild(el('span', 'cfg-skel ' + c)); }); return w; }
  function lists() { return (S.data && S.data.board && S.data.board.lists) || []; }
  function limRows() { return (S.data && S.data.limits && S.data.limits.rows) || []; }

  /* ---------- status lines under the tab names (p2 change 2) ---------- */
  function status(id) {
    var d = S.data; if (!d) return '';
    if (WEBST()) return WEBST().state === 'guest' ? 'household only' : 'waiting';
    if (id === 'routing') { var R = d.board && d.board.routing; return R ? 'read only' : 'not read'; }
    if (id === 'workload') { var live = 0, max = 0; limRows().forEach(function (r) { live += r.live || 0; if (r.enabled !== false) max += r.max_sessions || 0; }); return live + ' of ' + max + ' sessions live'; }
    if (id === 'autonomy') { var b = lists().filter(function (l) { return l.effective === 'ai_brain'; }).length; return lists().length ? (b ? b + ' on AI Brain' : 'all Mixed or narrower') : 'board not read'; }
    if (id === 'budgets') { var rows = (d.board && d.board.budgets && d.board.budgets.rows) || []; if (!rows.length) return 'no budget set'; var at = rows.filter(function (r) { return r.reached; }).length; return at ? at + ' at cap' : 'below caps'; }
    return 'TBD';
  }

  /* ---------- tabs (ARIA tablist; a 3x2 grid on phones, p2 change 5) ---------- */
  function tabsEl(host) {
    var bar = el('div', 'cfg-tabs'); bar.setAttribute('role', 'tablist'); bar.setAttribute('aria-label', 'Configurations');
    var btns = TABS.map(function (t, i) {
      var b = el('button'); b.type = 'button'; b.id = 'cfgt-' + t[0]; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', 'cfgp-' + t[0]);
      b.appendChild(el('span', 'cfg-tn', t[1])); b.appendChild(el('span', 'cfg-ts', status(t[0])));
      b.onclick = function () { select(t[0], false); };
      b.onkeydown = function (e) { var k = e.key, j = null; if (k === 'ArrowRight') j = (i + 1) % TABS.length; else if (k === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length; else if (k === 'Home') j = 0; else if (k === 'End') j = TABS.length - 1; if (j !== null) { e.preventDefault(); btns[j].focus(); } };
      bar.appendChild(b); return b;
    });
    host.appendChild(bar);
    return btns;
  }
  var tabBtns = [], panels = {};
  function select(id, focus) {
    S.tab = id;
    tabBtns.forEach(function (b) { var on = b.id === 'cfgt-' + id; b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
    Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== id; });
    try { localStorage.setItem('eis-cfg-tab', id); } catch (e) { /* a convenience only */ }
    if (id === 'budgets') drawChart();
  }

  /* ---------- Workload (edited in place, saved on change; Maksym 2026-11-11) ---------- */
  function gateOf(scope) { if (typeof canDo !== 'function') return null; var g = canDo('limits', null, { scope: scope }); return g && g.ok === false ? 'Run local version' + (g.why ? '\n' + g.why : '') : null; }
  function numIn(val, max, label) { var i = el('input', 'cfg-num'); i.type = 'number'; i.step = '1'; i.min = '0'; i.max = String(max); i.value = val; i.setAttribute('aria-label', label); return i; }
  var wlTimer = 0;
  function saveLists(rowsOut, msg, okText) {
    var L = S.data.limits || {}, n = function (v) { return v === '' ? NaN : Number(v); };
    var listsOut = {}; rowsOut.forEach(function (r) { listsOut[r.slug] = { enabled: r.enabled, max_sessions: n(r.max_sessions), max_agents_per_session: n(r.max_agents_per_session) }; });
    msg.className = 'cfg-msg'; msg.textContent = 'Saving…';
    return postJson('/api/limits', { defaults: L.defaults, lists: listsOut, base_hash: L.base_hash }).then(function (r) {
      if (r.ok) { S.data.limits = r.json; renderAll(); var m2 = $('cfg-wl-msg'); if (m2) m2.textContent = okText || 'Saved to this device.'; }
      else { msg.className = 'cfg-msg bad'; msg.textContent = ((r.json && (r.json.errors || [r.json.error])) || ['Not saved.']).join('; ') + ' Nothing was saved.'; }
    }).catch(function () { msg.className = 'cfg-msg bad'; msg.textContent = 'The server did not answer. Nothing was saved.'; });
  }
  function renderWorkload(p) {
    p.textContent = '';
    if (!S.data) { p.appendChild(skel()); return; }
    if (webState(p)) return;
    var rows = limRows(), live = 0, max = 0, L = S.data.limits || {}, MX = L.max || {}, DEF = L.defaults || {};
    rows.forEach(function (r) { live += r.live || 0; if (r.enabled !== false) max += r.max_sessions || 0; });
    var sec = el('section', 'cfg-sec'); sec.appendChild(el('h3', null, 'This device'));
    var t = table('This device and its sessions', [['Device'], ['Runs sessions'], ['Live / limit']]), tr = el('tr');
    var c1 = cell(tr, 'Device', 'h'); c1.appendChild(el('span', null, (S.data.device || 'this device') + ' (this device)')); c1.appendChild(el('span', 'cfg-st', max ? 'Online' : 'Off: takes no new sessions'));
    cell(tr, 'Runs sessions', null, max ? 'On' : 'Off');
    cell(tr, 'Live / limit').appendChild(meter(live, max));
    t.tBodies[0].appendChild(tr); sec.appendChild(t);
    sec.appendChild(el('p', 'cfg-note', 'Limits are per device (D57): the other device sets its own on its own page.'));
    p.appendChild(sec);
    // mothers at once (was the Machine tab)
    var M = S.data.machine || {}, sm = el('section', 'cfg-sec'); sm.appendChild(el('h3', null, 'Mother sessions on this device'));
    var mrow = el('div', 'cfg-inline'), ml = el('label', null, 'Mothers at once '), mi = numIn(M.max_mothers_set != null ? M.max_mothers_set : 2, 10, 'Mothers at once on this device'); mi.id = 'cfg-mothers'; mi.min = '1';
    ml.htmlFor = 'cfg-mothers'; mrow.appendChild(ml); mrow.appendChild(mi);
    var mmsg = el('span', 'cfg-msg'); mmsg.setAttribute('role', 'status'); mrow.appendChild(mmsg); sm.appendChild(mrow);
    sm.appendChild(el('p', 'cfg-note', 'One mother runs one list. ' + (M.max_mothers_set != null ? 'Set on this device.' : 'Default: 2.')));
    var mg = gateOf('machine'); if (mg) { mi.disabled = true; mi.title = mg; }
    mi.onchange = function () {
      var v = Number(mi.value); if (!(v >= 1 && v <= 10 && Math.round(v) === v)) { mmsg.className = 'cfg-msg bad'; mmsg.textContent = 'A whole number from 1 to 10.'; mi.value = M.max_mothers_set != null ? M.max_mothers_set : 2; return; }
      mmsg.className = 'cfg-msg'; mmsg.textContent = 'Saving…';
      postJson('/api/limits', { scope: 'machine', payload: { max_mothers: v }, base_hash: (L.base_hash && L.base_hash.machine) || null })
        .then(function (r) { if (r.ok) { mmsg.textContent = 'Saved to this device.'; load(); } else { mmsg.className = 'cfg-msg bad'; mmsg.textContent = 'Could not write the limits file. Not saved.'; } })
        .catch(function () { mmsg.className = 'cfg-msg bad'; mmsg.textContent = 'Could not write the limits file. Not saved.'; });
    };
    p.appendChild(sm);
    // per list, edited in place
    var s2 = el('section', 'cfg-sec'); s2.appendChild(el('h3', null, 'Per list on this device'));
    var msg = el('p', 'cfg-msg'); msg.id = 'cfg-wl-msg'; msg.setAttribute('role', 'status');
    var t2 = table('Lists, their limits and live sessions', [['List'], ['On'], ['Sessions', 'n'], ['Subagents', 'n'], ['Live / limit']]);
    if (!rows.length) { var e = el('div', 'cfg-empty'); e.appendChild(el('b', null, 'No lists yet.')); e.appendChild(document.createTextNode('A list shows here after the board is read.')); s2.appendChild(e); }
    var collect = function () { return [].map.call(t2.tBodies[0].rows, function (tr2) { var q = function (f) { return tr2.querySelector('[data-f="' + f + '"]'); }; return { slug: tr2.dataset.slug, enabled: q('enabled').checked, max_sessions: q('max_sessions').value, max_agents_per_session: q('max_agents_per_session').value }; }); };
    var changed = function () { clearTimeout(wlTimer); wlTimer = setTimeout(function () { saveLists(collect(), msg); }, 500); };
    rows.forEach(function (r) {
      var tr2 = el('tr'); tr2.dataset.slug = r.slug; if (r.enabled === false) tr2.className = 'muted';
      var nm = cell(tr2, 'List', 'h', r.name || r.slug); if (r.on_board === false) nm.appendChild(el('span', 'cfg-st', 'not on the board'));
      var cb = el('input'); cb.type = 'checkbox'; cb.checked = r.enabled !== false; cb.dataset.f = 'enabled'; cb.setAttribute('aria-label', (r.name || r.slug) + ' on'); cb.onchange = changed; cell(tr2, 'On').appendChild(cb);
      var i1 = numIn(r.max_sessions, MX.max_sessions || 10, (r.name || r.slug) + ' max sessions'); i1.dataset.f = 'max_sessions'; i1.onchange = changed; cell(tr2, 'Sessions', 'n').appendChild(i1);
      var i2 = numIn(r.max_agents_per_session, MX.max_agents_per_session || 10, (r.name || r.slug) + ' max subagents'); i2.dataset.f = 'max_agents_per_session'; i2.onchange = changed; cell(tr2, 'Subagents', 'n').appendChild(i2);
      cell(tr2, 'Live / limit').appendChild(meter(r.live || 0, r.enabled === false ? 0 : r.max_sessions || 0));
      var g = gateOf('list:' + r.slug); if (g) [cb, i1, i2].forEach(function (x) { x.disabled = true; x.title = g; });
      t2.tBodies[0].appendChild(tr2);
    });
    if (rows.length) s2.appendChild(t2);
    var acts = el('div', 'cfg-acts'), rb = el('button', 'btn', 'Reset all'); rb.type = 'button';
    rb.title = 'Every list on, with the default sessions and subagents of this device';
    rb.onclick = function () {
      if (!window.confirm('Reset every list on this device to on, ' + DEF.max_sessions + ' sessions and ' + DEF.max_agents_per_session + ' subagents?')) return;
      clearTimeout(wlTimer); saveLists(rows.map(function (r) { return { slug: r.slug, enabled: true, max_sessions: String(DEF.max_sessions), max_agents_per_session: String(DEF.max_agents_per_session) }; }), msg, 'Every list reset to the defaults.');
    };
    if (!rows.length || gateOf('any')) rb.disabled = true;
    acts.appendChild(rb); s2.appendChild(acts); s2.appendChild(msg);
    s2.appendChild(el('p', 'cfg-note', 'On unticked: this device takes no task of that list (max sessions 0 on this device only); the other device and the board are not changed. Changes save on their own. A session started for a task with its own Autonomy mode counts against its list’s limit like any other.'));
    p.appendChild(s2);
  }
  function meter(live, max) { var m = el('span', 'cfg-meter' + (max > 0 && live >= max ? ' full' : '')); var tr = el('span', 'tr'), f = el('span'); f.style.width = (max ? Math.min(100, live / max * 100) : 0) + '%'; tr.appendChild(f); m.appendChild(tr); m.appendChild(el('b', null, live + ' / ' + max)); if (max > 0 && live >= max) m.appendChild(el('span', 'flag', 'at limit')); return m; }

  /* ---------- the board bridge: writes with the person's own board sign-in (set_autonomy, set_budget) ---------- */
  var BR = { frame: null, ready: null, wait: {}, n: 0, hello: null };
  function bridgeReady() {
    if (BR.ready) return BR.ready;
    if (location.hostname !== 'localhost') return Promise.reject(new Error('saving needs this page at http://localhost:' + (location.port || '8790') + '/ (the board signs in on localhost; on ' + location.hostname + ' the browser keeps the two apart). Open it there and try again'));
    BR.ready = new Promise(function (resolve, reject) {
      var origin = BOARD.replace(/\/$/, ''), done = false;
      var to = setTimeout(function () { if (!done) { done = true; BR.ready = null; reject(new Error('the board at ' + origin + ' did not answer. Is it running (localhost:8788)?')); } }, 12000);
      window.addEventListener('message', function (e) {
        if (e.origin !== origin || !BR.frame || e.source !== BR.frame.contentWindow) return;
        var m = e.data || {};
        if (m.bridge === 'loaded') BR.frame.contentWindow.postMessage({ bridge: 'hello' }, origin);
        else if (m.bridge === 'hello' && !done) { done = true; clearTimeout(to); BR.hello = m; if (m.signedIn) resolve(m); else { BR.ready = null; reject(new Error('not signed in on the board. Sign in at ' + origin + '/board/ in this browser, then try again')); } }
        else if (m.bridge === 'reply' && BR.wait[m.id]) { var w = BR.wait[m.id]; delete BR.wait[m.id]; if (m.ok) w.ok(m.result); else w.no(Object.assign(new Error(m.error || 'refused'), { code: m.code })); }
      });
      if (BR.frame) BR.frame.remove();
      BR.frame = el('iframe'); BR.frame.hidden = true; BR.frame.title = 'Board bridge'; BR.frame.setAttribute('aria-hidden', 'true'); BR.frame.src = origin + '/harness/bridge.html';
      document.body.appendChild(BR.frame);
    });
    return BR.ready;
  }
  // on 127.0.0.1 the board's sign-in (localhost:8788) is out of reach: say so above the controls, with the link
  function hostNote(p) {
    if (location.hostname === 'localhost' || (window.HarnessTransport && window.HarnessTransport.rpc)) return;
    var d = el('div', 'cfg-banner'), u = 'http://localhost:' + (location.port || '8790') + '/' + location.hash, a = el('a', 'lk', u); a.href = u;
    d.appendChild(el('span', null, 'To save here, open this page at ')); d.appendChild(a); d.appendChild(el('span', null, ': changes are saved with your board sign-in on localhost.')); p.appendChild(d);
  }
  function boardRpc(name, args) {
    var T = window.HarnessTransport;
    if (T && typeof T.rpc === 'function') return T.rpc(name, args);   // the web copy: same origin as the board
    return bridgeReady().then(function () {
      return new Promise(function (ok, no) {
        var id = 'r' + (++BR.n) + '-' + Date.now(); BR.wait[id] = { ok: ok, no: no };
        setTimeout(function () { if (BR.wait[id]) { delete BR.wait[id]; no(new Error('the board did not answer in time')); } }, 20000);
        BR.frame.contentWindow.postMessage({ bridge: 'rpc', id: id, name: name, args: args }, BOARD.replace(/\/$/, ''));
      });
    });
  }

  /* ---------- Autonomy (edited here too, Maksym 2026-11-11: harness page, board and phone) ---------- */
  function renderAutonomy(p) {
    p.textContent = '';
    if (!S.data) { p.appendChild(skel()); return; }
    if (webState(p)) return;
    if (!S.data.board) { p.appendChild(banner('The board could not be read' + (S.data.board_error ? ': ' + S.data.board_error : '') + '. Modes are shown once it can.')); }
    hostNote(p);
    var wrap = el('div', 'cfg-au'), side = el('aside', 'cfg-au-side'); side.setAttribute('aria-label', 'What each mode means'); var host = p; p = el('div', 'cfg-au-main'); wrap.appendChild(p); wrap.appendChild(side); host.appendChild(wrap);
    var ls = lists(), cards = el('div', 'cfg-cards'); cards.setAttribute('role', 'group'); cards.setAttribute('aria-label', 'Filter by mode');
    var shown = ORDER.concat(ls.some(function (l) { return l.effective === 'manual'; }) ? ['manual'] : []);
    [['all', 'All lists']].concat(shown.map(function (m) { return [m, MODES[m].n]; })).forEach(function (x) {
      var n = x[0] === 'all' ? ls.length : ls.filter(function (l) { return l.effective === x[0]; }).length;
      var b = el('button', 'cfg-card'); b.type = 'button'; b.setAttribute('aria-pressed', S.filter === x[0] ? 'true' : 'false');
      if (x[0] !== 'all') b.appendChild(modeMark(x[0])); b.appendChild(el('b', null, String(n))); b.appendChild(el('span', null, x[1]));
      b.onclick = function () { S.filter = x[0]; renderAutonomy(host); }; cards.appendChild(b);
    });
    p.appendChild(cards);
    var msg = el('p', 'cfg-msg'); msg.id = 'cfg-au-msg'; msg.setAttribute('role', 'status');
    var rows = ls.filter(function (l) { return S.filter === 'all' || l.effective === S.filter; });
    var t = table('Lists and their Autonomy mode', [['List'], ['Mode'], ['Set by'], ['Tasks with own mode', 'n']]);
    rows.forEach(function (l) {
      var tr = el('tr'); cell(tr, 'List', 'h', l.name);
      var cm = cell(tr, 'Mode'), sel = el('select', 'cfg-sel'); sel.setAttribute('aria-label', 'Autonomy mode of ' + l.name);
      ORDER.concat(ORDER.indexOf(l.mode) < 0 ? [l.mode] : []).forEach(function (m) { var o = el('option', null, (MODES[m] || MODES.guided).n + (m === 'guided' ? ' (default)' : '')); o.value = m; if (m === l.mode) o.selected = true; if (ORDER.indexOf(m) < 0) o.disabled = true; sel.appendChild(o); });
      if (!l.id) { sel.disabled = true; sel.title = 'Restart the page server: it does not send list ids yet.'; }
      sel.onchange = function () {
        var want = sel.value, was = l.mode; sel.disabled = true; msg.className = 'cfg-msg'; writeStart();
        msg.textContent = WR.pend > 1 ? 'Saving ' + WR.pend + ' changes with your board sign-in…' : 'Saving ' + l.name + ' with your board sign-in…';
        l.mode = want; l.effective = want;   // shown at once; the read after the last write confirms it
        boardRpc('set_autonomy', { p_kind: 'list', p_id: l.id, p_mode: want, p_expected: was }).then(function () {
          S.opt.mode[l.id] = { mode: want, at: Date.now() };
          sel.disabled = false; writeEnd(); msg.textContent = WR.pend ? 'Saved ' + l.name + '; ' + WR.pend + ' more saving…' : l.name + ': ' + MODES[want].n + '. Saved on the board.';
        }, function (e) { l.mode = was; l.effective = was; sel.disabled = false; sel.value = was; writeEnd(); msg.className = 'cfg-msg bad'; msg.textContent = l.name + ' not saved: ' + (/not allowed/.test(e.message) ? 'only its owner or an editor may change its mode' + (l.owner ? ' (owner: ' + l.owner + '); ask them to share it with you as editor' : '') : e.message); });
      };
      cm.appendChild(sel);
      if (l.effective !== l.mode) cm.appendChild(el('span', 'cfg-st', 'Runs as ' + (MODES[l.effective] || MODES.guided).n + ': ' + (l.why || []).join('; ')));
      cell(tr, 'Set by', null, l.set_by ? l.set_by : 'Default');
      cell(tr, 'Tasks with own mode', 'n', String(l.overrides || 0));
      t.tBodies[0].appendChild(tr);
    });
    if (rows.length) p.appendChild(t); else { var e = el('div', 'cfg-empty'); e.appendChild(el('b', null, 'No list is in this mode.')); p.appendChild(e); }
    p.appendChild(msg);
    p.appendChild(el('p', 'cfg-note', 'Saved with your own sign-in on the board' + (web() ? '' : ' (localhost:8788)') + ', as in the list’s settings on the board and in the phone app: the same three places. AI Brain and Project rules only by a household person. A task inherits from its parent, then its list. To stop a list on this device, untick it in Workload.'));
    var e0 = el('section', 'cfg-e0'); e0.setAttribute('aria-labelledby', 'cfg-e0h'); var h = el('h3', null, 'Always the person’s, in every mode'); h.id = 'cfg-e0h'; e0.appendChild(h);
    e0.appendChild(el('p', null, 'No mode, precedent, project rule or list brief makes these an agent’s decision.'));
    var u = el('ul'); ((S.data.board && S.data.board.e0) || []).forEach(function (x) { u.appendChild(el('li', null, x)); }); e0.appendChild(u); p.appendChild(e0);
    var dl = el('dl', 'cfg-modes'); ORDER.forEach(function (m) { var d = el('div'), dt = el('dt'); dt.appendChild(modeEl(m)); d.appendChild(dt); d.appendChild(el('dd', null, MODES[m].does)); d.appendChild(el('dd', null, MODES[m].you)); dl.appendChild(d); }); side.appendChild(dl);
  }
  function banner(text) { var d = el('div', 'cfg-banner'); d.setAttribute('role', 'alert'); d.appendChild(el('p', null, text)); return d; }

  /* ---------- the web copy: guest and waiting states, optimistic saves ---------- */
  function webState(p) {
    var w = WEBST(); if (!w) return false;
    var d = el('div', 'cfg-empty'); d.appendChild(el('b', null, w.state === 'guest' ? 'Household only.' : 'Waiting for the PC to publish.'));
    d.appendChild(document.createTextNode(' ' + (w.text || '')));
    if (w.state === 'guest') d.appendChild(el('span', 'cfg-st', 'Run local version'));
    p.appendChild(d); return true;
  }
  // the shown budget rows after a saved cap (set_budget returns nothing): v null removes the month row
  function setCap(key, listId, v) {
    var B = S.data && S.data.board && S.data.board.budgets; if (!B) return;
    var rows = B.rows || (B.rows = []), mine = function (r) { return r.period === 'month' && (key === 'overall' ? r.scope === 'overall' : r.slug === key); };
    var r = rows.filter(mine)[0];
    if (v == null) { B.rows = rows.filter(function (x) { return !mine(x); }); return; }
    if (!r) { r = { scope: key === 'overall' ? 'overall' : 'list', list_id: listId || null, period: 'month', spent_usd: 0, reserved_usd: 0 }; if (key !== 'overall') r.slug = key; rows.push(r); }
    r.cap_usd = v; r.left_usd = Math.round((v - (r.spent_usd || 0) - (r.reserved_usd || 0)) * 100) / 100; r.reached = (r.spent_usd || 0) + (r.reserved_usd || 0) >= v;
  }
  // saved changes the read does not show yet (the web reads what the PC last published): applied over it until a read newer than the save
  function applyOpt(v) {
    var at = (Date.parse((v && (v.board_at || v.published_at)) || '') || 0) - 120000, b = v && v.board;   // board_at: when the board was read (a refresh started before a save ends after it); 2 min for PC/browser clock skew
    Object.keys(S.opt.mode).forEach(function (id) {
      var o = S.opt.mode[id]; if (at > o.at + 1000) { delete S.opt.mode[id]; return; }
      ((b && b.lists) || []).forEach(function (l) { if (l.id === id) { l.mode = o.mode; if (!l.why || !l.why.length) l.effective = o.mode; } });
    });
    var keep = S.data; S.data = v;
    Object.keys(S.opt.cap).forEach(function (k) { var o = S.opt.cap[k]; if (at > o.at + 1000) { delete S.opt.cap[k]; return; } setCap(k, o.list_id, o.cap); });
    S.data = keep;
    return v;
  }
  function publishedLine() {
    var d = S.data; if (!d || !d.published_at || WEBST()) return null;
    var t = new Date(d.published_at), age = Date.now() - t.getTime(), hh = (age > 864e5 ? t.toISOString().slice(0, 10) + ' ' : '') + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
    var pend = Object.keys(S.opt.mode).length + Object.keys(S.opt.cap).length;
    if (age > 15 * 60000) return el('p', 'cfg-pub', 'Published ' + hh + ' by ' + (d.device || 'the PC') + ': older than 15 minutes, the PC is not publishing now (run the local page there, or harness-web.js serve). Values may be out of date.');
    return el('p', 'cfg-pub', 'Published ' + hh + ' by ' + (d.device || 'the PC') + '. The PC republishes within about a minute' + (pend ? '; your ' + pend + ' saved change' + (pend > 1 ? 's show' : ' shows') + ' here until then.' : '.'));
  }

  /* ---------- Budgets ---------- */
  function budgetRows() { return (S.data && S.data.board && S.data.board.budgets && S.data.board.budgets.rows) || []; }
  function seriesOf(key) {
    var spend = (S.data && S.data.board && S.data.board.budgets && S.data.board.budgets.spend) || {};
    var cum = spend[key] || [], now = Date.now(), start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
    var a = start.getTime(), pts = [[a, 0]], prev = 0, sum = 0;
    cum.forEach(function (x) { var t = Date.parse(x.day + 'T12:00:00'), inc = x.usd - prev; prev = x.usd; if (t >= a) { sum += inc; pts.push([t, Math.round(sum * 100) / 100]); } });
    pts.push([now, sum]);
    var row = budgetRows().filter(function (r) { return r.period === 'month' && (key === 'overall' ? r.scope === 'overall' : r.slug === key); })[0] || null;
    var cap = row ? row.cap_usd : null, reserved = row ? row.reserved_usd : 0, perDay = sum / Math.max(1, (now - a) / DAY), fc = { kind: 'none' };
    if (cap) {
      if (sum + reserved >= cap) fc = { kind: 'reached', at: now };
      else if (perDay > 0) { var at = now + (cap - sum) / perDay * DAY, end = new Date(start); end.setMonth(end.getMonth() + 1); fc = at < end.getTime() ? { kind: 'forecast', at: at } : { kind: 'below', end: end.getTime(), val: sum + perDay * (end.getTime() - now) / DAY }; }
    }
    var name = key === 'overall' ? 'Overall' : ((lists().filter(function (l) { return l.slug === key; })[0] || {}).name || key);
    return { key: key, name: name, cap: cap, pts: pts, spent: sum, fc: fc, a: a };
  }
  function capText(s) {
    if (!s.cap) return 'No budget set. Set it in the table below.';
    if (s.fc.kind === 'forecast') return 'Cap reached around ' + ymd(s.fc.at, true);
    if (s.fc.kind === 'reached') return 'Cap reached. New sessions in this list are paused.';
    if (s.fc.kind === 'below') return 'Cap not reached this month.';
    return 'No forecast yet.';
  }
  function renderBudgets(p) {
    p.textContent = '';
    if (!S.data) { p.appendChild(skel()); return; }
    if (webState(p)) return;
    hostNote(p);
    var keys = ['overall'].concat(lists().map(function (l) { return l.slug; }));
    var bar = el('div', 'cfg-toolbar'), lab = el('label', null, 'Budget'), sel = el('select', 'cfg-sel'); sel.id = 'cfg-bsel'; lab.htmlFor = 'cfg-bsel';
    keys.forEach(function (k) { var o = el('option', null, seriesOf(k).name); o.value = k; if (k === S.series) o.selected = true; sel.appendChild(o); });
    sel.onchange = function () { S.series = sel.value; S.cursor = null; renderBudgets(p); };
    bar.appendChild(lab); bar.appendChild(sel); p.appendChild(bar);
    var s = seriesOf(S.series), k = el('div', 'cfg-kpis'), big = el('div', 'cfg-big', money(s.spent)); if (s.cap) big.appendChild(el('small', null, 'of ' + moneyShort(s.cap) + ' this month'));
    k.appendChild(big); var hl = el('p', 'cfg-kcap' + (s.fc.kind === 'reached' ? ' reached' : '')); hl.appendChild(el('b', null, capText(s))); k.appendChild(hl); p.appendChild(k);
    var w = el('div', 'cfg-chartw'), svg = sv('svg', { id: 'cfg-chart', role: 'img', tabindex: '0', 'aria-describedby': 'cfg-chart-sum' }); w.appendChild(svg);
    var tip = el('div', 'cfg-ctip'); tip.id = 'cfg-ctip'; w.appendChild(tip); p.appendChild(w);
    var lg = el('p', 'cfg-legend'); lg.appendChild(el('span', null, 'Blue: spent at API prices; dashed: forecast. Gold: the cap. The vertical line is the moment the cap is (or will be) reached.')); p.appendChild(lg);
    var sum = el('p', 'vh'); sum.id = 'cfg-chart-sum'; p.appendChild(sum); var live = el('p', 'vh'); live.id = 'cfg-chart-live'; live.setAttribute('aria-live', 'polite'); p.appendChild(live);
    var t = table('Budgets per list', [['List'], ['Spent this month', 'n'], ['Cap per month, $', 'n'], ['Cap reached']]);
    var msg = el('p', 'cfg-msg'); msg.id = 'cfg-bu-msg'; msg.setAttribute('role', 'status');
    var idOf = function (key) { return key === 'overall' ? null : ((lists().filter(function (l) { return l.slug === key; })[0] || {}).id || undefined); };
    var capOf = function (key) { return seriesOf(key).cap || null; };
    keys.forEach(function (key) {
      var x = seriesOf(key), tr = el('tr'); if (key === 'overall') tr.className = 'sum';
      var b = el('button', 'lk', x.name); b.type = 'button'; b.onclick = function () { S.series = key; renderBudgets(p); var c = $('cfg-chart'); if (c) c.focus(); }; cell(tr, 'List', 'h').appendChild(b);
      cell(tr, 'Spent this month', 'n', money(x.spent));
      var inp = el('input', 'cfg-num cfg-money'); inp.type = 'number'; inp.min = '0'; inp.step = '1'; inp.max = '100000'; inp.placeholder = 'Not set';
      inp.value = x.cap ? String(x.cap) : ''; inp.setAttribute('aria-label', 'Monthly cap of ' + x.name + ' in dollars, empty for none');
      if (idOf(key) === undefined) { inp.disabled = true; inp.title = 'Restart the page server: it does not send list ids yet.'; }
      inp.onchange = function () {
        var v = inp.value.trim() === '' ? null : Number(inp.value), err = budgetError(key, v, capOf);
        if (err) { msg.className = 'cfg-msg bad'; msg.textContent = err + ' Not saved.'; inp.value = x.cap ? String(x.cap) : ''; return; }
        inp.disabled = true; msg.className = 'cfg-msg'; msg.textContent = 'Saving ' + x.name + ' with your board sign-in…';
        writeStart();
        boardRpc('set_budget', { p_list: idOf(key), p_period: 'month', p_cap: v }).then(function () { setCap(key, idOf(key), v); S.opt.cap[key] = { cap: v, list_id: idOf(key), at: Date.now() }; inp.disabled = false; writeEnd(); msg.textContent = x.name + ': ' + (v == null ? 'no cap' : moneyShort(v) + ' a month') + '. Saved on the board.'; },
          function (e) { inp.disabled = false; inp.value = x.cap ? String(x.cap) : ''; writeEnd(); msg.className = 'cfg-msg bad'; msg.textContent = x.name + ' not saved: ' + (/not allowed/.test(e.message) ? 'only its owner or an editor who is a household person may set its cap' : e.message); });
      };
      cell(tr, 'Cap per month, $', 'n').appendChild(inp);
      cell(tr, 'Cap reached', null, !x.cap ? 'No budget set' : x.fc.kind === 'forecast' ? 'Around ' + ymd(x.fc.at, true) : x.fc.kind === 'reached' ? 'Reached. New sessions paused.' : x.fc.kind === 'below' ? 'Not this month' : 'No forecast yet');
      t.tBodies[0].appendChild(tr);
    });
    p.appendChild(t);
    var acts = el('div', 'cfg-acts'), rb = el('button', 'btn', 'Reset all'); rb.type = 'button';
    var set = keys.filter(function (k) { return capOf(k); });
    rb.disabled = !set.length; rb.title = 'Removes every monthly cap: lists first, then the overall one';
    rb.onclick = function () {
      if (!window.confirm('Remove all ' + set.length + ' monthly caps? Nothing then stops new sessions for money until a cap is set again.')) return;
      rb.disabled = true; msg.className = 'cfg-msg'; msg.textContent = 'Removing the caps…';
      var order = set.filter(function (k) { return k !== 'overall'; }).concat(set.indexOf('overall') >= 0 ? ['overall'] : []);
      writeStart();
      order.reduce(function (pr, k) { return pr.then(function () { return boardRpc('set_budget', { p_list: idOf(k), p_period: 'month', p_cap: null }).then(function () { setCap(k, idOf(k), null); S.opt.cap[k] = { cap: null, list_id: idOf(k), at: Date.now() }; }); }); }, Promise.resolve())
        .then(function () { writeEnd(); msg.textContent = 'Every monthly cap removed.'; }, function (e) { writeEnd(); msg.className = 'cfg-msg bad'; msg.textContent = 'Stopped: ' + e.message; });
    };
    acts.appendChild(rb); p.appendChild(acts); p.appendChild(msg);
    p.appendChild(el('p', 'cfg-note', 'Set a cap for the whole harness (Overall), for a list, or both; empty means no cap. A list’s cap may not be above the overall cap. Saved with your own board sign-in, household people only, and shared by every device. At API prices. A cap stops new starts in its list (no card, no try counted); running sessions finish their step. It never lifts the 90% token pause.'));
    drawChart();
  }
  // a new cap for key is refused when a list's cap is above the overall cap, or the overall cap would go below a list's
  function budgetError(key, v, capOf) {
    if (v != null && !(v >= 0 && v <= 100000)) return 'A cap is a number from 0 to 100000.';
    if (v == null) return '';
    if (key !== 'overall') { var o = capOf('overall'); return o != null && v > o ? 'A list’s cap may not be above the overall cap (' + moneyShort(o) + ').' : ''; }
    var over = lists().filter(function (l) { var c = capOf(l.slug); return c != null && c > v; }).map(function (l) { return l.name + ' ' + moneyShort(capOf(l.slug)); });
    return over.length ? 'The overall cap may not be below a list’s cap: ' + over.join(', ') + '.' : '';
  }
  function drawChart() {
    if (!$) return; var svg = $('cfg-chart'); if (!svg || !panels.budgets || panels.budgets.hidden) return;
    svg.textContent = '';
    var s = seriesOf(S.series), W = svg.clientWidth || 800, H = svg.clientHeight || 280; svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var end = new Date(s.a); end.setMonth(end.getMonth() + 1); var A = s.a, Bt = end.getTime(), now = Date.now();
    var m = { l: 46, r: 14, t: 30, b: 26 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
    var f = s.fc.kind === 'forecast' ? [[now, s.spent], [s.fc.at, s.cap]] : s.fc.kind === 'below' ? [[now, s.spent], [s.fc.end, s.fc.val]] : null;
    var maxV = Math.max(s.cap || 0, s.spent, f ? f[1][1] : 0, 1), step = maxV > 100 ? 20 : maxV > 40 ? 10 : maxV > 10 ? 5 : 1, yMax = Math.ceil(maxV * 1.12 / step) * step;
    var x = function (t) { return m.l + (t - A) / (Bt - A) * iw; }, y = function (v) { return m.t + ih - v / yMax * ih; };
    var g = sv('g'); svg.appendChild(g);
    for (var v = 0; v <= yMax; v += step) { g.appendChild(sv('line', { x1: m.l, x2: m.l + iw, y1: y(v), y2: y(v), stroke: 'rgba(255,255,255,.07)' })); g.appendChild(sv('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, '$' + v)); }
    var tick = iw < 520 ? 10 * DAY : 5 * DAY;
    for (var t = A; t <= Bt; t += tick) g.appendChild(sv('text', { x: x(t), y: H - 6, 'text-anchor': t === A ? 'start' : (t + tick > Bt ? 'end' : 'middle') }, ymd(t).slice(5)));
    var clip = sv('clipPath', { id: 'cfg-cp' }); clip.appendChild(sv('rect', { x: m.l, y: 0, width: iw, height: H })); svg.appendChild(clip);
    var plot = sv('g', { 'clip-path': 'url(#cfg-cp)' }); svg.appendChild(plot);
    plot.appendChild(sv('line', { x1: x(now), x2: x(now), y1: m.t, y2: m.t + ih, stroke: '#4b5b7a', 'stroke-dasharray': '2 3' })); g.appendChild(sv('text', { x: x(now) + 4, y: m.t + ih - 6 }, 'Now'));
    if (s.cap) { plot.appendChild(sv('line', { x1: m.l, x2: m.l + iw, y1: y(s.cap), y2: y(s.cap), stroke: '#f3cf7a', 'stroke-width': 1.5 })); g.appendChild(sv('text', { x: m.l + 4, y: y(s.cap) - 6, 'class': 'lbl', style: 'fill:#f3cf7a' }, 'Cap ' + moneyShort(s.cap))); }
    plot.appendChild(sv('path', { d: s.pts.map(function (q, i) { return (i ? 'L' : 'M') + x(q[0]).toFixed(1) + ' ' + y(q[1]).toFixed(1); }).join(''), fill: 'none', stroke: '#86a9ff', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    if (f) plot.appendChild(sv('path', { d: 'M' + x(f[0][0]) + ' ' + y(f[0][1]) + 'L' + x(f[1][0]) + ' ' + y(f[1][1]), fill: 'none', stroke: '#86a9ff', 'stroke-width': 2, 'stroke-dasharray': '6 5' }));
    var note = '';
    if (s.cap && (s.fc.kind === 'forecast' || s.fc.kind === 'reached')) {
      var at = s.fc.at, reached = s.fc.kind === 'reached', col = reached ? '#ff8a7c' : '#f4ad4e', txt = (reached ? 'Cap reached ' : 'Cap reached around ') + ymd(at, true);
      if (at >= A && at <= Bt) { var vx = x(at), right = vx > m.l + iw * 0.62; plot.appendChild(sv('line', { x1: vx, x2: vx, y1: m.t - 4, y2: m.t + ih, stroke: col, 'stroke-width': reached ? 2 : 1.5, 'stroke-dasharray': reached ? 'none' : '5 4' })); plot.appendChild(sv('circle', { cx: vx, cy: y(s.cap), r: 4, fill: col })); g.appendChild(sv('text', { x: right ? vx - 6 : vx + 6, y: m.t - 12, 'text-anchor': right ? 'end' : 'start', 'class': 'lbl', style: 'fill:' + col }, txt)); }
      else note = ' ' + txt + (at > Bt ? ', after this range.' : ', before this range.');
    }
    if (!s.cap) g.appendChild(sv('text', { x: m.l + iw / 2, y: m.t + 14, 'text-anchor': 'middle', 'class': 'lbl', style: 'fill:#eef2fa' }, 'No budget set. Set it in the table below.'));
    var sumEl = $('cfg-chart-sum'); if (sumEl) sumEl.textContent = 'Chart: ' + s.name + ', spent ' + money(s.spent) + ' this month' + (s.cap ? ' against a cap of ' + moneyShort(s.cap) + '. ' : '. ') + capText(s) + note;
    var tip = $('cfg-ctip'), cur = sv('g', { visibility: 'hidden' }); cur.appendChild(sv('line', { y1: m.t, y2: m.t + ih, stroke: '#eef2fa', 'stroke-opacity': 0.5 })); cur.appendChild(sv('circle', { r: 4, fill: '#eef2fa' })); svg.appendChild(cur);
    var valueAt = function (tm) { var all = s.pts.slice(); if (f) all.push(f[1]); if (tm < all[0][0]) return null; for (var i = 1; i < all.length; i++) if (tm <= all[i][0]) { var p0 = all[i - 1], p1 = all[i]; return p1[0] === p0[0] ? p1[1] : p0[1] + (p1[1] - p0[1]) * (tm - p0[0]) / (p1[0] - p0[0]); } return null; };
    var show = function (tm, announce) { var val = valueAt(tm); if (val == null) { cur.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; return; } var cx = x(tm), cy = y(val); cur.setAttribute('visibility', 'visible'); cur.firstChild.setAttribute('x1', cx); cur.firstChild.setAttribute('x2', cx); cur.lastChild.setAttribute('cx', cx); cur.lastChild.setAttribute('cy', cy); var label = ymd(tm) + ': ' + money(val) + (tm > now ? ' forecast' : ' spent'); tip.textContent = label; tip.style.display = 'block'; tip.style.left = Math.max(4, Math.min(svg.clientWidth - tip.offsetWidth + 4, cx - tip.offsetWidth / 2 + 8)) + 'px'; tip.style.top = Math.max(4, cy - 34) + 'px'; if (announce) $('cfg-chart-live').textContent = label; };
    svg.onmousemove = function (e) { var r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * (W / r.width), tm = Math.round((A + (px - m.l) / iw * (Bt - A)) / DAY) * DAY; if (tm < A || tm > Bt) return; S.cursor = tm; show(tm); };
    svg.onmouseleave = svg.onblur = function () { cur.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; };
    svg.onkeydown = function (e) { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); var tm = S.cursor == null ? Math.min(now, Bt) : S.cursor + (e.key === 'ArrowRight' ? DAY : -DAY); tm = Math.max(A, Math.min(Bt, tm)); S.cursor = tm; show(tm, true); };
  }

  /* ---------- Model routing (read only: config/routing.json, as lib/routing.js route() reads it; config/models.json is the old table) ---------- */
  function tierText(t) { var x = String(t || '').split('/'); return x[0] ? x[0].charAt(0).toUpperCase() + x[0].slice(1) + (x[1] ? ' · ' + x[1] : '') : '-'; }
  // the tier a role starts on under each list policy, as route() does before the risk floor, a retry or an override
  function policyTier(R, role, policy) {
    var L = R.ladder || [], base = (R.base || {})[role] || (R.base || {}).task, P = (R.policies || {})[policy] || {};
    if (policy === 'economy') return (P.untouched || []).indexOf(role) >= 0 ? base : (P.set && P.set[role]) || (P.down && P.down[base]) || base;
    if (policy === 'quality') { var i = L.indexOf(base) + (P.step_up || 1); return L[Math.max(0, Math.min(L.length - 1, i))] || base; }
    return base;
  }
  function renderRouting(p) {
    p.textContent = '';
    if (!S.data) { p.appendChild(skel()); return; }
    if (webState(p)) return;
    var R = S.data.board && S.data.board.routing, HEADS = ['Balanced (base)', 'Economy list', 'Quality list'];
    if (!R) p.appendChild(banner('The routing could not be read' + (S.data.board_error ? ': ' + S.data.board_error : '') + '.'));
    else {
      var sec = el('section', 'cfg-sec'); sec.appendChild(el('h3', null, 'Starting model per role'));
      var t = table('Starting model and effort per role and list policy', [['Role']].concat(HEADS.map(function (h) { return [h]; })));
      Object.keys(R.base || {}).forEach(function (role) {
        var tr = el('tr'); cell(tr, 'Role', 'h', role);
        ['balanced', 'economy', 'quality'].forEach(function (pol, i) { var v = policyTier(R, role, pol); cell(tr, HEADS[i], i && v !== R.base[role] ? 'cfg-chg' : null, tierText(v)); });
        t.tBodies[0].appendChild(tr);
      });
      sec.appendChild(t); p.appendChild(sec);
      var s2 = el('section', 'cfg-sec'); s2.appendChild(el('h3', null, 'Rules after the start'));
      var dl = el('dl', 'cfg-facts'), fact = function (k, v) { var d = el('div'); d.appendChild(el('dt', null, k)); d.appendChild(el('dd', null, v)); dl.appendChild(d); };
      fact('Ladder', (R.ladder || []).map(tierText).join(' → '));
      fact('Risk floor', 'at least ' + tierText(R.risk_floor) + ' when the task names an E0, E2 or E3 path or command');
      fact('Retry', 'one step up, once, only after a quality failure (tests, the check judge or you refused); at most ' + tierText(R.retry_cap) + ', on a Quality list ' + tierText(R.retry_cap_quality));
      fact('Your override', 'a model and effort set on the task win, never below the risk floor');
      var lp = R.lists || {}, names = Object.keys(lp);
      fact('List policies', 'default ' + (R.default_policy || 'balanced') + (names.length ? '; ' + names.map(function (k) { var l = lists().filter(function (x) { return x.slug === k; })[0]; return (l ? l.name : k) + ': ' + lp[k]; }).join(', ') : '; no list has its own'));
      s2.appendChild(dl); p.appendChild(s2);
      p.appendChild(el('p', 'cfg-note', 'From config/routing.json, a protected file: changed in the repo, not on this page. Order: base per role, list policy, risk floor, retry, your override.'));
    }
    var roles = (S.data.board && S.data.board.models && S.data.board.models.roles) || {};
    if (Object.keys(roles).length) {
      var s3 = el('section', 'cfg-sec'); s3.appendChild(el('h3', null, 'Old table: config/models.json, no longer read by spawn.js'));
      var t3 = table('Old model per role', [['Role'], ['Default'], ['Simple'], ['Complex']]);
      Object.keys(roles).forEach(function (r) { var x = roles[r], tr = el('tr', 'muted'); cell(tr, 'Role', 'h', r); cell(tr, 'Default', null, x['default']); cell(tr, 'Simple', null, x.simple ? tierText(x.simple.model + '/' + x.simple.effort) : ''); cell(tr, 'Complex', null, x.complex ? tierText(x.complex.model + '/' + x.complex.effort) : ''); t3.tBodies[0].appendChild(tr); });
      s3.appendChild(t3); p.appendChild(s3);
    }
  }

  var RENDER = { workload: renderWorkload, autonomy: renderAutonomy, budgets: renderBudgets, routing: renderRouting };
  function renderAll() {
    Object.keys(panels).forEach(function (k) { RENDER[k](panels[k]); });
    tabBtns.forEach(function (b) { var id = b.id.slice(5); b.lastChild.textContent = status(id); });
    var pb = $('cfg-banner-host'); if (pb) { pb.textContent = ''; if (S.error) pb.appendChild(banner('Could not read the configuration: ' + S.error + '. The last values read are shown.')); var pl = publishedLine(); if (pl) pb.appendChild(pl); }
    if (PO) PO.setAttribute('aria-busy', S.data ? 'false' : 'true');
  }
  /* board writes in flight (Maksym 2026-11-11, several lists switched in a row): the page reads the board again only once the last write is
     back, and drops any answer read while a write was going, so a slow read never puts back an older mode over a newer pick */
  var WR = { pend: 0, gen: 0, t: 0 };
  function writeStart() { WR.pend++; WR.gen++; clearTimeout(WR.t); }
  function writeEnd() { WR.pend = Math.max(0, WR.pend - 1); WR.gen++; clearTimeout(WR.t); if (!WR.pend) WR.t = setTimeout(function () { load(true); }, 600); }
  function load(fresh) {
    var g = WR.gen;
    getJson('/api/config' + (fresh ? '?fresh=1' : '')).then(function (v) { if (WR.pend || g !== WR.gen) return; S.data = applyOpt(v); S.error = null; renderAll(); })
      .catch(function (e) { if (WR.pend || g !== WR.gen) return; S.error = (e && e.message) || 'no answer'; renderAll(); });
  }

  window.renderConfigPage = function (U) {
    el = U.el; $ = U.$; panelHead = U.panelHead; panelBody = U.panelBody; openPanel = U.openPanel; getJson = U.getJson; postJson = U.postJson; renderLimits = U.renderLimits; restoreSize = U.restoreSize; markSel = U.markSel; setLit = U.setLit; state = U.state; PO = U.PO; canDo = U.canDo;
    if (typeof restoreSize === 'function') restoreSize(); state.sel = null; if (typeof markSel === 'function') markSel(); state.stageHi = null; if (typeof setLit === 'function') setLit();
    var head = panelHead('Configurations', 'How much agents may do, what they may spend and how this device runs them.'); var b = panelBody(); b.classList.add('cfg');
    var bh = el('div'); bh.id = 'cfg-banner-host'; b.appendChild(bh);
    tabBtns = tabsEl(b); panels = {};
    TABS.forEach(function (t) { var p = el('div', 'cfg-p'); p.id = 'cfgp-' + t[0]; p.setAttribute('role', 'tabpanel'); p.setAttribute('aria-labelledby', 'cfgt-' + t[0]); p.tabIndex = 0; panels[t[0]] = p; b.appendChild(p); });
    var keep = null; try { keep = localStorage.getItem('eis-cfg-tab'); } catch (e) { /* none */ }
    renderAll(); select(TABS.some(function (t) { return t[0] === keep; }) ? keep : S.tab, false);
    openPanel('config');
    if (PO && !(window.matchMedia && window.matchMedia('(max-width:759px)').matches)) PO.style.width = Math.min(1000, window.innerWidth) + 'px';
    load();
    return head;
  };
  window.__cfgTest = { policyTier: policyTier, tierText: tierText, renderRouting: renderRouting, setCap: setCap, applyOpt: applyOpt, S: S, use: function (U) { el = U.el; $ = U.$; } };   // test/config.test.js
  var rz; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(drawChart, 120); });
}());
