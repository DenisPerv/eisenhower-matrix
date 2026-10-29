-- db/020_priority_retired.sql: priority by position (HomeOS priority-position-plan.md, 2026-10-29). A task's priority is its
-- position in its quadrant (sort_key), so no function reads items.priority any more: review_quadrant loses p_priority (important =
-- category reminder / tbd / decision only), review_report calls the new one, kpi_events leaves priority out of the items and the
-- event diffs. The column itself stays until db/021 drops it (apply 021 only once every client runs a page without priority: the
-- hosted copy, both household machines, the Telegram bot). Idempotent.
-- After it: 003, 011, the 012 policy block, then 900-906.

drop function if exists public.review_quadrant(text, int, text, boolean, timestamptz, timestamptz, numeric) cascade;

-- deriveQuadrant as SQL: the stored quadrant, else important = category reminder / tbd / decision, urgent = the pin when set,
-- else an end within p_window days of p_now (overdue counts as urgent). Pure: reads no table.
create or replace function public.review_quadrant(p_quadrant text, p_category text, p_pin boolean,
                                                  p_due timestamptz, p_now timestamptz, p_window numeric)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_quadrant in ('A', 'B', 'C', 'D') then p_quadrant
    else case when coalesce(p_category, 'task') in ('reminder', 'tbd', 'decision')
              then case when coalesce(p_pin, p_due is not null and p_due - p_now <= p_window * interval '1 day') then 'A' else 'B' end
              else case when coalesce(p_pin, p_due is not null and p_due - p_now <= p_window * interval '1 day') then 'C' else 'D' end
         end
  end;
$$;
revoke all on function public.review_quadrant(text, text, boolean, timestamptz, timestamptz, numeric) from public, anon;
grant execute on function public.review_quadrant(text, text, boolean, timestamptz, timestamptz, numeric) to authenticated;

-- the review report of db/016, unchanged except the review_quadrant call
create or replace function public.review_report(p_weeks text[], p_lists uuid[] default null, p_now timestamptz default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := coalesce(p_now, now());
  v_tz text; v_win numeric := 7; v_u jsonb; v_order jsonb;
  v_keys text[] := '{}'; v_ranges tstzrange[] := '{}'; v_k text; v_y int; v_w int; v_d date;
  v_from timestamptz; v_to timestamptz; v_out jsonb;
begin
  if p_weeks is null or cardinality(p_weeks) not between 1 and 26 then
    raise exception 'p_weeks needs 1 to 26 ISO week keys (YYYY-Www)' using errcode = '22023';
  end if;
  if p_lists is not null and cardinality(p_lists) > 50 then
    raise exception 'p_lists takes at most 50 lists' using errcode = '22023';
  end if;

  select p.timezone into v_tz from public.profiles p where p.id = v_uid;
  if v_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_tz) then v_tz := 'Europe/Lisbon'; end if;
  begin
    v_u := public.urgency_settings(v_uid);
  exception when others then v_u := null;
  end;
  if jsonb_typeof(v_u->'windowDays') = 'number' and (v_u->>'windowDays')::numeric between 1 and 30 then
    v_win := (v_u->>'windowDays')::numeric;
  end if;
  select pr.prefs->'listOrder' into v_order from public.preferences pr where pr.profile_id = v_uid and pr.app = 'tasksdashboard';
  if jsonb_typeof(v_order) is distinct from 'array' then v_order := '[]'::jsonb; end if;

  for v_k in select distinct x from unnest(p_weeks) x order by 1 loop
    if v_k is null or v_k !~ '^[0-9]{4}-W[0-9]{2}$' then
      raise exception 'bad week key %, expected YYYY-Www', coalesce(v_k, 'null') using errcode = '22023';
    end if;
    v_y := substr(v_k, 1, 4)::int; v_w := substr(v_k, 7, 2)::int;
    if v_y < 1 or v_w < 1 or v_w > 53 then raise exception 'bad week key %', v_k using errcode = '22023'; end if;
    v_d := make_date(v_y, 1, 4) - (extract(isodow from make_date(v_y, 1, 4))::int - 1) + (v_w - 1) * 7;
    if to_char(v_d, 'IYYY-"W"IW') <> v_k then raise exception 'bad week key % (the year has no such week)', v_k using errcode = '22023'; end if;
    v_keys := v_keys || v_k;
    v_ranges := v_ranges || tstzrange(v_d::timestamp at time zone v_tz, (v_d + 7)::timestamp at time zone v_tz, '[)');
  end loop;
  select min(lower(r)), max(upper(r)) into v_from, v_to from unnest(v_ranges) r;

  with lst as (
    select l.id, l.name, l.sort,
           coalesce((select o.n from jsonb_array_elements_text(v_order) with ordinality o(v, n) where o.v = l.id::text limit 1), 1000000) as pos
      from public.lists l
     where l.archived_at is null and left(l.slug, 1) <> '_'
       and (case when p_lists is null
                 then not exists (select 1 from public.list_members m where m.list_id = l.id and m.profile_id = v_uid and m.hidden_at is not null)
                 else l.id = any(p_lists) end)
  ), base as (
    select i.id, i.list_id, i.num, i.title, i.status, i.due_at,
           public.review_quadrant(i.quadrant, i.category, i.urgent_pin, i.due_at, v_now, v_win) as q,
           case when i.status in ('done', 'cancelled') then
             coalesce(case when i.status = 'cancelled' then
                        (select max(e.at) from public.item_events e where e.item_id = i.id and e.diff->'status'->>'new' = 'cancelled') end,
                      i.completed_at, i.updated_at) end as done_at
      from public.items i join lst on lst.id = i.list_id
     where i.deleted_at is null
  ), k as (
    select b.*,
           case when b.done_at is not null and exists (select 1 from unnest(v_ranges) r where r @> b.done_at)
                  then case when b.status = 'cancelled' then 'cancelled' else 'done' end
                when b.due_at is not null and exists (select 1 from unnest(v_ranges) r where r @> b.due_at)
                  then case when b.done_at is null and b.due_at < v_now then 'overdue' else 'due' end
           end as kind
      from base b
  ), rw as (
    select k.*, case when k.kind in ('done', 'cancelled') then k.done_at else k.due_at end as at,
           (k.due_at is not null and k.due_at < coalesce(k.done_at, v_now)) as late
      from k where k.kind is not null
  ), qs(q, name, ord) as (values ('A', 'Do', 1), ('B', 'Plan', 2), ('C', 'Delegate', 3), ('D', 'Eliminate', 4))
  select jsonb_build_object(
    'period', jsonb_build_object('from', v_from, 'to', v_to, 'weeks', to_jsonb(v_keys), 'tz', v_tz, 'now', v_now, 'windowDays', v_win),
    'lists', coalesce((select jsonb_agg(jsonb_build_object('id', lst.id, 'name', lst.name) order by lst.pos, lst.sort, lst.name) from lst), '[]'::jsonb),
    'groups', (select jsonb_agg(jsonb_build_object(
        'q', qs.q, 'name', qs.name,
        'count', (select count(*) from rw r where r.q = qs.q),
        'lists', coalesce((select jsonb_agg(jsonb_build_object('list_id', lst.id, 'name', lst.name,
              'rows', (select jsonb_agg(jsonb_build_object('id', r.id, 'num', r.num, 'title', r.title, 'kind', r.kind, 'at', r.at,
                         'due_at', r.due_at, 'late', r.late, 'status', r.status,
                         'tags', coalesce((select jsonb_agg(jsonb_build_object('id', tg.id, 'name', tg.name) order by tg.name)
                                             from public.item_tags it join public.tags tg on tg.id = it.tag_id
                                            where it.item_id = r.id and it.removed_at is null and tg.deleted_at is null), '[]'::jsonb))
                         order by r.at, r.num)
                         from rw r where r.q = qs.q and r.list_id = lst.id))
            order by lst.pos, lst.sort, lst.name)
            from lst where exists (select 1 from rw r where r.q = qs.q and r.list_id = lst.id)), '[]'::jsonb))
      order by qs.ord) from qs))
  into v_out;
  return v_out;
