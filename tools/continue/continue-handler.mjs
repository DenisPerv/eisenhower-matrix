#!/usr/bin/env node
// Continue in Claude: opens a copy of an agent's finished Claude Code session in the Claude app. Called by continue-handler.ps1 with values it has
// already checked; they are checked again here. Dependency-free Node; README in this folder.
//   node tools/continue/continue-handler.mjs --sid <uuid> --ref <slug>#<num> --project <folder> [--env <file>] [--as <handle>] [--check]
// Two steps, because `claude --desktop` refuses --fork-session (tested on CLI 2.1.311): a headless `claude -p --resume <sid> --fork-session` makes the
// copy with a first message, then `claude --desktop --resume <new id>` opens it. The original transcript is not written.
// Exit: 0 opened, 2 bad values, 3 session live or task held, 4 second click within 30 s, 5 transcript not on this machine, 6 fork or open failed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const REF_RE = /^[a-z0-9_-]{1,64}#[0-9]{1,7}$/;
export const EXIT = { ok: 0, bad: 2, live: 3, twice: 4, missing: 5, failed: 6 };
const TWICE_MS = 30000, STARTING_MS = 120000;
export const FIRST_MESSAGE = 'This is a copy of a finished session, opened by the Continue in Claude button. You hold no task and no lease: change nothing on the board as this session. Reply with one word: ready. The person writes next.';

export const transcriptOf = (sid, project, home = os.homedir()) => path.join(home, '.claude', 'projects', path.resolve(project).replace(/[:\\/]/g, '-'), `${sid}.jsonl`);

function claudeBin() {
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return fs.existsSync(local) ? local : 'claude';
}

function alive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// A running session record of a harness that keeps Runs/<ts>/spawn-*.json in the project folder, if there is one.
export function sessionLive(sid, project, { nowMs = Date.now(), isAlive = alive } = {}) {
  const runs = path.join(project, 'Runs');
  let dirs = [];
  try { dirs = fs.readdirSync(runs); } catch (e) { return false; }
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(runs, d)); } catch (e) { continue; }
    for (const n of names) {
      if (!/^spawn-.*\.json$/.test(n) || /-out(\.\d+)?\.json$/.test(n)) continue;
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(runs, d, n), 'utf8')); } catch (e) { continue; }
      if (r.session_id !== sid) continue;
      if (r.state === 'running' && isAlive(r.runner_pid || r.pid)) return true;
      if (r.state === 'starting' && nowMs - Date.parse(r.started_at) < STARTING_MS) return true;
    }
  }
  return false;
}

// The task's lease from items.ai, or null when there is no env file or the board cannot be read: a copy writes nothing to the original or the board.
export async function leaseOf(ref, envFile, handle = 'homeos-agent', { nowMs = Date.now() } = {}) {
  if (!envFile) return null;
  let c;
  try {
    const { readEnv, connect } = await import('../../cli/lib.mjs');
    c = await connect(readEnv(envFile), handle, { via: 'script:continue-handler' });
    const [slug, num] = ref.split('#');
    const l = await c.rest('GET', `lists?select=id&slug=eq.${encodeURIComponent(slug)}`);
    if (!l.ok || l.json.length !== 1) return null;
    const i = await c.rest('GET', `items?select=ai&list_id=eq.${l.json[0].id}&num=eq.${Number(num)}`);
    const lease = i.ok && i.json[0] && i.json[0].ai && i.json[0].ai.lease;
    if (!lease || !lease.holder || !lease.until) return null;
    return { held: Date.parse(lease.until) > nowMs, holder: lease.holder, until: lease.until };
  } catch (e) { return null; } finally { if (c) await c.close(); }
}

