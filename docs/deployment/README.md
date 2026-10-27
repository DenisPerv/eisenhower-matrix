# Deployment

How the AI deploys TasksDashboard to its hosted copy on Cloudflare Pages when the person asks. Three steps, always in this order:

| Step | File | Answers |
|---|---|---|
| 1 | [1-version-check.md](1-version-check.md) | Is the hosted copy behind `release_maxden`? What exactly would change? |
| 2 | [2-deploy.md](2-deploy.md) | Build the upload from `release_maxden`, then deploy it (or roll back) |
| 3 | [3-post-deploy-check.md](3-post-deploy-check.md) | Is the right version live, are the headers and the Access gate right, does the page work? |

## Status

**Planned, not live yet.** It works only after:
- the person steps (Cloudflare account, Pages project, Access, tokens), and
- the build run of the household plan `references/homeos/tasksdb/hosting-plan.md` in HomeOS (the deploy script, the `e2e.mjs --url` option).

Until then, stop at step 1 and say that hosting is not set up.

## Rules

- **Who and when.** The AI deploys only when the person asks in chat ("deploy", "publish", "update the hosted page", "roll back the hosted page"). Never on its own initiative, never from a scheduled run. A release to `release_maxden` does not deploy by itself.
- **What.** Only what is on `origin/release_maxden`, never a working tree, `development_maxden` or a local branch. A rollback deploys an older commit of `release_maxden`.
- **Files uploaded.** `TasksDashboard.html` (as `index.html`), `config/tasksdashboard.config.js`, a generated `_headers`, and `version.json`. Never `db/`, `cli/`, `test/`, `docs/`, `config/profiles.js`, `config/*.prefs.json` or the Markdown files.
- **Where it runs.** Only on the machine that holds the Cloudflare tokens (in the household: Maksym's PC, `localConfigs/.env` in HomeOS). The tokens are never printed, never committed, and never sent anywhere but Cloudflare.
- **`file://` stays.** The local page is not affected by a deploy.
- **Report.** After step 3, one short report: old and new version, what changed, the check results. A failed check means a rollback (step 2, Rollback) and a report.

## Setup

| What | Value |
|---|---|
| Host | Cloudflare Pages, Direct Upload project (it can never switch to Git integration) |
| URL | `https://<project>.pages.dev` (household: `homeos-tasksboard.pages.dev`) |
| Gate | Cloudflare Access, one-time PIN by email, the household's emails only; a service token for the AI's checks |
| Tool | Wrangler, pinned version, run with `npx --yes wrangler@<version>` |
| Env names | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (Pages: Edit), `TASKSDB_PAGES_PROJECT`, `TASKSDB_PAGES_BRANCH` (the project's production branch), `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` |

The household's choices, the person steps and the verified Cloudflare facts are in HomeOS `references/homeos/tasksdb/hosting-plan.md`.
