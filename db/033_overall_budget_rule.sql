-- db/033_overall_budget_rule.sql: the overall cap is the ceiling of every list cap (Max, 2026-11-11, parity fix 2).
-- Replaces public.set_budget from 032_autonomy.sql and keeps everything it does (household people only, a list's budget needs
-- owner or editor of it, period day | month, cap 0..100000 or null to remove, the advisory lock, the autonomy_events row). New:
--   a list cap may not be above the overall cap of the same period   -> 22023 "a list cap may not be above the overall cap ($X)"
--   the overall cap may not be below any list cap of the same period -> 22023 "the overall cap may not be below a list cap: <list> $Y"
-- Removing a cap (p_cap null) is always allowed. Caps of the other period are not compared (a day cap against a day cap only).
-- Rollback: 033_down_overall_budget_rule.sql (sorts before this file, where it is a no-op re-create of 032's function).
-- After it: re-run 003, 011, the 012 policy block, 026, 030, 031 and 032 like after any schema change (032 re-creates set_budget
-- without the rule, so re-run this file after 032), then the selftests incl. 915 and 916.

create or replace function public.set_budget(p_list uuid, p_period text, p_cap numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_old numeric; v_overall numeric; v_name text; v_top numeric;
begin
  if not public.autonomy_is_household_human() then
    raise exception 'budgets are set by household people' using errcode = '42501';
  end if;
  if p_period is null or p_period not in ('day', 'month') then raise exception 'period is day or month' using errcode = '22023'; end if;
  if p_cap is not null and (p_cap < 0 or p_cap > 100000) then raise exception 'cap out of range' using errcode = '22023'; end if;
  if p_list is not null then
    if not exists (select 1 from public.lists where id = p_list) or not public.has_list_role(p_list, array['owner', 'editor']) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtext('td.budget'));
  if p_cap is not null and p_list is not null then
    select cap_usd into v_overall from public.budgets where list_id is null and period = p_period;
    if v_overall is not null and p_cap > v_overall then
      raise exception 'a list cap may not be above the overall cap ($%)', trim_scale(v_overall) using errcode = '22023';
    end if;
  elsif p_cap is not null then
    select l.name, b.cap_usd into v_name, v_top
      from public.budgets b join public.lists l on l.id = b.list_id
     where b.period = p_period and b.cap_usd > p_cap
     order by b.cap_usd desc, l.name limit 1;
    if v_top is not null then
      raise exception 'the overall cap may not be below a list cap: % $%', v_name, trim_scale(v_top) using errcode = '22023';
    end if;
  end if;
  select cap_usd into v_old from public.budgets where list_id is not distinct from p_list and period = p_period;
  delete from public.budgets where list_id is not distinct from p_list and period = p_period;
  if p_cap is not null then
    insert into public.budgets (list_id, period, cap_usd, set_by) values (p_list, p_period, p_cap, auth.uid());
  end if;
  perform public.autonomy_log(case when p_list is null then 'overall' else 'list' end, p_list, 'budget',
    jsonb_build_object('period', p_period, 'cap_usd', v_old), jsonb_build_object('period', p_period, 'cap_usd', p_cap));
end $$;

-- create or replace keeps the grants of 032 (authenticated may execute; anon and public may not); restated so the file stands alone
revoke all on function public.set_budget(uuid, text, numeric) from public, anon;
grant execute on function public.set_budget(uuid, text, numeric) to authenticated;
