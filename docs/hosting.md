# Hosting

Nothing here needs a server: any static https host can serve the pages, and `file://` keeps working beside a hosted copy. This page describes the setup this repo was built with, **two Cloudflare Pages projects (Direct Upload)**, on free plans, so another household can make the same. The deploy itself, step by step, is the runbook in [deployment/](deployment/README.md).

Why not Supabase itself: on the free plan Supabase Storage and Edge Functions serve HTML as `text/plain`, and a custom domain is paid. GitHub Pages would publish from the repo and has no free per-email gate; Netlify or Vercel would work but add another account without a free email gate like Access.

## Two hosts

The public landing page and the signed-in pages live on two origins, so the landing page shares no storage and no cookies with the board.

| Host (Pages project) | Paths | Access |
|---|---|---|
| landing, `<landing>.pages.dev` (household: `eisenhower-agentic-planner.pages.dev`) | `/` site, `/assets/*`, `/terms`, `/refund`, `/cookies`, `/legal-notice`, `/accessibility`, `/data-deletion`, `/privacy`, `/version.json` | public; noindex; CSP from hashes only; `connect-src` the Supabase origin on `/`, `'none'` on the other pages |
| app, `<app>.pages.dev` (household: `eisenhower-agentic-planner-app.pages.dev`) | `/board/`, `/app/`, `/signin`, `/request` (301 → `/signin`), `/privacy`, `/config/tasksdashboard.config.js`, `/version.json`; later first-party `/<name>/` | public; the Access app **Eisenhower gate** on `/board`, `/board/*`, `/app`, `/app/*` is bypassed (below) |

Every path on both hosts is noindex (`X-Robots-Tag: noindex`).

### What is published

| Host | Path | From |
|---|---|---|
| landing | `/`, `/assets/*` | `site/index.html`, `site/assets/*` (images only) |
| landing | `/terms`, `/refund`, `/cookies`, `/legal-notice`, `/accessibility`, `/data-deletion` | `legal/<name>.html`: static, no script; "This page is being prepared", the contact, a link to `/privacy` |
| landing, app | `/privacy` | `privacy.html` (no script) |
| landing, app | `/version.json` | generated: `{ "sha", "builtAt" }` of the release commit, for the version check |
| app | `/` | a 302 to `/board/` (the app host has no index page) |
| app | `/board/` | `TasksDashboard.html`; the deploy makes the config's address absolute (`/config/tasksdashboard.config.js`); the source keeps it relative so `file://` works |
| app | `/app/` | `app/*` (the phone app; manifest `id` and `scope` stay `/app/`) |
| app | `/harness/` | `harness/*`: the Eisenhower Harness page (HomeOS #45). `index.html`, `harness.css`, `harness.js`, `harness-data.js` are byte-equal copies of HomeOS `HomeOS-TasksBoardHarness/viewer/` (its `tools/copy-viewer-to-app.js`); `harness-remote.js` is the only app file: it reads `db/031` with the board's session (`td.auth`) and queues button presses for the PC that owns the run. Shipped only when the release has `harness/index.html` |
| app | `/signin` | `signin.html`: Google only; a household login or an approved request goes on to `/board/`, or to `next` when it is `/app/`; everyone else stays on the request screens ([access-requests.md](access-requests.md)) |
| app | `/request` | a 301 to `/signin`, so links in sent emails keep working |
| app | `/config/tasksdashboard.config.js` | the config: public values only (`supabaseUrl`, `publishableKey`, `pollMs`) |
| both | `_headers`, `_redirects` | generated; not served themselves |

Nothing else: never `db/`, `cli/`, `test/`, `docs/`, `telegram-integration/` or the Markdown files (`site/THIRD-PARTY-NOTICES.md` included). Only commits of `release_maxden` are deployed ([testing-and-release.md](testing-and-release.md)).

### Origins and storage: first-party only on the app host

The board, the phone app and every later `/<name>/` share the app origin, so they share `localStorage` (`td.auth` holds the Supabase session) and cookies. A per-path CSP does not separate storage. So only first-party code from this repository goes on the app host: a later web app of this repo gets its own folder `<name>/`, published at `/<name>/` with its own CSP row; a web app from anywhere else gets its own Pages project.

## The Access model: a gate on paths

**Household, since 2026-11-04: the gate on the app host is off.** Access answers before a page loads, so a new person on `/board/` or `/app/` saw the Access login and never reached `/signin` to ask for access. The bypass policy `TasksDashboard public paths (bypass)` is attached first to **Eisenhower gate**; take it off to gate these paths again. What guards the board now: RLS with the whitelist (`db/024`), the board's and the app's own refusal of a login that is not let in. The cost: the pages' code is public. The previews apps stay gated.

With the bypass off, the app host gates only the signed-in pages; the landing host has no gate except on its previews.

| Access app | Host and paths | Policies |
|---|---|---|
| **Eisenhower gate** | `<app>.pages.dev/board`, `/board/*`, `/app`, `/app/*` | the household's (Household emails, Family, the guests policy `TasksDashboard guests`, Service Auth for the checks' service token) |
| **Eisenhower previews (app)** | `*.<app>.pages.dev` | the same |
| **Eisenhower previews (landing)** | `*.<landing>.pages.dev` | the same |

