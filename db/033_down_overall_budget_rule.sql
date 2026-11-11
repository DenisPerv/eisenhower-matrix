-- db/033_down_overall_budget_rule.sql: rollback of 033_overall_budget_rule.sql - re-creates public.set_budget exactly as 032_autonomy.sql made
-- it (no overall-cap rule). Run by hand only, as admin SQL. It sorts before 033, where running it in file order is harmless (033
-- replaces the function again right after). Rows in public.budgets are not touched.

create or replace function public.set_budget(p_list uuid, p_period text, p_cap numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_old numeric;
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
  select cap_usd into v_old from public.budgets where list_id is not distinct from p_list and period = p_period;
  delete from public.budgets where list_id is not distinct from p_list and period = p_period;
  if p_cap is not null then
    insert into public.budgets (list_id, period, cap_usd, set_by) values (p_list, p_period, p_cap, auth.uid());
  end if;
  perform public.autonomy_log(case when p_list is null then 'overall' else 'list' end, p_list, 'budget',
    jsonb_build_object('period', p_period, 'cap_usd', v_old), jsonb_build_object('period', p_period, 'cap_usd', p_cap));
end $$;

revoke all on function public.set_budget(uuid, text, numeric) from public, anon;
grant execute on function public.set_budget(uuid, text, numeric) to authenticated;
