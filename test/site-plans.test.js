// The landing page's plan buttons (db/026): the three buttons are wired, the page repeats the public config exactly, it
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

test('plan buttons: the fields are optional and the privacy page says what is kept', () => {
  const dlg = site.slice(site.indexOf('<dialog id="sub"'), site.indexOf('</dialog>', site.indexOf('<dialog id="sub"')));
  assert.doesNotMatch(dlg, /\brequired\b/);
  assert.match(dlg, /Both are optional/);
  assert.match(dlg, /href="\/privacy"/);
  assert.match(read('privacy.html'), /Try the demo/);
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
