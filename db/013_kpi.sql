-- db/013_kpi.sql: round 3, G9 (HomeOS round3-plan.md A10). One call for the KPI history of the caller's lists: the items
-- (deleted ones too) and the item_events whose diff touches a KPI column, as one jsonb value. Read through paged REST, the
-- events cost about 0.4 s per 1000 rows one page after another, so a year of them would take far over 2 s; a single jsonb
-- answer is one request and is not cut by max-rows. Security invoker: the RLS of items and item_events decides what comes
-- back, exactly as with REST, so there is no new path to any row. Idempotent. After it: 003, 011, the 012 policy block, then
-- 900, 901 (71 of 73 since 012), 902.

-- p_lists: the lists to read (the app sends the ids it shows in the KPI chips). Diff values stay { old, new } as
-- items_after_write (db/002) wrote them, only the KPI columns kept (C.KPI_COLUMNS in the page).
create or replace function public.kpi_events(p_lists uuid[])
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'list_id', i.list_id, 'quadrant', i.quadrant, 'status', i.status, 'due_at', i.due_at,
               'urgent_pin', i.urgent_pin, 'priority', i.priority, 'category', i.category, 'deleted_at', i.deleted_at, 'created_at', i.created_at) order by i.id)
        from public.items i
       where i.list_id = any(p_lists)), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'item_id', e.item_id, 'at', e.at,
               'diff', (select jsonb_object_agg(d.key, d.value) from jsonb_each(e.diff) d
                         where d.key in ('quadrant', 'status', 'due_at', 'urgent_pin', 'priority', 'category', 'deleted_at', 'list_id'))) order by e.id)
        from public.item_events e join public.items i on i.id = e.item_id
       where i.list_id = any(p_lists) and e.action <> 'create'
         and e.diff ?| array['quadrant', 'status', 'due_at', 'urgent_pin', 'priority', 'category', 'deleted_at', 'list_id']), '[]'::jsonb));
$$;
revoke all on function public.kpi_events(uuid[]) from public, anon;
grant execute on function public.kpi_events(uuid[]) to authenticated;

-- final check: invoker (RLS applies), a fixed search_path, not for anon
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'kpi_events' and (p.prosecdef or not coalesce(p.proconfig, '{}') @> array['search_path=""'])) then
    raise exception '013: kpi_events must be security invoker with search_path ''''';
  end if;
  if has_function_privilege('anon', 'public.kpi_events(uuid[])', 'execute') then raise exception '013: kpi_events is executable by anon'; end if;
  if not has_function_privilege('authenticated', 'public.kpi_events(uuid[])', 'execute') then raise exception '013: kpi_events is not executable by authenticated'; end if;
end $$;