- **Why paths, not the whole host.** An older layout gated the whole host and bypassed some paths. An exact-root bypass is not a documented Access path, so the gate now covers exactly the pages that need it, and everything else on the app host (`/signin`, `/privacy`, the config, `version.json`) is public by default.
- **Create or check:** `node cli/access.mjs setup --gate --host <app>.pages.dev --landing-host <landing>.pages.dev --env <file>` (dry run), then with `--apply`. It copies the production app's policies (`CF_ACCESS_PROD_APP_ID`) and adds the guests policy; apps found by name are reported `present`, and only missing paths or policies are added ([access-requests.md](access-requests.md), README "Access CLI").
- **Afterwards** point `CF_ACCESS_PROD_APP_ID` at the gate, so `access.mjs list` and `process` work on it.
- **The phone app has two gates:** Access first, then the app's own gate (`gate()`), which shows the request screens to a login that is not let in.
- **Lag after an approval.** A login approved in the database passes Access only after the next `access.mjs process --apply`, which copies approved emails into the guests policy. In the household a daily routine runs it; run it by hand to let someone in at once.
- **Two Google prompts:** one from Supabase on `/signin`, one from Access on `/board/` or `/app/`. Access remembers its login for the session length of its policies.

### What Access does and does not do

- It hides the pages, not the data: Supabase is reachable directly with the public key. RLS, the grants and the sign-up hook stay the real lock; never relax them because Access is in front.
- The Access session (cookies `CF_Authorization`, `CF_AppSession` on the app host) and the app session (Supabase tokens) are separate. When the Access cookie expires, the next page load asks again; an open tab keeps polling Supabase.
- Old deployments keep their own `<hash>.<project>.pages.dev` URLs, covered by the previews apps.
- **Kill switch:** in the gate and the previews apps, edit the policies so they include nobody. To close registrations instead, turn sign-ups off in Supabase. `file://` always remains.

## Setup, once (a person does these; values never go into the repo)

