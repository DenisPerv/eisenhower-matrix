# TasksDashboard: rules for Claude

Eisenhower matrix task app on the Supabase database TasksDashboardDB. Files:

| Path | What |
|---|---|
| `TasksDashboard.html` | the whole app, one file, no build |
| `privacy.html` | the privacy page (static, no script), the Google consent screen's privacy policy link; published at `/privacy` on both hosts |
| `signin.html` | the public sign-in page (`/signin` on the app host; `/request` is a 301 alias): Google sign-in, then `rpc/my_access_request` / `rpc/request_access`; with `?intent=consult` (the landing's consulting buttons) `rpc/my_consultation_request` / `rpc/request_consultation` instead (`db/025`); a household login or an approved request goes on to `next` (`/board/`, `/app/` or `/harness/` only); no board data; exactly one inline script (its hash is in the deploy's `_headers`) |
| `site/index.html`, `site/assets/`, `site/THIRD-PARTY-NOTICES.md` | the landing page (landing host `/`): static, GSAP, ScrollTrigger and Lenis inlined, nothing loaded from the network; its inline scripts are hashed by the deploy (no `'self'`; `connect-src` only the Supabase origin, for its one call `rpc/request_plan_interest`, `db/026`); the notices name the libraries' licences and stay unpublished |
| `legal/*.html` | the legal placeholder pages of the landing host (`/terms`, `/refund`, `/cookies`, `/legal-notice`, `/accessibility`, `/data-deletion`): static, no script, the contact and a link to `/privacy` |
| `docs/business/` | the business notes behind the landing page and their screenshots (not published) |
| `docs/privacy-inputs.md` | facts for the legal texts: data, storage keys, cookies, processors, regions, contact (not published; no legal wording) |
| `skills/` | rendered copies of skills that call this repo's CLI; written by a build, never edited by hand |
| `config/tasksdashboard.config.js` | `window.TD_CONFIG = { supabaseUrl, publishableKey, pollMs, telegramBot }`, public values, committed (`telegramBot`: the household bot's public username for the Link Telegram deep link, `db/032`) |
| `db/001_schema.sql` … `004_seed.sql`, `005_item_order.sql`, `006_archived_lists.sql`, `007_renewal.sql`, `008_telegram_editor.sql`, `009_multiuser_schema.sql`, `010_multiuser_functions.sql`, `011_multiuser_rls.sql`, `012_round3.sql`, `013_kpi.sql`, `014_urgency_app.sql`, `015_access_requests.sql`, `016_review_report.sql`, `017_telegram_scope.sql`, `018_task_links.sql`, `019_bot_opt_out.sql`, `020_priority_retired.sql`, `021_drop_priority.sql` (apply only when every client runs code without priority), `022_share_by_person.sql`, `023_agent_tag_home.sql`, `024_whitelist_rls.sql` (its rollback `024_down_whitelist_rls.sql` sorts before it and is a no-op there), `025_consultancy_requests.sql`, `026_plan_interest.sql` (re-run after `003`, which revokes its anon grant; `tasksdb.js apply-sql` appends it), `027_agent_lists.sql`, `028_access_request_buttons.sql`, `029_delete_lists.sql`, `030_plan_interest_email.sql` (a plan-button press needs an email; re-run after `026`, `tasksdb.js apply-sql` appends it), `031_harness_web.sql` (the harness page on the web; re-run after `003`, which revokes its table grants; rollback `031_down_harness_web.sql`), `032_autonomy.sql` (autonomy, intake, budgets, precedents, list brief; re-run after `003`; rollback `032_down_autonomy.sql`), `033_overall_budget_rule.sql` (a list cap at or below the overall cap of its period; replaces `set_budget`; re-run after `032`, which re-creates it without the rule; rollback `033_down_overall_budget_rule.sql`, which sorts before it), `032_telegram_link.sql` (the Telegram link for the household Telegram server, the `workorder-material` bucket, HomeOS - Global, `items` in the Realtime publication; rollback `032_down_telegram_link.sql`; live since 2026-11-11, procedure `apply-032.md` with the read-only check `apply-032-check.sql`; both 032 files and both 915 selftests are applied and kept under their names, no renumbering), `034_project_dir_list_order.sql` (`lists.project_dir` and `set_project_dir`, `household_list_order`, a moved task inherits again, deploy target key `tasksdashboard`; rollback `034_down_project_dir_list_order.sql`), `041_harness_prefs.sql` (the harness settings per person in `preferences` app `harness`, `harness_prefs_read`/`harness_prefs_write` with PT409, `harness_configs` and `harness_config_publish`; re-run after `003`, which revokes its table grant; rollback `041_down_harness_prefs.sql`), `900_selftest.sql`, `901_selftest_multiuser.sql`, `902_selftest_round3.sql`, `903_selftest_access.sql`, `904_selftest_review_report.sql`, `905_selftest_telegram.sql`, `906_selftest_task_links.sql`, `907_selftest_share_by_person.sql`, `908_selftest_agent_tag_home.sql`, `909_selftest_whitelist.sql`, `910_selftest_consultancy.sql`, `911_selftest_plan_interest.sql`, `912_selftest_agent_lists.sql`, `913_selftest_delete_lists.sql`, `914_selftest_harness_web.sql`, `915_selftest_autonomy.sql`, `915_selftest_telegram_link.sql`, `916_selftest_budget_rule.sql`, `917_selftest_project_dir_list_order.sql`, `921_selftest_harness_prefs.sql` | the database, applied in file order (README "Set up") |
| `cli/lib.mjs`, `cli/tasks.mjs` | the CLI and its helpers (also used by the e2e runner) |
| `cli/sync-app-core.mjs` | writes `app/td-core.js` from the `<script id="core">` block of `TasksDashboard.html`; `--check` exits 1 when the copy is out of date |
| `cli/access.mjs` | access requests (`db/015`) to the Cloudflare Access guests policy: `list`, `add`, `remove`, `setup` (single host), `setup --gate` (the two-host Access apps), `process`; dry run unless `--apply` |
| `app/index.html`, `app/td-core.js`, `app/td-data.js`, `app/sw.js`, `app/manifest.webmanifest`, `app/icons/` | the phone app, a second page published at `/app/`: the UI (inline CSS and script), the rules copied from the web's core block (generated, never edited), the data layer (a twin of the web's), the service worker (scope `/app/`), the manifest and the PNG icons. Section "The phone app has a twin in the web page" |
| `test/app-core-parity.test.js`, `test/app-data.test.js`, `test/app-sw.test.js` | the phone app's tests: the core copy equals the block, the data layer against a fake Supabase, the service worker's cache rules (all no network) |
| `test/core.test.js`, `test/multiuser.test.js`, `test/round3.test.js`, `test/round3-tags.test.js`, `test/round3-review.test.js`, `test/round3-p1.test.js`, `test/round4.test.js`, `test/links.test.js`, `test/edit-window.test.js`, `test/edit-nav.test.js`, `test/card-view.test.js`, `test/continue-handler.test.js`, `test/priority-position.test.js`, `test/filters.test.js`, `test/lists-panels.test.js`, `test/access.test.js`, `test/signin.test.js`, `test/site-plans.test.js`, `test/cli.test.js`, `test/api-doc.test.js`, `test/telegram-parity.test.js`, `test/harness-config.test.js`, `test/card-zones.test.js`, `test/telegram-link.test.js`, `test/e2e.mjs` | unit tests and the end-to-end runner |
| `harness/index.html`, `harness/harness.css`, `harness/harness.js`, `harness/harness-data.js`, `harness/config.js`, `harness/harness-remote.js`, `harness/bridge.html`, `harness/bridge.js`, `test/harness-remote.test.js` | the Eisenhower Harness page, published at `/harness/` (HomeOS #45, `db/031`). The first four are byte-equal copies of HomeOS `HomeOS-TasksBoardHarness/viewer/`: never edit them here; change them in HomeOS and run its `tools/copy-viewer-to-app.js`. `harness-remote.js`, `bridge.html` and `bridge.js` (the local-only board bridge that lets the HomeOS harness page on localhost:8790 save the List settings RPCs - autonomy, intake, project folder, brief, budgets - with the board session; since `db/041` the transport reads and writes the person's own harness settings row and never waits for a PC) are this repo's own; the web transport (reads `db/031` with the board's session `td.auth`, queues button presses, greys what the web cannot do with "Run local version") |
| `tools/continue/` | the Continue in Claude handler for a person's PC: `continue-handler.ps1`, `continue-handler.mjs`, `install-continue-handler.ps1`, its `README.md`; never published to a host |
| `README.md`, `CLAUDE.md`, `dependencies-doc.md` | documentation |
| `docs/README.md`, `docs/architecture.md`, `docs/database.md`, `docs/auth.md`, `docs/hosting.md`, `docs/testing-and-release.md` | the documentation pages (index in `docs/README.md`); README stays the technical reference |
| `docs/api/openapi.yaml`, `docs/api/README.md` | the read API: OpenAPI 3.1 description and curl examples (weekly review report `rpc/review_report`, `db/016`); `test/api-doc.test.js` checks them against `db/` |
| `docs/deployment/` | deployment of the hosted copy (Cloudflare Pages): `README.md`, `1-version-check.md`, `2-deploy.md`, `3-post-deploy-check.md` |
| `docs/access-requests.md` | access requests: the flow, `db/015`, `cli/access.mjs`, the Cloudflare setup, seats, switch-off |
| `telegram-integration/` | the task card for a Telegram bot: a Python package (`tasksboard_telegram`, standard library only) with the card, the keyword parser, the button rows, the callback codec and the payloads; a bot plugs it in through three small ports. Its README says how. HomeOS's TelegramBasics bot uses a copy pinned to a commit |

`config/profiles.js` and `config/<id>.prefs.json` belong to the file-based app (`release_maxden_filesbased`); this app does not read them. Nothing else belongs here.

## The task card has a twin in Telegram

`telegram-integration/` builds the same card as the app's task window (title, list, end, description, tags; neither has a For field, but both still write a quadrant and an owner). One known gap, by Anastasiia's choice (2026-11-07): the app's window (web and phone) has four quadrant buttons again, the Telegram card keeps none (its quadrant comes from `deriveQuadrant` and the board). When the app's create or edit window changes (a field added, removed or renamed, a new rule for a field, the quadrant rule `deriveQuadrant`, the tag picker), change `telegram-integration/` in the same change: its card, its payloads, its tests (`python -m unittest discover telegram-integration/tests`) and its README. `test/telegram-parity.test.js` checks the quadrant names and `deriveQuadrant` against the module's shared cases. Bots that copied the module refresh their copy afterwards.

## The phone app has a twin in the web page

`app/` is a second client of the same database. It shares the rules and has its own copy of the data code:

- `app/td-core.js` is generated from `<script id="core">` by `node cli/sync-app-core.mjs`; `test/app-core-parity.test.js` fails when it is stale. A change to the core block is followed by that command in the same change; never edit `app/td-core.js` by hand.
- `app/td-data.js` is a port of the page's main-script data code (sign-in and refresh, `rest`, load, poll, versioned writes and the field-level conflict, links, tags, lists, sharing, preferences). Each part names the web function it came from ("web: name"). When the web's write path, auth, a field rule or a stored key changes, change `app/td-data.js` and `test/app-data.test.js` in the same change, or list the gap in the commit body and in the README "Phone app" section.
- The access gate (`gate()`, `requestAccess()`) repeats what `signin.html` does with `rpc/my_access_request` and `rpc/request_access`; change them together.
- Both clients share the storage key `td.auth`, the Web Lock `td.refresh`, the BroadcastChannel `td.auth` and the synced preferences, except the selected list: the phone keeps its own in `localStorage td.app.list` (it reads `prefs.list` only as the first default). A change to a shared key or preference is a change to both clients.
- `app/index.html` is the source of the phone UI (its inline scripts are edited in place; nothing generates it). `app/td-core.js` is the only generated file.
- The app has no copy of the desktop UI: a UI change on the web does not need one in `app/`. A new database object, RPC or column that the web uses is checked for the app too.

## Deployment: use `docs/deployment/` whenever the person asks for one

When the person asks to deploy, publish, update or roll back the hosted page, or asks whether it is up to date, read `docs/deployment/README.md` first. Then follow its three steps in order: the version check, the deploy, the post-deployment check.

- Deploy only on the person's request in chat, only `origin/release_maxden` (or an older commit of it for a rollback), and only the files the docs list.
- A failed post-deployment check means a rollback and a report.
- Until hosting is set up (status in `docs/deployment/README.md`), say so and stop after the version check.
- A change that adds an inline script, an external script or a network host to `TasksDashboard.html`, `signin.html` or `site/index.html` also updates the `_headers` template in `docs/deployment/2-deploy.md`, in the same commit. `signin.html` keeps exactly one inline script (the deploy refuses more). `legal/*.html` and `privacy.html` have no script (the deploy refuses one).

## Two hosts

- **Landing host** (public): `site/`, `legal/`, `privacy.html`. **App host**: the board at `/board/`, the phone app at `/app/` (both public; the Access gate is bypassed since 2026-11-04), `/signin`, `/privacy`, the config. `docs/hosting.md` has the tables.
- **First-party only on the app host.** Pages on one origin share `localStorage` (`td.auth` holds the session) and cookies, whatever their CSP. Only code from this repository goes on the app host. A later web app of this repo gets its own folder `<name>/`, published at `/<name>/`, with its own CSP row; any web app from elsewhere gets its own Pages project.
- The landing page makes one database call and no other: `rpc/request_plan_interest` (`db/026`), with the publishable key and no login, the only function `anon` may run. Its demo keeps its state in the browser. Its consulting buttons only navigate to the app host's `/signin?intent=consult` (local: the same origin), where the request is made after Google sign-in.

## README is the documentation: update it with every change

Every change to `TasksDashboard.html`, `signin.html`, `app/`, `cli/`, `db/`, `site/`, `legal/` or `test/e2e.mjs` updates `README.md` in the same commit. No exceptions, including small fixes.

- Before committing, check each README section against the change: Database, Config, Sign-in, Data and sync, Preferences and Settings, Storage, Features, CLI, Tests, Limits.
- Values in the README come from the code (`PREFS_DEFAULTS`, `SETTINGS_DEFAULTS`, `restError`, `*_KEY`, `PAGE`, `POLL_OVERLAP_MS`, `EXIT`), never from memory.
- Keep it minimal and technical: tables and short bullets, nothing that is not in this repository.
- A change with no documentation impact still gets a check; say "README checked, no change" in the commit body.

## Branches

- Work only on `development_maxden` (while developing) or `release_maxden` (default). Never check out, commit to, merge into or push `main` or any other branch.
- A local worktree branch may be used for unpushed work and is deleted after it is merged.
- `release_maxden_filesbased` is a frozen read-only snapshot of the file-based app: never commit to it, merge into it or push it.
- Commits go to `development_maxden`. When asked to merge or push: merge `development_maxden` into `release_maxden` and push `release_maxden`.
- Never force-push.

## Local first: every change is tested locally before it is released

Rule since 2026-10-29: the deployed and local versions had drifted apart, each with changes the other lacked.

- **The local version** is the checkout the person runs, on `development_maxden`. In HomeOS that is the mounted submodule `Views/TasksDashboard`, served on http://localhost:8788 by `node scripts/tasksdb/serve-local.js` from HomeOS. A build worktree is not the local version.
- **It always holds every change.** Every change lands on `development_maxden`, and right after each push the local checkout is fast-forwarded to `origin/development_maxden`. Until something is deployed, the newest code is on the local version, never only on `release_maxden`, the hosted page or a worktree.
- **The person tests locally first.** Nothing is merged into `release_maxden` and nothing is deployed until the person has tested the change on the local version and said so in chat. A plan puts "local test by <person>" before its release task, and its release and deploy tasks depend on it. A worker stops at "ready for local test", reports the sha and leaves the release and deploy rows pending.
- **Release and deploy only follow development.** `release_maxden` only ever receives merges from `development_maxden`. A fix made directly on `release_maxden` (avoid it) is merged back into `development_maxden` in the same task. Deploys come only from `release_maxden`. So the hosted page is never ahead of the local version.
- **Database changes follow the same order.** A `db/` file that the released page needs is applied live before the person's local test, because the local page runs against the live database too.
- **Exception: AI Brain.** Under AI Brain (set by a household person) a task whose list intake names the `tasksdashboard` deploy target may merge `development_maxden` into `release_maxden` and deploy, only after unit tests and e2e pass on a preview and the deploy-readiness judge says ready; outside AI Brain local first is unchanged.

## Code

- `TasksDashboard.html`: one HTML file, no build step, no runtime dependencies, opens from `file://`.
- Sign-in is Google only (2026-10-30): no client (board, phone app, `signin.html`) offers a password field, and none may again. Signed out on the app host, the board and the app go to `/signin?next=/board/` or `/app/` and take its session from `sessionStorage td.request.auth` (core `signinRedirect`, `signinHandover`); localhost signs in in place; `file://` shows the button but cannot sign in. Password logins exist only for service logins, signed in by REST (CLI, e2e). The privacy line (`PRIVACY`) is the same in the board and the app.
- `app/`: one app page (`index.html`) plus its scripts (`td-core.js`, `td-data.js`), manifest, service worker and icons; no build step beyond `node cli/sync-app-core.mjs`, no libraries. The PWA parts (manifest, service worker, install) need an https or `http://localhost` origin; `app/` does not need to open from `file://` (the page skips the worker there; Google sign-in is hosted or localhost only). A new inline script, external script or network host in `app/index.html` changes the `/app/*` CSP template in `docs/deployment/2-deploy.md` in the same commit.
- The only network calls are `fetch` to `TD_CONFIG.supabaseUrl` (`/auth/v1`, `/rest/v1`). No libraries, nothing else loaded from the network.
- Logic stays in `<script id="core">` with no DOM and no system clock (time is a parameter). The CLI and the tests load that block through `vm` (`cli/lib.mjs` `loadCore`), so there is one rule set.
- The CLI and the tests are dependency-free Node. `telegram-integration/` is the one Python folder: standard library only, never loaded by the page.
- After a UI change, check the page at desktop and mobile widths (`test/e2e.mjs` takes screenshots at 1440×900 and 390×844).

## Config

Public values only: the project URL, the publishable key, the poll interval. Never a password, a token, or the secret or service key.

## Database

- Changes only as a new `db/NNN_*.sql` file, never by editing an applied one. After one: re-run `003_rls.sql`, `011_multiuser_rls.sql`, the policy block at the end of `012_round3.sql` (it replaces 011's tag policies), `026_plan_interest.sql` (003 revokes its anon grant), `030_plan_interest_email.sql` (026 alone makes the email optional again), `031_harness_web.sql`, `032_autonomy.sql` and `041_harness_prefs.sql` (003 revokes their table grants), `033_overall_budget_rule.sql` (032 re-creates `set_budget` without its rule), then `900_selftest.sql`, `901_selftest_multiuser.sql`, `902_selftest_round3.sql`, `903_selftest_access.sql`, `904_selftest_review_report.sql`, `905_selftest_telegram.sql`, `906_selftest_task_links.sql`, `907_selftest_share_by_person.sql`, `908_selftest_agent_tag_home.sql`, `909_selftest_whitelist.sql`, `910_selftest_consultancy.sql`, `911_selftest_plan_interest.sql`, `912_selftest_agent_lists.sql`, `913_selftest_delete_lists.sql`, `914_selftest_harness_web.sql`, `915_selftest_autonomy.sql`, `915_selftest_telegram_link.sql`, `916_selftest_budget_rule.sql` `917_selftest_project_dir_list_order.sql` and `921_selftest_harness_prefs.sql` (each must report every assertion passed; 901 has two expected failures since 012, G34a and G35a, see README Set up).
- `006_archived_lists.sql` and then `010_multiuser_functions.sql` replace the trigger function from `002`: re-running `002` means re-running `006` and `010`.
- `010_multiuser_functions.sql` also replaces `items_tags_compat_after`: re-running `010` means re-running `023_agent_tag_home.sql` after it. It also replaces `members_keep_owner`: re-run `029_delete_lists.sql` after it too.

## Tests

- `node --test "test/*.test.js"` before every commit (no network).
- `python -m unittest discover -s telegram-integration/tests -t telegram-integration/tests` before a commit that touches `telegram-integration/` or the task window (no network).
- `node test/e2e.mjs --env <env file> --out <dir>` before a release merge (live database; writes only in `_selftest` and test lists it archives).
- The `guests` group needs guest logins (`TASKSDB_GUEST_A_*`, `TASKSDB_GUEST_B_*`) that are guests (`is_household` false); a missing one is reported as skipped. Never point it at a real person's account, and never share a household list or tag list with a guest: guests only see test lists the run makes, and only a guest's tags are shared, to Maksym.

## Data

Task data never lives in this repository. It lives in the database; the seed's emails are placeholders filled at apply time.
