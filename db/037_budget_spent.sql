-- db/037_budget_spent.sql: a settle-only budget row (Max, 2026-11-12). A session that never reserved (a master, a judge, a continued
-- session, a lost session the reaper settles) records its real cost with ONE ledger row: kind 'settle', no reservation.
-- Before this file HomeOS-TasksBoardHarness/scripts/budget.js `spent` reserved 0.01 and settled it at once, and at a cap
-- budget_reserve refused the reservation (54000), so money already spent was missing from the ledger.
--   budget_spent(p_host, p_session, p_list uuid, p_item uuid, p_amount) -> bigint (the ledger row id)
--   household logins only (people and agents such as homeos-agent), else 42501; amount > 0 and <= 1000, else 22023;
--   a guest or a list the caller cannot see: 42501; a task outside that list: 22023;
--   never refused at a cap: it records what was already spent. budget_used sums kind 'settle', so budget_status includes it.
-- Ledger check: 032's budget_ledger_check ("only a reserve has no reservation_id") is replaced by budget_ledger_reservation_link:
-- a reserve has none, a release has one, a settle may have one (closing a reservation) or none (this RPC).
-- No errcode 40001 anywhere (PostgREST retries it forever). Re-runnable. Rollback: 037_down_budget_spent.sql (run by hand).
-- After it: like after any schema change re-run 003 and its followers, then 031, 032_autonomy, 032_telegram_link, 033, 034, 035,
-- 036 and this file again (003 revokes function grants), then the selftests incl. 919.

alter table public.budget_ledger drop constraint if exists budget_ledger_check;
alter table public.budget_ledger drop constraint if exists budget_ledger_reservation_link;
alter table public.budget_ledger add constraint budget_ledger_reservation_link check (
  (kind = 'reserve' and reservation_id is null) or (kind = 'release' and reservation_id is not null) or kind = 'settle');

create or replace function public.budget_spent(p_host text, p_session text, p_list uuid, p_item uuid, p_amount numeric) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if not public.is_household() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000 then raise exception 'amount out of range' using errcode = '22023'; end if;
  if p_list is not null and not public.has_list_role(p_list, array['owner', 'editor', 'contributor', 'viewer']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_item is not null and not exists (select 1 from public.items where id = p_item and list_id is not distinct from p_list) then
    raise exception 'the task is not in that list' using errcode = '22023';
  end if;
  -- the same lock as budget_reserve, so a reservation never reads a half-written sum
  perform pg_advisory_xact_lock(hashtext('td.budget'));
  insert into public.budget_ledger (kind, host, session, list_id, item_id, amount_usd, created_by)
  values ('settle', p_host, p_session, p_list, p_item, p_amount, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.budget_spent(text, text, uuid, uuid, numeric) from public, anon;
grant execute on function public.budget_spent(text, text, uuid, uuid, numeric) to authenticated;
