// node --test test/  — multi-user rules of the page's <script id="core"> (HomeOS references/homeos/tasksdb/multi-user-plan.md T8, T9).
// Sign-in with Google (PKCE, the callback, td.accounts), errors in plain words, tags in item_tags, sharing. No network.
const test = require('node:test');
const assert = require('node:assert/strict');

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });
const row = (o = {}) => Object.assign({ id: 'i1', list_id: 'L1', num: 3, quadrant: 'B', title: 'T', body_md: '', tags: ['a'], due_at: null, start_at: null, status: 'open',
  completed_at: null, urgent_pin: null, sort_key: 1024, category: 'task', review_state: 'none', ai_confidence: null, created_by: 'u1', version: 2,
  deleted_at: null, updated_at: '2026-10-27T09:00:00Z' }, o);

test('restError: 22023 tells the sensitive screen from a bad value; 54000 is a limit; sharing texts in plain words', () => {
  assert.equal(C.restError(400, { code: '22023', message: 'sensitive data: looks like an IBAN' }).kind, 'sensitive');
  const owner = C.restError(400, { code: '22023', message: 'owner must be a member of the list' });
  assert.equal(owner.kind, 'invalid'); assert.match(owner.message, /not a member of this list/);
  assert.equal(C.restError(400, { code: '22023', message: 'this list is archived' }).message, 'This list is archived. Restore it first.');
  assert.equal(C.restError(400, { code: '22023', message: 'something new' }).message, 'Something new.');
  const lim = C.restError(400, { code: '54000', message: 'item limit reached' });
  assert.equal(lim.kind, 'limit'); assert.match(lim.message, /list is full/);
  assert.match(C.restError(403, { code: '42501', message: 'no such invitation' }).message, /no longer open/);
  assert.match(C.restError(403, { code: '42501', message: 'owners cannot leave their list' }).message, /can't leave/);
  assert.equal(C.restError(403, { code: '42501', message: 'new row violates row-level security' }).message, 'Not allowed for your role on this list.');
});

test('rowToTask: owner and tags from the item_tags embed; mergePoll keeps tags a row without the embed does not carry', () => {
  const t = C.rowToTask(row({ owner_id: 'u2', item_tags: [{ tag_id: 'g1', removed_at: null }, { tag_id: 'g2', removed_at: '2026-10-27T09:00:00Z' }] }));
  assert.equal(t.ownerId, 'u2'); assert.deepEqual(t.tags, ['g1']);
  assert.deepEqual(C.rowToTask(row()).tags, [], 'the legacy items.tags text is never read as tags');
  const tasks = [Object.assign(C.rowToTask(row({ id: 'a', version: 1 })), { tags: ['g1'] })];
  C.mergePoll(tasks, [row({ id: 'a', version: 2, title: 'new' })], {});
  assert.deepEqual(tasks[0].tags, ['g1']); assert.equal(tasks[0].title, 'new');
  assert.equal(C.pageParams(1000, 'item_id,tag_id'), 'order=item_id,tag_id&limit=1000&offset=1000');
});

test('isHostedOrigin: https and localhost only; never file://', () => {
  assert.equal(C.isHostedOrigin('https://homeos-tasksboard.pages.dev'), true);
  assert.equal(C.isHostedOrigin('http://localhost:8787'), true);
  assert.equal(C.isHostedOrigin('http://127.0.0.1:8787'), true);
  for (const o of ['null', 'file://', '', 'http://example.com', 'https://x.dev/path', undefined]) assert.equal(C.isHostedOrigin(o), false, String(o));
});

test('PKCE: verifier from random bytes, S256 challenge equals sha256 base64url (RFC 7636 appendix B)', async () => {
  const crypto = await import('node:crypto');
  // RFC 7636 appendix B: these 32 octets give this verifier and this challenge
  const octets = [116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121];
  const v = C.pkceVerifier(Uint8Array.from(octets));
  assert.equal(v, 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(await C.pkceChallenge(v, crypto.webcrypto.subtle), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const v2 = C.pkceVerifier(crypto.randomBytes(48));
  assert.match(v2, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(await C.pkceChallenge(v2, crypto.webcrypto.subtle), crypto.createHash('sha256').update(v2).digest('base64url'));
  assert.throws(() => C.pkceVerifier(new Uint8Array(16)), /32 to 96/);
});

test('authorizeUrl: provider google, redirect, s256 challenge, login hint and account picker; refuses file://', () => {
  const ch = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  const u = new URL(C.authorizeUrl('https://ref.supabase.co', { redirectTo: 'https://homeos-tasksboard.pages.dev/', challenge: ch }));
  assert.equal(u.origin + u.pathname, 'https://ref.supabase.co/auth/v1/authorize');
  assert.equal(u.searchParams.get('provider'), 'google');
  assert.equal(u.searchParams.get('redirect_to'), 'https://homeos-tasksboard.pages.dev/');
  assert.equal(u.searchParams.get('code_challenge'), ch);
  assert.equal(u.searchParams.get('code_challenge_method'), 's256');
  assert.equal(u.searchParams.get('login_hint'), null); assert.equal(u.searchParams.get('prompt'), null);
  const h = new URL(C.authorizeUrl('https://ref.supabase.co', { redirectTo: 'http://localhost:8787/TasksDashboard.html', challenge: ch, loginHint: 'a@b.c', selectAccount: true }));
  assert.equal(h.searchParams.get('login_hint'), 'a@b.c'); assert.equal(h.searchParams.get('prompt'), 'select_account');
  assert.throws(() => C.authorizeUrl('https://ref.supabase.co', { redirectTo: 'file:///C:/td/TasksDashboard.html', challenge: ch }), /https or localhost/);
  assert.throws(() => C.authorizeUrl('https://ref.supabase.co', { redirectTo: 'https://x.dev/', challenge: 'short' }), /challenge/);
  assert.deepEqual(C.pkceBody('c1', 'v1'), { auth_code: 'c1', code_verifier: 'v1' });
});

test('readCallback: the code or an error, and an address without either (other parameters kept)', () => {
  assert.equal(C.readCallback('https://x.dev/?profile=maksym'), null);
  assert.equal(C.readCallback('not a url'), null);
  const ok = C.readCallback('https://x.dev/index.html?profile=maksym&code=abc-123');
  assert.deepEqual({ ...ok }, { code: 'abc-123', error: '', errorCode: '', description: '', cleanUrl: '/index.html?profile=maksym' });
  const q = C.readCallback('http://localhost:8787/?error=server_error&error_code=unexpected_failure&error_description=Sign-up+is+by+Google+only.');
  assert.equal(q.code, ''); assert.equal(q.description, 'Sign-up is by Google only.'); assert.equal(q.cleanUrl, '/');
  const h = C.readCallback('https://x.dev/#error=access_denied&error_code=signup_disabled&error_description=Signups%20not%20allowed%20for%20this%20instance');
  assert.equal(h.errorCode, 'signup_disabled'); assert.equal(h.cleanUrl, '/');
  const tok = C.readCallback('https://x.dev/#access_token=secret&refresh_token=r&keep=1');
  assert.equal(tok.code, ''); assert.equal(tok.cleanUrl, '/#keep=1', 'tokens in a hash are dropped from the address');
});

test('oauthMessage: hook refusals, closed sign-ups, cancel and expiry in plain words', () => {
  assert.equal(C.oauthMessage({ error: 'server_error', description: 'TasksDashboard is full right now.' }), 'TasksDashboard is full right now. Try again later.');
  assert.equal(C.oauthMessage({ description: 'Error running hook URI: Sign-up is by Google only.' }), 'Sign-up is by Google only.');
  assert.match(C.oauthMessage({ errorCode: 'signup_disabled', description: 'Signups not allowed for this instance' }), /not open yet/);
  assert.equal(C.oauthMessage({ error: 'access_denied' }), 'Google sign-in was cancelled.');
  assert.match(C.oauthMessage({ error_code: 'flow_state_not_found', msg: 'invalid flow state, no valid flow state found' }), /expired/);
  assert.match(C.oauthMessage({ description: 'agent logins sign in with a password only' }), /password only/);
  assert.equal(C.oauthMessage({ description: 'Something odd' }), 'Google sign-in failed: Something odd.');
  assert.equal(C.oauthMessage(null), 'Google sign-in failed.');
});

test('td.accounts: handle, email, provider only; td.emails migrated; most recent first; at most 8 (round 4: no forget)', () => {
  const a = C.readAccounts(null, { maksym: 'm@x.pt', anastasiia: 'a@x.pt', 'bad handle': 'z@x.pt', nomail: 'nope' });
  assert.deepEqual(a.map(x => ({ ...x })), [{ handle: 'maksym', email: 'm@x.pt', provider: 'email' }, { handle: 'anastasiia', email: 'a@x.pt', provider: 'email' }]);
  const b = C.rememberAccount(a, { handle: 'anastasiia', email: 'a@x.pt', provider: 'google', refresh_token: 'never' });
  assert.deepEqual({ ...b[0] }, { handle: 'anastasiia', email: 'a@x.pt', provider: 'google' }, 'moved first, no token kept');
  assert.equal(b.length, 2);
  assert.equal(C.forgetAccount, undefined, 'round 4: Accounts on this browser (switch, forget) is gone');
  assert.equal(C.accountFor(b, 'maksym').email, 'm@x.pt'); assert.equal(C.accountFor(b, 'x'), null);
  const many = Array.from({ length: 12 }, (_, i) => ({ handle: 'u-' + i, email: i + '@x.pt', provider: 'google' }));
  assert.equal(C.readAccounts(many).length, C.ACCOUNTS_MAX);
  assert.equal(C.readAccounts([{ handle: 'u-1', email: 'x@y.z' }, { handle: 'u-1', email: 'other@y.z' }]).length, 1);
});

test('tagLabels: a name two owners hold is marked with the other owner\'s initial; never my own', () => {
  const lists = { T1: { owner_id: 'me' }, T2: { owner_id: 'b' }, T3: { owner_id: 'c' } };
  const tags = [{ id: 'x1', tag_list_id: 'T1', name: 'urgent' }, { id: 'x2', tag_list_id: 'T2', name: 'Urgent' }, { id: 'x3', tag_list_id: 'T2', name: 'home' },
    { id: 'x4', tag_list_id: 'T3', name: 'car' }];
  assert.deepEqual({ ...C.tagLabels(tags, lists, { me: 'Max', b: 'bella' }, 'me') }, { x1: 'urgent', x2: 'Urgent ·B', x3: 'home', x4: 'car' });
  const two = C.tagLabels([{ id: 'y1', tag_list_id: 'T2', name: 'a' }, { id: 'y2', tag_list_id: 'T3', name: 'a' }], lists, {}, 'me');
  assert.deepEqual({ ...two }, { y1: 'a ·?', y2: 'a ·?' });
});

// round 3 (db/012): by tag id (mine_tag_ids), no longer by name (mine_tags)
test('isMine: owner_id is me, or a visible tag whose id is in my mine_tag_ids', () => {
  const me = { id: 'me', mine_tags: ['maksym'], mine_tag_ids: ['g1', 'g2'] };
  assert.equal(C.isMine({ ownerId: 'me', tags: [] }, me, {}), true);
  assert.equal(C.isMine({ ownerId: 'b', tags: ['g1'] }, me, { g1: 'maksym' }), true);
  assert.equal(C.isMine({ ownerId: null, tags: ['g2'] }, me, { g1: 'maksym' }), false, 'a tag I cannot see does not count');
  assert.equal(C.isMine({ ownerId: null, tags: ['g3'] }, me, { g3: 'maksym' }), false, 'a name in mine_tags no longer counts');
  assert.equal(C.isMine({ ownerId: 'me', tags: [] }, null, {}), false);
});

test('mergeTagRows and tagDiff: adds, soft removals, pending items skipped, unknown tags reported', () => {
  const tasks = [{ id: 'a', tags: ['g1'] }, { id: 'b', tags: [] }, { id: 'p', tags: [] }];
  const m = C.mergeTagRows(tasks, [{ item_id: 'a', tag_id: 'g1', removed_at: '2026-10-27T09:00:00Z' }, { item_id: 'a', tag_id: 'g2', removed_at: null },
    { item_id: 'b', tag_id: 'g9', removed_at: null }, { item_id: 'p', tag_id: 'g1', removed_at: null }, { item_id: 'zz', tag_id: 'g1', removed_at: null }],
  { pending: new Set(['p']), knownTags: ['g1', 'g2'] });
  assert.deepEqual(tasks.map(t => t.tags), [['g2'], ['g9'], []]);
  assert.equal(m.changed, 3); assert.deepEqual(m.unknownTags, ['g9']);
  assert.deepEqual({ ...C.tagDiff(['a', 'b'], ['b', 'c']) }, { add: ['c'], remove: ['a'] });
  assert.match(C.tagPollFilter(Date.parse('2026-10-27T10:02:00Z')), /^changed_at=gte\.2026-10-27T10%3A00%3A00\.000Z$/);
});

test('membershipActions, canEditTags, defaultAddList (A6)', () => {
  assert.deepEqual(C.membershipActions('owner', 'list'), ['share', 'archive'], 'round 4: no People beside Share');
  assert.deepEqual(C.membershipActions('owner', 'tag_list'), ['share', 'rename']);
  assert.deepEqual(C.membershipActions('viewer', 'list'), ['people', 'hide', 'leave']);
  // round 3: an editor of a tag list shares it; a contributor adds and renames tags
  assert.deepEqual(C.membershipActions('editor', 'tag_list'), ['share', 'hide', 'leave']);
  assert.deepEqual(C.membershipActions('viewer', 'tag_list'), ['hide', 'leave']);
  assert.deepEqual(C.membershipActions(undefined, 'list'), []);
  assert.equal(C.canEditTags('editor'), true); assert.equal(C.canEditTags('contributor'), true); assert.equal(C.canEditTags('viewer'), false);
  const byId = { H: { owner_id: 'max' }, G: { owner_id: 'guest' }, S: { owner_id: 'max' } };
  const cats = { task: { default_list_id: 'H' } };
  assert.equal(C.defaultAddList({ lists: ['H', 'G'], roles: { H: 'editor', G: 'owner' }, byId, meId: 'guest', cats }), 'H');
  assert.equal(C.defaultAddList({ lists: ['S', 'G'], roles: { S: 'viewer', G: 'owner' }, byId, meId: 'guest', cats }), 'G', 'a guest falls back to their own list');
  assert.equal(C.defaultAddList({ lists: ['S'], roles: { S: 'viewer' }, byId, meId: 'guest', cats }), '');
  assert.equal(C.defaultAddList({ lists: ['S', 'X'], roles: { S: 'contributor', X: 'editor' }, byId: { S: { owner_id: 'max' }, X: { owner_id: 'max' } }, meId: 'guest' }), 'S');
});
