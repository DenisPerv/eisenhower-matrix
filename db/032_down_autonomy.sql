-- db/032_down_autonomy.sql: removes everything 032_autonomy.sql made (autonomy, intake, budgets, ledger, precedents, list brief).
-- Run by hand only, as admin SQL; it sorts before 032, where it is a no-op on a database that never had it. Drops the columns
-- with their values and the budget ledger and precedents with their rows. Re-run 003, 011, the 012 block, 026, 030 and 031
-- afterwards like after any schema change, then the selftests.

drop function if exists public.revoke_precedent(uuid);
drop function if exists public.record_precedent(bigint, uuid, text, text, text);
drop function if exists public.budget_status(uuid);
drop function if exists public.budget_release(bigint);
drop function if exists public.budget_settle(bigint, numeric);
drop function if exists public.budget_close(bigint, text, numeric);
drop function if exists public.budget_reserve(text, text, uuid, uuid, numeric, int);
drop function if exists public.set_budget(uuid, text, numeric);
drop function if exists public.set_list_brief(uuid, text, text, text, text);
drop function if exists public.set_intake(text, uuid, boolean, text, boolean, boolean);
drop function if exists public.set_autonomy(text, uuid, text, text);
drop function if exists public.budget_used(uuid, text);
drop function if exists public.budget_period_start(text);
drop function if exists public.autonomy_log(text, uuid, text, jsonb, jsonb);
drop function if exists public.autonomy_is_household_human();

drop trigger if exists items_zz_settings on public.items;
drop function if exists public.items_settings_guard();

drop table if exists public.autonomy_events;
drop table if exists public.precedents;
drop table if exists public.budget_ledger;
drop table if exists public.budgets;

alter table public.items drop column if exists stage_report, drop column if exists notify_telegram,
  drop column if exists deploy_target, drop column if exists e2e_self, drop column if exists autonomy_set_at,
  drop column if exists autonomy_set_by, drop column if exists autonomy;
alter table public.lists drop constraint if exists lists_brief_sizes, drop constraint if exists lists_autonomy_not_inherit;
alter table public.lists drop column if exists brief_updated_at, drop column if exists brief_updated_by,
  drop column if exists brief_concept, drop column if exists brief_instruction, drop column if exists brief_naming,
  drop column if exists brief_decisions, drop column if exists stage_report, drop column if exists notify_telegram,
  drop column if exists deploy_target, drop column if exists e2e_self, drop column if exists autonomy_set_at,
  drop column if exists autonomy_set_by, drop column if exists autonomy;

drop table if exists public.deploy_targets;
drop type if exists public.autonomy_mode;
