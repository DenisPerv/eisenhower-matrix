# 3. Post-deployment check

Right after every deploy or rollback. Any failed check: roll back to the previous sha ([step 2](2-deploy.md), Rollback), run this check again on it, and report both.

| # | Check | How | Pass |
|---|---|---|---|
| 1 | Version | `deploy-pages.js --status` (or `GET /version.json` with the service token) | exit 0; the sha is the one just deployed |
| 2 | Gate | `curl -sI https://<project>.pages.dev/` and the deployment's `https://<hash>.<project>.pages.dev/`, **without** the service token | a redirect to `*.cloudflareaccess.com`, never `200` with the app |
| 3 | Headers | `curl -sI` on `/` **with** the service token | `200`; every header from the `_headers` template, the CSP hashes equal the ones the build computed, `Cache-Control: no-cache` |
| 4 | Nothing extra served | with the service token: `/config/profiles.js`, `/config/maksym.prefs.json`, `/db/001_schema.sql`, `/cli/tasks.mjs`, `/test/e2e.mjs`, `/README.md`, `/docs/deployment/README.md` | none returns that file (404 or the index page) |
| 5 | Page in a browser | Playwright (headless), the service-token headers added only to requests for the pages.dev origin, at 1440×900 and 390×844 | the sign-in form, or the board for a seeded session; no CSP violation and no error in the console; network goes only to the pages.dev origin and the Supabase URL |
| 6 | Signed in, live data | `node test/e2e.mjs --url https://<project>.pages.dev --access-env <env> --env <env> --out <dir> --smoke` | smoke passes: signed in, chip counts equal the database, only the two hosts contacted |
| 7 | Local copy | `node test/e2e.mjs --env <env> --out <dir> --smoke` on the mounted `TasksDashboard.html` | still passes from `file://` |

## Notes

- Never type a real password into the hosted page. Signed-in checks use sessions made over REST and seeded into the page's storage (`test/e2e.mjs`), as for `file://`.
- Never send the service-token headers to Supabase: they are not in its CORS allow-list and must not leave for another host.
- Check 2 failing means Access does not cover the address: report it at once. The page is public until a person fixes the Access application.
- Checks 5-6 need the `e2e.mjs --url` option from the hosting build run. Until it exists, check 5 with Playwright only, and say that check 6 was not run.

## Report

One block to the person:
- the version change (`<old short sha> → <new short sha>`) and the commits that changed the page;
- the deployment URL;
- checks 1-7 pass or fail, with the output of any failure;
- whether a rollback ran.
