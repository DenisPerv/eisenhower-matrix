// Eisenhower Harness page: pure helpers between the server's run model (scripts/runs.js readRun) and the page (harness.js).
// No network and no document of their own (gateControl is handed its element factory), so test/harness-data.test.js runs them in Node. Nothing here invents a value: a fact the run did not record stays null.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HarnessData = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const LIVE_STATES = ["running", "starting"];
  const KIND_KEYS = ["input", "output", "cache_read", "cache_write"];

  // A session's tokens over every model, its subagents' included, with the dollars of each kind.
  function tokOf(stats) {
    const t = { input: 0, output: 0, cache_read: 0, cache_write: 0, requests: 0, cost: (stats && stats.cost) || 0, c_input: 0, c_output: 0, c_cache_read: 0, c_cache_write: 0, c_web: 0 };
    for (const m of Object.values((stats && stats.by_model) || {})) {
      t.input += m.input; t.output += m.output; t.cache_read += m.cache_read; t.cache_write += m.write_5m + m.write_1h; t.requests += m.requests;
      const k = m.cost_by_kind || {};
      t.c_input += k.input || 0; t.c_output += k.output || 0; t.c_cache_read += k.cache_read || 0; t.c_cache_write += k.cache_write || 0; t.c_web += k.web_search || 0;
    }
    return t;
  }

  // The list of a mother from her name when the record has none: mother-<slug>, mother-<slug>-2.
  const listOfMother = (name) => name.replace(/^mother-/, "").replace(/-\d+$/, "");
  // "2026-11-05--13-19" as a time: the fallback for a master with no transcript.
  const tsTime = (ts) => { const m = /^(\d{4}-\d\d-\d\d)--(\d\d)-(\d\d)/.exec(ts); return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:00`).toISOString() : null; };

  // What the three controls offer for a session: the table in the plan and docs/eisenhower-agent-framework.md.
  function controlsFor(state, role, sessionId, task) {
    const sid = UUID.test(sessionId || "") ? sessionId : null;
    const running = LIVE_STATES.includes(state);
    const worker = role !== "master" && state !== "unknown";
    const hint = !worker ? null : state === "stopped" || state === "taken-over" ? "spawn.js release" : ["failed", "timeout", "lost", "stuck"].includes(state) ? "spawn.js takeover" : null;
    return {
      stop: !!sid && worker && running,
      continue_headless: !!sid && worker && ["stopped", "taken-over", "failed", "timeout", "lost", "stuck"].includes(state),
      continue_in_claude: sid && task && (role === "do" || role === "plan") ? continueUrl(sid, task) : null,
      copy: sid ? `claude --resume ${sid} --fork-session` : null,
      hint,
    };
  }
  const continueUrl = (sid, ref) => `homeos-claude://continue?sid=${encodeURIComponent(sid)}&ref=${encodeURIComponent(ref)}`;

  // Pure: running total of a session at time t, from its [ms, dollars] points.
  function spendAt(spend, t) {
    let lo = 0, hi = (spend || []).length - 1, v = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (spend[mid][0] <= t) { v = spend[mid][1]; lo = mid + 1; } else hi = mid - 1; }
    return v;
  }

  // Pure: a task's state at time t from its history; before its first sighting, that first state.
  function stateAt(hist, t, fallback) {
    if (!hist || !hist.length) return fallback;
    let v = hist[0].state;
    for (const h of hist) { if (Date.parse(h.at) <= t) v = h.state; else break; }
    return v;
  }

  // The run as the page uses it. Restarted mothers of a list become rows of the first one's block; a successor master stays a master.
  function toHarness(run) {
    const out = run.sessions.map((s) => {
      const running = LIVE_STATES.includes(s.state);
      const started = s.started_at || (s.stats && s.stats.first_at) || null;
      const ended = running ? null : s.ended_at || (s.stats && s.stats.last_at) || started;
      const list = s.list || (s.role === "mother" ? listOfMother(s.name) : null);
      return { name: s.name, role: s.role, parent: s.parent, started_by: s.parent, state: s.state, task: s.task, tasks: s.tasks || [], goal: s.goal, title: s.title, model: s.model, list,
        started_at: started, ended_at: ended, session_id: s.session_id, resume: s.resume, attempt: s.attempt || 0, result_of: s.result_of || [],
        active: (s.stats && s.stats.active) || [], tok: tokOf(s.stats), own_requests: s.stats ? s.stats.requests : 0, sub_requests: s.stats ? s.stats.subagent_requests : 0,
        tools: s.stats ? s.stats.tools : null, context: s.stats ? s.stats.context : null, spend: (s.stats && s.stats.spend) || [], by_model: (s.stats && s.stats.by_model) || {},
        no_price: (s.stats && s.stats.no_price) || [], agents: (s.stats && s.stats.agents) || [], report: s.report || null, brief: s.brief || null,
        transcript_missing: !s.stats, cost_usd: s.cost_usd || null, restart_of: null, controls: controlsFor(s.state, s.role, s.session_id, s.task) };
    });
    const master = out.find((s) => s.name === "master");
    const firstKid = out.filter((s) => s.started_at).map((s) => s.started_at).sort()[0];
    if (master && !master.started_at) master.started_at = firstKid || tsTime(run.ts);
    for (const s of out) if (!s.started_at) s.started_at = master.started_at;
    if (master && !LIVE_STATES.includes(master.state) && !master.ended_at) master.ended_at = master.started_at;

    const first = {}, rename = {};
    for (const s of out.filter((x) => x.role === "mother").sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))) {
      if (!first[s.list]) first[s.list] = s.name; else { s.restart_of = first[s.list]; rename[s.name] = first[s.list]; }
    }
    for (const s of out) if (rename[s.parent]) s.parent = rename[s.parent];
    for (const s of out) if (rename[s.name]) s.parent = rename[s.name];
    // A session with no list of its own belongs to its mother's.
    const byName = Object.fromEntries(out.map((s) => [s.name, s]));
    for (const s of out) if (!s.list && byName[s.parent] && byName[s.parent].role === "mother") s.list = byName[s.parent].list;

    const history = {};
    for (const h of run.board_history || []) (history[h.ref] = history[h.ref] || []).push(h);
    const tasks = (run.tasks || []).map((t) => ({ ...t, state: t.state === "other" && (t.why_not || []).some((w) => /^held by/.test(w)) ? "held" : t.state, hist: history[t.ref] || [] }));
    const list_names = {};
    for (const t of tasks) if (t.list && !list_names[t.list]) list_names[t.list] = String(t.ref).replace(/\s*#\d+$/, "").replace(/^HomeOS - /, "");

    const escalations = (run.escalations || []).map((e) => {
      const t = Date.parse(e.at), td = e.decision ? Date.parse(e.decision.at) : e.applied ? Date.parse(e.applied.at) : null;
      const dec = e.decision || e.applied;
      const cause = (String(e.text).split(/\r?\n/).find((l) => l.trim()) || "").replace(/^#+\s*/, "").trim();
      return { key: e.file, list: e.list, n: String(e.num), t: td && t > td ? td - 60000 : t, td, fixed: !!(td && t > td), origin: e.origin, mother: first[e.list] || e.mother, cause,
        raw: e.text, decision: dec ? dec.text : null, applied: e.decision && e.applied ? e.applied.text : null, by: dec && /master-/.test(dec.text) ? "the master" : "not recorded" };
    }).sort((a, b) => a.t - b.t);

    return { ts: run.ts, live: out.some((s) => LIVE_STATES.includes(s.state)), start: run.start, stop: run.stop, stopped_at: run.stopped_at, usage: run.usage || [], usage_start: run.usage_start,
      decisions: run.decisions || [], master_decisions: run.master_decisions || [], mother_decisions: run.mother_decisions || {}, escalations, tasks, day: run.day, planned: run.planned || {},
      wakes: run.wakes, links: run.links || [], prices: run.prices || {}, board_at: run.board ? run.board.at : null, suspects: run.board ? run.board.suspects || [] : [],
      day_report: run.day_report, tokens_md: run.tokens_md, sessions: out, list_names };
  }

  // A control the page cannot carry out now (the web copy, #45 decision 5): greyed, not disabled, so it keeps hover and keyboard focus; a click
  // does nothing; "Run local version" and the reason show on hover and focus (CSS .gw), in the title and through aria-describedby.
  // node: the control, its click handler already set. verdict: { ok:false, why } or anything else (then the node is returned as it is).
  // make: document.createElement. uid: a stable part of the hint's id. Every text goes through textContent.
  const LOCAL_HINT = "Run local version";
  function gateControl(node, verdict, make, uid) {
    if (!verdict || verdict.ok !== false) return node;
    const why = String(verdict.why || "").slice(0, 200);
    node.setAttribute("aria-disabled", "true");
    node.classList.add("greyed");
    if (node.tagName === "A") { node.removeAttribute("href"); node.setAttribute("role", "link"); }
    node.tabIndex = 0;
    node.setAttribute("title", why ? `${LOCAL_HINT}\n${why}` : LOCAL_HINT);
    node.onclick = (e) => { if (e && e.preventDefault) e.preventDefault(); return false; };
    const hint = make("span");
    hint.className = "ghint";
    hint.id = `gh-${String(uid).replace(/[^a-z0-9_-]/gi, "_")}`;
    hint.setAttribute("role", "tooltip");
    const head = make("b");
    head.textContent = LOCAL_HINT;
    hint.appendChild(head);
    if (why) { const line = make("span"); line.textContent = why; hint.appendChild(line); }
    node.setAttribute("aria-describedby", hint.id);
    const wrap = make("span");
    wrap.className = "gw";
    wrap.appendChild(node);
    wrap.appendChild(hint);
    return wrap;
  }

  return { KIND_KEYS, LOCAL_HINT, tokOf, listOfMother, controlsFor, continueUrl, spendAt, stateAt, toHarness, gateControl };
});
