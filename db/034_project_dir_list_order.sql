-- db/034_project_dir_list_order.sql: harness fixes after the Configurations build (HomeOS plan joyful-jingling-cerf, task B1,
-- 2026-11-11; decisions in references/homeos/harness-configurations/decisions-round-2-2026-11-11.md, section 3 and round 5).
--
--   lists.project_dir     text, null = HomeOS. The folder of the project whose own CLAUDE.md, rules, permissions and hooks
--                         a Project rules list follows. At most 260 characters, an absolute Windows (D:\..., D:/...) or POSIX
--                         (/...) path, no ".." segment, no control characters. No API role may update it (003 grants list
--                         columns by name and does not name it); only set_project_dir writes it.
--   set_project_dir(p_list, p_dir, p_expected) -> text   household people, owner or editor of a list that is not archived.
--                         p_expected must equal the current value (null = not set; 40001 otherwise), like set_autonomy.
--                         An empty or blank p_dir clears it. Logged in autonomy_events (action project_dir).
--   household_list_order(p_person) -> jsonb   household logins only (people and homeos-agent; 42501 otherwise). For a
--                         household person: {"listOrder": [...], "listBar": {...} | null} from their TasksDashboard
--                         preferences (app 'tasksdashboard'); null for anyone else or when they have no preferences row.
--                         Lets the harness walk lists in the order the person keeps them on the board.
--   items_zzz_list_move   when items.list_id changes, the task's own mode goes back to inherit and autonomy_set_by/_at are
--                         cleared: a mode set for one list does not travel to another. It fires after items_zz_settings
--                         (trigger names sort), so the guard still refuses a REST write that sets a mode itself.
--   deploy_targets        the key check allows the exact key 'tasksdashboard' (the TasksDashboard production target under
--                         AI Brain, round 5); every other key naming TasksDashboard is still refused; format unchanged.
--
-- Error codes: 42501 not allowed, 22023 bad value, 40001 stale expected value.
-- Additive and re-runnable. Rollback: 034_down_project_dir_list_order.sql. Selftest: 917_selftest_project_dir_list_order.sql.

-- ---------- lists.project_dir ----------

alter table public.lists add column if not exists project_dir text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lists_project_dir_path') then
    alter table public.lists add constraint lists_project_dir_path check (
      project_dir is null or (
        char_length(project_dir) between 2 and 260
        and project_dir ~ '^([A-Za-z]:[\\/]|/)'
        and project_dir !~ '(^|[\\/])\.\.([\\/]|$)'
        and project_dir !~ '[[:cntrl:]]'));
  end if;
end $$;

-- the audit table learns the new action
alter table public.autonomy_events drop constraint if exists autonomy_events_action_check;
alter table public.autonomy_events add constraint autonomy_events_action_check
  check (action in ('autonomy', 'intake', 'brief', 'budget', 'precedent', 'precedent_revoke', 'project_dir'));

create or replace function public.set_project_dir(p_list uuid, p_dir text, p_expected text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_dir text := nullif(btrim(p_dir), ''); v_exp text := nullif(btrim(p_expected), ''); v_cur text; v_arch timestamptz;
        v_found boolean;
begin
  if not public.autonomy_is_household_human() then
    raise exception 'the project folder is set by household people' using errcode = '42501';
  end if;
  select true, project_dir, archived_at into v_found, v_cur, v_arch from public.lists where id = p_list;
  if v_found is null or not public.has_list_role(p_list, array['owner', 'editor']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_arch is not null then raise exception 'this list is archived' using errcode = '42501'; end if;
  if v_dir is not null and (char_length(v_dir) > 260 or char_length(v_dir) < 2
       or v_dir !~ '^([A-Za-z]:[\\/]|/)' or v_dir ~ '(^|[\\/])\.\.([\\/]|$)' or v_dir ~ '[[:cntrl:]]') then
    raise exception 'the project folder is an absolute path of at most 260 characters, without ..' using errcode = '22023';
  end if;
  if v_cur is distinct from v_exp then
    raise exception 'the project folder changed meanwhile (now %)', coalesce(v_cur, 'not set') using errcode = '40001';
  end if;
  update public.lists set project_dir = v_dir where id = p_list;
  perform public.autonomy_log('list', p_list, 'project_dir', to_jsonb(v_cur), to_jsonb(v_dir));
  return v_dir;
end $$;

-- ---------- household_list_order ----------

create or replace function public.household_list_order(p_person uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_prefs jsonb;
begin
  if not public.is_household() then
    raise exception 'household logins only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_person and is_household and kind = 'human') then
    return null;
  end if;
  select prefs into v_prefs from public.preferences where profile_id = p_person and app = 'tasksdashboard';
  if v_prefs is null then return null; end if;
  return jsonb_build_object(
    'listOrder', case when jsonb_typeof(v_prefs->'listOrder') = 'array' then v_prefs->'listOrder' else '[]'::jsonb end,
    'listBar',   case when jsonb_typeof(v_prefs->'listBar') = 'object' then v_prefs->'listBar' else 'null'::jsonb end);
end $$;

-- ---------- a moved task inherits again ----------

-- Not security definer: it only edits NEW. Named items_zzz_* so it fires after items_zz_settings (032), which has already
-- compared the caller's own values; the reset here is the database's, not the caller's.
create or replace function public.items_list_move_reset() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.list_id is distinct from old.list_id then
    new.autonomy := 'inherit';
    new.autonomy_set_by := null;
    new.autonomy_set_at := null;
  end if;
  return new;
end $$;
drop trigger if exists items_zzz_list_move on public.items;
create trigger items_zzz_list_move before update on public.items
  for each row execute function public.items_list_move_reset();

-- ---------- deploy_targets: the exact key tasksdashboard ----------

alter table public.deploy_targets drop constraint if exists deploy_targets_key_check;
alter table public.deploy_targets add constraint deploy_targets_key_check check (
  key ~ '^[a-z0-9][a-z0-9-]{0,40}$'
  and (key = 'tasksdashboard'
       or key !~ '(tasksdashboard|tasks-dashboard|tasksboard|tasks-board|eisenhower-agentic-planner-app)'));

-- ---------- grants ----------

revoke all on function public.items_list_move_reset() from public, anon, authenticated;
revoke all on function public.set_project_dir(uuid, text, text), public.household_list_order(uuid) from public, anon;
grant execute on function public.set_project_dir(uuid, text, text), public.household_list_order(uuid) to authenticated;
