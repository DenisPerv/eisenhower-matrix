# 2. Deploy

Build the upload for one host from `origin/release_maxden` and send it to Cloudflare Pages. Only after [step 1](1-version-check.md), and only on the person's request. Two hosts ([../hosting.md](../hosting.md)): the **landing** project (`TASKSDB_SITE_PROJECT`) and the **app** project (`TASKSDB_PAGES_PROJECT`, the default). Deploy the landing host first, then the app host.

## With the HomeOS script (the household)

```
node scripts/tasksdb/deploy-pages.js --project <name> --dry-run     # build only: LocalOutputs/<ts>/pages-dist/
node scripts/tasksdb/deploy-pages.js --project <name>               # build and deploy origin/release_maxden
node scripts/tasksdb/deploy-pages.js --project <name> --ref <sha>   # build and deploy an older release_maxden commit (rollback)
node scripts/tasksdb/deploy-pages.js --project <name> --status [--timeout <ms>]   # step 1 and 3: hosted version.json vs release_maxden
node scripts/tasksdb/deploy-pages.js --project <old> --redirect-to <origin> [--permanent]   # a redirect-only upload for a retired host
node scripts/tasksdb/deploy-pages.js --project <old> --layout legacy --ref <sha>            # rebuild the single-host layout (board at /)
```

Run from the HomeOS root on the machine with the tokens. `--project` picks the file set: the project named in `TASKSDB_SITE_PROJECT` gets the landing set, any other the app set. Look at the dry-run output first: the file list, `_headers` and `_redirects`.

- **`--ref`** takes a 7-40 character sha that must be an ancestor of `origin/release_maxden` (otherwise exit 3).
- **Before deploying** the script reads the project's production branch through the Cloudflare API (`GET /accounts/<id>/pages/projects/<project>`) and refuses with exit 4 when it differs from `TASKSDB_PAGES_BRANCH` (default `main`): the upload would land as a preview.
- **After deploying** it reads the latest production deployment through the API (`…/deployments?env=production&per_page=1`) and fails with exit 7 unless it carries the deployed sha. It then prints `deployed <short sha> to <url>` and the CSP hashes.

| Exit | Means |
|---|---|
| 0 | ok (`--status`: current, or "redirect" on a redirect-only host) |
| 2 | usage error, or an env name missing (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `TASKSDB_PAGES_PROJECT`) |
| 3 | build refused: config check failed, a script outside the allow-list, a script in a legal page or `privacy.html`, or `--ref` not on `release_maxden` |
| 4 | the production branch differs: the deploy would land as a preview |
| 5 | `wrangler pages deploy` failed (its last lines are printed) |
| 6 | unreachable (`--status`) |
| 7 | post-deploy check failed: the latest production deployment is not the sha |
| 10 | behind (`--status`) |

## What the script does (also the manual way)

1. **Read the files** without touching any checkout: `git -C <repo> show <ref>:<path>` for each file of the host's set (images read as binary).
2. **Build the folder** `pages-dist/`.

   **Landing set**

   | File | From |
   |---|---|
   | `index.html` | `site/index.html` as is; no external script |
   | `assets/*` | `site/assets/*`: jpg, png or webp only, each checked by its magic bytes |
   | `<name>.html` (served at `/<name>`) | `legal/*.html`; refused when one holds a script |
   | `privacy.html` (served at `/privacy`) | as is; it must hold no script |
   | `version.json` | `{ "sha": "<ref sha>", "builtAt": "<now>" }` |
   | `_headers` | generated, below |

   **App set**

   | File | From |
   |---|---|
   | `board/index.html` | `TasksDashboard.html`, the config's `src` made absolute (`/config/tasksdashboard.config.js`) |
   | `config/tasksdashboard.config.js` | as is |
   | `signin.html` (served at `/signin`) | as is; exactly one inline script, and no external script but the config |
   | `privacy.html` | as is; no script |
   | `app/index.html` | the phone app's page; its `td-core.js` and `td-data.js` script addresses get `?v=<short sha>`; external scripts only the config, `td-core.js` and `td-data.js` |
   | `app/td-core.js`, `app/td-data.js`, `app/manifest.webmanifest` | as is (all required with `app/index.html`); the manifest's `id`, `start_url` and `scope` must be `/app/` |
   | `app/sw.js` | the line `const VERSION = 'dev';` becomes `const VERSION = '<ref sha>';` (exactly one such line; no `importScripts`) |
   | `app/icons/*.png` | as is (binary; PNG only) |
   | `version.json` | as above |
   | `_headers`, `_redirects` | generated, below |

   Nothing else goes in. The config must set only `supabaseUrl`, `publishableKey` and `pollMs` (any other key: exit 3). A release from before the two-host layout still puts the board at `/board/`, so it stays under the gate.
3. **Generate `_redirects`** (app host):

   ```
   /request /signin 301
   / /board/ 302
   ```

