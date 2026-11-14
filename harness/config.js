/* Eisenhower harness viewer: the Configurations page (harness-configurations-plan.md T11, UI spec references/homeos/harness-configurations/ui/
   configurations-page-spec.md, winner p1 with the p2 changes). Tabs Workload, Lists, Model routing (read only: config/routing.json);
   Notifications and Machine removed and the mothers cap moved to Workload (Maksym, 2026-11-11). Lists (2026-11-13) holds the board's
   List settings except Stage report - Autonomy, Intake (e2e, project folder, Telegram), monthly budget and the list brief -
   written through the same RPCs as the board (set_autonomy, set_intake, set_project_dir, set_list_brief, set_budget); it replaced the
   Autonomy and Budgets tabs. Workload limits are the person's own DB row (db/041); each PC syncs it into its limits file.
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
  var TABS = [['workload', 'Workload'], ['lists', 'Lists'], ['routing', 'Model routing']];
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
    if (id === 'workload') { var live = 0, max = 0; limRows().forEach(function (r) { live += r.live || 0; if (r.enabled === true) max += r.max_sessions || 0; }); return live + ' of ' + max + ' sessions live'; }
    if (id === 'lists') { var b = lists().filter(function (l) { return l.effective === 'ai_brain'; }).length; return lists().length ? lists().length + ' lists' + (b ? ', ' + b + ' on AI Brain' : '') : 'board not read'; }
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
      if (r.ok) { S.data.limits = r.json; renderAll(); var m2 = $('cfg-wl-msg'); if (m2) m2.textContent = okText || 'Saved.'; }
      else { msg.className = 'cfg-msg bad'; msg.textContent = ((r.json && (r.json.errors || [r.json.error])) || ['Not saved.']).join('; ') + ' Nothing was saved.'; }
    }).catch(function () { msg.className = 'cfg-msg bad'; msg.textContent = 'The server did not answer. Nothing was saved.'; });
  }
  function renderWorkload(p) {
    p.textContent = '';
    if (!S.data) { p.appendChild(skel()); return; }
    if (webState(p)) return;
    var rows = limRows(), live = 0, max = 0, L = S.data.limits || {}, MX = L.max || {}, DEF = L.defaults || {};
    rows.forEach(function (r) { live += r.live || 0; if (r.enabled === true) max += r.max_sessions || 0; });
    var sec = el('section', 'cfg-sec'); sec.appendChild(el('h3', null, 'This device'));
    var t = table('This device and its sessions', [['Device'], ['Runs sessions'], ['Live / limit']]), tr = el('tr');
    var c1 = cell(tr, 'Device', 'h'); c1.appendChild(el('span', null, (S.data.device || 'this device') + ' (this device)')); c1.appendChild(el('span', 'cfg-st', max ? 'Online' : 'Off: takes no new sessions'));
    cell(tr, 'Runs sessions', null, max ? 'On' : 'Off');
    cell(tr, 'Live / limit').appendChild(meter(live, max));
    t.tBodies[0].appendChild(tr); sec.appendChild(t);
    sec.appendChild(el('p', 'cfg-note', 'Limits are yours, kept in the database: every PC that runs your harness reads them within a minute or two. Mothers at once is per PC.'));
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
        .then(function (r) { if (r.ok) { mmsg.textContent = 'Saved.'; load(); } else { mmsg.className = 'cfg-msg bad'; mmsg.textContent = 'Could not write the limits file. Not saved.'; } })
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
      var tr2 = el('tr'); tr2.dataset.slug = r.slug; if (r.enabled !== true) tr2.className = 'muted';
      var nm = cell(tr2, 'List', 'h', r.name || r.slug); if (r.on_board === false) nm.appendChild(el('span', 'cfg-st', 'not on the board'));
      var cb = el('input'); cb.type = 'checkbox'; cb.checked = r.enabled === true; cb.dataset.f = 'enabled'; cb.setAttribute('aria-label', (r.name || r.slug) + ' on'); cb.onchange = changed; cell(tr2, 'On').appendChild(cb);
      var i1 = numIn(r.max_sessions, MX.max_sessions || 10, (r.name || r.slug) + ' max sessions'); i1.dataset.f = 'max_sessions'; i1.onchange = changed; cell(tr2, 'Sessions', 'n').appendChild(i1);
      var i2 = numIn(r.max_agents_per_session, MX.max_agents_per_session || 10, (r.name || r.slug) + ' max subagents'); i2.dataset.f = 'max_agents_per_session'; i2.onchange = changed; cell(tr2, 'Subagents', 'n').appendChild(i2);
      cell(tr2, 'Live / limit').appendChild(meter(r.live || 0, r.enabled !== true ? 0 : r.max_sessions || 0));
      var g = gateOf('list:' + r.slug); if (g) [cb, i1, i2].forEach(function (x) { x.disabled = true; x.title = g; });
      t2.tBodies[0].appendChild(tr2);
    });
    if (rows.length) s2.appendChild(t2);
    var acts = el('div', 'cfg-acts'), rb = el('button', 'btn', 'Reset all'); rb.type = 'button';
    rb.title = 'Every list on, with the default sessions and subagents of this device';
    rb.onclick = function () {
      if (!window.confirm('Reset every list on this device to on, ' + DEF.max_sessions + ' sessions and ' + DEF.max_agents_per_session + ' subagents?')) return;
      clearTimeout(wlTimer); saveLists(rows.map(function (r) { return { slug: r.slug, enabled: false, max_sessions: String(DEF.max_sessions), max_agents_per_session: String(DEF.max_agents_per_session) }; }), msg, 'Every list reset to the defaults.');
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

  /* ---------- Lists (2026-11-13): the board's List settings minus Stage report, through the same RPCs; replaced Autonomy and Budgets ---------- */
  var LIST_BRIEF = [['instruction', 'Instruction'], ['concept', 'Concept'], ['decisions', 'Decisions'], ['naming', 'Naming']];
  function budgetRows() { return (S.data && S.data.board && S.data.board.budgets && S.data.board.budgets.rows) || []; }
  function monthRow(key) { return budgetRows().filter(function (r) { return r.period === 'month' && (key === 'overall' ? r.scope === 'overall' : r.slug === key); })[0] || null; }
  function capOf(key) { var r = monthRow(key); return r && r.cap_usd != null ? Number(r.cap_usd) : null; }
  function spentOf(key) { var r = monthRow(key); return r ? Number(r.spent_usd) || 0 : 0; }
  // pure: the RPC calls a list's form needs, only for what changed (the board's Save does the same)
  function listChanges(l, f, monthCap) {
    var out = [], it = l.intake || {}, bt = l.brief_texts || {};
    if (f.mode !== l.mode) out.push(['set_autonomy', { p_kind: 'list', p_id: l.id, p_mode: f.mode, p_expected: l.mode }]);
    if (!!f.e2e !== !!it.e2e_self || !!f.tg !== !!it.notify_telegram)
      out.push(['set_intake', { p_kind: 'list', p_id: l.id, p_e2e_self: !!f.e2e, p_notify_telegram: !!f.tg, p_stage_report: null }]);
    var dir = String(f.dir || '').trim();
    if (dir !== (l.project_dir || '')) out.push(['set_project_dir', { p_list: l.id, p_dir: dir, p_expected: l.project_dir || null }]);
    if (LIST_BRIEF.some(function (k) { return (f.brief[k[0]] || '') !== (bt[k[0]] || ''); }))
      out.push(['set_list_brief', { p_list: l.id, p_decisions: f.brief.decisions || '', p_naming: f.brief.naming || '', p_instruction: f.brief.instruction || '', p_concept: f.brief.concept || '' }]);
    if ((f.cap == null ? null : f.cap) !== (monthCap == null ? null : monthCap)) out.push(['set_budget', { p_list: l.id, p_period: 'month', p_cap: f.cap }]);
    return out;
  }
  function dirError(d) {
    d = String(d || '').trim(); if (!d) return '';
    if (d.length > 260) return 'The project folder is longer than 260 characters.';
    if (!/^([A-Za-z]:[\\/]|\/)/.test(d)) return 'The project folder must be an absolute path (D:\\… or /…).';
    if (/(^|[\\/])\.\.([\\/]|$)/.test(d) || /[\u0000-\u001f]/.test(d)) return 'The project folder may not contain ".." or control characters.';
    return '';
  }
  function listForm(l) {
    var cap = capOf(l.slug), spent = spentOf(l.slug), it = l.intake || {}, bt = l.brief_texts || {};
    var d = el('details', 'cfg-lf'); d.dataset.slug = l.slug; var sm = el('summary');
    sm.appendChild(el('b', null, l.name)); sm.appendChild(modeEl(l.mode)); sm.appendChild(el('span', 'cfg-st', cap != null ? money(spent) + ' of ' + moneyShort(cap) + ' this month' : 'no budget'));
    d.appendChild(sm);
    var g = el('div', 'cfg-lf-g');
    var field = function (label, input, hint, wide) { var w = el('label', 'cfg-lf-f' + (wide ? ' wide' : '')); w.appendChild(el('span', null, label)); w.appendChild(input); if (hint) w.appendChild(el('small', null, hint)); g.appendChild(w); return input; };
    var box = function (on) { var c = el('input'); c.type = 'checkbox'; c.checked = !!on; return c; };
    var sel = el('select', 'cfg-sel'); sel.dataset.f = 'mode';
    ORDER.concat(ORDER.indexOf(l.mode) < 0 ? [l.mode] : []).forEach(function (m) { var o = el('option', null, (MODES[m] || MODES.guided).n + (m === 'guided' ? ' (default)' : '')); o.value = m; if (m === l.mode) o.selected = true; if (ORDER.indexOf(m) < 0) o.disabled = true; sel.appendChild(o); });
    field('Autonomy', sel, l.effective !== l.mode ? 'Runs as ' + (MODES[l.effective] || MODES.guided).n + ': ' + (l.why || []).join('; ') : (l.set_by ? 'Set by ' + l.set_by : 'Default'));
    var e2e = field('Agent runs e2e', box(it.e2e_self)); e2e.dataset.f = 'e2e';
    var tg = field('Notify on Telegram', box(it.notify_telegram)); tg.dataset.f = 'tg';
    var dir = el('input'); dir.type = 'text'; dir.maxLength = 260; dir.placeholder = 'Empty = HomeOS'; dir.value = l.project_dir || ''; dir.dataset.f = 'dir';
    field('Project folder', dir, 'Empty = HomeOS. Without CLAUDE.md, rules or hooks there, Project rules acts as Mixed.');
    var capIn = el('input', 'cfg-num cfg-money'); capIn.type = 'number'; capIn.min = '0'; capIn.max = '100000'; capIn.step = '1'; capIn.placeholder = 'Not set'; capIn.value = cap != null ? String(cap) : ''; capIn.dataset.f = 'cap';
    field('Monthly budget, $', capIn, money(spent) + ' spent this month. Empty = no cap.');
    var tas = {};
    LIST_BRIEF.forEach(function (k) { var ta = el('textarea'); ta.rows = 3; ta.maxLength = 8000; ta.value = bt[k[0]] || ''; ta.dataset.f = 'brief-' + k[0]; tas[k[0]] = ta; field('Brief: ' + k[1], ta, null, true); });
    d.appendChild(g);
    var acts = el('div', 'cfg-acts'), save = el('button', 'btn', 'Save'), msg = el('span', 'cfg-msg', 'No changes'); save.type = 'button'; save.disabled = true; msg.setAttribute('role', 'status');
    acts.appendChild(save); acts.appendChild(msg); d.appendChild(acts);
    var inputs = [sel, e2e, tg, dir, capIn].concat(LIST_BRIEF.map(function (k) { return tas[k[0]]; }));
    if (!l.id) inputs.forEach(function (x) { x.disabled = true; x.title = 'Restart the page server: it does not send list ids yet.'; });
    var form = function () { var b = {}; LIST_BRIEF.forEach(function (k) { b[k[0]] = tas[k[0]].value; }); return { mode: sel.value, e2e: e2e.checked, tg: tg.checked, dir: dir.value, cap: capIn.value.trim() === '' ? null : Number(capIn.value), brief: b }; };
    var dirty = function () { var n = l.id ? listChanges(l, form(), cap).length : 0; save.disabled = !n; msg.className = 'cfg-msg'; msg.textContent = n ? 'Unsaved changes' : 'No changes'; };
    g.addEventListener('input', dirty); g.addEventListener('change', dirty);
    save.onclick = function () {
      var f = form(), calls = listChanges(l, f, cap), err = dirError(f.dir) || budgetError(l.slug, f.cap, capOf);
      if (err) { msg.className = 'cfg-msg bad'; msg.textContent = err + ' Not saved.'; return; }
      save.disabled = true; msg.className = 'cfg-msg'; msg.textContent = 'Saving with your board sign-in…'; writeStart();
      calls.reduce(function (pr, c) { return pr.then(function () { return boardRpc(c[0], c[1]); }); }, Promise.resolve()).then(function () {
        l.mode = f.mode; if (!l.why || !l.why.length) l.effective = f.mode; S.opt.mode[l.id] = { mode: f.mode, at: Date.now() };
        l.intake = { e2e_self: f.e2e, notify_telegram: f.tg }; l.project_dir = f.dir.trim() || null; l.brief_texts = f.brief;
        if (f.cap !== cap) { setCap(l.slug, l.id, f.cap); S.opt.cap[l.slug] = { cap: f.cap, list_id: l.id, at: Date.now() }; cap = f.cap; }
        writeEnd(); msg.textContent = l.name + ': saved on the board.';
      }, function (e) {
        writeEnd(); save.disabled = false; msg.className = 'cfg-msg bad';
        msg.textContent = l.name + ' not saved: ' + (/not allowed|household people/.test(e.message) ? 'only its owner or an editor who is a household person may change these' + (l.owner ? ' (owner: ' + l.owner + ')' : '') : e.message) + '. What was saved before the error stays.';
      });
    };
    return d;
  }
  function renderLists(p) {
    p.textContent = '';
    if (!S.data) { p.appendChild(skel()); return; }
    if (!S.data.board) p.appendChild(banner('The board could not be read' + (S.data.board_error ? ': ' + S.data.board_error : '') + '. Lists show once it can.'));
    hostNote(p);
    var wrap = el('div', 'cfg-au'), side = el('aside', 'cfg-au-side'), main = el('div', 'cfg-au-main'); side.setAttribute('aria-label', 'What each mode means');
    wrap.appendChild(main); wrap.appendChild(side); p.appendChild(wrap);
    var ov = el('section', 'cfg-sec'); ov.appendChild(el('h3', null, 'Overall monthly budget'));
    var orow = el('div', 'cfg-inline'), ol = el('label', null, 'Cap per month, $ '), oi = el('input', 'cfg-num cfg-money'), omsg = el('span', 'cfg-msg');
    oi.type = 'number'; oi.min = '0'; oi.max = '100000'; oi.step = '1'; oi.id = 'cfg-ocap'; ol.htmlFor = 'cfg-ocap'; oi.placeholder = 'Not set'; oi.value = capOf('overall') != null ? String(capOf('overall')) : ''; omsg.setAttribute('role', 'status');
    orow.appendChild(ol); orow.appendChild(oi); orow.appendChild(el('span', 'cfg-st', money(spentOf('overall')) + ' spent this month')); orow.appendChild(omsg); ov.appendChild(orow);
    oi.onchange = function () {
      var v = oi.value.trim() === '' ? null : Number(oi.value), err = budgetError('overall', v, capOf);
      if (err) { omsg.className = 'cfg-msg bad'; omsg.textContent = err + ' Not saved.'; oi.value = capOf('overall') != null ? String(capOf('overall')) : ''; return; }
      oi.disabled = true; omsg.className = 'cfg-msg'; omsg.textContent = 'Saving…'; writeStart();
      boardRpc('set_budget', { p_list: null, p_period: 'month', p_cap: v }).then(function () { setCap('overall', null, v); S.opt.cap.overall = { cap: v, list_id: null, at: Date.now() }; oi.disabled = false; writeEnd(); omsg.textContent = 'Saved on the board.'; },
        function (e) { oi.disabled = false; writeEnd(); omsg.className = 'cfg-msg bad'; omsg.textContent = 'Not saved: ' + e.message; });
    };
    main.appendChild(ov);
    var ls = lists(), sec = el('section', 'cfg-sec'); sec.appendChild(el('h3', null, 'Lists'));
    if (!ls.length) { var e = el('div', 'cfg-empty'); e.appendChild(el('b', null, 'No lists yet.')); e.appendChild(document.createTextNode(' A list shows here after the board is read.')); sec.appendChild(e); }
    ls.forEach(function (l) { sec.appendChild(listForm(l)); });
    main.appendChild(sec);
    main.appendChild(el('p', 'cfg-note', 'The same settings as List settings on the board and in the phone app, saved with your own board sign-in' + (web() ? '' : ' (localhost:8788)') + ' through the same calls. AI Brain, Project rules, intake, the brief and budgets only by a household person who owns or edits the list. A list’s cap may not be above the overall cap. To stop a list on one PC, untick it in Workload.'));
    var e0 = el('section', 'cfg-e0'); e0.setAttribute('aria-labelledby', 'cfg-e0h'); var h = el('h3', null, 'Always the person’s, in every mode'); h.id = 'cfg-e0h'; e0.appendChild(h);
    e0.appendChild(el('p', null, 'No mode, precedent, project rule or list brief makes these an agent’s decision.'));
    var u = el('ul'); ((S.data.board && S.data.board.e0) || []).forEach(function (x) { u.appendChild(el('li', null, x)); }); e0.appendChild(u); main.appendChild(e0);
    var dl = el('dl', 'cfg-modes'); ORDER.forEach(function (m) { var dd = el('div'), dt = el('dt'); dt.appendChild(modeEl(m)); dd.appendChild(dt); dd.appendChild(el('dd', null, MODES[m].does)); dd.appendChild(el('dd', null, MODES[m].you)); dl.appendChild(dd); }); side.appendChild(dl);
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

  // a new cap for key is refused when a list's cap is above the overall cap, or the overall cap would go below a list's
  function budgetError(key, v, capOf) {
    if (v != null && !(v >= 0 && v <= 100000)) return 'A cap is a number from 0 to 100000.';
    if (v == null) return '';
    if (key !== 'overall') { var o = capOf('overall'); return o != null && v > o ? 'A list’s cap may not be above the overall cap (' + moneyShort(o) + ').' : ''; }
    var over = lists().filter(function (l) { var c = capOf(l.slug); return c != null && c > v; }).map(function (l) { return l.name + ' ' + moneyShort(capOf(l.slug)); });
    return over.length ? 'The overall cap may not be below a list’s cap: ' + over.join(', ') + '.' : '';
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

  var RENDER = { workload: renderWorkload, lists: renderLists, routing: renderRouting };
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
  window.__cfgTest = { policyTier: policyTier, tierText: tierText, renderRouting: renderRouting, renderLists: renderLists, listChanges: listChanges, setCap: setCap, applyOpt: applyOpt, S: S, use: function (U) { el = U.el; $ = U.$; } };   // test/config.test.js
}());
