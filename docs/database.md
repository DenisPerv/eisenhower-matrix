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
| 6 | `013_kpi.sql`, `014_urgency_app.sql`, `015_access_requests.sql`, `016_review_report.sql`, `017_telegram_scope.sql`, `018_task_links.sql`, `019_bot_opt_out.sql`, `020_priority_retired.sql`, `022_share_by_person.sql`, `023_agent_tag_home.sql` | KPI history RPC, urgency settings by app, access requests, the review report API, the chat bot's scope, task links, the bot's opt-out, functions without priority (priority by position) |
| 7 | `003`, `011`, the 012 policy block | again |
| 7a | `021_drop_priority.sql` | drops `items.priority`, only once every client runs a page without priority (the hosted copy, both household machines, the Telegram bot); then 7 and 8 again |
| 8 | `900_selftest.sql` … `908_selftest_agent_tag_home.sql` | each rolls back and ends with an error whose text reads `SELFTEST n of n passed (rolled back). Failures: none`; 901 reads 71 of 73 since 012 (G34a, G35a describe a rule 012 replaced); 905 calls the `020` signature, so until 020 is live run its pre-020 copy |

Every file is re-runnable. The trigger function `items_before_write` is replaced by `002`, then `006`, then `010`: re-running `002` means re-running `006` and `010`. `010` also replaces `items_tags_compat_after`, which `023` replaces again: re-running `010` means re-running `023` after it.

**Household:** HomeOS applies files with `node scripts/tasksdb/tasksdb.js apply-sql <files>` (the Supabase Management API with a personal access token, admin SQL only); it appends `011` after `003` and the 012 policy block after `011` by itself.

## Changing the schema

1. Add a new file `db/NNN_<name>.sql` with the next free number. Never edit an applied file.
2. Make it idempotent (`create or replace`, `if not exists`) and end it with a final-check block that raises an exception when its own promise does not hold (see `013`, `014`, `016`: invoker or definer, `search_path`, no execute for `anon`).
3. New functions: `revoke all … from public, anon` and an explicit `grant execute … to authenticated`. Default privileges revoke execute from everyone, so nothing is callable by accident.
4. Re-run `003`, `011` and the 012 policy block, then every selftest (900-908).
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
| sharing | `share_list`, `share_tag_list`, `shareable_profiles`, `share_list_with`, `share_tag_list_with`, `my_invitations`, `accept_invite`, `decline_invite`, `revoke_invite`, `answer_shared_notice`, `visible_profiles` | 010/012/022 |
| tag lists | `create_tag_list`, `set_default_tag_list` (no longer called by the page or the app), `set_tag_list_archived`, `set_tag_list_hidden`, `leave_tag_list`, `tag_list_people`, `move_tags`, `merge_tags`, `merge_tag_lists` | 010/012 |
| settings | `urgency_settings(p_profile)` | 014 |
| task links | `link_items(p_from, p_to, p_kind)`, `unlink_items(p_from, p_to, p_kind)`; the trigger `item_links_guard` and its helper `link_would_loop` (no execute for anyone) | 018 |
| reports | `kpi_events(p_lists)` (invoker), `review_report(p_weeks, p_lists, p_now)` (invoker), its pure helper `review_quadrant` | 013/016 |
| access requests | `request_access`, `my_access_request`, `access_requests`, `access_request_decided` | 015 |
| keep-alive | `keepalive`, `keepalive_status` | 002/010 |
| helpers not callable through the API | `is_whitelisted(uuid)`, `shareable_email(uuid)` (022: the whitelist and a person's verified address, resolved on the server), `agent_tag_home_check`, `tag_lists_home_guard`, `tag_members_keep_home` (023) | 022/023 |
| helpers used by policies | `has_list_role`, `has_item_role`, `has_tag_list_role`, `has_tag_role`, `can_edit_item`, `can_use_category`, `is_household`, `is_human`, `is_agent`, `my_kind`, `my_verified_emails` | 002/010 |

`review_report` and `kpi_events` are **security invoker**: they run with the caller's rights, so RLS decides exactly as for a REST read, and they need no access checks of their own. The read endpoints and the review report are described in [api/openapi.yaml](api/openapi.yaml).

## Share by name and the agent home tag list

- **Share by name** (`022`): `shareable_profiles()` lists whitelisted human accounts (household members, a used sign-up allowlist row, an approved access request) as `(id, display_name)`: never a bot, never the caller, never an email, and nothing at all to a signed-in account nobody let in or to an agent. `share_list_with` (list owner) and `share_tag_list_with` (tag list owner or editor) take a profile id from that list, resolve the verified email on the server and call `invite_upsert(…, p_join := true)`, like a share by email.
- **Landing list and agent home** (`012`, `023`): tags typed by name (`items.tags`) are filed by `items_tags_compat_after()`. For a person the landing list is their `is_default` tag list ("My tags"; hidden in the clients, never archived or deleted). An agent with a row in `ops.agent_tag_home` files them into its home list instead, reusing a live or soft-deleted tag by `lower(name)`, else creating one; a missing, archived or read-only home list is 42501 "agent tag home not writable". A home list cannot be archived or merged away, and the agent's membership of it cannot be removed, lowered below editor or left, while its row exists.
- **Change an agent's home list:** admin SQL only (the table is closed to every API role): make the agent an owner or editor of the new list first, then `update ops.agent_tag_home set tag_list_id = '<id>' where agent_id = '<agent id>'` (HomeOS: `node scripts/tasksdb/tasksdb.js apply-sql <file>`). Live: `homeos-agent` and `telegram-bot` → Maksym's HomeOS tags.

## Task links

`item_links` (`db/001`, extended by `018`) keeps two kinds the app shows, both with `from_item` = the dependent side: `depends_on` (from comes after to, its predecessor; soft: nothing is refused for an open predecessor) and `parent` (from is a child of to; one live parent per task, a unique partial index). `relates` and `duplicates` are written by HomeOS skills and not shown; `blocks` rows were turned into `depends_on` and new ones are refused, so one direction is stored. Removal is soft (`removed_at`), and `changed_at` moves on every write so a poll sees adds and removals.

- **Rules for every write path** (trigger `item_links_guard`, security definer): no loop through live links of the same kind (`link_would_loop`, a recursive walk), no deleted end, no end in an archived list, at most 200 live links on a task. Texts name no item.
- **Rights** (`link_items`, `unlink_items`): edit rights on at least one end (`can_edit_item`: editor and up, or the contributor who made that item) and read on both; removing is also allowed to the one who made the link. A parent link replaces the old parent in the same call. `links_read` (`011`, read on both ends) is unchanged, so a link to an item someone cannot read never reaches them, not even as a count.
- **Direct REST** (`003`: select, insert, delete for `authenticated`): an insert still needs `links_add` and passes the trigger; agents should use the RPCs so removals are soft and polled.

## Limits

The caps live in `ops.settings` (`db/009`, `012`, `015`; admin SQL tunes them) and answer 54000 when crossed; the root README's **Limits** table lists them (guests: 20 live lists, 1,000 live items, 120 item writes a minute …; household: 50 lists each, 5,000 items per list …; invitations; access requests; the sign-up hook's 200 profiles or 400 MB). Reads have no rate limit of their own; `review_report` bounds itself (1-26 weeks, at most 50 lists).

## Backups and keep-alive

A free Supabase project pauses after a week without requests; `keepalive(host)` is a one-row write that a scheduled job calls. **Household:** HomeOS runs a weekly keep-alive routine and a remote backup (`HomeOS-Documentation/tasks-database.md` in HomeOS).
