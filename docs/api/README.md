# API: the weekly review and other reads

The database behind TasksDashboard is a Supabase project. Its REST API (PostgREST) and its Auth API are the API: there is no server of our own. This folder documents the read endpoints, above all the weekly review report (`rpc/review_report`, `db/016_review_report.sql`), so another tool can pull what the Review view shows.

- `openapi.yaml`: the OpenAPI 3.1 description (paths, parameters, answers, errors). Open it in any OpenAPI viewer (for example paste it into editor.swagger.io); the repo ships no viewer, because the app loads no libraries.
- This README: how to get a token and call each endpoint with curl.
- `test/api-doc.test.js` keeps both honest: every RPC in `openapi.yaml` must exist in `db/*.sql` with `grant execute … to authenticated`, and every path in it must be in the table below.

## Endpoints

| Path | Method | What |
|---|---|---|
| `/auth/v1/token` | POST | sign in with a password login (`grant_type=password`) or refresh a session (`grant_type=refresh_token`) |
| `/rest/v1/rpc/review_report` | POST | the weekly review for 1-26 ISO weeks: rows by quadrant, then list, kinds done / cancelled / overdue / due (`db/016`) |
| `/rest/v1/rpc/kpi_events` | POST | the KPI history of some lists: items and their KPI events, the raw data behind Visuals (`db/013`) |
| `/rest/v1/rpc/urgency_settings` | POST | a person's urgency window, due-soon threshold and Do limit (`db/014`) |
| `/rest/v1/rpc/list_people` | POST | who is on a list; pending invitations for its owner (`db/010`) |
| `/rest/v1/rpc/my_invitations` | POST | open invitations addressed to the caller (`db/012`) |
| `/rest/v1/lists` | GET | the lists the caller can read |
| `/rest/v1/items` | GET | the items of those lists, with PostgREST filters |
| `/rest/v1/item_links` | GET | links between tasks the caller can read on both ends: `depends_on` (from comes after to) and `parent` (from is a child of to) (`db/018`) |
| `/rest/v1/rpc/link_items` | POST | link two tasks, predecessor or parent; a parent link replaces the old parent (`db/018`) |
| `/rest/v1/rpc/unlink_items` | POST | remove a link (soft, `removed_at`) (`db/018`) |

Writes are not part of this API description: the app and the CLI (`cli/tasks.mjs`) write, with the rules in `docs/database.md`. The exception is task links: `link_items` and `unlink_items` are the only way to change them, so they are described here.

## Who can call it

Every request carries the project's **publishable key** (`apikey` header) and a signed-in login's **access token** (`Authorization: Bearer`). Row level security then decides what comes back, exactly as in the app: a person gets their own lists, lists shared with them and (household members) the household's lists; an agent login gets the lists it is a member of; a guest gets only what was shared with it. With the publishable key alone (no token) every call here answers 401: `anon` executes no function and reads no table.

- Use a **password login** for scripts (Supabase Auth → Users; after `db/012` a new password login needs an allowlist nonce, see the root README Set up).
- Google sign-in is browser-only (a PKCE redirect), so a Google-only login cannot get a token with curl.
- Never use the secret or service key: it bypasses row level security.

## Get a token

Set these in your shell (placeholders; never commit real values):

```bash
TD_URL='https://<project-ref>.supabase.co'
TD_KEY='<publishable key, sb_publishable_…>'
TD_EMAIL='<login email>'
TD_PASSWORD='<login password>'
```

Sign in and keep the access token (the examples read JSON with Node, which the repo needs anyway; `jq -r .access_token` works too):

```bash
SESSION=$(curl -s "$TD_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $TD_KEY" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TD_EMAIL\",\"password\":\"$TD_PASSWORD\"}")
TOKEN=$(printf '%s' "$SESSION" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).access_token")
REFRESH=$(printf '%s' "$SESSION" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).refresh_token")
```

The access token lives `expires_in` seconds (3600). Refresh it before then. Refresh tokens rotate: each answer carries a new one, and a used one is refused (`refresh_token_already_used`) once the project's short reuse interval (10 s by default) has passed, so always keep the new one:

```bash
SESSION=$(curl -s "$TD_URL/auth/v1/token?grant_type=refresh_token" \
  -H "apikey: $TD_KEY" -H "Content-Type: application/json" \
  -d "{\"refresh_token\":\"$REFRESH\"}")
```

## Calls

The weekly review for two weeks (all the lists the app shows you):

```bash
curl -s "$TD_URL/rest/v1/rpc/review_report" \
  -H "apikey: $TD_KEY" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"p_weeks":["2026-W43","2026-W44"]}'
```

Only some lists: add `"p_lists":["<list-uuid>","<list-uuid>"]` (at most 50). The answer:

```json
{
  "period": { "from": "2026-10-19T00:00:00+01:00", "to": "2026-11-02T00:00:00+00:00", "weeks": ["2026-W43", "2026-W44"], "tz": "Europe/Lisbon", "now": "…", "windowDays": 7 },
  "lists": [ { "id": "<uuid>", "name": "OtherTasks" } ],
  "groups": [
    { "q": "A", "name": "Do", "count": 1, "lists": [
      { "list_id": "<uuid>", "name": "OtherTasks", "rows": [
        { "id": "<uuid>", "num": 12, "title": "Renew the insurance", "kind": "overdue", "at": "2026-10-27T09:00:00+00:00",
          "due_at": "2026-10-27T09:00:00+00:00", "late": true, "status": "open", "tags": [ { "id": "<uuid>", "name": "home" } ] } ] } ] },
    { "q": "B", "name": "Plan", "count": 0, "lists": [] },
    { "q": "C", "name": "Delegate", "count": 0, "lists": [] },
    { "q": "D", "name": "Eliminate", "count": 0, "lists": [] }
  ]
}
```