1. **Cloudflare account** (free). Turn on two-factor. Note the Account ID (Workers & Pages shows it).
2. **Two Pages projects, Direct Upload:** Workers & Pages → Create → Pages → Upload assets; names `<landing>` and `<app>`; production branch `main`; upload a placeholder folder with one `index.html` each. Direct Upload can never switch to Git integration later; that is fine, the deploy uploads a folder. A taken name gets random characters appended, so check that both names are free first.
3. **Zero Trust on the Free plan:** pick a team name; Integrations → Identity providers → add Google (and One-time PIN, if wanted).
4. **Service token for automated checks:** Access → Service auth → Service Tokens → Create; it goes into a Service Auth policy. Checks send its two headers **only** to the app origin, never to Supabase.
5. **API tokens:** one for deploys (Account → Cloudflare Pages → Edit) and one for `cli/access.mjs` (Account → Access: Apps and Policies → Edit), each scoped to this account.
6. **Access apps:** `cli/access.mjs setup --gate` as above, or by hand: Zero Trust → Access → Applications → Add → Self-hosted; for the gate the domain `<app>.pages.dev` with the paths `board`, `board/*`, `app`, `app/*`; for each previews app the domain `*.<project>.pages.dev`; the same policies on each.
7. **Secrets** go only into the deploying machine's env file, by name: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCESS_TOKEN`, `TASKSDB_PAGES_PROJECT` (the app project), `TASKSDB_SITE_PROJECT` (the landing project), `TASKSDB_PAGES_BRANCH` (usually `main`), `CF_ACCESS_PROD_APP_ID` (the gate), `CF_ACCESS_GUEST_POLICY_ID`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.
8. **Supabase:** Authentication → URL Configuration: Site URL `https://<app>.pages.dev`; Redirect URLs, exact: `https://<app>.pages.dev/signin`, `https://<app>.pages.dev/board/`, `https://<app>.pages.dev/app/` (plus `http://localhost:<port>/**` for local tests). `signin.html` returns to exactly `<origin>/signin`, with no query, so the exact entry matches ([auth.md](auth.md)).
9. **Google Cloud** (the OAuth client): Authorized JavaScript origins `https://<app>.pages.dev`. On the consent screen, the home page `https://<landing>.pages.dev/` and the privacy policy `https://<landing>.pages.dev/privacy`, both public; authorized domains: both hosts.
10. **Check** in a private window: `https://<app>.pages.dev/board/` shows the Cloudflare Access page (with the bypass policy attached: goes to `/signin`); `/signin` and `/privacy` open; the landing `/` opens.

**Household:** projects `eisenhower-agentic-planner` (landing) and `eisenhower-agentic-planner-app` (app), set up on 2026-10-30 and deployed from Maksym's PC, the only machine with the tokens. The older single host `homeos-tasksboard.pages.dev` (board at `/`, whole host behind Access, bypass apps for `/request` and `/app/*`) redirects to the app host.

## Headers and CSP

`_headers` gives each path its own policy (`! Content-Security-Policy` first wherever a path would otherwise also match `/*`, because Pages joins two matching values with a comma and both would apply). Common to every path on both hosts:

- `Referrer-Policy: no-referrer` (keeps the Google `?code=` out of any request), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` with every device off, `Strict-Transport-Security`, `X-Robots-Tag: noindex`.
- In every CSP: `default-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `object-src 'none'`, `img-src 'self' data:`, `style-src 'unsafe-inline'` (the timeline writes `style` attributes; the app adds `'self'`).

| Host | Path | `script-src` | `connect-src` |
|---|---|---|---|
| landing | `/` | `'sha256-…'` of each inline script of `site/index.html` (no `'self'`: the site loads no script file) | the Supabase URL, for `rpc/request_plan_interest` only (`db/026`); `'none'` for a release whose page does not name it |
| landing | legal pages, `/privacy` | `'none'` | `'none'` |
| app | `/board`, `/board/`, `/board/*` | `'self'` (the config) plus the board's inline scripts | the Supabase URL |
| app | `/app/`, `/app/*` | `'self'` plus the app's inline scripts; also `manifest-src 'self'`, `worker-src 'self'` | `'self'` and the Supabase URL |
| app | `/signin` | `'self'` (the config) plus its one inline script | the Supabase URL |
| app | `/harness/`, `/harness/*` | `'self'` only (the page has no inline script; `deploy-pages.js` refuses one); `style-src 'self' 'unsafe-inline'`; no-cache | the Supabase URL |
| app | everything else (`/*`) | `'none'` (a strict default) | `'none'` |

