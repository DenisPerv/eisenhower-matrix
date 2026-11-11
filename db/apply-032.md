# Live apply: db/032_telegram_link.sql

The ordered procedure to put the Telegram link (`db/032_telegram_link.sql`, HomeOS telegram-v2 D18, D21, D29, D31 and the Realtime step) on the live TasksDashboardDB, check it and roll it back. Written 2026-11-11 for the master session, which runs it. Nobody has applied it yet.

- **Who runs it:** the HomeOS master session, after a person has tested `development_maxden` locally (http://localhost:8788). Nothing is released or deployed by this procedure.
- **How:** every SQL step runs from the HomeOS root with `node scripts/tasksdb/tasksdb.js apply-sql <files…>`. That command uses admin SQL through the Management API with the PAT from `localConfigs/.env`, never a service-role key. The files are read from the mounted checkout `Views/TasksDashboard`, which must be on `development_maxden` at or after the commit that added this file.
- **No partial files:** `012_round3.sql`'s policy block needs no extracted file. `apply-sql` cuts it out of `012_round3.sql` by itself (the `-- >>> 012 policies` … `-- <<< 012 policies` lines). It appends the block after `011`, `011` after `003`, `026` after them and `030` after `026`. Its notes name each file it adds. To name the block explicitly, use the path `Views/TasksDashboard/db/012_round3.sql#policies`.

Below, `D=Views/TasksDashboard/db` and `T="node scripts/tasksdb/tasksdb.js"`. Run each step in Git Bash from the HomeOS root.

## 0. Before

1. Confirm the mounted checkout is current and clean:

   ```bash
   git -C Views/TasksDashboard status -sb
   ```

   It should show `## development_maxden...origin/development_maxden` with no changes.
2. Make a backup and check it:

   ```bash
   $T export --out LocalOutputs/<ts>/tasksdb-pre-032.json
   ```

   ```bash
   $T export --check LocalOutputs/<ts>/tasksdb-pre-032.json
   ```

   `$T keepalive --status` shows the newest remote backup as well.
3. Check the state before the apply:

   ```bash
   $T apply-sql $D/apply-032-check.sql
   ```

   Expect `tg_login`, `agent_login`, `maksym` and `autonomy_live` to be `true`, and the 032 keys `false`, `0` or `null`.
   - `tg_login` false: stop. The bot's agent login `telegram-bot` is missing.
   - `autonomy_live` false: leave `032_autonomy.sql` out of step 2.
4. Dry run, to see the expanded order without touching the database:

   ```bash
   $T apply-sql $D/032_telegram_link.sql $D/003_rls.sql $D/031_harness_web.sql $D/032_autonomy.sql --dry-run
   ```

   It must list `032_telegram_link`, `003_rls`, `011_multiuser_rls`, `012_round3.sql#policies`, `026_plan_interest`, `030_plan_interest_email`, `031_harness_web` and `032_autonomy`, in that order.

## 1. Apply 032

```bash
$T apply-sql $D/032_telegram_link.sql
```

Expect `applied: …/032_telegram_link.sql` and no error. The file is re-runnable, so after a failure fix the cause and run it again. Each `create or replace`, the `if not exists` tables and the `on conflict` inserts make a second run safe.

## 2. Re-run the grants

```bash
$T apply-sql $D/003_rls.sql $D/031_harness_web.sql $D/032_autonomy.sql
```

The rule is in `CLAUDE.md` ("After one: re-run …"). `apply-sql` adds `011`, the 012 policy block, `026` and `030` after `003`, and prints a note for each. `031` and `032_autonomy` are named because `003` revokes their table grants and nothing appends them.

`032_telegram_link.sql` does not need a second run after `003`. `003` revokes functions only from `public` and `anon`, and grants nothing on `ops`, Storage or the publication, so 032's grants to `authenticated` stay. Step 3 checks that.

## 3. Verify

1. Run the state check:

   ```bash
   $T apply-sql $D/apply-032-check.sql
   ```

   Expect:

   | Key | Value |
   |---|---|
   | `ops_tables` | true |
   | `rpcs` | 6 |
   | `anon_closed` | true |
   | `internal_closed` | true |
   | `triggers` | 2 |
   | `settings` | 2 |
   | `global_editors` | includes `anastasiia=editor`, `homeos-agent=editor`, `maksym=owner`, `telegram-bot=editor` |
   | `bucket_private` | true |
   | `bucket_policies` | 3 |
   | `items_realtime` | true |
   | `realtime_marker` | 1, or null when `items` was already in the publication |

2. Run the selftests in one call, in this order:

   ```bash
   $T apply-sql $D/900_selftest.sql $D/901_selftest_multiuser.sql $D/902_selftest_round3.sql $D/903_selftest_access.sql $D/904_selftest_review_report.sql $D/905_selftest_telegram.sql $D/906_selftest_task_links.sql $D/907_selftest_share_by_person.sql $D/908_selftest_agent_tag_home.sql $D/909_selftest_whitelist.sql $D/910_selftest_consultancy.sql $D/911_selftest_plan_interest.sql $D/912_selftest_agent_lists.sql $D/913_selftest_delete_lists.sql $D/914_selftest_harness_web.sql $D/915_selftest_autonomy.sql $D/915_selftest_telegram_link.sql
   ```

   Every line must read `SELFTEST n of n passed (rolled back). Failures: none`. The one exception is 901: `71 of 73`, with `G34a, G35a` failing by design since 012 (README Set up). Each selftest rolls itself back. Known counts are in README Set up, for example 900 57/57, 903 47/47 and 905 35/35.

   `915_selftest_telegram_link.sql` covers 032: L0–L17, with L17 checking Realtime. It runs here for the first time and has never run against a database, so a failing case may be a test bug. Report its failure list and stop. Step 4 is for a broken 032, not for a test bug.
3. Run the REST selftest:

   ```bash
   $T selftest
   ```

   Expect every check to pass (59/59 at the last run).
4. Optional live check by the bot owner: a person presses **Link Telegram** on the local board, and the bot redeems the token with `rpc/telegram_redeem_link`. That needs the local test build and the bot running, and is not part of the SQL apply.

## 4. Roll back

Use this only when 032 itself is wrong. Do not use it for a failing 915 case.

1. Remove what 032 added:

   ```bash
   $T apply-sql $D/032_down_telegram_link.sql
   ```

   It drops the 032 functions, triggers and storage policies, and the bucket when empty (newer Storage may refuse that: then delete the bucket in the dashboard). It takes `public.items` out of `supabase_realtime` only if 032 put it there (marker `telegram_realtime_added`).

   It keeps three things:
   - the `ops.telegram_*` tables, which hold the links;
   - the list **HomeOS - Global** and its members;
   - the bot's membership of people's "My tasks".

   Remove those in the app if wanted. The comments at the top of the down file say how.
2. Run the state check again:

   ```bash
   $T apply-sql $D/apply-032-check.sql
   ```

   Expect `rpcs` 0, `triggers` 0, `bucket_policies` 0, and `items_realtime` false (unless it was there before 032).
3. Run the selftests from step 3.2 without `915_selftest_telegram_link.sql`, and expect the same results as before the apply.
4. There is no need to re-run `003`. The down file only drops objects.

What the app does after a rollback: the sign-in Telegram field and **Link Telegram** call the 032 RPCs, so they show an error until 032 is back. The rest of the board is unaffected. Keep 032 live before any release that carries those buttons.

## Realtime and the telegram login

032 adds `public.items` to `supabase_realtime`, so Postgres changes of items reach Realtime subscribers. Realtime applies the subscriber's RLS, so the telegram login receives only changes to items in lists it is a member of: the "My tasks" lists shared with it and **HomeOS - Global**. That matches what a REST read would return. The bot subscribes with its own access token, never a service key, and filters for status `done` on the items it created.

## After

- Record it in the README Set up table: the 032 row gets "Applied live <date> … (900 …, 915 telegram link n/n)".
- Ask the person whether to bump the HomeOS pointer and release (`release_maxden`) after their local test. Never before it.
