# Testing and release

Three layers of checks, all dependency-free: unit tests of the core rules (no network), selftests of the database (admin SQL, rolled back), and an end-to-end runner that drives the real page against the live database. The root README's **Tests** section lists every file and check in detail.

## Unit tests

```
node --test "test/*.test.js"
```

- Run before every commit. No network, no browser.
- They load the page's `<script id="core">` through Node `vm`, so they test the code the page runs.
- Files: `core.test.js` (core rules), `multiuser.test.js` (Google sign-in helpers, errors, tags, roles), `round3*.test.js` and `round4.test.js` (the features of those rounds), `access.test.js` (`cli/access.mjs` against a mocked Cloudflare API), `cli.test.js` (the CLI), `api-doc.test.js` (the API description against `db/`: every RPC in `docs/api/openapi.yaml` exists with an `authenticated` grant, every path is in `docs/api/README.md`, no secrets in the docs).

## Database selftests

`db/900_selftest.sql` … `db/904_selftest_review_report.sql`, run as admin SQL after every schema change ([database.md](database.md)). Each makes its own fixtures (test logins with `example.invalid` addresses, test lists), signs in as them by setting the JWT claims, checks the answers, and **rolls everything back** by ending with an error whose text is the result:

| File | Covers | Expected |
|---|---|---|
| `900_selftest.sql` | RLS of the household: roles, agents, protected columns, keep-alive | 57 of 57 |
| `901_selftest_multiuser.sql` | guests, invitations, tags, the sign-up hook, identity guards, limits | 71 of 73 (G34a, G35a describe a v1 rule 012 replaced) |
| `902_selftest_round3.sql` | list names and slugs, first shares, notices, blocks, tag-list roles, `urgency_settings`, the nonce | 66 of 66 |
| `903_selftest_access.sql` | access requests: who may ask, the row and task, decisions, caps, rights | 47 of 47 |
| `904_selftest_review_report.sql` | `review_report`: kinds done / cancelled (by its event) / overdue / due, `late`, quadrants incl. stored and pinned, groups, period and time zone, sorting, `p_lists`, test lists, guests and other people see nothing of a private list, bad input 22023, rights | 23 of 23 |
| `905_selftest_telegram.sql` | the chat bot's scope and opt-out (`db/017`, `db/019`, the Telegram track) | 35 of 35 |
| `906_selftest_task_links.sql` | task links: links by the owner, viewer and contributor rights, `depends_on` and `parent` loops, a second parent, no read on one end (no row, a refusal naming nothing), cross-list links, soft unlink and `changed_at`, archived and deleted ends, `blocks`, self links and bad kinds, the agent, the guest, rights | 42 of 42 |

## End-to-end runner

```
node test/e2e.mjs --env <env file> --out <dir> [--group auth,data,sync,archive,errors,ui,links,guests,request] [--smoke] [--url <https origin> [--access-env <file>]]
```

- Headless Chrome or Edge over DevTools, Node 22+, no Playwright package needed. Report `e2e-report.md` and screenshots (1440×900 and 390×844) in `<dir>`.
- Logins come from the env file (`TASKSDB_URL`, `TASKSDB_ANON_KEY`, `TASKSDB_<HANDLE>_EMAIL` / `_PASSWORD`, optional `TASKSDB_GUEST_A_*`, `TASKSDB_GUEST_B_*`); values are never printed. Sessions are seeded into the page, so no real password is typed into it.
- Writes stay in the `_selftest` list and test lists the run creates and archives; both people's preferences are put back at the end.
- Group `ui` includes the parity check of the review API: for the weeks picked in the Review, `rpc/review_report` as the same person must give the same ids, kinds and quadrants as the page, in under 2 s (timings in the report's "Review API" table).
- Group `links` makes a parent tree and a predecessor chain in `_selftest` through the task window and `rpc/link_items`, checks the badges, Group by parent and the Timeline (tree, arrows, fold), and draws 200 more rows in under 100 ms (report table "Timeline render").
- `--url` runs the same checks against a hosted copy; `--access-env` adds the Access service-token headers to that origin only.

## Branches and release

| Branch | Use |
|---|---|
| `development_maxden` | every commit lands here first (or on a local worktree branch that is fast-forwarded into it) |
| `release_maxden` | what is released and what a deploy may upload; moves only by merging `development_maxden` |
| `release_maxden_filesbased` | a frozen snapshot of the older file-based app; never changed |
| `main` | not used by this setup; never committed to or pushed |

Release flow:

1. Unit tests green, README and docs updated in the same commit (the root `CLAUDE.md` rule), push `development_maxden` (`git pull --rebase` first; never force-push).
2. A schema change: apply the new `db/NNN` file live, then the re-runs and every selftest.
3. Run the e2e groups that cover the change against `development_maxden`'s page and read the screenshots at both widths.
4. Merge `development_maxden` into `release_maxden` and push. When another line of work has unvalidated commits on `development_maxden`, wait for it (or release only up to a validated commit).
5. Deploy only when a person asks, following [deployment/](deployment/README.md): version check, deploy, post-deploy check (version, headers, Access gate, `e2e --url`); a failed check means a rollback. A change that touches no published file (the database, docs, the CLI) needs no deploy.

**Household:** HomeOS mounts this repo as a submodule on `release_maxden`; after a release it commits the new pointer (`bump Views/TasksDashboard to <sha>`).
