# TasksDashboard: rules for Claude

Eisenhower matrix task app on the Supabase database TasksDashboardDB. Files:

| Path | What |
|---|---|
| `TasksDashboard.html` | the whole app, one file, no build |
| `privacy.html` | the privacy page (static, no script), the Google consent screen's privacy policy link; deployed beside `index.html` |
| `request.html` | the public access-request page (`/request`): Google sign-in, then `rpc/my_access_request` / `rpc/request_access`; no board data; exactly one inline script (its hash is in the deploy's `_headers`) |
| `config/tasksdashboard.config.js` | `window.TD_CONFIG = { supabaseUrl, publishableKey, pollMs }`, public values, committed |
| `db/001_schema.sql` … `004_seed.sql`, `005_item_order.sql`, `006_archived_lists.sql`, `007_renewal.sql`, `008_telegram_editor.sql`, `009_multiuser_schema.sql`, `010_multiuser_functions.sql`, `011_multiuser_rls.sql`, `012_round3.sql`, `013_kpi.sql`, `014_urgency_app.sql`, `015_access_requests.sql`, `016_review_report.sql`, `017_telegram_scope.sql`, `900_selftest.sql`, `901_selftest_multiuser.sql`, `902_selftest_round3.sql`, `903_selftest_access.sql`, `904_selftest_review_report.sql`, `905_selftest_telegram.sql` | the database, applied in file order (README "Set up") |
| `cli/lib.mjs`, `cli/tasks.mjs` | the CLI and its helpers (also used by the e2e runner) |
| `cli/access.mjs` | access requests (`db/015`) to the Cloudflare Access guests policy: `list`, `add`, `remove`, `setup`, `process`; dry run unless `--apply` |
| `test/core.test.js`, `test/multiuser.test.js`, `test/round3.test.js`, `test/round3-tags.test.js`, `test/round3-review.test.js`, `test/round3-p1.test.js`, `test/round4.test.js`, `test/access.test.js`, `test/cli.test.js`, `test/api-doc.test.js`, `test/telegram-parity.test.js`, `test/e2e.mjs` | unit tests and the end-to-end runner |
| `README.md`, `CLAUDE.md`, `dependencies-doc.md` | documentation |
| `docs/README.md`, `docs/architecture.md`, `docs/database.md`, `docs/auth.md`, `docs/hosting.md`, `docs/testing-and-release.md` | the documentation pages (index in `docs/README.md`); README stays the technical reference |
| `docs/api/openapi.yaml`, `docs/api/README.md` | the read API: OpenAPI 3.1 description and curl examples (weekly review report `rpc/review_report`, `db/016`); `test/api-doc.test.js` checks them against `db/` |
| `docs/deployment/` | deployment of the hosted copy (Cloudflare Pages): `README.md`, `1-version-check.md`, `2-deploy.md`, `3-post-deploy-check.md` |
| `docs/access-requests.md` | access requests: the flow, `db/015`, `cli/access.mjs`, the Cloudflare setup, seats, switch-off |
| `telegram-integration/` | the task card for a Telegram bot: a Python package (`tasksboard_telegram`, standard library only) with the card, the keyword parser, the button rows, the callback codec and the payloads; a bot plugs it in through three small ports. Its README says how. HomeOS's TelegramBasics bot uses a copy pinned to a commit |

`config/profiles.js` and `config/<id>.prefs.json` belong to the file-based app (`release_maxden_filesbased`); this app does not read them. Nothing else belongs here.

## The task card has a twin in Telegram

`telegram-integration/` builds the same card as the app's task window (title, list, quadrant, end, description, tags; plus For). When the app's create or edit window changes (a field added, removed or renamed, a new rule for a field, the quadrant rule `deriveQuadrant`, the tag picker), change `telegram-integration/` in the same change: its card, its payloads, its tests (`python -m unittest discover telegram-integration/tests`) and its README. `test/telegram-parity.test.js` checks the quadrant names and `deriveQuadrant` against the module's shared cases. Bots that copied the module refresh their copy afterwards.

## Deployment: use `docs/deployment/` whenever the person asks for one

When the person asks to deploy, publish, update or roll back the hosted page, or asks whether it is up to date, read `docs/deployment/README.md` first. Then follow its three steps in order: the version check, the deploy, the post-deployment check.

- Deploy only on the person's request in chat, only `origin/release_maxden` (or an older commit of it for a rollback), and only the files the docs list.
- A failed post-deployment check means a rollback and a report.
- Until hosting is set up (status in `docs/deployment/README.md`), say so and stop after the version check.
- A change that adds an inline script, an external script or a network host to `TasksDashboard.html` or `request.html` also updates the `_headers` template in `docs/deployment/2-deploy.md`, in the same commit. `request.html` keeps exactly one inline script (the deploy refuses more).

## README is the documentation: update it with every change

Every change to `TasksDashboard.html`, `request.html`, `cli/`, `db/` or `test/e2e.mjs` updates `README.md` in the same commit. No exceptions, including small fixes.

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

## Code

- One HTML file, no build step, no runtime dependencies, opens from `file://`.
- The only network calls are `fetch` to `TD_CONFIG.supabaseUrl` (`/auth/v1`, `/rest/v1`). No libraries, nothing else loaded from the network.
- Logic stays in `<script id="core">` with no DOM and no system clock (time is a parameter). The CLI and the tests load that block through `vm` (`cli/lib.mjs` `loadCore`), so there is one rule set.
- The CLI and the tests are dependency-free Node. `telegram-integration/` is the one Python folder: standard library only, never loaded by the page.
- After a UI change, check the page at desktop and mobile widths (`test/e2e.mjs` takes screenshots at 1440×900 and 390×844).

## Config

Public values only: the project URL, the publishable key, the poll interval. Never a password, a token, or the secret or service key.

## Database

- Changes only as a new `db/NNN_*.sql` file, never by editing an applied one. After one: re-run `003_rls.sql`, `011_multiuser_rls.sql`, the policy block at the end of `012_round3.sql` (it replaces 011's tag policies), then `900_selftest.sql`, `901_selftest_multiuser.sql`, `902_selftest_round3.sql`, `903_selftest_access.sql`, `904_selftest_review_report.sql` and `905_selftest_telegram.sql` (each must report every assertion passed; 901 has two expected failures since 012, G34a and G35a, see README Set up).
- `006_archived_lists.sql` and then `010_multiuser_functions.sql` replace the trigger function from `002`: re-running `002` means re-running `006` and `010`.

## Tests

- `node --test "test/*.test.js"` before every commit (no network).
- `python -m unittest discover -s telegram-integration/tests -t telegram-integration/tests` before a commit that touches `telegram-integration/` or the task window (no network).
- `node test/e2e.mjs --env <env file> --out <dir>` before a release merge (live database; writes only in `_selftest` and test lists it archives).
- The `guests` group needs guest logins (`TASKSDB_GUEST_A_*`, `TASKSDB_GUEST_B_*`) that are guests (`is_household` false); a missing one is reported as skipped. Never point it at a real person's account, and never share a household list or tag list with a guest: guests only see test lists the run makes, and only a guest's tags are shared, to Maksym.

## Data

Task data never lives in this repository. It lives in the database; the seed's emails are placeholders filled at apply time.
