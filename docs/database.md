# Database

TasksDashboardDB is one Supabase (Postgres) project. Every rule about who may read or write lives here: row level security (RLS) on every public table, triggers for the columns a client may not set, and RPCs (`security definer` functions with `search_path = ''`) for the steps that need more than one table. The page and the CLI only ever use the publishable key plus a login.

## Files and apply order

Run the files in the SQL editor (or with an admin tool), each file whole, in this order. The root README's **Set up** table says what each file adds, and which selftest result each must give.

| Order | Files | Note |
|---|---|---|
| 1 | `001_schema.sql`, `002_functions.sql`, `003_rls.sql`, `004_seed.sql` | tables, triggers and helpers, RLS and grants, the seed (fill the email placeholders in the editor, never commit them) |
| 2 | `005_item_order.sql` … `010_multiuser_functions.sql` | card order, archived lists, renewal category, the bot as editor, multi-user schema and functions |
| 3 | `003_rls.sql`, `011_multiuser_rls.sql` | grants for 005-010; 011 replaces some of 003's household policies, so it always runs after 003 |
| 4 | `012_round3.sql` | round 3; it ends with a policy block (`-- >>> 012 policies` … `-- <<< 012 policies`) that replaces 011's tag policies |
| 5 | `003`, `011`, the 012 policy block | as after every new file |
| 6 | `013_kpi.sql`, `014_urgency_app.sql`, `015_access_requests.sql`, `016_review_report.sql` | KPI history RPC, urgency settings by app, access requests, the review report API |
| 7 | `003`, `011`, the 012 policy block | again |
| 8 | `900_selftest.sql` … `904_selftest_review_report.sql` | each rolls back and ends with an error whose text reads `SELFTEST n of n passed (rolled back). Failures: none`; 901 reads 71 of 73 since 012 (G34a, G35a describe a rule 012 replaced) |

Every file is re-runnable. The trigger function `items_before_write` is replaced by `002`, then `006`, then `010`: re-running `002` means re-running `006` and `010`.

**Household:** HomeOS applies files with `node scripts/tasksdb/tasksdb.js apply-sql <files>` (the Supabase Management API with a personal access token, admin SQL only); it appends `011` after `003` and the 012 policy block after `011` by itself.

## Changing the schema

1. Add a new file `db/NNN_<name>.sql` with the next free number. Never edit an applied file.
2. Make it idempotent (`create or replace`, `if not exists`) and end it with a final-check block that raises an exception when its own promise does not hold (see `013`, `014`, `016`: invoker or definer, `search_path`, no execute for `anon`).
3. New functions: `revoke all … from public, anon` and an explicit `grant execute … to authenticated`. Default privileges revoke execute from everyone, so nothing is callable by accident.
4. Re-run `003`, `011` and the 012 policy block, then every selftest (900-904).
5. Update the root README (Set up table, the section the change touches) and, for an RPC that is part of the API, `docs/api/openapi.yaml` and `docs/api/README.md` (`test/api-doc.test.js` fails otherwise).
6. Never click a table on the dashboard's Data API page: it replaces the explicit grants with defaults that include `anon`. If it happens, re-run `003_rls.sql`.

## Access model (RLS)

| Who | Kind | Sees and does |
|---|---|---|
| household person | `profiles.is_household = true`, `kind = human` | own lists and lists shared with them; household profiles; all categories; creates lists (private, or shared with the household and its agent) |
| household agent | `kind = agent` (e.g. `homeos-agent`, `telegram-bot`) | only lists it is a member of, by role; never deletes or restores; marks what it wrote (`actor_kind`, `created_via`) |
| guest | a Google login with `is_household = false` | its own "My tasks" and lists shared with it; only categories with `audience = 'all'` (`task`, `reminder`); names only of people it shares with; capped (see Limits) |
| anon | no login | nothing: no table grant, no function execute |

Per list, `list_members.role` decides: **viewer** reads; **contributor** adds and edits the items it created, never deletes; **editor** does everything to items; **owner** also shares, changes roles, archives. Tag lists have their own roles (viewer, contributor, editor, owner; `db/012`). Archived lists are read only for every writer (`db/006`); a hidden list (`list_members.hidden_at`) is only hidden for that member.

What triggers guard (`002`, `006`, `010`): protected columns (an update keeps `id`, `created_by`, `created_at`, `actor_kind`, `created_via`, `dedup_key` and `on_behalf_of`, and bumps `version`), per-list numbers, `completed_at` and `updated_at`, the sensitive-data screen (card, IBAN and ID numbers are refused with 22023 "sensitive data"), write rate limits, and one `item_events` row per change with the diff `{ column: { old, new } }`.

## Functions (RPCs)

Callable by `authenticated` (every one is `security definer` with `search_path = ''` unless marked invoker):

| Area | Functions | File |
|---|---|---|
| lists | `create_list`, `create_list_row`, `set_list_hidden`, `leave_list`, `list_people` | 002/010/012 |
| sharing | `share_list`, `share_tag_list`, `my_invitations`, `accept_invite`, `decline_invite`, `revoke_invite`, `answer_shared_notice`, `visible_profiles` | 010/012 |
| tag lists | `create_tag_list`, `set_default_tag_list`, `set_tag_list_archived`, `set_tag_list_hidden`, `leave_tag_list`, `tag_list_people`, `move_tags`, `merge_tags`, `merge_tag_lists` | 010/012 |
| settings | `urgency_settings(p_profile)` | 014 |
| reports | `kpi_events(p_lists)` (invoker), `review_report(p_weeks, p_lists, p_now)` (invoker), its pure helper `review_quadrant` | 013/016 |
| access requests | `request_access`, `my_access_request`, `access_requests`, `access_request_decided` | 015 |
| keep-alive | `keepalive`, `keepalive_status` | 002/010 |
| helpers used by policies | `has_list_role`, `has_item_role`, `has_tag_list_role`, `has_tag_role`, `can_edit_item`, `can_use_category`, `is_household`, `is_human`, `is_agent`, `my_kind`, `my_verified_emails` | 002/010 |

`review_report` and `kpi_events` are **security invoker**: they run with the caller's rights, so RLS decides exactly as for a REST read, and they need no access checks of their own. The read endpoints and the review report are described in [api/openapi.yaml](api/openapi.yaml).

## Limits

The caps live in `ops.settings` (`db/009`, `012`, `015`; admin SQL tunes them) and answer 54000 when crossed; the root README's **Limits** table lists them (guests: 20 live lists, 1,000 live items, 120 item writes a minute …; household: 50 lists each, 5,000 items per list …; invitations; access requests; the sign-up hook's 200 profiles or 400 MB). Reads have no rate limit of their own; `review_report` bounds itself (1-26 weeks, at most 50 lists).

## Backups and keep-alive

A free Supabase project pauses after a week without requests; `keepalive(host)` is a one-row write that a scheduled job calls. **Household:** HomeOS runs a weekly keep-alive routine and a remote backup (`HomeOS-Documentation/tasks-database.md` in HomeOS).
