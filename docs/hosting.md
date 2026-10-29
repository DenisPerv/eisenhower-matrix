# Hosting

The page needs no server: any static https host can serve it, and `file://` keeps working beside a hosted copy. This page describes the setup this repo was built with, **Cloudflare Pages (Direct Upload) behind Cloudflare Access**, on free plans, so another household can make the same. The deploy itself, step by step, is the runbook in [deployment/](deployment/README.md).

Why not Supabase itself: on the free plan Supabase Storage and Edge Functions serve HTML as `text/plain`, and a custom domain is paid. GitHub Pages would publish from the repo and has no free per-email gate; Netlify or Vercel would work but add another account without a free email gate like Access.

## What is published

| Published path | From | Note |
|---|---|---|
| `/` (`index.html`) | `TasksDashboard.html` | as is |
| `/config/tasksdashboard.config.js` | the config | public values only (`supabaseUrl`, `publishableKey`, `pollMs`) |
| `/privacy` (`privacy.html`) | `privacy.html` | no script; the Google consent screen's privacy link |
| `/request` (`request.html`) | `request.html` | the access-request page, exactly one inline script ([access-requests.md](access-requests.md)) |
| `/app/` (`app/index.html`) | `app/index.html`, `app/td-core.js`, `app/td-data.js`, `app/sw.js`, `app/manifest.webmanifest`, `app/icons/*.png` | the phone app, only when the release has `app/index.html`; `sw.js` gets the release sha, the page's script addresses get `?v=<short sha>` ([deployment/2-deploy.md](deployment/2-deploy.md)) |
| `_headers` | generated | security headers and the CSP (below); not served itself |
| `/version.json` | generated | `{ "sha", "builtAt" }` of the release commit, for the version check |

Nothing else: never `db/`, `cli/`, `test/`, `docs/` or the Markdown files. Only commits of `release_maxden` are deployed ([testing-and-release.md](testing-and-release.md)).

## Setup, once (a person does these; values never go into the repo)

1. **Cloudflare account** (free). Turn on two-factor. Note the Account ID (Workers & Pages shows it).
2. **Pages project, Direct Upload:** Workers & Pages → Create → Pages → Upload assets; name `<project>`; upload a placeholder folder with one `index.html`. Direct Upload can never switch to Git integration later; that is fine, the deploy uploads a folder.
3. **Zero Trust on the Free plan:** pick a team name; Integrations → Identity providers → add **One-time PIN** (and Google, if wanted).
4. **Access on the project, production included:** project → Settings → General → Enable access policy (this protects previews). Then Zero Trust → Access → Applications → open that application → remove the `*` wildcard from the subdomain so it covers `<project>.pages.dev` itself (rename it if saving complains), and Enable access policy again for a second application that covers previews. In both: policy Allow, Include Emails = the people who may open the page; session duration as long as wanted.
5. **Service token for automated checks:** Access → Service auth → Service Tokens → Create; add a policy Service Auth → that token in both applications. Checks send its two headers **only** to the pages.dev origin, never to Supabase.
6. **API token for deploys:** My Profile → API Tokens → Custom token with Account → Cloudflare Pages → Edit; scope it to the account.
7. **Secrets** go only into the deploying machine's env file, by name: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `TASKSDB_PAGES_PROJECT`, `TASKSDB_PAGES_BRANCH` (the project's production branch, usually `main`), `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.
8. **Supabase:** Authentication → URL Configuration: Site URL `https://<project>.pages.dev`, Redirect URLs `https://<project>.pages.dev/**` (plus `http://localhost:<port>/**` for local tests). A password-only setup needs neither (CORS allows any origin), Google sign-in needs both ([auth.md](auth.md)).
9. **Check:** a private window on `https://<project>.pages.dev` shows the Cloudflare Access page, not the app.

**Household:** project `homeos-tasksboard` (`https://homeos-tasksboard.pages.dev`), set up on 2026-10-27 by the HomeOS hosting plan (`references/homeos/tasksdb/hosting-plan.md` in HomeOS), deployed by HomeOS `scripts/tasksdb/deploy-pages.js` from Maksym's PC, the only machine with the tokens. Access stays on production; strangers ask for access on `/request`, which a bypass application makes public together with the config ([access-requests.md](access-requests.md)).

## The phone app on the same project

The phone app ([architecture.md](architecture.md), section Phone app) ships from the same Pages project and domain: `https://<project>.pages.dev/app/`. Same origin means the same Supabase redirect allow-list (`https://<project>.pages.dev/**` already covers `/app/`), the same config file and the same `td.auth` storage.

**Person step: a path bypass for `/app/*`.** Access in front of the app breaks installing it: the browser fetches the manifest and icons without the Access cookie, and an iPhone's installed app does not share Safari's cookies. So `/app/*` is public at the edge and the app gates itself; the website at `/` keeps Access. It is the same pattern as `/request` ([access-requests.md](access-requests.md)):

1. Zero Trust → Access → Applications → Add → Self-hosted; domain `<project>.pages.dev`, path `app/*` (the more specific path wins over the production application).
2. Policy: action **Bypass**, include **Everyone**. (`cli/access.mjs setup` makes this kind of policy for `/request`; it does not know `/app/*`, so make the application by hand, or add the path to the request application.)
3. Check in a private window: `/app/` opens the app without the Access page; `/` still asks for Access.

