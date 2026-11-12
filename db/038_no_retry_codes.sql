-- db/038_no_retry_codes.sql: set_autonomy and set_project_dir answer a stale p_expected with PT409 (HTTP 409) instead of
-- 40001 (2026-11-12, HomeOS plan nested-plotting-reddy, review finding 1). PostgREST 14 retries a transaction that fails
-- with 40001 (serialization_failure) with the same arguments, so a stale expected value would loop inside PostgREST and hold
-- its pool, as harness_push did on 2026-11-12 00:24-00:40 UTC (db/035). Bodies are the live functions (032, 034) with only
-- that code changed; the board, the phone app and the harness page treat PT409 and 40001 alike ("changed meanwhile").
-- Run after 032 and 034 (and again after any re-run of them); create or replace keeps their grants.

CREATE OR REPLACE FUNCTION public.set_autonomy(p_kind text, p_id uuid, p_mode text, p_expected text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid(); v_kind text; v_hh boolean; v_mode public.autonomy_mode; v_cur public.autonomy_mode;
  v_list uuid; v_list_mode public.autonomy_mode; v_owner uuid; v_arch timestamptz; v_del timestamptz;
begin
  select kind, is_household into v_kind, v_hh from public.profiles where id = v_uid;
  if v_kind is distinct from 'human' then raise exception 'only people set autonomy' using errcode = '42501'; end if;
  if p_mode is null or p_mode not in ('inherit', 'manual', 'project_rules', 'guided', 'ai_brain') then
    raise exception 'unknown mode' using errcode = '22023';
  end if;
  if p_expected is null or p_expected not in ('inherit', 'manual', 'project_rules', 'guided', 'ai_brain') then
    raise exception 'expected mode is required' using errcode = '22023';
  end if;
  v_mode := p_mode::public.autonomy_mode;
  if v_mode = 'ai_brain' and not v_hh then raise exception 'AI Brain is for the household only' using errcode = '42501'; end if;
  if not v_hh and v_mode not in ('manual', 'guided', 'inherit') then
    raise exception 'guests set Manual or Guided only' using errcode = '42501';
  end if;

  if p_kind = 'list' then
    select autonomy, archived_at into v_cur, v_arch from public.lists where id = p_id;
    if v_cur is null or not public.has_list_role(p_id, array['owner', 'editor']) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if v_arch is not null then raise exception 'this list is archived' using errcode = '42501'; end if;
    if v_mode = 'inherit' then raise exception 'a list has no parent to inherit from' using errcode = '22023'; end if;
    if v_cur <> p_expected::public.autonomy_mode then
      raise exception 'the mode changed meanwhile (now %)', v_cur using errcode = 'PT409';
    end if;
    update public.lists set autonomy = v_mode, autonomy_set_by = v_uid, autonomy_set_at = now() where id = p_id;
  elsif p_kind = 'item' then
    select i.autonomy, i.list_id, i.deleted_at into v_cur, v_list, v_del from public.items i where i.id = p_id;
    if v_cur is null or not public.has_list_role(v_list, array['owner', 'editor']) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if v_del is not null then raise exception 'this task is deleted' using errcode = '42501'; end if;
    select autonomy, owner_id into v_list_mode, v_owner from public.lists where id = v_list;
    if v_list_mode = 'manual' and v_mode not in ('inherit', 'manual') and not (v_owner = v_uid and v_hh) then
      raise exception 'only the household owner of a Manual list widens its tasks' using errcode = '42501';
    end if;
    if v_cur <> p_expected::public.autonomy_mode then
      raise exception 'the mode changed meanwhile (now %)', v_cur using errcode = 'PT409';
    end if;
    perform set_config('td.settings_only', p_id::text, true);
    update public.items set autonomy = v_mode, autonomy_set_by = v_uid, autonomy_set_at = now() where id = p_id;
    perform set_config('td.settings_only', '', true);
  else
    raise exception 'kind is list or item' using errcode = '22023';
  end if;
  perform public.autonomy_log(p_kind, p_id, 'autonomy', to_jsonb(v_cur::text), to_jsonb(v_mode::text));
  return v_mode::text;
end $function$;

CREATE OR REPLACE FUNCTION public.set_project_dir(p_list uuid, p_dir text, p_expected text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    raise exception 'the project folder changed meanwhile (now %)', coalesce(v_cur, 'not set') using errcode = 'PT409';
  end if;
  update public.lists set project_dir = v_dir where id = p_list;
  perform public.autonomy_log('list', p_list, 'project_dir', to_jsonb(v_cur), to_jsonb(v_dir));
  return v_dir;
end $function$;

