# TasksDashboard documentation

TasksDashboard is an Eisenhower matrix task app: one HTML file (`TasksDashboard.html`) on a Supabase database (TasksDashboardDB). This folder explains how the project is built, set up, hosted, tested and released, so someone else can run their own copy. The root `README.md` stays the technical reference (every table of keys, defaults, checks and limits, updated with every change); these pages give the overview and point into it.

| Page | Read it for |
|---|---|
| [architecture.md](architecture.md) | the pieces (page, core, UI, CLI, database, host) and how data flows between them |
| [database.md](database.md) | the SQL files and their apply order, the RLS model, the functions (RPCs), limits, how to change the schema |
| [auth.md](auth.md) | password and Google sign-in, sessions and storage, the sign-up hook and allowlist, closing registrations |
| [hosting.md](hosting.md) | serving the page on Cloudflare Pages behind Cloudflare Access: setup steps, headers and CSP, Supabase redirect URLs, verified free-plan facts |
| [testing-and-release.md](testing-and-release.md) | unit tests, the end-to-end runner, the selftests, branches and the release flow |
| [api/README.md](api/README.md) and [api/openapi.yaml](api/openapi.yaml) | the read API: the weekly review report (`rpc/review_report`), tokens, curl examples, errors |
| [deployment/](deployment/README.md) | the step-by-step runbook for a deploy or a rollback (version check, deploy, post-deploy check) |
| [access-requests.md](access-requests.md) | (access track) how a stranger asks for access on `/request` and how an owner lets them in |

Conventions in these pages:

- Values in angle brackets (`<project-ref>`, `<publishable key>`) are placeholders. The repository never holds a secret, a token, an account id, an email address or a project ref.
- Lines marked **Household:** describe the one household this repo was built for (two people, two agent logins, one hosted copy); another household replaces those values.
- Code names (`reviewEntries`, `db/016`) point to where the rule lives; when a page and the code disagree, the code wins and the page is fixed.
