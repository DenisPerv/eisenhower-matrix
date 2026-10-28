-- db/016_review_report.sql: round 4 wave B, item 7 (HomeOS round4-plan.md D1-D4). The Weekly review as an API: one call
-- returns the report the Review view shows for the picked ISO weeks, as data. Same rule, kinds and sorting as the page's core
-- functions reviewEntries and reviewGroups; the quadrant mirrors deriveQuadrant (review_quadrant below).
-- Security invoker: the RLS of lists, items, item_events and tags decides what comes back, exactly as with REST, so the caller
-- sees what the app shows it and no more; anon gets no execute. Read only, no rate limit (writes have one); bounded by its caps.
-- Visuals (KPI charts) are not in it: they are computed in the page from kpi_events (db/013). Idempotent.
-- After it: 003, 011, the 012 policy block, then 900, 901 (71 of 73 since 012), 902, 903, 904.

-- deriveQuadrant as SQL: the stored quadrant, else important = priority >= 3 or category reminder / tbd / decision, urgent =
-- the pin when set, else an end within p_window days of p_now (overdue counts as urgent). Pure: reads no table, so granting it
-- to authenticated (an invoker function needs it) shows nothing new.
create or replace function public.review_quadrant(p_quadrant text, p_priority int, p_category text, p_pin boolean,
                                                  p_due timestamptz, p_now timestamptz, p_window numeric)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_quadrant in ('A', 'B', 'C', 'D') then p_quadrant
    else case when coalesce(p_priority, 0) >= 3 or coalesce(p_category, 'task') in ('reminder', 'tbd', 'decision')
              then case when coalesce(p_pin, p_due is not null and p_due - p_now <= p_window * interval '1 day') then 'A' else 'B' end
              else case when coalesce(p_pin, p_due is not null and p_due - p_now <= p_window * interval '1 day') then 'C' else 'D' end
         end
  end;
$$;
revoke all on function public.review_quadrant(text, int, text, boolean, timestamptz, timestamptz, numeric) from public, anon;
grant execute on function public.review_quadrant(text, int, text, boolean, timestamptz, timestamptz, numeric) to authenticated;

-- p_weeks: 1-26 ISO week keys 'YYYY-Www' (weeks start on Monday at local midnight in the caller's profiles.timezone).
-- p_lists: at most 50 list ids; null = the lists the app shows (live, not hidden by the caller). Test lists (slug '_…') and
-- archived lists never appear; a list the caller cannot read is left out silently. p_now: tests only (default now()).
-- Errors: 22023 a bad week key, no week or more than 26, more than 50 lists.
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
           public.review_quadrant(i.quadrant, i.priority, i.category, i.urgent_pin, i.due_at, v_now, v_win) as q,
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

-- final check: invoker (RLS applies), a fixed search_path, not for anon; the helper is pure and not for anon either
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('review_report', 'review_quadrant')
                and (p.prosecdef or not coalesce(p.proconfig, '{}') @> array['search_path=""'])) then
    raise exception '016: review_report and review_quadrant must be security invoker with search_path ''''';
  end if;
  if has_function_privilege('anon', 'public.review_report(text[], uuid[], timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.review_quadrant(text, int, text, boolean, timestamptz, timestamptz, numeric)', 'execute') then
    raise exception '016: review_report or review_quadrant is executable by anon';
  end if;
  if not has_function_privilege('authenticated', 'public.review_report(text[], uuid[], timestamptz)', 'execute') then
    raise exception '016: review_report is not executable by authenticated';
  end if;
end $$;