How a row is chosen (the same rule as the Review view, core `reviewEntries` and `reviewGroups` in `TasksDashboard.html`):

| Field | Meaning |
|---|---|
| `kind` | `done` or `cancelled` when the task was closed in a picked week (a cancelled task by its latest cancel event in `item_events`, else its last change); else `overdue` (still open, end passed) or `due` when its end is in a picked week |
| `at` | the time the row is listed by: the close time for done and cancelled, else `due_at` |
| `late` | the end is before the close, or before now while the task is open |
| `q` | the stored quadrant, else derived: important = priority 3+ or category reminder, tbd or decision; urgent = the pin when set, else an end within `windowDays` (the caller's urgency window) |
| lists, rows | lists in the caller's order (`listOrder` preference, else `sort`, then name); rows by `at`, then `num`; deleted tasks, archived lists and test lists (slug `_…`) never appear |
| weeks | ISO weeks, Monday 00:00 to Monday 00:00 in the caller's `profiles.timezone` (`period.tz`) |

The Visuals (KPI charts) are not in the report. Their raw data:

```bash
curl -s "$TD_URL/rest/v1/rpc/kpi_events" \
  -H "apikey: $TD_KEY" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"p_lists":["<list-uuid>"]}'
```

The app computes the charts from it in the browser (core `kpiHistory`, `kpiSeries`, `kpiPie`, `kpiClosure`); a tool that wants the same numbers runs those functions (the core block loads in Node, see `cli/lib.mjs` `loadCore`).

Other reads:

```bash
# my urgency settings (null = the app's default)
curl -s "$TD_URL/rest/v1/rpc/urgency_settings" -H "apikey: $TD_KEY" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
# who is on a list
curl -s "$TD_URL/rest/v1/rpc/list_people" -H "apikey: $TD_KEY" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"p_list":"<list-uuid>"}'
# invitations waiting for me
curl -s "$TD_URL/rest/v1/rpc/my_invitations" -H "apikey: $TD_KEY" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
# my live lists
curl -s "$TD_URL/rest/v1/lists?select=id,slug,name,sort&archived_at=is.null&order=sort" -H "apikey: $TD_KEY" -H "Authorization: Bearer $TOKEN"
# open items of one list, soonest end first
curl -s "$TD_URL/rest/v1/items?select=id,num,title,status,due_at,quadrant&list_id=eq.<list-uuid>&status=in.(open,in_progress,waiting)&deleted_at=is.null&order=due_at.asc.nullslast" -H "apikey: $TD_KEY" -H "Authorization: Bearer $TOKEN"
```

`items` and `lists` answer at most 1000 rows; page with `limit` and `offset` (or a `Range: 0-999` header).

Task links (`db/018`): read the live ones, then make one task come after another and give it a parent:

```bash
curl -s "$TD_URL/rest/v1/item_links?select=from_item,to_item,kind&removed_at=is.null&kind=in.(depends_on,parent)" -H "apikey: $TD_KEY" -H "Authorization: Bearer $TOKEN"
# <later-uuid> comes after <earlier-uuid>
curl -s "$TD_URL/rest/v1/rpc/link_items" -H "apikey: $TD_KEY" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"p_from":"<later-uuid>","p_to":"<earlier-uuid>","p_kind":"depends_on"}'
# <child-uuid> becomes a child of <parent-uuid> (its old parent link goes)
curl -s "$TD_URL/rest/v1/rpc/link_items" -H "apikey: $TD_KEY" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"p_from":"<child-uuid>","p_to":"<parent-uuid>","p_kind":"parent"}'
curl -s "$TD_URL/rest/v1/rpc/unlink_items" -H "apikey: $TD_KEY" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"p_from":"<child-uuid>","p_to":"<parent-uuid>","p_kind":"parent"}'
```

## Errors

| Status | Code | When |
|---|---|---|
| 400 | `22023` | `review_report`: a bad week key, no week, more than 26 weeks or more than 50 lists; `link_items`: a loop ("this link would make a loop"), a task linked to itself, a deleted task, a bad kind |
| 400 | `invalid_credentials` | `/auth/v1/token`: wrong email or password |
| 400 | `refresh_token_already_used`, `refresh_token_not_found` | a refresh token used again after the reuse interval, or unknown: sign in again |
| 401 | `PGRST301`, `PGRST303` | no, expired or invalid access token: refresh and retry |
| 401 | `42501` | no token at all: `anon` may not execute the function or read the table |
| 403 | `42501` | `urgency_settings` for someone outside your household; `link_items` / `unlink_items`: "not allowed" (no rights on either end, or no read on one; the text never names an item) or "this list is archived" |
| 400 | `54000` | `link_items`: more than 200 links on one task |
| 429 | `over_request_rate_limit` | too many sign-ins: wait a minute |

PostgREST errors are JSON `{ code, message, details, hint }`; Auth errors are `{ code, error_code, msg }`.

## Limits

- `review_report` takes 1-26 weeks and at most 50 lists; it is read only and has no rate limit of its own (the writes-per-minute caps do not apply to reads; the platform's own limits do).
- Free Supabase plan limits apply to the whole project (database size, egress); see `docs/hosting.md`.
