# Access requests

How a person who is not let into a hosted copy asks for access, and how an owner lets them in. Details of each piece are in `README.md` (Set up `db/015`, Open and sign in "Access request page", Access CLI, Hosting, Limits); this page is the overview.

## Flow

| # | Who | What happens |
|---|---|---|
| 1 | stranger | opens `<host>/request` (`request.html`), which the host serves without its access gate |
| 2 | stranger | Continue with Google (the app's PKCE flow, `redirect_to` = `<origin>/request`); the sign-up hook decides whether a new login may exist, as for the board |
| 3 | page | `rpc/my_access_request`; when there is no request (or the last one is `removed`) `rpc/request_access`, then `my_access_request` again. It shows "Your request is sent" with the request time |
| 4 | database | `request_access()` adds a row to `users_pending_for_decision` and a task `Access request: <email>` in the household list `access-requests` ("Access requests"), created as the agent login, due at the next 09:00 in the owners' time zone, `details.notify` = the owners, so a daily digest that lists tasks due today shows it |
| 5 | owner | writes `Approved` or `Declined` as the **first word** of the task's description (any case; anything else = not decided yet) |
| 6 | owner or a job | `node cli/access.mjs process --apply`: approved emails go into the access policy, then `access_request_decided` and the task is set done with a closing line |
| 7 | stranger | reloads `/request`: "You're in" with a link to `/`, or "Request declined" |

The page loads no board data. A signed-in stranger already has a login and their own "My tasks" (as any guest), so the gate in front of the board is the host's access policy, not the database.

## Database (`db/015_access_requests.sql`)

| Object | Purpose |
|---|---|
| `users_pending_for_decision` | one row per request: `user_id`, `email`, `first_name`, `last_name`, `requested_at`, `status` (`pending`, `approved`, `declined`, `removed`), `decided_at`, `applied_at`, `item_id`. RLS on, no API grants: read only through the functions below |
| `request_access()` | no parameters; uses the caller's verified Google email and name. One open request per person; caps in `ops.settings` (`access_requests_per_day` 20, `access_requests_open` 30) → `54000`; a household member → `22023` |
| `my_access_request()` | the caller's latest request or `null` |
| `access_requests(p_status)` | every request, for members of `access-requests` |
| `access_request_decided(p_id, p_status)` | the agent records what it applied (pending → approved or declined, declined → approved, approved → removed) |
| `db/903_selftest_access.sql` | the selftest: `SELFTEST 47 of 47 passed (rolled back)` |

## The CLI (`cli/access.mjs`)

Dry run unless `--apply`. Env names only (values never printed): `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ACCESS_TOKEN`, `CF_ACCESS_PROD_APP_ID`, `CF_ACCESS_GUEST_POLICY_ID`; `process` and `remove` also the agent login (`TASKSDB_URL`, `TASKSDB_ANON_KEY`, `TASKSDB_AGENT_EMAIL`, `TASKSDB_AGENT_PASSWORD`).

| Command | Use |
|---|---|
| `setup` | once: creates the guests policy, the bypass policy, the request app and the phone app, attaches the guests policy to the production app (every existing policy kept; exit 3 if one would be lost), prints `CF_ACCESS_GUEST_POLICY_ID` |
| `list` | emails on the guests policy, seats, the production app's policies |
| `add --email A` / `remove --email A` | by hand; `remove` also marks an approved request `removed`, so the person may ask again |
| `process` | applies the decisions written in the tasks |

## Cloudflare setup (once)

1. Cloudflare dashboard → My Profile → API Tokens → Create Custom Token: Account → **Access: Apps and Policies → Edit**, this account only. Put it in the env file as `CLOUDFLARE_ACCESS_TOKEN`, with `CLOUDFLARE_ACCOUNT_ID` and `CF_ACCESS_PROD_APP_ID` (Zero Trust → Access → Applications → the app guarding the site → its id).
2. `node cli/access.mjs setup --env <file>`: read the before/after policy list.
3. `node cli/access.mjs setup --env <file> --apply`; add the printed `CF_ACCESS_GUEST_POLICY_ID` to the env file.
4. Check without a token: `<host>/request` and `<host>/config/tasksdashboard.config.js` answer `200`; `<host>/` still redirects to `*.cloudflareaccess.com`.

What `setup` creates: the reusable policy **TasksDashboard guests** (allow, emails, session 730 h; it holds the placeholder `no-guests-yet@example.invalid` until the first guest, because a reusable policy needs one rule), the policy **TasksDashboard request (bypass)** (bypass, everyone) the self-hosted app **TasksDashboard request** on `/request` and `/config/tasksdashboard.config.js`, and the self-hosted app **TasksDashboard phone app** on `/app` and `/app/*` (the phone app, which gates itself; [hosting.md](hosting.md) "The phone app on the same project"), both on the bypass policy. The more specific path wins over the production app, so only those paths are public. Run `setup` again on an older installation to add the phone app: it creates only what is missing. The config holds only public values (project URL, publishable key, poll interval). `privacy.html` is not on the bypass app; add its path there if a Google consent screen must link to it publicly.

## Seats

Zero Trust's free plan counts 50 users, the owners included. `add` and `process` warn from 45 emails on the guests policy and refuse to reach 50 unless `--force`. Free a seat: `cli/access.mjs remove --email A --apply`, then Zero Trust → Users → Remove.

## Switch off

- Stop new requests: delete the app **TasksDashboard request** in Zero Trust (the page is gated again), or set `access_requests_open` to 0 in `ops.settings`.
- Take a guest out: `cli/access.mjs remove --email A --apply`.
- Take every guest out: detach **TasksDashboard guests** from the production app.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `/request` shows the Access login | `setup --apply` not run, or the request app was deleted |
| `/app/` shows the Access login | `setup --apply` not run since the phone app was added, or the phone app was deleted |
| "Try again later" | a cap (`54000`) or the sign-up hook's limit; raise the caps in `ops.settings` or decide open requests |
| an approved person still sees the Access login | `process --apply` not run yet, or their Google email differs from the one Access receives (they must use the same account) |
| `access.mjs` exit 2 | the env names it prints are missing |
| `access.mjs` exit 3 | the production app would lose a policy: nothing was changed; check it in Zero Trust |
