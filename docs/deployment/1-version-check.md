# 1. Version check

Before every deploy: compare what is live with what `release_maxden` holds, and say what would change.

## How versions are named

- **Version = the commit sha of `release_maxden`** that the upload was built from. There is no separate version number.
- Every upload carries `version.json`: `{ "sha": "<full sha>", "builtAt": "<ISO time>" }`.
- Each deployment is also tagged in Cloudflare with `--commit-hash <sha>` and `--commit-message "release_maxden <short sha>"`, so the Cloudflare dashboard shows the same sha.

## Steps

1. **Release side.** `git -C <repo> fetch origin`, then `git -C <repo> rev-parse origin/release_maxden`. This is the wanted version.
2. **Hosted side.** Through the HomeOS script: `node scripts/tasksdb/deploy-pages.js --status [--timeout <ms>]` (default 10000 ms; it fetches `origin/release_maxden` first). By hand: `GET https://<project>.pages.dev/version.json` with the headers `CF-Access-Client-Id` and `CF-Access-Client-Secret` from the env. The Access gate answers anything without them with a redirect to `*.cloudflareaccess.com`.

   | `--status` exit | Means |
   |---|---|
   | 0 | current: hosted sha = `origin/release_maxden` |
   | 10 | behind: hosted sha differs |
   | 6 | unreachable, timed out, or the gate refused the service token (a redirect) |
   | 2 | usage error, or `TASKSDB_PAGES_PROJECT` (or `TASKSDB_PAGES_URL`) missing |

3. **What changed.** `git -C <repo> log --oneline <hosted sha>..origin/release_maxden -- TasksDashboard.html config/tasksdashboard.config.js privacy.html request.html`. Only these four files reach the hosted page; other commits (db, cli, tests, docs) change nothing there.
4. **Decide.**
   - **Current:** nothing to deploy. Say so and stop, unless the person asked for a rollback.
   - **Behind, page files changed:** list the commits for the person, then go to step 2.
   - **Behind, only other files changed:** a deploy changes only `version.json`. Say so; deploy only if the person still wants it.
   - **Hosted sha not on `release_maxden`** (`git merge-base --is-ancestor <hosted sha> origin/release_maxden` fails): the hosted copy is a rollback or from a rewritten history. Report it and ask before deploying.
5. **Config check** on the wanted version: `git show origin/release_maxden:config/tasksdashboard.config.js` must hold an https `supabaseUrl`, an `sb_publishable_…` key and never `sb_secret_`. Otherwise stop: it would publish a secret or a broken page.

## Sync warning

In HomeOS the 09:00 sync runs `deploy-pages.js --status` and prints a warning when the hosted copy is behind. It never deploys: the warning is a hint to ask the AI.
