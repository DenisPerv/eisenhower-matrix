-- db/904_selftest_review_report.sql: the review_report selftest (HomeOS round4-plan.md wave B, VB1) as admin SQL. Rolls
-- everything back and reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-903.
-- Cases: V1 the rows a person gets (kinds done, cancelled, overdue, due; late; quadrants A-D incl. a stored one and a pin);
-- V2 a cancelled task is listed by its item_events time, not updated_at; V3 the four groups; V4 the period in the caller's
-- time zone; V5 rows sorted by day, then number; V6 p_lists; V7 test lists never appear; V8 a guest sees none of the
-- household's and only its own; V9 another household person does not see a private list; V10 deleted and out-of-week tasks
-- stay out; V11 bad input (22023); V12 rights (invoker, search_path, not for anon).
-- Fixtures: H1 (household, allowlist row) and A (a Google guest), as in 902; items written as admin in week 2026-W10
-- (2-8 March 2026, Europe/Lisbon = UTC+0 then) with p_now = 2026-03-05 12:00 UTC.
-- Run after 016, 003, 011, the 012 policy block, 900, 901, 902 and 903.

do $do$
declare
  h1 uuid := gen_random_uuid(); a uuid := gen_random_uuid();
  he text := 'st-rv-h1@example.invalid'; ae text := 'st-rv-a@example.invalid';
  mk uuid; l1 uuid; lt uuid; am uuid; ic uuid; idl uuid; j jsonb; v text;
  pnow timestamptz := '2026-03-05 12:00:00+00';
