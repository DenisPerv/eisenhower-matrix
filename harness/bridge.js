/* The board bridge (HomeOS Configurations page, 2026-11-11). The local harness page (http://127.0.0.1:8790 or http://localhost:8790) has no
   sign-in of its own, and homeos-agent may never write Autonomy or budgets. It loads this page in a hidden frame; this page runs on the
   board's origin with the person's own session (td.auth, through harness-remote.js) and calls only two RPCs for it: set_autonomy and
   set_budget. The database checks the person's rights as on the board. Runs only on localhost; any other origin or parent is ignored. */
(function () {
  'use strict';
  var LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var ALLOWED = ['http://127.0.0.1:8790', 'http://localhost:8790'];
  var RPCS = { set_autonomy: ['p_kind', 'p_id', 'p_mode', 'p_expected'], set_budget: ['p_list', 'p_period', 'p_cap'] };
  if (!LOCAL || window.parent === window || !window.HarnessTransport) return;
  var T = window.HarnessTransport;
  var hello = function (origin) {
    T.ready.then(function () { return T.rpc('is_household', {}).catch(function () { return null; }); })
      .then(function (hh) { window.parent.postMessage({ bridge: 'hello', signedIn: !!T.whoami(), household: hh === true }, origin); },
        function (e) { window.parent.postMessage({ bridge: 'hello', signedIn: false, error: String((e && e.message) || e) }, origin); });
  };
  window.addEventListener('message', function (e) {
    if (ALLOWED.indexOf(e.origin) < 0 || e.source !== window.parent) return;
    var m = e.data || {};
    if (m.bridge === 'hello') return hello(e.origin);
    if (m.bridge !== 'rpc' || !RPCS[m.name] || typeof m.id !== 'string') return;
    var args = {};
    RPCS[m.name].forEach(function (k) { args[k] = m.args && m.args[k] !== undefined ? m.args[k] : null; });
    T.ready.then(function () { return T.rpc(m.name, args); })
      .then(function (r) { window.parent.postMessage({ bridge: 'reply', id: m.id, ok: true, result: r === undefined ? null : r }, e.origin); },
        function (x) { window.parent.postMessage({ bridge: 'reply', id: m.id, ok: false, error: String((x && x.message) || x), code: x && x.code }, e.origin); });
  });
  window.parent.postMessage({ bridge: 'loaded' }, '*');
}());
