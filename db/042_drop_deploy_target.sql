-- db/042_drop_deploy_target.sql: removes the intake field "deploy target" (2026-11-13, plan eventual-giggling-charm B1).
-- A project's deploy is described in the project's own docs now; the board no longer stores where a task deploys.
-- Counted before writing this file: lists.deploy_target non-null 0, items.deploy_target non-null 0, deploy_targets rows 6.
--
--   lists.deploy_target, items.deploy_target   dropped
--   deploy_targets                             dropped (with its policy and the 034 key check)
--   items_settings_guard                       recreated without deploy_target
--   set_intake(p_kind, p_id, p_e2e_self, p_notify_telegram, p_stage_report)      new 5-argument form
--   set_intake(p_kind, p_id, p_e2e_self, p_deploy_target, p_notify_telegram, p_stage_report)   kept as an overload that
--     ignores p_deploy_target, so a page still on the old code keeps working until it is reloaded
--
-- Apply only after the hosted page runs code that no longer selects deploy_target (person step after the release).
-- Then re-run 003_rls.sql and the selftests (915, 917, 922). Rollback: 042_down_drop_deploy_target.sql.

create or replace function public.items_settings_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.autonomy <> 'inherit' or new.autonomy_set_by is not null or new.autonomy_set_at is not null
         or new.e2e_self is not null or new.notify_telegram is not null
         or new.stage_report is not null then
        raise exception 'autonomy and intake are set through set_autonomy and set_intake' using errcode = '42501';
      end if;
    elsif (new.autonomy, new.autonomy_set_by, new.autonomy_set_at, new.e2e_self, new.notify_telegram, new.stage_report)
          is distinct from
          (old.autonomy, old.autonomy_set_by, old.autonomy_set_at, old.e2e_self, old.notify_telegram, old.stage_report) then
      raise exception 'autonomy and intake are set through set_autonomy and set_intake' using errcode = '42501';
    end if;
  elsif tg_op = 'UPDATE' and current_setting('td.settings_only', true) = new.id::text then
    new.version := old.version;   -- a settings change keeps the item's version (plan T7)
  end if;
  return new;
end $$;

drop function if exists public.set_intake(text, uuid, boolean, text, boolean, boolean);

alter table public.lists drop column if exists deploy_target;
alter table public.items drop column if exists deploy_target;
drop table if exists public.deploy_targets;

create or replace function public.set_intake(p_kind text, p_id uuid, p_e2e_self boolean,
                                             p_notify_telegram boolean, p_stage_report boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_list uuid; v_old jsonb; v_new jsonb; v_arch timestamptz; v_del timestamptz;
begin
  if not public.autonomy_is_household_human() then
    raise exception 'intake is set by household people' using errcode = '42501';
  end if;
  v_new := jsonb_build_object('e2e_self', p_e2e_self, 'notify_telegram', p_notify_telegram, 'stage_report', p_stage_report);
  if p_kind = 'list' then
    select jsonb_build_object('e2e_self', e2e_self, 'notify_telegram', notify_telegram, 'stage_report', stage_report),
           archived_at
      into v_old, v_arch from public.lists where id = p_id;
    if v_old is null or not public.has_list_role(p_id, array['owner', 'editor']) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if v_arch is not null then raise exception 'this list is archived' using errcode = '42501'; end if;
    update public.lists set e2e_self = p_e2e_self, notify_telegram = p_notify_telegram, stage_report = p_stage_report
     where id = p_id;
  elsif p_kind = 'item' then
    select jsonb_build_object('e2e_self', e2e_self, 'notify_telegram', notify_telegram, 'stage_report', stage_report),
           list_id, deleted_at
      into v_old, v_list, v_del from public.items where id = p_id;
    if v_old is null or not public.has_list_role(v_list, array['owner', 'editor']) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if v_del is not null then raise exception 'this task is deleted' using errcode = '42501'; end if;
    perform set_config('td.settings_only', p_id::text, true);
    update public.items set e2e_self = p_e2e_self, notify_telegram = p_notify_telegram, stage_report = p_stage_report
     where id = p_id;
    perform set_config('td.settings_only', '', true);
  else
    raise exception 'kind is list or item' using errcode = '22023';
  end if;
  perform public.autonomy_log(p_kind, p_id, 'intake', v_old, v_new);
end $$;

-- the old signature: p_deploy_target is accepted and ignored
create or replace function public.set_intake(p_kind text, p_id uuid, p_e2e_self boolean, p_deploy_target text,
                                             p_notify_telegram boolean, p_stage_report boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.set_intake(p_kind, p_id, p_e2e_self, p_notify_telegram, p_stage_report);
end $$;

-- ---------- grants (as 032) ----------

revoke all on function public.set_intake(text, uuid, boolean, boolean, boolean),
  public.set_intake(text, uuid, boolean, text, boolean, boolean) from public, anon;
grant execute on function public.set_intake(text, uuid, boolean, boolean, boolean),
  public.set_intake(text, uuid, boolean, text, boolean, boolean) to authenticated;
