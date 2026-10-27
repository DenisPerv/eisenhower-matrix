# 2. Deploy

Build the upload from `origin/release_maxden` and send it to Cloudflare Pages. Only after [step 1](1-version-check.md), and only on the person's request.

## With the HomeOS script (the household)

```
node scripts/tasksdb/deploy-pages.js --dry-run     # build only: LocalOutputs/<ts>/pages-dist/
node scripts/tasksdb/deploy-pages.js               # build and deploy origin/release_maxden
node scripts/tasksdb/deploy-pages.js --ref <sha>   # build and deploy an older release_maxden commit (rollback)
```

Run from the HomeOS root on the machine with the tokens. Look at the dry-run output first: the file list and `_headers`.

## What the script does (also the manual way)

1. **Read the files** without touching any checkout: `git -C <repo> show <ref>:TasksDashboard.html` and `git -C <repo> show <ref>:config/tasksdashboard.config.js`.
2. **Build the folder** `pages-dist/`:

   | File | From |
   |---|---|
   | `index.html` | `TasksDashboard.html` as is |
   | `config/tasksdashboard.config.js` | as is |
   | `_headers` | generated, below |
   | `version.json` | `{ "sha": "<ref sha>", "builtAt": "<now>" }` |

   Nothing else goes in.
3. **Generate `_headers`.** The CSP lists the sha256 of the body of each inline `<script>` (base64, `'sha256-…'`), and `connect-src` is the `supabaseUrl` from the config:

   ```
   /*
     Content-Security-Policy: default-src 'none'; script-src 'self' 'sha256-<each inline script>'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src <supabaseUrl>; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
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
   /config/*
     Cache-Control: no-cache
   /version.json
     Cache-Control: no-cache
   ```

   - `style-src 'unsafe-inline'`: the timeline writes `style` attributes.
   - `img-src data:`: the favicon and the background are `data:` SVGs.
   - A new inline script, an external script or a new network host in `TasksDashboard.html` needs this template changed first.
4. **Deploy:**

   ```
   npx --yes wrangler@<pinned version> pages deploy pages-dist --project-name <project> --branch <production branch> --commit-hash <sha> --commit-message "release_maxden <short sha>"
   ```

   - `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set in the child process only.
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