Bypass hides nothing that was hidden before: Access never protected the data, RLS does ([What Access does and does not do](#what-access-does-and-does-not-do)).

**After the first deploy with the app, check the headers:**

- `/app/`: exactly one `Content-Security-Policy`, the app's (`connect-src 'self' <supabaseUrl>`, `manifest-src 'self'`, `worker-src 'self'`), and `Cache-Control: no-cache`. Two policies joined by a comma mean the `! Content-Security-Policy` detach line is missing.
- `/app/sw.js` and `/app/manifest.webmanifest`: `no-cache`.
- `/`: unchanged, the page's CSP (`connect-src` only the Supabase origin).
- The Cloudflare features that inject scripts stay off (below); the app's CSP blocks them too.

**Switch the app off.** Deploy a release without `app/` (the script then ships no `app/` file and no `/app` header rule), or delete the bypass application so `/app/*` is behind Access again. A phone that installed the app keeps its cached shell until the next network start; the website and `file://` are not affected.

## Headers and CSP

`_headers` applies one policy to every path:

- `Content-Security-Policy: default-src 'none'; script-src 'self' 'sha256-<each inline script>'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src <supabaseUrl>; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`
- `Referrer-Policy: no-referrer` (keeps the Google `?code=` out of any request), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` with every device off, `Strict-Transport-Security`, `X-Robots-Tag: noindex`
- `Cache-Control: no-cache` for `/`, `/index.html`, `/request`, the config and `version.json`

Paths under `/app/` get their own CSP (`default-src 'none'; script-src 'self' 'sha256-<each inline script of app/index.html>'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' <supabaseUrl>; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`); the template is in `docs/deployment/2-deploy.md`.

`script-src` lists the sha256 of the body of each inline `<script>` of the page and of `request.html` (line endings LF), so a new inline script, an external script or a new network host needs the template changed in the same commit (`docs/deployment/2-deploy.md` holds the template). `connect-src` is only the Supabase origin, so a stolen token cannot be sent anywhere else from the page. Turn off any Cloudflare feature that injects scripts (Web Analytics auto-inject, Rocket Loader, email obfuscation): the CSP blocks them and the page breaks.

## What Access does and does not do

- It hides the page, not the data: Supabase is reachable directly with the public key. RLS and the sign-up hook stay the real lock; never relax them because Access is in front.
- The Access session (cookie on pages.dev) and the app session (Supabase tokens) are separate. When the Access cookie expires, the next page load asks again; an open tab keeps polling Supabase.
- Old deployments keep their own `<hash>.<project>.pages.dev` URLs, covered by the preview application.
- **Kill switch:** in both Access applications, edit the policies so they include nobody. To close registrations instead, turn sign-ups off in Supabase. `file://` always remains.

## Storage per origin

Each hosted origin has its own browser storage (`td.auth`, `td.accounts`, `td.pkce`, `td.theme`, `td.rail`; the phone app adds `td.app.pkce`, `td.app.theme`, `td.app.lastList`, IndexedDB `td-app` and the cache `td-app-<sha>`; the web page and the app share the origin, so they share the sign-in): sign in once on each; signing out of one leaves the others signed in.

## Verified free-plan facts

Read in the Cloudflare and Supabase docs on 2026-10-27 (re-check before relying on them):

| Fact | Source |
|---|---|
| Pages free plan: 500 builds a month, 1 build at a time, 20,000 files per site, 25 MiB per file, 100 projects per account; `_headers` up to 100 rules, 2,000 characters per line | developers.cloudflare.com/pages/platform/limits/ |
| "On both free and paid plans, requests to static assets are free and unlimited." (bandwidth not mentioned: unverified) | developers.cloudflare.com/pages/functions/pricing/ |
| Direct Upload cannot switch to Git integration later; `wrangler pages deploy <dir>` goes to production, `--branch=<other>` makes a preview; inside a Git workspace Wrangler picks the branch up by itself, so always pass `--branch <production branch>` | developers.cloudflare.com/pages/get-started/direct-upload/ |
| No Wrangler rollback command; the dashboard can roll back to an earlier production deployment (for Direct Upload: unverified), so the script redeploys an older commit instead | developers.cloudflare.com/pages/configuration/rollbacks/ |
| Enable access policy protects previews only; protecting `<project>.pages.dev` needs the wildcard removed (two Access applications) | developers.cloudflare.com/pages/platform/known-issues/ |
| One-time PIN codes go only to addresses a policy allows, valid 10 minutes, single use | developers.cloudflare.com/cloudflare-one/identity/one-time-pin/ |
| Zero Trust Free: $0, 50 users | cloudflare.com/plans/ |
| Supabase Redirect URLs are the allow list for `redirect_to` (OAuth); the password grant needs none | supabase.com/docs/guides/auth/redirect-urls |
| A free Supabase project pauses after a week without requests (restore it in the dashboard; a keep-alive job prevents it) | root README, Open and sign in (not re-read in the Supabase docs) |
