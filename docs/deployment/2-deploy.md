# 2. Deploy

Build the upload from `origin/release_maxden` and send it to Cloudflare Pages. Only after [step 1](1-version-check.md), and only on the person's request.

## With the HomeOS script (the household)

```
node scripts/tasksdb/deploy-pages.js --dry-run     # build only: LocalOutputs/<ts>/pages-dist/
node scripts/tasksdb/deploy-pages.js               # build and deploy origin/release_maxden
node scripts/tasksdb/deploy-pages.js --ref <sha>   # build and deploy an older release_maxden commit (rollback)
node scripts/tasksdb/deploy-pages.js --status [--timeout <ms>]   # step 1 and 3: hosted version.json vs release_maxden
```

Run from the HomeOS root on the machine with the tokens. Look at the dry-run output first: the file list and `_headers`.

- **`--ref`** takes a 7-40 character sha that must be an ancestor of `origin/release_maxden` (otherwise exit 3).
- **Before deploying** the script reads the project's production branch through the Cloudflare API (`GET /accounts/<id>/pages/projects/<project>`) and refuses with exit 4 when it differs from `TASKSDB_PAGES_BRANCH` (default `main`): the upload would land as a preview.
- **After deploying** it reads the latest production deployment through the API (`…/deployments?env=production&per_page=1`) and fails with exit 7 unless it carries the deployed sha. It then prints `deployed <short sha> to <url>` and the CSP hashes.

| Exit | Means |
|---|---|
| 0 | ok (`--status`: current) |
| 2 | usage error, or an env name missing (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `TASKSDB_PAGES_PROJECT`) |
| 3 | build refused: config check failed, a script outside the allow-list, or `--ref` not on `release_maxden` |
| 4 | the production branch differs: the deploy would land as a preview |
| 5 | `wrangler pages deploy` failed (its last lines are printed) |
| 6 | unreachable (`--status`) |
| 7 | post-deploy check failed: the latest production deployment is not the sha |
| 10 | behind (`--status`) |

## What the script does (also the manual way)

1. **Read the files** without touching any checkout: `git -C <repo> show <ref>:TasksDashboard.html`, `git -C <repo> show <ref>:config/tasksdashboard.config.js`, and `privacy.html` and `request.html` when the ref has them; the phone app's files under `app/` when the ref has `app/index.html` (icons read as binary).
2. **Build the folder** `pages-dist/`:

   | File | From |
   |---|---|
   | `index.html` | `TasksDashboard.html` as is |
   | `config/tasksdashboard.config.js` | as is |
   | `privacy.html` | as is, when the release has it; it must hold no script |
   | `request.html` | as is, when the release has it (Pages serves it at `/request`); exactly one inline script, and no external script but the config |
   | `_headers` | generated, below |
   | `version.json` | `{ "sha": "<ref sha>", "builtAt": "<now>" }` |
   | `app/index.html` | the phone app's page, when the release has it (Pages serves it at `/app/`); its `td-core.js` and `td-data.js` script addresses get `?v=<short sha>`; external scripts only the config, `td-core.js` and `td-data.js` |
   | `app/td-core.js`, `app/td-data.js`, `app/manifest.webmanifest` | as is, with `app/index.html` (all required then); the manifest's `id`, `start_url` and `scope` must be `/app/` |
   | `app/sw.js` | the line `const VERSION = 'dev';` becomes `const VERSION = '<ref sha>';` (exactly one such line; no `importScripts`) |
   | `app/icons/*.png` | as is (binary; PNG only) |

   A release without `app/index.html` (every release before the phone app) ships no `app/` file and no `/app` header rule. Nothing else goes in. The config must set only `supabaseUrl`, `publishableKey` and `pollMs` (any other key: exit 3).
