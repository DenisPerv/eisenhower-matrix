// node --test test/  — HomeOS self-improvements #39: a new task in a HomeOS list starts with Assignee HomeOS picked
// (core homeosAssigneeTag, assigneeOnListChange; web openTask, phone openAdd). No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let C;
test.before(async () => { C = (await import('../cli/lib.mjs')).loadCore(); });

const MK = 'p-mk', AN = 'p-an';
const LISTS = {
  hos: { id: 'L-hs', slug: 'homeos-selfimprovements', name: 'HomeOS - SelfImprovements', owner_id: MK },
  bySlug: { id: 'L-ht', slug: 'homeos-tasks', name: 'Agent tasks', owner_id: MK },
  byName: { id: 'L-hn', slug: 'renamed-list', name: 'HomeOS - Renamed', owner_id: MK },
  other: { id: 'L-ot', slug: 'othertasks', name: 'OtherTasks', owner_id: MK },
};
const tagLists = (o = {}) => Object.assign({
  TL1: { id: 'TL1', owner_id: MK, name: 'My tags', role: 'owner', hidden: false, archived_at: null },
  TL2: { id: 'TL2', owner_id: MK, name: 'Assignee', role: 'viewer', hidden: false, archived_at: null },
}, o);
const TAGS = {
  g1: { id: 'g1', tag_list_id: 'TL1', name: 'HomeOS' }, // same name in another tag list: not it
  g2: { id: 'g2', tag_list_id: 'TL2', name: 'Maksym' },
  g3: { id: 'g3', tag_list_id: 'TL2', name: 'HomeOS' },
};
const pick = (list, o = {}) => C.homeosAssigneeTag(Object.assign({ list, tagLists: tagLists(), tags: TAGS, meId: AN }, o));

test('isHomeosList: by name prefix or slug prefix', () => {
  assert.equal(C.isHomeosList(LISTS.hos), true);
  assert.equal(C.isHomeosList(LISTS.bySlug), true);
  assert.equal(C.isHomeosList(LISTS.byName), true);
  assert.equal(C.isHomeosList(LISTS.other), false);
  assert.equal(C.isHomeosList({ name: 'HomeOStasks', slug: 'homeostasks' }), false);
  assert.equal(C.isHomeosList(null), false);
});

test('homeosAssigneeTag: HomeOS list gives the Assignee HomeOS tag, other lists none', () => {
  assert.equal(pick(LISTS.hos), 'g3');
  assert.equal(pick(LISTS.bySlug), 'g3');
  assert.equal(pick(LISTS.byName), 'g3');
  assert.equal(pick(LISTS.other), null);
  assert.equal(pick(undefined), null);
  assert.deepEqual(C.ASSIGNEE_DEFAULT, { tagList: 'Assignee', tag: 'HomeOS' });
});

test('homeosAssigneeTag: names without case', () => {
  const tl = tagLists({ TL2: Object.assign({}, tagLists().TL2, { name: 'assignee' }) });
  assert.equal(pick(LISTS.hos, { tagLists: tl, tags: Object.assign({}, TAGS, { g3: { id: 'g3', tag_list_id: 'TL2', name: 'homeos' } }) }), 'g3');
});

test('homeosAssigneeTag: no visible Assignee list, archived, hidden, no role, deleted or missing tag -> null', () => {
  const tl2 = o => tagLists({ TL2: Object.assign({}, tagLists().TL2, o) });
  assert.equal(pick(LISTS.hos, { tagLists: { TL1: tagLists().TL1 } }), null);
  assert.equal(pick(LISTS.hos, { tagLists: tl2({ archived_at: '2026-11-01T00:00:00Z' }) }), null);
  assert.equal(pick(LISTS.hos, { tagLists: tl2({ hidden: true }) }), null);
  assert.equal(pick(LISTS.hos, { tagLists: tl2({ role: null }) }), null);
  assert.equal(pick(LISTS.hos, { tags: Object.assign({}, TAGS, { g3: Object.assign({}, TAGS.g3, { deleted_at: '2026-11-01T00:00:00Z' }) }) }), null);
  assert.equal(pick(LISTS.hos, { tags: { g1: TAGS.g1, g2: TAGS.g2 } }), null);
  assert.equal(pick(LISTS.hos, { tagLists: {}, tags: {} }), null);
});

