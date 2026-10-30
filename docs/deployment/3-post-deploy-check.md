# 3. Post-deployment check

Right after every deploy or rollback. Any failed check: roll back to the previous sha ([step 2](2-deploy.md), Rollback), run this check again on it, and report both.

| # | Check | How | Pass |
|---|---|---|---|
| 1 | Version | `deploy-pages.js --status` (or `GET /version.json` with the service token) | exit 0; the sha is the one just deployed |
| 2 | Gate | **without** the service token: app host `/board`, `/board/`, `/board/index.html`, `/app`, `/app/` and one deployment's `https://<hash>.<project>.pages.dev/` per host | a redirect to `*.cloudflareaccess.com`, never `200` with a page. Public: app host `/signin` 200, `/request` 301 to `/signin`, `/` 302 to `/board/`, `/privacy`, the config and `/version.json` 200; landing `/`, the six legal pages and `/privacy` 200 |
| 3 | Headers | `curl -sI` on every published path (the gated ones **with** the service token) | each path has exactly one CSP, its own, hashes equal the dry run's; landing `connect-src 'none'`; `X-Robots-Tag: noindex` everywhere; `Cache-Control: no-cache` where listed; no `Access-Control-Allow-Origin` on `/board*` and `/app/*` |
| 4 | Nothing extra served | with the service token: `/config/profiles.js`, `/config/maksym.prefs.json`, `/db/001_schema.sql`, `/cli/tasks.mjs`, `/test/e2e.mjs`, `/README.md`, `/docs/deployment/README.md` | none returns that file (404 or the index page) |
| 5 | Pages in a browser | Playwright (headless), the service-token headers added only to requests for the app origin, at 1440×900 and 390×844: landing `/` and a legal page; app host `/board/`, `/app/`, `/signin` | no CSP violation and no error in the console; landing: only its own host; app host: only itself and the Supabase URL |
| 6 | Signed in, live data | `node test/e2e.mjs --url https://<app>.pages.dev/board/ --access-env <env> --env <env> --out <dir> --smoke` | smoke passes: signed in, chip counts equal the database, only the two hosts contacted |
| 7 | Local copy | `node test/e2e.mjs --env <env> --out <dir> --smoke` on the mounted `TasksDashboard.html` | still passes from `file://` |

## Notes

- Never type a real password into the hosted page. Signed-in checks use sessions made over REST and seeded into the page's storage (`test/e2e.mjs`), as for `file://`.
- Never send the service-token headers to Supabase: they are not in its CORS allow-list and must not leave for another host.
- Check 2 failing means Access does not cover the address: report it at once. The page is public until a person fixes the Access application.
- Status checks 5-6 now use `e2e.mjs --url`: check 6 as in the table, and for check 5 `--group ui` (screenshots at 1440×900 and 390×844, console errors including CSP violations, the two hosts) next to Playwright. `--access-env` adds the service-token headers to the app origin only.

## Report

One block to the person:
- the version change (`<old short sha> → <new short sha>`) and the commits that changed the page;
- the deployment URL;
- checks 1-7 pass or fail, with the output of any failure;
- whether a rollback ran.
