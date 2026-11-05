// Continue in Claude: the handler's refusals, its two steps, and hostile links through the real PowerShell handler. No network, no Claude session.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const A = '5168303d-609e-4627-bad9-78d02d71674a', B = '7911488d-2838-4935-8b27-4f3d41fe5635';
const NOW = Date.parse('2026-11-05T20:00:00Z');
const load = () => import('../tools/continue/continue-handler.mjs');
const ok = { sid: A, ref: 'tasks#3', live: false, lease: null, lastClickMs: null, nowMs: NOW, transcriptExists: true };

test('refusals: bad values, live session, held task, double click, missing transcript', async () => {
  const H = await load();
  assert.equal(H.refusal(ok), null);
  assert.equal(H.refusal({ ...ok, sid: 'x' }).exit, H.EXIT.bad);
  assert.equal(H.refusal({ ...ok, ref: 'a b#3' }).exit, H.EXIT.bad);
  assert.equal(H.refusal({ ...ok, live: true }).exit, H.EXIT.live);
  assert.equal(H.refusal({ ...ok, lease: { held: true, holder: 'do-x', until: 'later' } }).exit, H.EXIT.live);
  assert.equal(H.refusal({ ...ok, lease: { held: false, holder: 'do-x' } }), null);
  assert.equal(H.refusal({ ...ok, lastClickMs: NOW - 29000 }).exit, H.EXIT.twice);
  assert.equal(H.refusal({ ...ok, lastClickMs: NOW - 31000 }), null);
  const missing = H.refusal({ ...ok, transcriptExists: false });
  assert.equal(missing.exit, H.EXIT.missing);
  assert.match(missing.text, /tasks#3/);
});

function deps(over = {}) {
  const calls = { forked: 0, opened: [], stamps: 0, logs: [] };
  return { calls, d: { log: t => calls.logs.push(t), nowMs: NOW, live: () => false, lease: async () => null, exists: () => true, read: () => null,
    write: () => { calls.stamps++; }, forkOf: () => { calls.forked++; return B; }, open: id => { calls.opened.push(id); return { status: 0 }; }, ...over } };
}
const args = { sid: A, ref: 'tasks#3', project: 'P' };

test('handle: forks, then opens the copy, never the original', async () => {
  const H = await load();
  const { calls, d } = deps();
  assert.equal(await H.handle(args, d), 0);
  assert.equal(calls.forked, 1);
  assert.deepEqual(calls.opened, [B]);
  assert.equal(calls.stamps, 1);
});

test('handle: a live session refuses before any fork; --check runs nothing; no project is refused', async () => {
  const H = await load();
  const live = deps({ live: () => true });
  assert.equal(await H.handle(args, live.d), H.EXIT.live);
  assert.equal(live.calls.forked, 0);
  const dry = deps();
  assert.equal(await H.handle({ ...args, check: true }, dry.d), 0);
  assert.equal(dry.calls.forked + dry.calls.stamps + dry.calls.opened.length, 0);
  assert.equal(await H.handle({ sid: A, ref: 'tasks#3' }, deps().d), H.EXIT.bad);
});

test('handle: a failed fork gives the plain command and opens nothing', async () => {
  const H = await load();
  const { calls, d } = deps({ forkOf: () => null });
  assert.equal(await H.handle(args, d), H.EXIT.failed);
  assert.equal(calls.opened.length, 0);
  assert.match(calls.logs.join('\n'), /--fork-session[\s\S]*\/desktop/);
});

test('fork: the first message goes on stdin, only the session id is an argument', async () => {
  const H = await load();
  let seen;
  const id = H.fork(A, 'P', { bin: 'c', run: (bin, a, o) => { seen = { a, input: o.input, cwd: o.cwd }; return { status: 0, stdout: JSON.stringify({ session_id: B }) }; } });
  assert.equal(id, B);
  assert.deepEqual(seen.a, ['-p', '--resume', A, '--fork-session', '--output-format', 'json']);
  assert.equal(seen.input, H.FIRST_MESSAGE);
  assert.equal(seen.cwd, 'P');
  assert.equal(H.fork(A, 'P', { bin: 'c', run: () => ({ status: 0, stdout: JSON.stringify({ session_id: A }) }) }), null, 'the same id is no copy');
  assert.equal(H.fork(A, 'P', { bin: 'c', run: () => ({ status: 1, stdout: '' }) }), null);
});

test('sessionLive: reads a run record of the project, a dead process does not count', async () => {
  const H = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cont-'));
  assert.equal(H.sessionLive(A, dir), false, 'no Runs folder');
  fs.mkdirSync(path.join(dir, 'Runs', 'r1'), { recursive: true });
  const rec = path.join(dir, 'Runs', 'r1', 'spawn-do-x-1.json');
  fs.writeFileSync(rec, JSON.stringify({ session_id: A, state: 'running', pid: 1 }));
  assert.equal(H.sessionLive(A, dir, { isAlive: () => true }), true);
  assert.equal(H.sessionLive(A, dir, { isAlive: () => false }), false);
  assert.equal(H.sessionLive(B, dir, { isAlive: () => true }), false);
  fs.writeFileSync(rec, JSON.stringify({ session_id: A, state: 'done', pid: 1 }));
  assert.equal(H.sessionLive(A, dir, { isAlive: () => true }), false);
  fs.rmSync(dir, { recursive: true });
});

test('the app builds a link the handler accepts, with the # encoded', async () => {
  const H = await load();
  const ref = '_selftest#12';
  assert.match(ref, H.REF_RE);
  assert.equal(encodeURIComponent(ref), '_selftest%2312');
});

const folder = path.join(__dirname, '..', 'tools', 'continue');
const ps = (file, ...a) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(folder, file), ...a], { encoding: 'utf8', timeout: 60000 });