test('homeosAssigneeTag: several Assignee lists -> the list owner\'s, then mine, then the first by id', () => {
  const tl = tagLists({
    TL0: { id: 'TL0', owner_id: 'p-x', name: 'Assignee', role: 'viewer', hidden: false, archived_at: null },
    TL9: { id: 'TL9', owner_id: AN, name: 'Assignee', role: 'owner', hidden: false, archived_at: null },
  });
  const tags = Object.assign({}, TAGS, { x0: { id: 'x0', tag_list_id: 'TL0', name: 'HomeOS' }, x9: { id: 'x9', tag_list_id: 'TL9', name: 'HomeOS' } });
  assert.equal(pick(LISTS.hos, { tagLists: tl, tags }), 'g3'); // the list's owner (MK) owns TL2
  assert.equal(pick(Object.assign({}, LISTS.hos, { owner_id: 'p-none' }), { tagLists: tl, tags }), 'x9'); // mine
  assert.equal(pick(Object.assign({}, LISTS.hos, { owner_id: 'p-none' }), { tagLists: tl, tags, meId: 'p-other' }), 'x0'); // first by id
  // the owner's list without the tag: the next one that has it
  assert.equal(pick(LISTS.hos, { tagLists: tl, tags: Object.assign({}, tags, { g3: undefined }) }), 'x9');
});

test('assigneeOnListChange: the auto tag follows the list; a tag picked by hand is kept', () => {
  assert.deepEqual(C.assigneeOnListChange([], null, 'g3'), { tags: ['g3'], auto: 'g3' }); // open in a HomeOS list
  assert.deepEqual(C.assigneeOnListChange(['g3', 'g2'], 'g3', null), { tags: ['g2'], auto: null }); // HomeOS -> other
  assert.deepEqual(C.assigneeOnListChange(['g2'], null, 'g3'), { tags: ['g2', 'g3'], auto: 'g3' }); // other -> HomeOS
  assert.deepEqual(C.assigneeOnListChange(['g3'], 'g3', 'g3'), { tags: ['g3'], auto: 'g3' }); // HomeOS -> HomeOS
  assert.deepEqual(C.assigneeOnListChange(['g3'], null, 'g3'), { tags: ['g3'], auto: null }); // already picked by hand
  assert.deepEqual(C.assigneeOnListChange(['g3'], null, null), { tags: ['g3'], auto: null }); // by hand, other list: kept
  assert.deepEqual(C.assigneeOnListChange(undefined, null, null), { tags: [], auto: null });
});

// The two create forms call the rule; the edit window never does (source checks, as edit-window.test.js does)
const web = fs.readFileSync(path.join(__dirname, '..', 'TasksDashboard.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

test('web openTask: preselect only for a new task without a draft, follows #fl until touched', () => {
  const body = web.slice(web.indexOf('function openTask('), web.indexOf('\nfunction ', web.indexOf('function openTask(') + 10));
  assert.match(body, /let autoTag = null, tagTouched = !!\(t \|\| dr\.tags\);/);
  assert.match(body, /if \(!tagTouched\) \{ const a = C\.assigneeOnListChange\(\[\.\.\.chosen\], null, assigneeFor\(listDefault\)\)/);
  assert.match(body, /if \(tagTouched \|\| !editable\) return;\s+const a = C\.assigneeOnListChange\(\[\.\.\.chosen\], autoTag, assigneeFor\(dlg\.querySelector\('#fl'\)\.value\)\)/);
  assert.match(body, /b\.onclick = \(\) => \{ if \(x === autoTag \|\| x === assigneeFor\(dlg\.querySelector\('#fl'\)\.value\)\) tagTouched = true;/);
  // the dirty snapshot is taken after the preselect: closing an untouched form asks nothing
  assert.ok(body.indexOf('const snap0 = snap();') > body.indexOf('if (!tagTouched)'));
});

test('phone openAdd: preselect, follows the List chip until the tag is tapped, an auto tag alone is not dirty', () => {
  assert.match(app, /AD\.touched = false; \{ const a = C\.assigneeOnListChange\(\[\], null, assigneeFor\(AD\.list\)\); AD\.tags = a\.tags; AD\.auto = a\.auto; \}/);
  assert.match(app, /if \(k === 'list'\) \{ AD\.list = v; AD\.open = null; if \(!AD\.touched\) \{ const a = C\.assigneeOnListChange\(AD\.tags, AD\.auto, assigneeFor\(v\)\);/);
  assert.match(app, /if \(tg === AD\.auto \|\| tg === assigneeFor\(AD\.list\)\) \{ AD\.touched = true; AD\.auto = null; \}/);
  assert.match(app, /const addDirty = \(\) => .*AD\.tags\.filter\(x => x !== AD\.auto\)\.length\);/);
  // the task sheet (edit) does not call the rule
  const edit = app.slice(app.indexOf('function openTaskSheet'), app.indexOf('function openTaskSheet') + 4000);
  if (app.includes('function openTaskSheet')) assert.doesNotMatch(edit, /assigneeFor|homeosAssigneeTag/);
});