end $$;
revoke all on function public.review_report(text[], uuid[], timestamptz) from public, anon;
grant execute on function public.review_report(text[], uuid[], timestamptz) to authenticated;

-- the KPI history of db/013, without priority
create or replace function public.kpi_events(p_lists uuid[])
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'list_id', i.list_id, 'quadrant', i.quadrant, 'status', i.status, 'due_at', i.due_at,
               'urgent_pin', i.urgent_pin, 'category', i.category, 'deleted_at', i.deleted_at, 'created_at', i.created_at) order by i.id)
        from public.items i
       where i.list_id = any(p_lists)), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'item_id', e.item_id, 'at', e.at,
               'diff', (select jsonb_object_agg(d.key, d.value) from jsonb_each(e.diff) d
                         where d.key in ('quadrant', 'status', 'due_at', 'urgent_pin', 'category', 'deleted_at', 'list_id'))) order by e.id)
        from public.item_events e join public.items i on i.id = e.item_id
       where i.list_id = any(p_lists) and e.action <> 'create'
         and e.diff ?| array['quadrant', 'status', 'due_at', 'urgent_pin', 'category', 'deleted_at', 'list_id']), '[]'::jsonb));
$$;
revoke all on function public.kpi_events(uuid[]) from public, anon;
grant execute on function public.kpi_events(uuid[]) to authenticated;

-- final check: the old review_quadrant is gone; the three functions are security invoker with search_path '', not for anon,
-- executable by authenticated; none of them mentions priority
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'review_quadrant' and p.pronargs <> 6) then
    raise exception '020: an old review_quadrant is still there';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('review_report', 'review_quadrant', 'kpi_events')
                and (p.prosecdef or not coalesce(p.proconfig, '{}') @> array['search_path=""'] or p.prosrc ilike '%priority%')) then
    raise exception '020: review_report, review_quadrant and kpi_events must be invoker with search_path '''' and must not read priority';
  end if;
  if has_function_privilege('anon', 'public.review_report(text[], uuid[], timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.review_quadrant(text, text, boolean, timestamptz, timestamptz, numeric)', 'execute')
     or has_function_privilege('anon', 'public.kpi_events(uuid[])', 'execute') then
    raise exception '020: a function is executable by anon';
  end if;
  if not has_function_privilege('authenticated', 'public.review_report(text[], uuid[], timestamptz)', 'execute')
     or not has_function_privilege('authenticated', 'public.kpi_events(uuid[])', 'execute') then
    raise exception '020: review_report or kpi_events is not executable by authenticated';
  end if;
end $$;
