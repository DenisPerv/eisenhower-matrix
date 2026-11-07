// the task window's text and the check-card rules of the core block: renderMd, the blocks, the answer section, the badge, the Continue link
// (HomeOS-TasksBoardHarness/docs/card-contract.md). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from '../cli/lib.mjs';

const C = loadCore();
const PROMPT = C.ANSWER_PROMPT;
const NOW = '2026-11-05T10:00:00.000Z';

test('renderMd: tables, headings, rules, links, inline code', () => {
  const h = C.renderMd('# One\n## Two\n\ntext `a*b*c` and **bold** *it*\n\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- x\n  - y\n1. z\n\n[site](https://example.com/?a=1&b=2)');
  assert.match(h, /<h3>One<\/h3><h4>Two<\/h4>/);
  assert.match(h, /<code>a\*b\*c<\/code>/, 'markers stay inside code');
  assert.match(h, /<strong>bold<\/strong> <em>it<\/em>/);
  assert.match(h, /<hr>/);
  assert.match(h, /<div class="md-tbl" tabindex="0"><table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table><\/div>/);
  assert.match(h, /<ul><li>x<\/li><li class="md-sub">y<\/li><\/ul><ol><li>z<\/li><\/ol>/);
  assert.match(h, /<a href="https:\/\/example\.com\/\?a=1&amp;b=2" target="_blank" rel="noopener">site<\/a>/);
});