// Pure: the refusal for these facts, or null.
export function refusal({ sid, ref, live, lease, lastClickMs, nowMs, transcriptExists }) {
  if (!UUID_RE.test(String(sid)) || !REF_RE.test(String(ref))) return { exit: EXIT.bad, text: 'Refused: not a session id and a task reference.' };
  if (live) return { exit: EXIT.live, text: `Session ${sid} is still running. Wait until it ends, then click again.` };
  if (lease && lease.held) return { exit: EXIT.live, text: `Task ${ref} is held by ${lease.holder} until ${lease.until}. Wait until that session ends, then click again.` };
  if (lastClickMs && nowMs - lastClickMs < TWICE_MS) return { exit: EXIT.twice, text: `This session was opened a moment ago. Look for the new session in the Claude app; a second copy is possible after ${TWICE_MS / 1000} seconds.` };
  if (!transcriptExists) return { exit: EXIT.missing, text: `The transcript of session ${sid} is not on this machine. Start fresh from task ${ref}.` };
  return null;
}

const stampPath = (sid, tmp = os.tmpdir()) => path.join(tmp, 'tasksdashboard-continue', `${sid}.stamp`);
function readStamp(f) { try { return Number(fs.readFileSync(f, 'utf8')) || null; } catch (e) { return null; } }
function writeStamp(f, ms) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(ms)); }

// Makes the copy; returns its session id or null.
export function fork(sid, project, { bin = claudeBin(), run = spawnSync } = {}) {
  const r = run(bin, ['-p', '--resume', sid, '--fork-session', '--output-format', 'json'], { cwd: project, input: FIRST_MESSAGE, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  try {
    const id = JSON.parse(r.stdout).session_id;
    return UUID_RE.test(String(id)) && id !== sid ? id : null;
  } catch (e) { return null; }
}

export async function handle({ sid, ref, project, env, as, check = false }, deps = {}) {
  const { log = console.log, nowMs = Date.now(), live = sessionLive, lease = leaseOf, exists = fs.existsSync, read = readStamp, write = writeStamp, forkOf = fork,
    open = id => spawnSync(claudeBin(), ['--desktop', '--resume', id], { cwd: project, stdio: 'inherit' }) } = deps;
  const valid = UUID_RE.test(String(sid)) && REF_RE.test(String(ref));
  if (valid && !project) { log('Refused: no project folder. Install the handler again with -ProjectDir.'); return EXIT.bad; }
  const facts = valid
    ? { live: live(sid, project), lease: await lease(ref, env, as), lastClickMs: read(stampPath(sid)), nowMs, transcriptExists: exists(transcriptOf(sid, project)) }
    : {};
  const no = refusal({ sid, ref, ...facts });
  if (no) { log(no.text); return no.exit; }
  if (check) { log(`Would open a copy of session ${sid} for task ${ref}.`); return EXIT.ok; }
  write(stampPath(sid), nowMs);
  log(`Making a copy of session ${sid} for task ${ref}. The original stays as it was. This can take a minute.`);
  const copy = forkOf(sid, project);
  if (!copy) {
    log(`The copy failed. In a console, in ${project}, run:\n  claude --resume ${sid} --fork-session\nThen type /desktop to move it to the Claude app.`);
    return EXIT.failed;
  }
  const opened = open(copy);
  if (opened.error || opened.status !== 0) {
    log(`The copy ${copy} exists, but the app did not open. Run: claude --desktop --resume ${copy}`);
    return EXIT.failed;
  }
  log(`Opened in the Claude app: session ${copy}. This copy does not close the task's check card.`);
  return EXIT.ok;
}

export function parseArgs(argv) {
  const f = {}, names = { '--sid': 'sid', '--ref': 'ref', '--project': 'project', '--env': 'env', '--as': 'as' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') f.check = true;
    else if (names[argv[i]]) f[names[argv[i]]] = argv[++i];
    else return null;
  }
  return f;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const f = parseArgs(process.argv.slice(2));
  if (!f) { console.log('Refused: unknown argument.'); process.exit(EXIT.bad); }
  process.exit(await handle(f));
}