test('handler: hostile links run nothing', { skip: process.platform !== 'win32' }, () => {
  const hostile = ['', 'homeos-claude://continue', `homeos-claude://continue?sid=${A}`, `homeos-claude://continue?sid=${A}&ref=a#3`,
    `homeos-claude://continue?sid=${A}&ref=a%233&x=1`, `homeos-claude://continue?x=1&sid=${A}&ref=a%233`, `homeos-claude://other?sid=${A}&ref=a%233`,
    `HOMEOS-CLAUDE://continue?sid=${A}&ref=a%233`, `homeos-claude://continue?sid=${A};calc&ref=a%233`, `homeos-claude://continue?sid=${A}&ref=a%233;calc`,
    `homeos-claude://continue?sid=${A}&ref=a%233%0Acalc`, `homeos-claude://continue?sid=$(calc)&ref=a%233`, `homeos-claude://continue?sid=${A}&ref=A%233`,
    `homeos-claude://continue?sid=${A}&ref=a b%233`];
  for (const uri of hostile) {
    const r = ps('continue-handler.ps1', uri, '-ProjectDir', os.tmpdir(), '-Check');
    assert.equal(r.status, 2, `${uri}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /Refused/);
  }
});

test('handler: a good link reaches the checks, and a session not on this machine is refused by name', { skip: process.platform !== 'win32' }, () => {
  const r = ps('continue-handler.ps1', 'homeos-claude://continue?sid=00000000-0000-4000-8000-000000000000&ref=_selftest%231', '-ProjectDir', os.tmpdir(), '-Check');
  assert.equal(r.status, 5, r.stdout + r.stderr);
  assert.match(r.stdout, /Start fresh from task _selftest#1/);
});

test('installer: -Show writes nothing and names the folder; no folder is refused', { skip: process.platform !== 'win32' }, () => {
  const r = ps('install-continue-handler.ps1', '-ProjectDir', os.tmpdir(), '-Show');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /HKCU:\\Software\\Classes\\homeos-claude/);
  assert.match(r.stdout, /continue-handler\.ps1" -ProjectDir ".*" "%1"/);
  assert.equal(ps('install-continue-handler.ps1', '-Show').status, 2);
});

test('nothing in the published set or the scripts names a household path', () => {
  for (const n of fs.readdirSync(folder)) {
    assert.doesNotMatch(fs.readFileSync(path.join(folder, n), 'utf8'), /D:\\Claude|HomeOS-TasksBoardHarness|maximdenisuk|Anastasiia/, n);
  }
});
