-- 014 (round 3, V4 review): urgency_settings reads the TasksDashboard preferences row only.
-- preferences has the key (profile_id, app); 012 selected by profile_id alone, so a second app writing a row would make
-- the answer depend on which row came first. Same body, same rights (create or replace keeps the grants). Idempotent.

create or replace function public.urgency_settings(p_profile uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid := coalesce(p_profile, auth.uid()); v_hh boolean; v jsonb;
begin
  select is_household into v_hh from public.profiles where id = v_id;
  if not (public.is_admin_sql() or (v_id = auth.uid() and v_hh is not null) or (coalesce(v_hh, false) and public.is_household())) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select prefs->'settings' into v from public.preferences where profile_id = v_id and app = 'tasksdashboard';
  return jsonb_build_object('profile_id', v_id,
    'windowDays', case when jsonb_typeof(v->'windowDays') = 'number' then v->'windowDays' end,
    'threshold',  case when jsonb_typeof(v->'threshold')  = 'number' then v->'threshold'  end,
    'doLimit',    case when jsonb_typeof(v->'doLimit')    = 'number' then v->'doLimit'    end);
end $$;
revoke all on function public.urgency_settings(uuid) from public, anon;
grant execute on function public.urgency_settings(uuid) to authenticated;

-- final check: definer with an empty search_path, filtered by app, not for anon
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'urgency_settings' and p.prosecdef
                    and coalesce(p.proconfig, '{}') @> array['search_path=""'] and p.prosrc like '%app = %tasksdashboard%') then
    raise exception '014: urgency_settings is not the app-filtered definer';
  end if;
  if has_function_privilege('anon', 'public.urgency_settings(uuid)', 'execute') then raise exception '014: urgency_settings is executable by anon'; end if;
  if not has_function_privilege('authenticated', 'public.urgency_settings(uuid)', 'execute') then raise exception '014: urgency_settings is not executable by authenticated'; end if;
end $$;