4. **Generate `_headers`.** Each path gets its own CSP. The hashes are the sha256 of the body of each inline `<script>` (base64, `'sha256-…'`, line endings LF; `--dry-run` prints them per page). `connect-src` on the app host is the `supabaseUrl` from the config. The common lines (`COMMON` below) are one constant in the script:

   ```
   COMMON:
     Referrer-Policy: no-referrer
     X-Content-Type-Options: nosniff
     X-Frame-Options: DENY
     Cross-Origin-Opener-Policy: same-origin
     Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
     Strict-Transport-Security: max-age=31536000
     X-Robots-Tag: noindex
   ```

   Landing host:

   ```
   /*
     Content-Security-Policy: default-src 'none'; script-src 'sha256-<each inline script of site/index.html>'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
     COMMON
   /terms  (and /refund, /cookies, /legal-notice, /accessibility, /data-deletion, /privacy)
     ! Content-Security-Policy
     Content-Security-Policy: default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
   /
     Cache-Control: no-cache
   /version.json
     Cache-Control: no-cache
   ```

   App host:

   ```
   /*
     Content-Security-Policy: default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
     COMMON
   /board  (and /board/, /board/*)
     ! Content-Security-Policy
     ! Access-Control-Allow-Origin
     Content-Security-Policy: default-src 'none'; script-src 'self' 'sha256-<each inline script of TasksDashboard.html>'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src <supabaseUrl>; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
   /app/  (and /app/*)
     ! Content-Security-Policy
     ! Access-Control-Allow-Origin
     Content-Security-Policy: default-src 'none'; script-src 'self' 'sha256-<each inline script of app/index.html>'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' <supabaseUrl>; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
   /signin
     ! Content-Security-Policy
     Content-Security-Policy: default-src 'none'; script-src 'self' 'sha256-<the inline script of signin.html>'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src <supabaseUrl>; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
   /privacy
     ! Content-Security-Policy
     Content-Security-Policy: <the strict policy of /*>
   no-cache: /, /board/, /board/index.html, /signin, /config/*, /version.json, /app/, /app/index.html, /app/sw.js, /app/manifest.webmanifest
   ```

   - `! Content-Security-Policy` detaches the `/*` policy first: Pages joins two matching values of one header with a comma, and two policies would both apply. Each public path ends with exactly one CSP.
   - `! Access-Control-Allow-Origin`: Pages sends `*` by default; the board and the app do not need it.
   - At most 100 rules per host (the Pages limit).
   - `style-src 'unsafe-inline'`: the timeline writes `style` attributes. `img-src data:`: the favicons and backgrounds are `data:` SVGs.
   - `manifest-src 'self'` and `worker-src 'self'`: the phone app's manifest and `sw.js`; its `connect-src 'self'`: the worker's cache refills and `/version.json`. No `Service-Worker-Allowed`: the worker's scope is its own folder, `/app/`.
   - A new inline script, an external script or a new network host in `TasksDashboard.html`, `signin.html`, `app/index.html` or `site/index.html` needs this template changed first.
   - `privacy.html` and `legal/*.html` stay script-free.
5. **Deploy:**

   ```
   npx --yes wrangler@4.150.0 pages deploy pages-dist --project-name <project> --branch <production branch> --commit-hash <sha> --commit-message "release_maxden <short sha>" --commit-dirty=false
   ```

   - `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set in the child process only (with `WRANGLER_SEND_METRICS=false`).
   - First check the production branch (Cloudflare API, above); afterwards check that the latest production deployment carries the sha.
   - Always pass `--branch` with the project's production branch (`TASKSDB_PAGES_BRANCH`). Without it, Wrangler takes the branch of the folder it runs in, and the upload lands as a preview.
6. **Note** the deployment URL Wrangler prints (`https://<hash>.<project>.pages.dev`) for the report. Then go to [step 3](3-post-deploy-check.md).

## A retired host (`--redirect-to`)

A redirect-only upload for the old single host: `/` and `/index.html` go to `<origin>/board/`, `/app/*` to `<origin>/app/:splat`, any other path to the same path on `<origin>`. Two files are kept out of every rule: `/app/sw.js` (a service worker that unregisters itself and deletes its caches, served `no-cache`, because a worker script fetch does not follow redirects) and `/version.json` (`{ "redirect": "<origin>" }`, so `--status` reports "redirect"). 302 first; `--permanent` makes them 301 once nobody needs a rollback (browsers keep a 301).

## Rollback

- **Script:** `deploy-pages.js --project <name> --ref <older sha>` uploads that commit's files as a new production deployment. Use the sha the hosted copy had before (step 1 noted it). For the retired host, `--layout legacy --ref <sha>` rebuilds the old single-host layout (board at `/`).
- **Dashboard** (a person, or when the script can't run): Workers & Pages → the project → Deployments → `…` on an earlier production deployment → Rollback to this deployment.
- **Kill switch** (a person): in Zero Trust → Access → Applications, edit the gate and the previews apps so that the policy includes nobody. The board and the app are then unreachable; `file://` still works.
- Never delete a project or deployments without the person's yes in chat.

## Never

- Deploy from a working tree, from `development_maxden` or with local changes.
- Upload anything outside the tables above.
- Print, log or commit a token, the service-token secret or `version.json` contents other than the sha.
- Turn on Cloudflare features that inject scripts (Web Analytics auto-inject, Rocket Loader, email obfuscation): the CSP blocks them and the pages break.
