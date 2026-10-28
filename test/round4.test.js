// node --test test/  — round 4 of the page's <script id="core">: the Source switch (item 3), descriptions cut at N characters
// (item 4), the facts Card layout switches on (item 5), owners without People (item 2), no forgetAccount (item 1). No network.
const test = require('node:test');
const assert = require('node:assert/strict');

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });

test('Source: off by default, a boolean in Card layout, never with one list selected', () => {
  assert.equal(C.CARD_LAYOUT_DEFAULTS.source, false);
  assert.ok(C.CARD_FIELDS.includes('source'));
  assert.equal(C.readCardLayout({ source: true }).source, true);
  assert.equal(C.readCardLayout({ source: 'yes' }).source, false, 'a non-boolean falls back to the default');
  assert.equal(C.showSource(C.readCardLayout(null), false), false, 'off by default');
  assert.equal(C.showSource(C.readCardLayout({ source: true }), false), true, 'on, All lists');
  assert.equal(C.showSource(C.readCardLayout({ source: true }), true), false, 'on, one list selected');
  assert.equal(C.showSource(null, false), false);
});

test('descClip: word boundary, unclosed markers dropped, lone bullet dropped, 0 and short texts whole', () => {
  assert.deepEqual({ ...C.descClip('hello world this is long', 8) }, { text: 'hello', clipped: true });
  assert.deepEqual({ ...C.descClip('**bold text here** more', 10) }, { text: 'bold', clipped: true }, 'an unclosed ** is dropped');
  assert.deepEqual({ ...C.descClip('a *it* and *open italic here', 20) }, { text: 'a *it* and open', clipped: true }, 'an unclosed * is dropped, a closed pair kept');
  assert.deepEqual({ ...C.descClip('- item one\n- **bo', 15) }, { text: '- item one', clipped: true }, 'a bullet left alone goes');
  assert.deepEqual({ ...C.descClip('- one\n2. two three', 12) }, { text: '- one\n2. two', clipped: true });
  assert.deepEqual({ ...C.descClip('x'.repeat(30), 10) }, { text: 'x'.repeat(10), clipped: true }, 'one long word is cut hard');
  assert.deepEqual({ ...C.descClip('word next', 4) }, { text: 'word', clipped: true }, 'a cut on a word end keeps the word');
  assert.deepEqual({ ...C.descClip('x'.repeat(300), 0) }, { text: 'x'.repeat(300), clipped: false }, '0 shows the whole description');
  assert.deepEqual({ ...C.descClip('short', 100) }, { text: 'short', clipped: false });
  assert.deepEqual({ ...C.descClip('x'.repeat(100), 100) }, { text: 'x'.repeat(100), clipped: false }, 'exactly N is not cut');
  assert.deepEqual({ ...C.descClip(null, 100) }, { text: '', clipped: false });
});

test('cardFacts: only what Card layout switches on and the item has, in card order', () => {
  const t = { deadline: new Date(2), createdAt: new Date(1), createdBy: 'u1', ownerId: 'u2' };
  assert.deepEqual(C.cardFacts(t, C.readCardLayout(null)).map(f => f.k), ['end'], 'defaults: End only');
  assert.deepEqual(C.cardFacts(t, C.readCardLayout({ end: false, created: true, creator: true, owner: true })).map(f => f.k), ['created', 'creator', 'owner']);
  assert.deepEqual(C.cardFacts({ createdBy: 'u1' }, C.readCardLayout({ created: true, creator: true, owner: true })), [{ k: 'creator', id: 'u1' }], 'missing facts left out');
  assert.equal(C.cardFacts(t, C.readCardLayout({ created: true })).find(f => f.k === 'created').at, t.createdAt);
});

test('round 4 items 1 and 2: no forgetAccount; owners share, members see the people', () => {
  assert.equal(C.forgetAccount, undefined);
  assert.equal(typeof C.rememberAccount, 'function', 'the last account still prefills the sign-in form');
  assert.ok(!C.membershipActions('owner', 'list').includes('people'));
  assert.ok(C.membershipActions('contributor', 'list').includes('people'));
});
