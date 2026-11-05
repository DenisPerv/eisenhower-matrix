// The landing page's plan buttons (db/026, db/030): the three buttons are wired, the page repeats the public config exactly, it
// sends only what the RPC takes, and it holds nothing that must not be public. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const site = read('site/index.html');
const box = { window: {} };
vm.runInNewContext(read('config/tasksdashboard.config.js'), box);
const cfg = box.window.TD_CONFIG;

test('plan buttons: Try the demo, Subscribe to Personal and Subscribe to Team carry data-plan', () => {
  assert.match(site, /<a class="btn" href="#app" data-plan="Demo" data-price="Free">Try the demo<\/a>/);
  assert.match(site, /data-plan="Personal" data-price="Pricing soon">Subscribe to Personal</);
  assert.match(site, /data-plan="Team" data-price="Pricing soon">Subscribe to Team</);
});

test('plan buttons: the page repeats the public config exactly and holds no secret', () => {
  const m = site.match(/const API = \{ url: '([^']+)', key: '([^']+)' \}/);
  assert.ok(m, 'the API constant');
  assert.equal(m[1], cfg.supabaseUrl);
  assert.equal(m[2], cfg.publishableKey);
  assert.match(m[2], /^sb_publishable_/);
  assert.doesNotMatch(site, /sb_secret_|service_role/);
});

test('plan buttons: the only database call is rpc/request_plan_interest, with no login', () => {
  assert.deepEqual([...site.matchAll(/\/rest\/v1\/[\w/]*/g)].map((x) => x[0]), ['/rest/v1/rpc/request_plan_interest']);
  assert.doesNotMatch(site, /\/auth\/v1\//);
  assert.match(site, /body: JSON\.stringify\(\{ p_plan: plan, p_email: email \|\| null, p_telegram: telegram \|\| null \}\)/);
  assert.doesNotMatch(site.slice(site.indexOf('const API ='), site.indexOf('const sub = ')), /Authorization/);
});

test('plan buttons: the email is required, Telegram optional, and the privacy page says what is kept', () => {
  const dlg = site.slice(site.indexOf('<dialog id="sub"'), site.indexOf('</dialog>', site.indexOf('<dialog id="sub"')));
  assert.match(dlg, /Leave your email so we can write when the full tool opens\. Telegram is optional\./);
  assert.match(dlg, /Telegram username \(optional\)/);
  assert.doesNotMatch(dlg, /Both are optional/);
  assert.match(dlg, /href="\/privacy"/);
  assert.match(site, /subForm\.elements\.email\.required = !demo;/);
  const privacy = read('privacy.html');
  assert.match(privacy, /Try the demo/);
  assert.match(privacy, /keep nothing/);
});

test('plan buttons: no email, no call; closing the dialog files nothing', () => {
  const code = site.slice(site.indexOf('const sub = '), site.indexOf('/* ---------- consulting call'));
  assert.equal([...code.matchAll(/fileInterest\(/g)].length, 1, 'one call site, in Send');
  const close = code.slice(code.indexOf("sub.addEventListener('close'"));
  assert.doesNotMatch(close, /fileInterest/);
  assert.match(close, /markFiled\(round\.plan\); round\.after\(\)/);
  const send = code.slice(code.indexOf("subForm.addEventListener('submit'"), code.indexOf("sub.addEventListener('close'"));
  assert.ok(send.indexOf('if (!email)') > -1 && send.indexOf('if (!email)') < send.indexOf('fileInterest('), 'the email check comes before the call');
  assert.match(send, /if \(!email && !telegram && round\.after\) return sub\.close\(\);/);
  assert.doesNotMatch(site, /no contact|noContact|We noted your interest/i);
});

test('plan buttons: after Send a paid plan says what happens next and offers the consulting call', () => {
  assert.match(site, /We will let you know as soon as prices are set\./);
  assert.match(site, /<button class="btn btn-primary" type="button" id="subConsult" data-consult hidden>Schedule a consulting call<\/button>/);
});

test('db/026: its one anon grant is the new function', () => {
  const sql = read('db/026_plan_interest.sql');
  assert.deepEqual([...sql.matchAll(/grant [^;]*\banon\b[^;]*;/g)].map((x) => x[0]),
    ['grant execute on function public.request_plan_interest(text, text, text) to anon, authenticated;']);
});

test('db/030: no email is refused before anything is written, and the grant stays the same', () => {
  const sql = read('db/030_plan_interest_email.sql');
  const refuse = sql.indexOf("if v_email is null then raise exception 'Email: please enter your email address' using errcode = '22023'");
  assert.ok(refuse > -1, 'the refusal');
  assert.ok(refuse < sql.indexOf('insert into public.items'));
  assert.doesNotMatch(sql, /no contact'/);
  assert.deepEqual([...sql.matchAll(/grant [^;]*\banon\b[^;]*;/g)].map((x) => x[0]),
    ['grant execute on function public.request_plan_interest(text, text, text) to anon, authenticated;']);
});
