-- db/042_down_drop_deploy_target.sql: rollback of 042_drop_deploy_target.sql. Recreates an empty deploy_targets table
-- (key check as 034, policy and grants as 032), the two columns, the guard and the 6-argument set_intake of 032.
-- The six old target rows are not restored (no list or task used them); add them by admin SQL if needed.

create table if not exists public.deploy_targets (
  key         text primary key,
  label       text not null check (length(label) between 1 and 80),
  created_at  timestamptz not null default now()
);
alter table public.deploy_targets drop constraint if exists deploy_targets_key_check;
alter table public.deploy_targets add constraint deploy_targets_key_check check (
  key ~ '^[a-z0-9][a-z0-9-]{0,40}$'
  and (key = 'tasksdashboard'
       or key !~ '(tasksdashboard|tasks-dashboard|tasksboard|tasks-board|eisenhower-agentic-planner-app)'));
alter table public.deploy_targets enable row level security;
drop policy if exists deploy_targets_read on public.deploy_targets;
create policy deploy_targets_read on public.deploy_targets for select to authenticated using (true);
revoke all on public.deploy_targets from public, anon, authenticated;
grant select on public.deploy_targets to authenticated;

alter table public.lists add column if not exists deploy_target text references public.deploy_targets(key);
alter table public.items add column if not exists deploy_target text references public.deploy_targets(key);

create or replace function public.items_settings_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.autonomy <> 'inherit' or new.autonomy_set_by is not null or new.autonomy_set_at is not null
         or new.e2e_self is not null or new.deploy_target is not null or new.notify_telegram is not null
         or new.stage_report is not null then
        raise exception 'autonomy and intake are set through set_autonomy and set_intake' using errcode = '42501';
      end if;
    elsif (new.autonomy, new.autonomy_set_by, new.autonomy_set_at, new.e2e_self, new.deploy_target, new.notify_telegram, new.stage_report)
          is distinct from
          (old.autonomy, old.autonomy_set_by, old.autonomy_set_at, old.e2e_self, old.deploy_target, old.notify_telegram, old.stage_report) then
      raise exception 'autonomy and intake are set through set_autonomy and set_intake' using errcode = '42501';
    end if;
  elsif tg_op = 'UPDATE' and current_setting('td.settings_only', true) = new.id::text then
    new.version := old.version;   -- a settings change keeps the item's version (plan T7)
  end if;
  return new;
end $$;

drop function if exists public.set_intake(text, uuid, boolean, text, boolean, boolean);
drop function if exists public.set_intake(text, uuid, boolean, boolean, boolean);

create or replace function public.set_intake(p_kind text, p_id uuid, p_e2e_self boolean, p_deploy_target text,
                                             p_notify_telegram boolean, p_stage_report boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_list uuid; v_old jsonb; v_new jsonb; v_arch timestamptz; v_del timestamptz;
begin
  if not public.autonomy_is_household_human() then
    raise exception 'intake is set by household people' using errcode = '42501';
  end if;
  if p_deploy_target is not null and not exists (select 1 from public.deploy_targets where key = p_deploy_target) then
    raise exception 'unknown deploy target' using errcode = '22023';
  end if;
  v_new := jsonb_build_object('e2e_self', p_e2e_self, 'deploy_target', p_deploy_target,
                              'notify_telegram', p_notify_telegram, 'stage_report', p_stage_report);
  if p_kind = 'list' then
    select jsonb_build_object('e2e_self', e2e_self, 'deploy_target', deploy_target, 'notify_telegram', notify_telegram,
                              'stage_report', stage_report), archived_at
      into v_old, v_arch from public.lists where id = p_id;
    if v_old is null or not public.has_list_role(p_id, array['owner', 'editor']) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if v_arch is not null then raise exception 'this list is archived' using errcode = '42501'; end if;
    update public.lists set e2e_self = p_e2e_self, deploy_target = p_deploy_target, notify_telegram = p_notify_telegram,
                            stage_report = p_stage_report where id = p_id;
  elsif p_kind = 'item' then
    select jsonb_build_object('e2e_self', e2e_self, 'deploy_target', deploy_target, 'notify_telegram', notify_telegram,
                              'stage_report', stage_report), list_id, deleted_at
      into v_old, v_list, v_del from public.items where id = p_id;
    if v_old is null or not public.has_list_role(v_list, array['owner', 'editor']) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if v_del is not null then raise exception 'this task is deleted' using errcode = '42501'; end if;
    perform set_config('td.settings_only', p_id::text, true);
    update public.items set e2e_self = p_e2e_self, deploy_target = p_deploy_target, notify_telegram = p_notify_telegram,
                            stage_report = p_stage_report where id = p_id;
    perform set_config('td.settings_only', '', true);
  else
    raise exception 'kind is list or item' using errcode = '22023';
  end if;
  perform public.autonomy_log(p_kind, p_id, 'intake', v_old, v_new);
end $$;

revoke all on function public.set_intake(text, uuid, boolean, text, boolean, boolean) from public, anon;
grant execute on function public.set_intake(text, uuid, boolean, text, boolean, boolean) to authenticated;