test('renderMd: no HTML from the database, only http(s) links', () => {
  const bad = ['<img src=x onerror=alert(1)>', '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](data:text/html,<script>1</script>)', '[x](vbscript:x)', '[x](//evil.example)', '[x](https://a"onclick="b)', '| <b>a</b> | c |\n|---|---|\n| <script>x</script> | d |', '`<script>`', '```\n<script>\n```', '# <i>h</i>', '> <i>q</i>'];
  bad.forEach(s => {
    const h = C.renderMd(s);
    assert.ok(!/<(img|script|b>|i>)/.test(h), s + ' -> ' + h);
    assert.ok(!/href="(?!https?:)/i.test(h), s + ' -> ' + h);
    assert.ok(!/<a [^>]*onclick/.test(h), s + ' -> ' + h);
  });
  assert.ok(!/<a /.test(C.renderMd('[x](javascript:alert(1))')), 'stays plain text');
  assert.equal(C.renderMd('a\u00000\u0000b'), '<p>a0b</p>', 'a held-text mark in the data is dropped');
});

test('renderMd: a numbered list split by text shows the written numbers', () => {
  assert.equal(C.renderMd('1. a\n\nx\n\n2. b'), '<ol><li>a</li></ol><p>x</p><ol start="2"><li>b</li></ol>');
  assert.equal(C.renderMd('For later:\n3. c\n4. d'), '<p>For later:</p><ol start="3"><li>c</li><li>d</li></ol>');
  assert.equal(C.renderMd('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>', 'a list from 1 carries no attribute');
});

const LINK = u => '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>';
test('renderMd: a bare http(s) address is a link; the punctuation after it is not part of it', () => {
  assert.equal(C.renderMd('see https://a.example/p?x=1&y=2 now'), '<p>see ' + LINK('https://a.example/p?x=1&amp;y=2') + ' now</p>');
  assert.equal(C.renderMd('https://a.example/c, saved'), '<p>' + LINK('https://a.example/c') + ', saved</p>');
  assert.equal(C.renderMd('End https://a.example/c.'), '<p>End ' + LINK('https://a.example/c') + '.</p>');
  assert.equal(C.renderMd('(https://a.example/c)'), '<p>(' + LINK('https://a.example/c') + ')</p>');
  assert.equal(C.renderMd('https://a.example/w_(x) y'), '<p>' + LINK('https://a.example/w_(x)') + ' y</p>', 'a closing bracket with its opening one stays');
  assert.equal(C.renderMd('**https://a.example**'), '<p><strong>' + LINK('https://a.example') + '</strong></p>');
  assert.equal(C.renderMd('- Source: https://a.example/*x*'), '<ul><li>Source: ' + LINK('https://a.example/*x') + '*</li></ul>', 'a star inside an address is no italic');
});

test('renderMd: no link where there is already one, in code, or without an address', () => {
  const count = s => (C.renderMd(s).match(/<a /g) || []).length;
  assert.equal(count('[t](https://a.example)'), 1);
  assert.equal(count('[https://a.example](https://b.example)'), 1, 'an address as link text');
  assert.equal(count('[see https://a.example here](https://b.example)'), 1, 'an address inside link text');
  assert.equal(C.renderMd('[https://a.example](https://b.example)'), '<p><a href="https://b.example" target="_blank" rel="noopener">https://a.example</a></p>');
  [ '`https://a.example`', '```\nhttps://a.example\n```', 'xhttps://a.example', 'ftp://a.example', 'https://', 'https://.', '[x](https://a b)' ].forEach(s => assert.equal(count(s), 0, s));
});

test('renderMd: a bare address never carries markup out of the href', () => {
  ['https://a.example/"onclick="x', "https://a.example/'onclick='x", 'https://a.example/<script>x</script>', 'https://a.example/>y'].forEach(s => {
    const h = C.renderMd(s);
    assert.ok(!/<a [^>]*onclick/.test(h), s + ' -> ' + h);
    assert.ok(!/<script/.test(h), s + ' -> ' + h);
    assert.ok((h.match(/<a /g) || []).length === 1 && /href="https:\/\/a\.example\/"/.test(h), s + ' -> ' + h);
  });
});

test('mdBlocks: split at the fixed headings only, text before the first stays first, a fence hides a heading', () => {
  const b = C.mdBlocks('Task\n\n## Plan\nsteps\n## Context\nstays inside\n\n```\n## Result\n```\n\n## Result of s#1\nr\n\n---\n\n## Delegate · 2026-11-05\nq\n## Answer (read 2026-11-05)\na\n## Planet\nstays');
  assert.deepEqual(b.map(x => x.split('\n')[0]), ['Task', '## Plan', '## Result of s#1', '## Delegate · 2026-11-05', '## Answer (read 2026-11-05)']);
  assert.ok(b[1].includes('## Context') && b[1].includes('## Result\n'));
  assert.ok(!/---\s*$/.test(b[2]), 'a closing rule is not repeated');
  assert.ok(b[4].includes('## Planet'));
});

test('answerSection and setAnswer: last heading, stops at ## Links, the prompt is not the answer, other bytes stay', () => {
  const body = `Task\r\n\r\n## Your answer\nold\n\n## Plan\n| a |\n\n## Your answer\n${PROMPT}\n\n## Links\n- [p](https://github.com/x)\n`;
  assert.equal(C.answerSection(body).text, '');
  const w = C.setAnswer(body, 'Yes\n## Not a block\ndo it');
  assert.equal(C.answerSection(w).text, 'Yes\n## Not a block\ndo it');
  assert.ok(w.startsWith(`Task\r\n\r\n## Your answer\nold\n\n## Plan\n| a |\n\n## Your answer\n${PROMPT}\nYes\n`));
  assert.ok(w.endsWith('\n\n## Links\n- [p](https://github.com/x)\n'));
  assert.equal(C.answerSection('no section'), null);
  assert.equal(C.setAnswer('no section', 'x'), 'no section');
  assert.equal(C.answerSection(`a\n## Your answer\n${PROMPT}\nmine`).text, 'mine');
});

test('cardView: newest first, open answer on top, links last; a check card keeps stored order', () => {
  const d = `Task\n\n## Plan\np\n\n## Result\nr\n\n---\n\n## Delegate · d\nq\n\n## Your answer\n${PROMPT}\n`;
  const v = C.cardView(d, { answerable: true });
  assert.equal(v.answer, true);
  assert.deepEqual(v.blocks.map(x => x.split('\n')[0]), ['## Delegate · d', '## Result', '## Plan', 'Task']);
  assert.ok(!v.blocks.join().includes('## Your answer'));
  const v2 = C.cardView(d, { answerable: false });
  assert.equal(v2.answer, false);
  assert.equal(v2.blocks[0].split('\n')[0], '## Your answer');
  const answered = C.cardView(C.setAnswer(d, 'done'), { answerable: true });
  assert.equal(answered.answer, false, 'an answered section is an ordinary block');
  const card = `## What was done\nw\n\n## Deviations\nv\n\n## How to answer\nh\n\n## Your answer\n${PROMPT}\n\n## Links\n- [p](https://github.com/x)`;
  const c = C.cardView(card, { check: true, answerable: true });
  assert.equal(c.answer, true);
  assert.equal(c.blocks.length, 1);
  assert.ok(c.blocks[0].indexOf('## What was done') < c.blocks[0].indexOf('## Deviations') && c.blocks[0].indexOf('## Deviations') < c.blocks[0].indexOf('## How to answer'));
  assert.equal(c.links, '## Links\n- [p](https://github.com/x)');
  const html = C.cardViewHtml(c);
  assert.ok(html.indexOf('What was done') < html.indexOf('rel="noopener"'), 'links last');
  assert.equal(C.cardViewHtml(v).split('md-blockrule').length - 1, 3, 'a rule between the blocks');
});

test('cardDesc: the first paragraph only, no table on a small card; Show more shows the whole text', () => {
  const md = '## Plan\n\nFirst line\nsecond line\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  assert.equal(C.firstParagraph(md), 'First line\nsecond line');
  const s = C.cardDesc(md, 100, false);
  assert.deepEqual({ ...s }, { md: 'First line\nsecond line', hasMore: true });
  assert.ok(!C.renderMd(s.md).includes('<table'));
  assert.equal(C.cardDesc(md, 100, true).md, md);
  assert.deepEqual({ ...C.cardDesc('short', 100, false) }, { md: 'short', hasMore: false });
  assert.deepEqual({ ...C.cardDesc('hello world this is long', 8, false) }, { md: 'hello …', hasMore: true });
  assert.equal(C.firstParagraph('| a |\n|---|\n| 1 |'), '| a |');
});

test('answerDecision: status done for every decision card, with no kind and with a kind (check, delegate close at once)', () => {
  const card = kind => ({ status: 'open', details: { other: 1, decision: Object.assign({ v: 1, label_1: 'Accept', label_0: 'Needs changes', answer: null }, kind ? { kind } : {}) } });
  assert.equal(C.answerDecision(card(null), 1, 'm', NOW).status, 'done');
  ['check', 'delegate'].forEach(k => {
    const ch = C.answerDecision(card(k), 0, 'm', NOW);
    assert.equal(ch.status, 'done', k);
    assert.equal(ch.details.decision.answer, 0);
    assert.equal(ch.details.decision.kind, k);
    assert.equal(ch.details.other, 1);
  });
  const applied = card('check'); applied.details.decision.applied_at = NOW;
  assert.equal(C.answerDecision(applied, 1, 'm', NOW), null);
  assert.equal(C.decisionKind(card('check')), 'check');
  assert.equal(C.decisionKind(card(null)), null);
});

test('rowToTask keeps ai as data; taskToPatch never writes it', () => {
  const ai = { check: { n: 1 } };
  const t = C.rowToTask({ id: 'i', list_id: 'L', num: 1, title: 'x', status: 'waiting', ai });
  assert.deepEqual({ ...t.ai }, ai);
  assert.notEqual(t.ai, ai);
  assert.equal(C.rowToTask({ id: 'i', list_id: 'L', num: 1, title: 'x' }).ai, null);
  assert.ok(!('ai' in C.taskToPatch(t)));
});

test('awaitingCheck reads the data, not the tag; readOnlyTask', () => {
  const w = check => ({ status: 'waiting', ai: { check } });
  assert.equal(C.awaitingCheck(w({ n: 1 })), true);
  assert.equal(C.awaitingCheck(w({ n: 2, settled_n: 1 })), true);
  assert.equal(C.awaitingCheck(w({ n: 2, settled_n: 2 })), false);
  assert.equal(C.awaitingCheck({ status: 'open', ai: { check: { n: 1 } } }), false);
  assert.equal(C.awaitingCheck({ status: 'waiting', ai: null }), false);
  assert.equal(C.awaitingCheck({ status: 'waiting' }), false);
  assert.equal(C.readOnlyTask({ status: 'done' }, false), true);
  assert.equal(C.readOnlyTask({ status: 'cancelled' }, false), true);
  assert.equal(C.readOnlyTask({ status: 'open' }, true), true);
  assert.equal(C.readOnlyTask({ status: 'waiting' }, false), false);
  assert.equal(C.readOnlyTask(null, false), false);
});

test('continueLink: the latest do, else the latest plan; a bad id or ref gives none', () => {
  const A = '11111111-2222-3333-4444-555555555555', B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', Z = '99999999-2222-3333-4444-555555555555';
  const t = sessions => ({ num: 15, ai: { sessions } });
  const c = C.continueLink(t([{ session_id: Z, role: 'do' }, { session_id: A, role: 'do' }, { session_id: B, role: 'plan' }, { session_id: Z, role: 'mother' }]), 'homeos-game_1');
  assert.equal(c.sid, A);
  assert.equal(c.href, `homeos-claude://continue?sid=${A}&ref=homeos-game_1%2315`);
  assert.equal(c.command, `claude --resume ${A} --fork-session`);
  assert.equal(C.continueLink(t([{ session_id: B, role: 'plan' }, { session_id: Z, role: 'mother' }]), 's').sid, B);
  assert.equal(C.continueLink(t([{ session_id: Z, role: 'mother' }]), 's'), null);
  assert.equal(C.continueLink(t([]), 's'), null);
  assert.equal(C.continueLink({ num: 1, ai: null }, 's'), null);
  assert.equal(C.continueLink({ num: 1 }, 's'), null);
  ['x', A + '&x=1', A + ' ', 'rm -rf; ' + A].forEach(id => assert.equal(C.continueLink(t([{ session_id: id, role: 'do' }]), 's'), null, id));
  ['Bad Slug', 'a&b', 'a#b', '', undefined].forEach(sl => assert.equal(C.continueLink(t([{ session_id: A, role: 'do' }]), sl), null, String(sl)));
});

test('click to edit (2026-11-07): an edited description and a typed answer are both kept (notesNow = setAnswer(raw, answer))', () => {
  const md = '## What was done\nA thing.\n\n## Your answer\n' + C.ANSWER_PROMPT + '\n\n## Links\n- [a](https://x.y/a)\n';
  const raw = md.replace('A thing.', 'A thing, edited.').replace(/\s+$/, '');
  const out = C.setAnswer(raw, 'Please redo it');
  assert.ok(out.includes('A thing, edited.'), 'the description edit');
  assert.equal(C.answerSection(out).text, 'Please redo it', 'the answer in its place');
  assert.ok(out.endsWith('## Links\n- [a](https://x.y/a)'), 'the links stay last');
  // the rendered description of the edited raw text still keeps the answer box apart (answer section empty there)
  assert.equal(C.cardView(raw, { check: true, answerable: true }).answer, true);
});