- `Access-Control-Allow-Origin` is removed (`! Access-Control-Allow-Origin`) on `/board*` and `/app/*`.
- `Cache-Control: no-cache` for `/`, `/board/`, `/board/index.html`, `/signin`, the config, `version.json` and the phone app's paths.
- `script-src` lists the sha256 of the body of each inline `<script>` (line endings LF), so a new inline script, an external script or a new network host needs the template changed in the same commit ([deployment/2-deploy.md](deployment/2-deploy.md) holds it). `connect-src` is only the Supabase origin on the app host and the landing `/`, so a stolen token cannot be sent anywhere else from the page.
- Turn off any Cloudflare feature that injects scripts (Web Analytics auto-inject, Rocket Loader, email obfuscation): the CSP blocks them and the pages break.

## Storage per origin

Each hosted origin has its own browser storage. The app origin holds the board's and the phone app's keys (`td.auth`, `td.accounts`, `td.pkce`, `td.theme`, `td.rail`; `td.app.*`, IndexedDB `td-app`, the cache `td-app-<sha>`; `signin.html`'s `td.request.*` and `td.signin.next` in `sessionStorage`) and the Access cookies. The landing origin holds only the demo's `ec.demo.v5`. The full list: [privacy-inputs.md](privacy-inputs.md).

## Switch the landing page off

Deploy the landing project with a placeholder (one static `index.html` and the same `_headers`), or delete the landing project's custom domain later. The app host is not affected: `/signin`, the board and the app keep working. The Google consent screen links to the landing host's `/` and `/privacy`, so keep `/privacy` there or change the consent screen first.

## A custom domain later

No path moves. With a domain bought by a person (a purchase, never part of a run):

1. Add `<landing-name>.<domain>` to the landing project and `<app-name>.<domain>` to the app project (one level each: Universal SSL covers one level), **before** any Access app exists on those hostnames.
2. Add the gate paths for the app hostname to **Eisenhower gate**, its Supabase Redirect URLs and its Google JavaScript origin.
3. Keep the pages.dev hosts live beside them; with a domain of its own, `Strict-Transport-Security` can add `includeSubDomains; preload`.

## Verified free-plan facts

Read in the Cloudflare and Supabase docs on 2026-10-27 and 2026-10-29 (re-check before relying on them):

| Fact | Source |
|---|---|
| Pages free plan: 500 builds a month, 1 build at a time, 20,000 files per site, 25 MiB per file, 100 projects per account; `_headers` up to 100 rules, 2,000 characters per line | developers.cloudflare.com/pages/platform/limits/ |
| "On both free and paid plans, requests to static assets are free and unlimited." (bandwidth not mentioned: unverified) | developers.cloudflare.com/pages/functions/pricing/ |
| Direct Upload cannot switch to Git integration later; `wrangler pages deploy <dir>` goes to production, `--branch=<other>` makes a preview; inside a Git workspace Wrangler picks the branch up by itself, so always pass `--branch <production branch>` | developers.cloudflare.com/pages/get-started/direct-upload/ |
| No Wrangler rollback command; the dashboard can roll back to an earlier production deployment (for Direct Upload: unverified), so the script redeploys an older commit instead | developers.cloudflare.com/pages/configuration/rollbacks/ |
| Enable access policy protects previews only; a production hostname needs its own Access app | developers.cloudflare.com/pages/platform/known-issues/ |
| Universal SSL covers one subdomain level only | developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/ |
| Zero Trust Free: $0, 50 users | cloudflare.com/plans/ |
| Supabase Redirect URLs are the allow list for `redirect_to` (OAuth); the password grant needs none | supabase.com/docs/guides/auth/redirect-urls |
| A free Supabase project pauses after a week without requests (restore it in the dashboard; a keep-alive job prevents it) | root README, Open and sign in (not re-read in the Supabase docs) |