begin
  execute $f$create function public._rv_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true);
      else perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
           set local role authenticated; end if; end $b$$f$;
  execute $f$create function public._rv(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute $f$create function public._rv_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('rv.total', (coalesce(nullif(current_setting('rv.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('rv.nf', (coalesce(nullif(current_setting('rv.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('rv.f', coalesce(current_setting('rv.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  -- the rows of a report as 'title:kind:quadrant:late', by title
  execute $f$create function public._rv_rows(j jsonb) returns text language sql as $b$
    select coalesce(string_agg(concat_ws(':', r->>'title', r->>'kind', g->>'q', r->>'late'), ',' order by r->>'title'), 'none')
      from jsonb_array_elements(j->'groups') g, jsonb_array_elements(g->'lists') l, jsonb_array_elements(l->'rows') r $b$$f$;
  execute 'grant execute on function public._rv_as(uuid), public._rv(text), public._rv_chk(text, text, text), public._rv_rows(jsonb) to authenticated';
  perform set_config('rv.total', '0', true); perform set_config('rv.nf', '0', true); perform set_config('rv.f', '', true);

  -- ---------- fixtures (admin) ----------
  select id into mk from public.profiles where handle = 'maksym';
  insert into ops.signup_allowlist (email_lower, kind, is_household) values (he, 'human', true);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1, he, 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), h1, h1::text, 'email', json_build_object('sub', h1, 'email', he));
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (a, ae, 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest RV"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), a, 'st-rv-sub-a', 'google', json_build_object('sub', 'st-rv-sub-a', 'email', ae, 'email_verified', true));
  update public.profiles set timezone = 'Europe/Lisbon' where id in (h1, a);

  perform public._rv_as(h1);
  l1 := public.create_list('RV one');
  lt := public.create_list('RV test');
  perform public._rv_as(a);
  am := public.create_list('RV guest');
  perform public._rv_as(null);
  update public.lists set slug = '_st-rv-' || left(lt::text, 6) where id = lt;

  insert into public.items (list_id, category, title, created_by, status, completed_at, due_at) values
    (l1, 'task', 'rv-d1', h1, 'done', '2026-03-03 10:00+00', '2026-03-02 09:00+00');
  insert into public.items (list_id, category, title, created_by, status) values
    (l1, 'tbd', 'rv-c1', h1, 'cancelled') returning id into ic;
  insert into public.item_events (item_id, at, actor_id, actor_kind, action, diff) values
    (ic, '2026-03-04 08:00+00', h1, 'human', 'update', '{"status":{"old":"open","new":"cancelled"}}'),
    (ic, '2026-03-03 08:00+00', h1, 'human', 'update', '{"status":{"old":"open","new":"cancelled"}}');
  insert into public.items (list_id, category, title, created_by, quadrant, due_at) values
    (l1, 'task', 'rv-o1', h1, 'D', '2026-03-04 10:00+00');
  insert into public.items (list_id, category, title, created_by, due_at) values
    (l1, 'reminder', 'rv-u1', h1, '2026-03-07 10:00+00'),
    (l1, 'task', 'rv-x1', h1, '2026-04-01 10:00+00'),
    (lt, 'task', 'rv-t1', h1, '2026-03-05 10:00+00'),
    (am, 'task', 'rv-g1', a, '2026-03-05 18:00+00');
  insert into public.items (list_id, category, title, created_by, urgent_pin, due_at) values
    (l1, 'task', 'rv-p1', h1, false, '2026-03-06 10:00+00');
  insert into public.items (list_id, category, title, created_by, due_at) values
    (l1, 'task', 'rv-del', h1, '2026-03-05 09:00+00') returning id into idl;
  update public.items set deleted_at = now() where id = idl;

  -- V1 the rows H1 gets for 2026-W10
  perform public._rv_as(h1);
  j := public.review_report(array['2026-W10'], null, pnow);
  perform public._rv_chk('V1 rows', public._rv_rows(j),
    'rv-c1:cancelled:B:false,rv-d1:done:C:true,rv-o1:overdue:D:true,rv-p1:due:D:false,rv-u1:due:A:false');
  -- V2 cancelled by its latest item_events time (updated_at is today)
  perform public._rv_chk('V2 cancel time', (select ((r->>'at')::timestamptz = '2026-03-04 08:00+00')::text
                                              from jsonb_array_elements(j->'groups') g, jsonb_array_elements(g->'lists') l, jsonb_array_elements(l->'rows') r
                                             where r->>'title' = 'rv-c1'), 'true');
  -- V3 the four groups, their names and counts
  perform public._rv_chk('V3 groups', (select string_agg(concat_ws(':', g->>'q', g->>'name', g->>'count'), ',' order by n)
                                         from jsonb_array_elements(j->'groups') with ordinality x(g, n)),
                         'A:Do:1,B:Plan:1,C:Delegate:1,D:Eliminate:2');
  -- V4 the period: Monday 00:00 to the next Monday in Europe/Lisbon
  perform public._rv_chk('V4 period', concat_ws('|', (j->'period'->>'from')::timestamptz = '2026-03-02 00:00+00',
                                                 (j->'period'->>'to')::timestamptz = '2026-03-09 00:00+00',
                                                 j->'period'->>'weeks', j->'period'->>'tz'),
                         't|t|["2026-W10"]|Europe/Lisbon');
  -- V5 rows by day, then number (group D: rv-o1 on 4 March, rv-p1 on 6 March); lists: only RV one
  perform public._rv_chk('V5 order', (select string_agg(r->>'title', ',' order by n)
                                        from jsonb_array_elements(j->'groups') g, jsonb_array_elements(g->'lists') l,
                                             jsonb_array_elements(l->'rows') with ordinality y(r, n) where g->>'q' = 'D'), 'rv-o1,rv-p1');
  -- V6 p_lists: the same rows when the list is named; two weeks with a duplicate key give the same rows
  perform public._rv_chk('V6a p_lists', public._rv_rows(public.review_report(array['2026-W10'], array[l1], pnow)),
    'rv-c1:cancelled:B:false,rv-d1:done:C:true,rv-o1:overdue:D:true,rv-p1:due:D:false,rv-u1:due:A:false');
  perform public._rv_chk('V6b two weeks', (select jsonb_array_length(x->'period'->'weeks') || '/' || public._rv_rows(x)
                                             from (select public.review_report(array['2026-W11', '2026-W10', '2026-W10'], null, pnow) x) s),
    '2/rv-c1:cancelled:B:false,rv-d1:done:C:true,rv-o1:overdue:D:true,rv-p1:due:D:false,rv-u1:due:A:false');
  -- V7 a test list never appears, not even when it is named
  perform public._rv_chk('V7a lists', (select (not (j->'lists' @> jsonb_build_array(jsonb_build_object('id', lt))))::text
                                       || '/' || (j->'lists' @> jsonb_build_array(jsonb_build_object('id', l1)))::text), 'true/true');
  perform public._rv_chk('V7b named', (select jsonb_array_length(x->'lists') || '/' || public._rv_rows(x)
                                         from (select public.review_report(array['2026-W10'], array[lt], pnow) x) s), '0/none');
  -- V8 a guest sees its own row and none of the household's
  perform public._rv_as(a);
  perform public._rv_chk('V8a guest', public._rv_rows(public.review_report(array['2026-W10'], null, pnow)), 'rv-g1:due:C:false');
  perform public._rv_chk('V8b guest names H1''s list', public._rv_rows(public.review_report(array['2026-W10'], array[l1], pnow)), 'none');
  -- V9 another household person does not see H1's private list
  perform public._rv_as(mk);
  perform public._rv_chk('V9 maksym', (select jsonb_array_length(x->'lists') || '/' || public._rv_rows(x)
                                         from (select public.review_report(array['2026-W10'], array[l1, am], pnow) x) s), '0/none');
  -- V10 deleted and out-of-week tasks stay out (V1 lists neither rv-del nor rv-x1); rv-x1 shows in its own week
  perform public._rv_as(h1);
  perform public._rv_chk('V10 other week', public._rv_rows(public.review_report(array['2026-W14'], null, pnow)), 'rv-x1:due:D:false');
  -- V11 bad input: 22023
  perform public._rv_chk('V11a 27 weeks', public._rv(format('select public.review_report(%L::text[], null, %L)::text',
           (select array_agg(to_char(date '2025-01-06' + 7 * g, 'IYYY-"W"IW')) from generate_series(0, 26) g), pnow)), 'ERR 22023%');
  perform public._rv_chk('V11b week 60', public._rv('select public.review_report(array[''2026-W60''])::text'), 'ERR 22023%');
  perform public._rv_chk('V11c no W', public._rv('select public.review_report(array[''2026-13''])::text'), 'ERR 22023%');
  perform public._rv_chk('V11d no week 53', public._rv('select public.review_report(array[''2021-W53''])::text'), 'ERR 22023%');
  perform public._rv_chk('V11e empty', public._rv('select public.review_report(array[]::text[])::text'), 'ERR 22023%');
  perform public._rv_chk('V11f 51 lists', public._rv(format('select public.review_report(array[''2026-W10''], %L::uuid[])::text',
           (select array_agg(gen_random_uuid()) from generate_series(1, 51)))), 'ERR 22023%');
  perform public._rv_chk('V11g 26 weeks', public._rv(format('select (public.review_report(%L::text[], null, %L) -> ''period'' ->> ''weeks'') is not null',
           (select array_agg(to_char(date '2025-01-06' + 7 * g, 'IYYY-"W"IW')) from generate_series(0, 25) g), pnow)), 'true');

  -- V12 rights
  perform public._rv_as(null);
  perform public._rv_chk('V12a anon', (has_function_privilege('anon', 'public.review_report(text[], uuid[], timestamptz)', 'execute')
                                       or has_function_privilege('anon', 'public.review_quadrant(text, int, text, boolean, timestamptz, timestamptz, numeric)', 'execute'))::text, 'false');
  perform public._rv_chk('V12b authenticated', has_function_privilege('authenticated', 'public.review_report(text[], uuid[], timestamptz)', 'execute')::text, 'true');
  perform public._rv_chk('V12c invoker and search_path', (select string_agg(p.proname || ':' || p.prosecdef || ':' || (coalesce(p.proconfig, '{}') @> array['search_path=""']), ',' order by p.proname)
                                                            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                                           where n.nspname = 'public' and p.proname in ('review_report', 'review_quadrant')),
                         'review_quadrant:false:true,review_report:false:true');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('rv.total')::int - current_setting('rv.nf')::int,
    current_setting('rv.total'), coalesce(nullif(current_setting('rv.f'), ''), 'none');
end $do$;
