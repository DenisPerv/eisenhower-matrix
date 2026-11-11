// node --test test/  — the Telegram link (db/032): the core's telegramClaim and telegramDeepLink against the rules of
// set_telegram_claim, the same cases through signin.html's copy, telegramBot in readAppConfig, the board's account-menu
// entry and dialog, and the migration's names that the bot uses. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'TasksDashboard.html'), 'utf8');
const SQL = fs.readFileSync(path.join(ROOT, 'db', '032_telegram_link.sql'), 'utf8');
const SELFTEST = fs.readFileSync(path.join(ROOT, 'db', '915_selftest_telegram_link.sql'), 'utf8');
const TOKEN = '0123456789abcdef0123456789abcdef01234567';

// [input, ok, stored value] - the same rows as set_telegram_claim's regexes in db/032 and 915 L11
const CLAIMS = [
  ['', true, null], ['   ', true, null], [null, true, null],
  ['@ada_lovelace', true, '@ada_lovelace'], ['ada_lovelace', true, '@ada_lovelace'], [' Ada_L ', true, '@Ada_L'],
  ['https://t.me/ada_lovelace', true, '@ada_lovelace'], ['telegram.me/ada_lovelace', true, '@ada_lovelace'],
  ['123456789', true, '123456789'], ['12345', true, '12345'],
  ['@abc', false, null], ['abcd', false, null], ['_ada', false, null], ['1ada_l', true, '1ada_l'], ['ada lovelace', false, null],
  ['ada-l', false, null], ['1234', false, null], ['1234567890123456', false, null], ['+351912345678', false, null], ['@' + 'a'.repeat(33), false, null],
];

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });

test('telegramClaim: the rules of set_telegram_claim', () => {
  for (const [v, ok, value] of CLAIMS) {
    if (v === '1ada_l') { assert.equal(C.telegramClaim(v).ok, false, 'a username starts with a letter'); continue; }
    const r = C.telegramClaim(v);
    assert.equal(r.ok, ok, String(v));
    assert.equal(r.value, value, String(v));
    if (!ok) assert.match(r.message, /^Telegram: /);
  }
});

test('telegramDeepLink: a valid bot and a 40-hex token, else empty', () => {
  assert.equal(C.telegramDeepLink('MD_support_line_bot', TOKEN), 'https://t.me/MD_support_line_bot?start=' + TOKEN);
  for (const [bot, tok] of [['', TOKEN], ['bad bot', TOKEN], ['abc', TOKEN], ['MD_support_line_bot', ''], ['MD_support_line_bot', TOKEN.toUpperCase()],
    ['MD_support_line_bot', TOKEN + '0'], ['MD_support_line_bot', TOKEN.slice(1)], ['MD_support_line_bot', '<script>' + TOKEN.slice(8)]])
    assert.equal(C.telegramDeepLink(bot, tok), '', bot + ' ' + tok);
});

test('readAppConfig: telegramBot is kept when valid, without @; left out when missing or bad; never an error', () => {
  const base = { supabaseUrl: 'https://abc.supabase.co', publishableKey: 'sb_publishable_x' };
  assert.equal(C.readAppConfig(Object.assign({ telegramBot: '@MD_support_line_bot' }, base)).config.telegramBot, 'MD_support_line_bot');
  for (const bad of [undefined, '', 'a b', 'abc', 42, 'https://t.me/x_bot']) {
    const r = C.readAppConfig(Object.assign({ telegramBot: bad }, base));
    assert.deepEqual(r.errors, []);
    assert.equal('telegramBot' in r.config, false, String(bad));
  }
  const cfg = fs.readFileSync(path.join(ROOT, 'config', 'tasksdashboard.config.js'), 'utf8');
  const m = cfg.match(/telegramBot:\s*"([^"]*)"/);
  assert.ok(m && C.readAppConfig(Object.assign({ telegramBot: m[1] }, base)).config.telegramBot === m[1], 'the committed config names a valid bot');
});

