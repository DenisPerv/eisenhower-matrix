# Deployment

How the AI deploys TasksDashboard and its landing page to the two hosts on Cloudflare Pages when the person asks ([../hosting.md](../hosting.md)): the landing host (site, legal placeholders, `/privacy`) and the app host (`/board/`, `/app/`, `/signin`, `/privacy`). Each host is deployed separately, landing first. Three steps, always in this order:

| Step | File | Answers |
|---|---|---|
| 1 | [1-version-check.md](1-version-check.md) | Is the hosted copy behind `release_maxden`? What exactly would change? |
| 2 | [2-deploy.md](2-deploy.md) | Build the upload from `release_maxden`, then deploy it (or roll back) |
| 3 | [3-post-deploy-check.md](3-post-deploy-check.md) | Is the right version live, are the headers and the Access gate right, does the page work? |

## Status

**Two hosts (household, 2026-10-30):** landing `https://eisenhower-agentic-planner.pages.dev` (public) and app `https://eisenhower-agentic-planner-app.pages.dev` (all public: `/board/` and `/app/` go to `/signin` when signed out; the Access app "Eisenhower gate" is bypassed since 2026-11-04). Both projects exist with placeholder pages until the first release that holds `site/` and `signin.html` is deployed. The older single host `https://homeos-tasksboard.pages.dev` (board at `/`, whole host behind Access) is redirected to the app host once the app host has passed its checks. Deploy script: HomeOS `scripts/tasksdb/deploy-pages.js`.

## Rules

- **Who and when.** The AI deploys only when the person asks in chat ("deploy", "publish", "update the hosted page", "roll back the hosted page"). Never on its own initiative, never from a scheduled run. A release to `release_maxden` does not deploy by itself.
- **What.** Only what is on `origin/release_maxden`, never a working tree, `development_maxden` or a local branch. A rollback deploys an older commit of `release_maxden`.
- **Files uploaded.** Landing host: `site/index.html` (as `index.html`), `site/assets/*` (images only), `legal/*.html` (no script; served at `/<name>`), `privacy.html` (no script), a generated `_headers` and `version.json`. App host: `TasksDashboard.html` (as `board/index.html`), `config/tasksdashboard.config.js`, `signin.html` (one inline script; served at `/signin`), `privacy.html`, the phone app under `app/` (`index.html`, `td-core.js`, `td-data.js`, `sw.js` with the release sha, `manifest.webmanifest`, `icons/*.png`; served at `/app/`), generated `_headers` and `_redirects` (`/request` → `/signin` 301, `/` → `/board/` 302), and `version.json`. Never `db/`, `cli/`, `test/`, `docs/`, `telegram-integration/`, `config/profiles.js`, `config/*.prefs.json` or the Markdown files.
- **Where it runs.** Only on the machine that holds the Cloudflare tokens (in the household: Maksym's PC, `localConfigs/.env` in HomeOS). The tokens are never printed, never committed, and never sent anywhere but Cloudflare.
- **`file://` stays.** The local page is not affected by a deploy.
- **Report.** After step 3, one short report: old and new version, what changed, the check results. A failed check means a rollback (step 2, Rollback) and a report.

## Setup

| What | Value |
|---|---|
| Host | Cloudflare Pages, Direct Upload project (it can never switch to Git integration) |
| URL | `https://<landing>.pages.dev` and `https://<app>.pages.dev` (household: `eisenhower-agentic-planner.pages.dev`, `eisenhower-agentic-planner-app.pages.dev`) |
| Gate | Cloudflare Access: a previews app per host, a service token for the AI's checks; "Eisenhower gate" on the app host's `/board` and `/app` paths is bypassed ([../hosting.md](../hosting.md)) |
| Tool | Wrangler, pinned: `npx --yes wrangler@4.150.0` (the pin lives in `deploy-pages.js`) |
| Env names | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (Pages: Edit), `TASKSDB_PAGES_PROJECT` (the app project), `TASKSDB_SITE_PROJECT` (the landing project), `TASKSDB_PAGES_BRANCH` (the project's production branch, default `main`), `TASKSDB_PAGES_URL` (optional, default `https://<project>.pages.dev`), `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` |

The setup steps and the verified Cloudflare facts are in [../hosting.md](../hosting.md); the household's own decisions are kept with its plans outside this repository.