3. **Generate `_headers`.** One CSP for every path but `/app/`: it lists the sha256 of the body of each inline `<script>` of `TasksDashboard.html` and of `request.html` (base64, `'sha256-…'`; `--dry-run` prints them per page), and `connect-src` is the `supabaseUrl` from the config:

   ```
   /*
     Content-Security-Policy: default-src 'none'; script-src 'self' 'sha256-<each inline script of index.html>' 'sha256-<the inline script of request.html>'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src <supabaseUrl>; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
     Referrer-Policy: no-referrer
     X-Content-Type-Options: nosniff
     X-Frame-Options: DENY
     Cross-Origin-Opener-Policy: same-origin
     Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
     Strict-Transport-Security: max-age=31536000
     X-Robots-Tag: noindex
   /
     Cache-Control: no-cache
   /index.html
     Cache-Control: no-cache
   /request
     Cache-Control: no-cache
   /request.html
     Cache-Control: no-cache
   /config/*
     Cache-Control: no-cache
   /version.json
     Cache-Control: no-cache
   ```

   With the phone app, an `/app/*` rule follows the `/*` rule, `/app/` repeats it, and the app's paths are no-cache. `! Content-Security-Policy` detaches the `/*` policy first: Pages joins two matching values of one header with a comma, and two policies would both apply. The `/*` rule and the paths outside `/app/` keep exactly the policy above.

   ```
   /app/*
     ! Content-Security-Policy
     Content-Security-Policy: default-src 'none'; script-src 'self' 'sha256-<each inline script of app/index.html>'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' <supabaseUrl>; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
   /app/
     ! Content-Security-Policy
     Content-Security-Policy: <the same app policy>
     Cache-Control: no-cache
   /app/index.html
     Cache-Control: no-cache
   /app/sw.js
     Cache-Control: no-cache
   /app/manifest.webmanifest
     Cache-Control: no-cache
   ```

   - `manifest-src 'self'` and `worker-src 'self'`: the manifest and `sw.js`; `connect-src 'self'`: the worker's cache refills and `/version.json`.
   - No `Service-Worker-Allowed`: the worker's scope is its own folder, `/app/`.
   - After the first deploy with the app, check the response headers of `/app/` (one CSP, the app's) and of `/` (unchanged).

   - `style-src 'unsafe-inline'`: the timeline writes `style` attributes.
   - `img-src data:`: the favicon and the background are `data:` SVGs.
   - A new inline script, an external script or a new network host in `TasksDashboard.html`, `request.html` or `app/index.html` needs this template changed first.
   - `privacy.html` stays script-free: its CSP is the same policy, and it needs no hash.
4. **Deploy:**

   ```
   npx --yes wrangler@4.150.0 pages deploy pages-dist --project-name <project> --branch <production branch> --commit-hash <sha> --commit-message "release_maxden <short sha>" --commit-dirty=false
   ```

   - `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set in the child process only (with `WRANGLER_SEND_METRICS=false`).
   - First check the production branch (Cloudflare API, above); afterwards check that the latest production deployment carries the sha.
   - Always pass `--branch` with the project's production branch (`TASKSDB_PAGES_BRANCH`). Without it, Wrangler takes the branch of the folder it runs in, and the upload lands as a preview.
5. **Note** the deployment URL Wrangler prints (`https://<hash>.<project>.pages.dev`) for the report. Then go to [step 3](3-post-deploy-check.md).

## Rollback

- **Script:** `deploy-pages.js --ref <older sha>` uploads that commit's files as a new production deployment. Use the sha the hosted copy had before (step 1 noted it).
- **Dashboard** (a person, or when the script can't run): Workers & Pages → the project → Deployments → `…` on an earlier production deployment → Rollback to this deployment. Whether Direct Upload projects offer this is checked when hosting is set up; see the HomeOS hosting plan.
- **Kill switch** (a person): in Zero Trust → Access → Applications, edit both of the project's applications so that the policy includes nobody. The page is then unreachable; `file://` still works.
- Never delete the project or deployments without the person's yes in chat.

## Never

- Deploy from a working tree, from `development_maxden` or with local changes.
- Upload anything outside the table above.
- Print, log or commit a token, the service-token secret or `version.json` contents other than the sha.
- Turn on Cloudflare features that inject scripts (Web Analytics auto-inject, Rocket Loader, email obfuscation): the CSP blocks them and the page breaks.