test('signin.html: its copy of telegramClaim gives the same answers as the core', () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(ROOT, 'signin.html'), 'utf8');
  const src = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi)].filter(m => !/\ssrc\s*=/i.test(m[1] || ''))[0][2];
  const ctx = { TD_CONFIG: null, location: { href: 'https://x.example/signin', origin: 'https://x.example' }, history: { replaceState() {} }, URL, URLSearchParams, console,
    document: { readyState: 'loading', addEventListener() {}, documentElement: { dataset: {} } }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, localStorage: { getItem: () => null } };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(src, ctx);
  const S = ctx.TDSignin;
  for (const [v] of CLAIMS) assert.deepEqual({ ...S.telegramClaim(v) }, { ...C.telegramClaim(v) }, String(v));
  assert.equal(S.telegramDeepLink('MD_support_line_bot', TOKEN), C.telegramDeepLink('MD_support_line_bot', TOKEN));
});

test('board: Link Telegram in the account menu for people, wired to openTelegram, using the db/032 RPCs', () => {
  assert.match(HTML, /\(human \? '<button data-menu="telegram">Link Telegram<\/button>' : ''\)/);
  assert.match(HTML, /telegram: openTelegram \}\)\[b\.dataset\.menu\]\(\)/);
  const fn = HTML.slice(HTML.indexOf('async function openTelegram()'), HTML.indexOf('// Account menu, Sharing:'));
  for (const name of ['my_telegram_link', 'telegram_link_token', 'telegram_unlink']) assert.match(fn, new RegExp("rpc\\('" + name + "'"));
  assert.match(fn, /C\.telegramDeepLink\(bot, td\.token\)/);
  assert.match(fn, /rel="noopener noreferrer"/);
});

test('db/032: the RPCs the app and the bot call exist, are granted to authenticated and not to anon; the bucket and the list', () => {
  const people = ['telegram_link_token()', 'my_telegram_link()', 'set_telegram_claim(text)', 'telegram_unlink()'];
  const bot = ['telegram_redeem_link(text, bigint, text)', 'telegram_member(bigint)'];
  const grant = SQL.slice(SQL.lastIndexOf('grant execute on function'));
  for (const f of people.concat(bot)) {
    assert.match(SQL, new RegExp('create or replace function public\\.' + f.split('(')[0] + '\\('), f);
    assert.ok(grant.includes('public.' + f), 'granted: ' + f);
  }
  assert.doesNotMatch(SQL, /to anon/);
  for (const f of bot) assert.match(SQL.slice(SQL.indexOf('function public.' + f.split('(')[0])), /if not public\.is_telegram_login\(\) then raise exception/);
  assert.match(SQL, /'workorder-material', 'workorder-material', false/);
  assert.match(SQL, /create policy workorder_material_insert on storage\.objects for insert to authenticated\s+with check \(bucket_id = 'workorder-material' and public\.is_telegram_login\(\)/);
  assert.match(SQL, /create policy workorder_material_select on storage\.objects for select to authenticated\s+using \(bucket_id = 'workorder-material' and public\.is_homeos_agent\(\)\)/);
  assert.match(SQL, /'homeos-global', 'HomeOS - Global'/);
  assert.match(SQL, /where p\.handle in \('anastasiia', 'homeos-agent', 'telegram-bot'\)/);
  // every function of 032 is security definer with an empty search_path
  const defs = [...SQL.matchAll(/create or replace function (public\.\w+)\([^)]*\)[\s\S]*?(?:as \$\$)/g)];
  assert.equal(defs.length, 16);
  for (const d of defs) assert.match(d[0], /security definer set search_path = ''/, d[1]);
  // the selftest reports in the shared format and covers L1-L16
  assert.match(SELFTEST, /raise exception 'SELFTEST % of % passed \(rolled back\)\. Failures: %'/);
  for (let i = 1; i <= 16; i++) assert.match(SELFTEST, new RegExp("_tl_chk\\('L" + i + '[a-z ]'), 'L' + i);
});
