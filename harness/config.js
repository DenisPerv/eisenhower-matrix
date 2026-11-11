/* Eisenhower harness viewer: the Configurations page (harness-configurations-plan.md T11, UI spec references/homeos/harness-configurations/ui/
   configurations-page-spec.md, winner p1 with the p2 changes). Tabs Workload, Autonomy, Budgets, Notifications, Machine, Model routing (TBD).
   Reads GET /api/config. Writes only this device's limits file through the page's own POST /api/limits (Workload, Machine). Autonomy, intake
   and budgets are read-only here: people change them on the board with their own sign-in (set_autonomy, set_intake, set_budget).
   Uses what harness.js hands over (its UI object): el, $, panelHead, panelBody, openPanel, getJson, postJson, renderLimits, restoreSize, markSel, setLit, state, PO, canDo. */
(function () {
  'use strict';
  var el, $, panelHead, panelBody, openPanel, getJson, postJson, renderLimits, restoreSize, markSel, setLit, state, PO, canDo;   // from harness.js (UI), set on open
  var SVGNS = 'http://www.w3.org/2000/svg';
  var BOARD = 'http://localhost:8788/';
  var DAY = 864e5;
  var MODES = {
    manual: { n: 'Manual', does: 'Agent does: nothing.', you: 'Comes to you: everything.' },
    project_rules: { n: 'Project rules', does: "Agent does: what the project's rules allow; with no rules, as Guided.", you: 'Comes to you: anything the rules do not cover.' },
    guided: { n: 'Guided', does: "Agent does: plans and work; the list's mother approves plans.", you: 'Comes to you: every question and every result check.' },
    ai_brain: { n: 'AI Brain', does: 'Agent does: plans, side questions and checks, with your past answers.', you: 'Comes to you: security, data structure and E0.' }
  };
  var ORDER = ['manual', 'project_rules', 'guided', 'ai_brain'];
  var TABS = [['workload', 'Workload'], ['autonomy', 'Autonomy'], ['budgets', 'Budgets'], ['notify', 'Notifications'], ['machine', 'Machine'], ['routing', 'Model routing']];
  var S = { tab: 'workload', filter: 'all', series: 'overall', range: 'month', data: null, error: null, cursor: null };

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
    if (id === 'workload') { var live = 0, max = 0; limRows().forEach(function (r) { live += r.live || 0; if (r.enabled !== false) max += r.max_sessions || 0; }); return live + ' of ' + max + ' sessions live'; }
    if (id === 'autonomy') { var b = lists().filter(function (l) { return l.effective === 'ai_brain'; }).length; return lists().length ? (b ? b + ' on AI Brain' : 'all Guided or narrower') : 'board not read'; }
    if (id === 'budgets') { var rows = (d.board && d.board.budgets && d.board.budgets.rows) || []; if (!rows.length) return 'no budget set'; var at = rows.filter(function (r) { return r.reached; }).length; return at ? at + ' at cap' : 'below caps'; }
    if (id === 'notify') { var t = lists().filter(function (l) { return l.intake && l.intake.notify_telegram; }).length; return t ? t + ' with Telegram' : 'Daily report and cards'; }
    if (id === 'machine') { var m = d.machine || {}; return (m.max_mothers ? m.max_mothers + ' mothers at once' : 'no mother cap') + (m.commit_free_gb != null ? ' · ' + m.commit_free_gb + ' GB free' : ''); }
    return 'TBD';
  }

  /* ---------- tabs (ARIA tablist; a 3x2 grid on phones, p2 change 5) ---------- */
  function tabsEl(host) {
    var bar = el('div', 'cfg-tabs'); bar.setAttribute('role', 'tablist'); bar.setAttribute('aria-label', 'Configurations');
    var btns = TABS.map(function (t, i) {
      var b = el('button'); b.type = 'button'; b.id = 'cfgt-' + t[0]; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', 'cfgp-' + t[0]);
      b.appendChild(el('span', 'cfg-tn', t[1])); b.appendChild(el('span', 'cfg-ts', status(t[0])));
      if (t[0] === 'routing') b.setAttribute('aria-disabled', 'true');
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

  /* ---------- Workload ---------- */
  function renderWorkload(p) {
    p.textContent = '';
    if (!S.data) { p.appendChild(skel()); return; }
    var rows = limRows(), live = 0, max = 0;
    rows.forEach(function (r) { live += r.live || 0; if (r.enabled !== false) max += r.max_sessions || 0; });
    var sec = el('section', 'cfg-sec'); sec.appendChild(el('h3', null, 'This device'));
    var t = table('This device and its sessions', [['Device'], ['Runs sessions'], ['Live / limit']]), tr = el('tr');
    var c1 = cell(tr, 'Device', 'h'); c1.appendChild(el('span', null, (S.data.device || 'this device') + ' (this device)')); c1.appendChild(el('span', 'cfg-st', max ? 'Online' : 'Off: takes no new sessions'));
    cell(tr, 'Runs sessions', null, max ? 'On' : 'Off');
    cell(tr, 'Live / limit').appendChild(meter(live, max));
    t.tBodies[0].appendChild(tr); sec.appendChild(t);
    sec.appendChild(el('p', 'cfg-note', 'The other device sets its own limits on its own page ("Set on that device"): limits are per device (D57), and switching a list off here gives it max sessions 0 on this device only, never a Manual mode on the board.'));
    p.appendChild(sec);
    var s2 = el('section', 'cfg-sec'); s2.appendChild(el('h3', null, 'Per list on this device'));
    var t2 = table('Lists and their live sessions', [['List'], ['On'], ['Live / limit']]);
    if (!rows.length) { var e = el('div', 'cfg-empty'); e.appendChild(el('b', null, 'No lists yet.')); e.appendChild(document.createTextNode('A list shows here after the board is read.')); s2.appendChild(e); }
    rows.forEach(function (r) { var tr2 = el('tr'); if (r.enabled === false) tr2.className = 'muted'; cell(tr2, 'List', 'h', r.name || r.slug); cell(tr2, 'On', null, r.enabled === false ? 'Off' : 'On'); cell(tr2, 'Live / limit').appendChild(meter(r.live || 0, r.enabled === false ? 0 : r.max_sessions || 0)); t2.tBodies[0].appendChild(tr2); });
    if (rows.length) s2.appendChild(t2);
    s2.appendChild(el('p', 'cfg-note', 'A session started for a task with its own Autonomy mode counts against its list’s limit like any other.'));
    var ed = el('details', 'cfg-edit'); ed.appendChild(el('summary', null, 'Change the limits of this device')); var h = el('div'); h.id = 'limits'; ed.appendChild(h); s2.appendChild(ed);
    ed.addEventListener('toggle', function () { if (ed.open && typeof renderLimits === 'function') renderLimits(S.data.limits); });
    p.appendChild(s2);
  }
  function meter(live, max) { var m = el('span', 'cfg-meter' + (max > 0 && live >= max ? ' full' : '')); var tr = el('span', 'tr'), f = el('span'); f.style.width = (max ? Math.min(100, live / max * 100) : 0) + '%'; tr.appendChild(f); m.appendChild(tr); m.appendChild(el('b', null, live + ' / ' + max)); if (max > 0 && live >= max) m.appendChild(el('span', 'flag', 'at limit')); return m; }

  /* ---------- Autonomy ---------- */
  function renderAutonomy(p) {
    p.textContent = '';
    if (!S.data) { p.appendChild(skel()); return; }
    if (!S.data.board) { p.appendChild(banner('The board could not be read' + (S.data.board_error ? ': ' + S.data.board_error : '') + '. Modes are shown once it can.')); }
    var ls = lists(), cards = el('div', 'cfg-cards'); cards.setAttribute('role', 'group'); cards.setAttribute('aria-label', 'Filter by mode');
    [['all', 'All lists']].concat(ORDER.map(function (m) { return [m, MODES[m].n]; })).forEach(function (x) {
      var n = x[0] === 'all' ? ls.length : ls.filter(function (l) { return l.effective === x[0]; }).length;
      var b = el('button', 'cfg-card'); b.type = 'button'; b.setAttribute('aria-pressed', S.filter === x[0] ? 'true' : 'false');
      if (x[0] !== 'all') b.appendChild(modeMark(x[0])); b.appendChild(el('b', null, String(n))); b.appendChild(el('span', null, x[1]));
      b.onclick = function () { S.filter = x[0]; renderAutonomy(p); }; cards.appendChild(b);
    });
    p.appendChild(cards);
    var rows = ls.filter(function (l) { return S.filter === 'all' || l.effective === S.filter; });
    var t = table('Lists and their Autonomy mode', [['List'], ['Mode'], ['Set by'], ['Tasks with own mode', 'n'], ['']]);
    rows.forEach(function (l) {
      var tr = el('tr'); cell(tr, 'List', 'h', l.name);
      var cm = cell(tr, 'Mode'); cm.appendChild(modeEl(l.effective)); if (l.effective !== l.mode) cm.appendChild(el('span', 'cfg-st', 'Set to ' + (MODES[l.mode] || MODES.guided).n + ': ' + (l.why || []).join('; ')));
      cell(tr, 'Set by', null, l.set_by ? l.set_by : 'Default');
      cell(tr, 'Tasks with own mode', 'n', String(l.overrides || 0));
      var a = el('a', 'lk', 'Edit on the board ↗'); a.href = BOARD; a.target = '_blank'; a.rel = 'noopener'; a.setAttribute('aria-label', 'Edit ' + l.name + ' on the board'); cell(tr, '', 'n').appendChild(a);
      t.tBodies[0].appendChild(tr);
    });
    if (rows.length) p.appendChild(t); else { var e = el('div', 'cfg-empty'); e.appendChild(el('b', null, 'No list is in this mode.')); p.appendChild(e); }
    p.appendChild(el('p', 'cfg-note', 'Read only here. Modes are set on the board, in each list’s settings, by its owner or editor with their own sign-in; AI Brain only by a household person. A task inherits from its parent, then its list; a Manual list is widened only by its household owner.'));
    var e0 = el('section', 'cfg-e0'); e0.setAttribute('aria-labelledby', 'cfg-e0h'); var h = el('h3', null, 'E0: always the person’s, in every mode'); h.id = 'cfg-e0h'; e0.appendChild(h);
    e0.appendChild(el('p', null, 'No mode, precedent, project rule or list brief makes these an agent’s decision.'));
    var u = el('ul'); ((S.data.board && S.data.board.e0) || []).forEach(function (x) { u.appendChild(el('li', null, x)); }); e0.appendChild(u); p.appendChild(e0);
    var dl = el('dl', 'cfg-modes'); ORDER.forEach(function (m) { var d = el('div'), dt = el('dt'); dt.appendChild(modeEl(m)); d.appendChild(dt); d.appendChild(el('dd', null, MODES[m].does)); d.appendChild(el('dd', null, MODES[m].you)); dl.appendChild(d); }); p.appendChild(dl);
  }
  function banner(text) { var d = el('div', 'cfg-banner'); d.setAttribute('role', 'alert'); d.appendChild(el('p', null, text)); return d; }

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
    if (!s.cap) return 'No budget set. Set it on the master’s list on the board.';
    if (s.fc.kind === 'forecast') return 'Cap reached around ' + ymd(s.fc.at, true);
    if (s.fc.kind === 'reached') return 'Cap reached. New sessions in this list are paused.';
    if (s.fc.kind === 'below') return 'Cap not reached this month.';
    return 'No forecast yet.';
  }
  function renderBudgets(p) {
    p.textContent = '';
    if (!S.data) { p.appendChild(skel()); return; }
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
    var t = table('Budgets per list', [['List'], ['Spent this month', 'n'], ['Cap', 'n'], ['Cap reached']]);
    keys.forEach(function (key) {
      var x = seriesOf(key), tr = el('tr'); if (key === 'overall') tr.className = 'sum';
      var b = el('button', 'lk', x.name); b.type = 'button'; b.onclick = function () { S.series = key; renderBudgets(p); var c = $('cfg-chart'); if (c) c.focus(); }; cell(tr, 'List', 'h').appendChild(b);
      cell(tr, 'Spent this month', 'n', money(x.spent)); cell(tr, 'Cap', 'n', x.cap ? moneyShort(x.cap) : 'Not set');
      cell(tr, 'Cap reached', null, !x.cap ? 'No budget set' : x.fc.kind === 'forecast' ? 'Around ' + ymd(x.fc.at, true) : x.fc.kind === 'reached' ? 'Reached. New sessions paused.' : x.fc.kind === 'below' ? 'Not this month' : 'No forecast yet');
      t.tBodies[0].appendChild(tr);
    });
    p.appendChild(t);
    p.appendChild(el('p', 'cfg-note', 'At API prices. Caps are shared by every device through the board and are set there by a household person. A cap stops new starts in its list (no card, no try counted); running sessions finish their step. It never lifts the 90% token pause.'));
    drawChart();
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
    if (!s.cap) g.appendChild(sv('text', { x: m.l + iw / 2, y: m.t + 14, 'text-anchor': 'middle', 'class': 'lbl', style: 'fill:#eef2fa' }, 'No budget set. Set it on the master’s list.'));
    var sumEl = $('cfg-chart-sum'); if (sumEl) sumEl.textContent = 'Chart: ' + s.name + ', spent ' + money(s.spent) + ' this month' + (s.cap ? ' against a cap of ' + moneyShort(s.cap) + '. ' : '. ') + capText(s) + note;
    var tip = $('cfg-ctip'), cur = sv('g', { visibility: 'hidden' }); cur.appendChild(sv('line', { y1: m.t, y2: m.t + ih, stroke: '#eef2fa', 'stroke-opacity': 0.5 })); cur.appendChild(sv('circle', { r: 4, fill: '#eef2fa' })); svg.appendChild(cur);
    var valueAt = function (tm) { var all = s.pts.slice(); if (f) all.push(f[1]); if (tm < all[0][0]) return null; for (var i = 1; i < all.length; i++) if (tm <= all[i][0]) { var p0 = all[i - 1], p1 = all[i]; return p1[0] === p0[0] ? p1[1] : p0[1] + (p1[1] - p0[1]) * (tm - p0[0]) / (p1[0] - p0[0]); } return null; };
    var show = function (tm, announce) { var val = valueAt(tm); if (val == null) { cur.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; return; } var cx = x(tm), cy = y(val); cur.setAttribute('visibility', 'visible'); cur.firstChild.setAttribute('x1', cx); cur.firstChild.setAttribute('x2', cx); cur.lastChild.setAttribute('cx', cx); cur.lastChild.setAttribute('cy', cy); var label = ymd(tm) + ': ' + money(val) + (tm > now ? ' forecast' : ' spent'); tip.textContent = label; tip.style.display = 'block'; tip.style.left = Math.max(4, Math.min(svg.clientWidth - tip.offsetWidth + 4, cx - tip.offsetWidth / 2 + 8)) + 'px'; tip.style.top = Math.max(4, cy - 34) + 'px'; if (announce) $('cfg-chart-live').textContent = label; };
    svg.onmousemove = function (e) { var r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * (W / r.width), tm = Math.round((A + (px - m.l) / iw * (Bt - A)) / DAY) * DAY; if (tm < A || tm > Bt) return; S.cursor = tm; show(tm); };
    svg.onmouseleave = svg.onblur = function () { cur.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; };
    svg.onkeydown = function (e) { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); var tm = S.cursor == null ? Math.min(now, Bt) : S.cursor + (e.key === 'ArrowRight' ? DAY : -DAY); tm = Math.max(A, Math.min(Bt, tm)); S.cursor = tm; show(tm, true); };
  }

  /* ---------- Notifications ---------- */
  function renderNotify(p) {
    p.textContent = '';
    if (!S.data) { p.appendChild(skel()); return; }
    var t = table('Notifications per list', [['List'], ['Daily report'], ['Delegate task'], ['Telegram'], ['Stage report']]);
    lists().forEach(function (l) {
      var tr = el('tr'); cell(tr, 'List', 'h', l.name);
      cell(tr, 'Daily report', null, 'Always on'); cell(tr, 'Delegate task', null, 'Always on');
      cell(tr, 'Telegram', null, l.intake && l.intake.notify_telegram ? 'On (own chat)' : 'Off');
      cell(tr, 'Stage report', null, l.intake && l.intake.stage_report ? 'On' : 'Off');
      t.tBodies[0].appendChild(tr);
    });
    p.appendChild(t);
    p.appendChild(el('p', 'cfg-note', 'By default the harness tells you only in the Daily report and on a Delegate task. Telegram is on request, set in the list’s intake on the board by a household person; it goes to your own chat with a fixed text and never takes an answer: answers come only from the board.'));
  }

  /* ---------- Machine ---------- */
  function renderMachine(p) {
    p.textContent = '';
    if (!S.data) { p.appendChild(skel()); return; }
    var M = S.data.machine || {}, dl = el('dl', 'cfg-kvf');
    var row = function (lbl, nodes) { dl.appendChild(el('dt', null, lbl)); var dd = el('dd'); nodes.forEach(function (n) { dd.appendChild(typeof n === 'string' ? document.createTextNode(n) : n); }); dl.appendChild(dd); };
    var inp = el('input', 'cfg-num'); inp.type = 'number'; inp.min = 0; inp.max = 10; inp.id = 'cfg-mothers'; inp.value = M.max_mothers_set != null ? M.max_mothers_set : (M.max_mothers || 0);
    var lab = el('label', 'vh', 'Mothers at once on this device'); lab.htmlFor = 'cfg-mothers';
    var save = el('button', 'btn', 'Save'); save.type = 'button'; var msg = el('span', 'cfg-msg'); msg.setAttribute('role', 'status');
    save.onclick = function () {
      var n = Number(inp.value); if (!(n >= 0 && n <= 10 && Math.round(n) === n)) { msg.textContent = 'A whole number from 0 to 10.'; return; }
      save.disabled = true; var base = (S.data.limits && S.data.limits.base_hash && S.data.limits.base_hash.machine) || null;
      postJson('/api/limits', { scope: 'machine', payload: { max_mothers: n }, base_hash: base }).then(function (r) { save.disabled = false; if (r.ok) { msg.textContent = 'Saved to this device.'; load(); } else msg.textContent = 'Could not write the limits file. Your change is not saved.'; })
        .catch(function () { save.disabled = false; msg.textContent = 'Could not write the limits file. Your change is not saved.'; });
    };
    if (typeof canDo === 'function') { var gate = canDo('limits', null, { scope: 'machine' }); if (gate && gate.ok === false) { inp.disabled = true; save.disabled = true; save.title = 'Run local version' + (gate.why ? '\n' + gate.why : ''); } }
    row('Mothers at once', [lab, inp, save, msg, el('span', 'cfg-st', M.max_mothers_set != null ? 'Set on this device.' : 'Default: ' + (M.max_mothers ? M.max_mothers + ' (16 GB of memory or less)' : 'no cap') + '.')]);
    row('Memory', [(M.commit_free_gb != null ? M.commit_free_gb + ' GB of commit free' : 'not read') + ', ' + (M.memory_gb || '?') + ' GB in all. Under 4 GB no session starts.']);
    row('Reaper', ['Ends only processes it registered itself, of a session whose runner is gone, every ' + (M.reaper && M.reaper.tick_min || 5) + ' min and at each mother start. Registered now: ' + (M.reaper ? M.reaper.registered : 0) + '.']);
    var log = el('ul', 'cfg-log'); (M.watchdog || []).forEach(function (l) { log.appendChild(el('li', null, l)); }); if (!(M.watchdog || []).length) log.appendChild(el('li', null, 'No alert in the newest run.'));
    row('Watchdog', [el('span', null, 'No child start for a while while mothers wait: an alert, and the youngest waiting mother ends (never a master).'), log]);
    p.appendChild(dl);
    p.appendChild(el('p', 'cfg-note', 'This device saves changes right away. The other device has its own page.'));
  }

  /* ---------- Model routing (TBD) ---------- */
  function renderRouting(p) {
    p.textContent = '';
    var d = el('div', 'cfg-tbd'); d.appendChild(el('b', null, 'Model routing: to be designed.')); d.appendChild(document.createTextNode(' Today every role starts by config/models.json (read only):')); p.appendChild(d);
    var roles = (S.data && S.data.board && S.data.board.models && S.data.board.models.roles) || {};
    var t = table('Model per role', [['Role'], ['Default'], ['Simple'], ['Complex']]);
    Object.keys(roles).forEach(function (r) { var x = roles[r], tr = el('tr', 'muted'); cell(tr, 'Role', 'h', r); cell(tr, 'Default', null, x['default']); cell(tr, 'Simple', null, x.simple ? x.simple.model + ' · ' + x.simple.effort : ''); cell(tr, 'Complex', null, x.complex ? x.complex.model + ' · ' + x.complex.effort : ''); t.tBodies[0].appendChild(tr); });
    if (Object.keys(roles).length) p.appendChild(t);
  }

  var RENDER = { workload: renderWorkload, autonomy: renderAutonomy, budgets: renderBudgets, notify: renderNotify, machine: renderMachine, routing: renderRouting };
  function renderAll() {
    Object.keys(panels).forEach(function (k) { RENDER[k](panels[k]); });
    tabBtns.forEach(function (b) { var id = b.id.slice(5); b.lastChild.textContent = status(id); });
    var pb = $('cfg-banner-host'); if (pb) { pb.textContent = ''; if (S.error) pb.appendChild(banner('Could not read the configuration: ' + S.error + '. The last values read are shown.')); }
    if (PO) PO.setAttribute('aria-busy', S.data ? 'false' : 'true');
  }
  function load() { getJson('/api/config').then(function (v) { S.data = v; S.error = null; renderAll(); }).catch(function (e) { S.error = (e && e.message) || 'no answer'; renderAll(); }); }

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
  var rz; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(drawChart, 120); });
}());
