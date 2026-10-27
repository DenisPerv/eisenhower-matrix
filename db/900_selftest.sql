-- db/900_selftest.sql: the RLS selftest as admin SQL; rolls everything back and reports
-- "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text. Was schema.md §6.1; #37 and #38 added
-- for 005 and 006; fixture handles and the
-- test list renamed to st-* so it runs on a seeded database. Run after every db/ change (after re-running 003_rls.sql).

-- RLS selftest (schema.md §6) run as admin SQL. Fixture logins have no password and cannot sign in.
-- Everything runs in one DO block that ends with RAISE, so the whole transaction rolls back.
do $do$
declare
  mk uuid := gen_random_uuid(); an uuid := gen_random_uuid(); ag uuid := gen_random_uuid(); tg uuid := gen_random_uuid(); nx uuid := gen_random_uuid(); sa uuid;
  st uuid; bl uuid; i1 uuid; i2 uuid; i3 uuid; i4 uuid; v text; f text := ''; pass int := 0; total int := 0;
begin
  execute $f$create function public._st_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true);
      else perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
           set local role authenticated; end if; end $b$$f$;
  execute $f$create function public._st_anon() returns void language plpgsql as $b$
    begin reset role; perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
          set local role anon; end $b$$f$;
  execute $f$create function public._st(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute 'grant execute on function public._st_as(uuid), public._st_anon(), public._st(text) to authenticated, anon';

  -- fixture (admin)
  insert into auth.users (id, email, aud, role) values
    (mk, 'st-maksym@example.invalid', 'authenticated', 'authenticated'), (an, 'st-anastasiia@example.invalid', 'authenticated', 'authenticated'),
    (ag, 'st-agent@example.invalid', 'authenticated', 'authenticated'),  (tg, 'st-telegram@example.invalid', 'authenticated', 'authenticated'),
    (nx, 'st-noprofile@example.invalid', 'authenticated', 'authenticated');
  insert into public.profiles (id, handle, display_name, kind, email, mine_tags) values
    (mk, 'st-maksym', 'Maksym', 'human', 'st-maksym@example.invalid', '{maksym,shared}'),
    (an, 'st-anastasiia', 'Anastasiia', 'human', 'st-anastasiia@example.invalid', '{anastasiia,shared}'),
    (ag, 'st-homeos-agent', 'HomeOS agent', 'agent', 'st-agent@example.invalid', '{}'),
    (tg, 'st-telegram-bot', 'Telegram bot', 'agent', 'st-telegram@example.invalid', '{}');
  insert into public.categories (slug, name) values ('task', 'Task') on conflict do nothing;
  insert into public.lists (slug, name, owner_id, created_by) values ('st-backlog', 'Backlog', mk, mk) returning id into bl;
  insert into public.list_members (list_id, profile_id, role) values (bl, mk, 'owner'), (bl, an, 'owner'), (bl, ag, 'editor');
  insert into public.items (list_id, category, title, created_by) values (bl, 'task', 'backlog item', mk);
  insert into public.preferences (profile_id, prefs) values (mk, '{"theme":"dark"}');

  -- setup as maksym: _selftest through create_list, members through RLS
  perform public._st_as(mk);
  st := public.create_list('st-selftest', 'st-selftest', false);
  insert into public.list_members (list_id, profile_id, role) values (st, an, 'editor'), (st, ag, 'editor'), (st, tg, 'contributor');

  -- 1 anon
  perform public._st_anon();
  total := total + 3;
  v := public._st('select count(*)::text from public.items');    if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#1a ' || v || '; '; end if;
  v := public._st('select count(*)::text from public.lists');    if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#1b ' || v || '; '; end if;
  v := public._st('select count(*)::text from public.profiles'); if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#1c ' || v || '; '; end if;

  -- 2 maksym creates; created_by from the login, version 1, one create event
  perform public._st_as(mk);
  insert into public.items (list_id, category, title, created_by) values (st, 'task', 'selftest item', an) returning id into i1;
  total := total + 1;
  v := public._st(format('select created_by::text || ''/'' || version || ''/'' || (select count(*) from public.item_events e where e.item_id = %L and e.action = ''create'') from public.items where id = %L', i1, i1));
  if v = mk::text || '/1/1' then pass := pass + 1; else f := f || '#2 ' || v || '; '; end if;

  -- 3 anastasiia sees the same lists as maksym
  v := public._st('select count(*)::text from public.lists');
  perform public._st_as(an);
  total := total + 1;
  if public._st('select count(*)::text from public.lists') = v and v = '2' then pass := pass + 1; else f := f || '#3 mk=' || v || '; '; end if;

  -- 4 anastasiia edits, moves, completes, reopens Maksym's item
  total := total + 2;
  perform public._st(format('update public.items set title = ''edited by an'' where id = %L', i1));
  perform public._st(format('update public.items set quadrant = ''A'' where id = %L', i1));
  perform public._st(format('update public.items set status = ''done'' where id = %L', i1));
  perform public._st(format('update public.items set status = ''open'' where id = %L', i1));
  v := public._st(format('select version::text from public.items where id = %L', i1));
  if v = '5' then pass := pass + 1; else f := f || '#4a version=' || v || '; '; end if;
  v := public._st(format('select string_agg(action, '','' order by id) from public.item_events where item_id = %L', i1));
  if v = 'create,update,move,complete,reopen' then pass := pass + 1; else f := f || '#4b ' || v || '; '; end if;

  -- 5 anastasiia creates her own item, soft-deletes and restores it
  insert into public.items (list_id, category, title) values (st, 'task', 'an item') returning id into i2;
  total := total + 1;
  perform public._st(format('update public.items set deleted_at = now() where id = %L', i2));
  perform public._st(format('update public.items set deleted_at = null where id = %L', i2));
  v := public._st(format('select string_agg(action, '','' order by id) from public.item_events where item_id = %L', i2));
  if v = 'create,delete,restore' then pass := pass + 1; else f := f || '#5 ' || v || '; '; end if;

  -- 6 preferences: own ok; Maksym's invisible; writing Maksym's refused
  total := total + 3;
  v := public._st(format('insert into public.preferences (profile_id, prefs) values (%L, ''{"theme":"light"}'')', an));
  if v = 'ok:1' then pass := pass + 1; else f := f || '#6a ' || v || '; '; end if;
  v := public._st(format('select count(*)::text from public.preferences where profile_id = %L', mk));
  if v = '0' then pass := pass + 1; else f := f || '#6b ' || v || '; '; end if;
  v := public._st(format('insert into public.preferences (profile_id, app, prefs) values (%L, ''other'', ''{}'')', mk));
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#6c ' || v || '; '; end if;

  -- 7 stale version filter
  total := total + 1;
  v := public._st(format('update public.items set title = ''stale'' where id = %L and version = 1', i1));
  if v = 'ok:0' then pass := pass + 1; else f := f || '#7 ' || v || '; '; end if;

  -- 8 telegram-bot inserts: agent, unverified
  perform public._st_as(tg);
  insert into public.items (list_id, category, title, created_via) values (st, 'task', 'from telegram', 'telegram') returning id into i3;
  total := total + 1;
  v := public._st(format('select actor_kind || ''/'' || validation from public.items where id = %L', i3));
  if v = 'agent/unverified' then pass := pass + 1; else f := f || '#8 ' || v || '; '; end if;

  -- 9 telegram-bot cannot update Maksym's item; 10 cannot see Backlog; 21 cannot soft-delete its own
  total := total + 3;
  v := public._st(format('update public.items set title = ''tg edit'' where id = %L', i1));
  if v = 'ok:0' then pass := pass + 1; else f := f || '#9 ' || v || '; '; end if;
  v := public._st(format('select count(*)::text from public.items where list_id = %L', bl));
  if v = '0' then pass := pass + 1; else f := f || '#10 ' || v || '; '; end if;
  v := public._st(format('update public.items set deleted_at = now() where id = %L', i3));
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#21 ' || v || '; '; end if;

  -- 11-13, 22, 23 homeos-agent
  perform public._st_as(ag);
  total := total + 9;
  v := public._st(format('update public.items set body_md = ''agent note'' where id = %L', i1));
  if v = 'ok:1' then pass := pass + 1; else f := f || '#11a ' || v || '; '; end if;
  v := public._st(format('update public.items set deleted_at = now() where id = %L', i1));
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#11b ' || v || '; '; end if;
  v := public._st(format('insert into public.list_members (list_id, profile_id, role) values (%L, %L, ''viewer'')', bl, tg));
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#12a ' || v || '; '; end if;
  v := public._st('select public.create_list(''agent list'')::text');
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#12b ' || v || '; '; end if;
  v := public._st(format('update public.items set validation = ''verified'' where id = %L', i3));
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#13 ' || v || '; '; end if;
  v := public._st(format('insert into public.items (list_id, category, title, created_via, review_state) values (%L, ''task'', ''x'', ''skill:task-intake'', ''confirmed'')', st));
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#22a ' || v || '; '; end if;
  v := public._st(format('update public.items set review_state = ''confirmed'' where id = %L', i3));
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#22b ' || v || '; '; end if;
  v := public._st(format('insert into public.items (list_id, category, title) values (%L, ''task'', ''x'')', st));
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#23a ' || v || '; '; end if;
  v := public._st(format('insert into public.items (list_id, category, title, created_via, on_behalf_of) values (%L, ''task'', ''for max'', ''skill:task-intake'', %L)', st, mk));
  if v = 'ok:1' then pass := pass + 1; else f := f || '#11c on_behalf_of ' || v || '; '; end if;

  -- 17, 26 keep-alive as agent; email column refused
  total := total + 3;
  v := public._st('select public.keepalive(''selftest'')::text');
  if v not like 'ERR%' then pass := pass + 1; else f := f || '#17 ' || v || '; '; end if;
  v := public._st('select count(*)::text from public.keepalive_status()');
  if v ~ '^[1-9]' then pass := pass + 1; else f := f || '#26a ' || v || '; '; end if;
  v := public._st('select string_agg(email, '','') from public.profiles');
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#26b ' || v || '; '; end if;

  -- 14, 15, 16, 18, 20, 23b, 24, 25 as maksym
  perform public._st_as(mk);
  total := total + 9;
  v := public._st(format('insert into public.items (list_id, category, title, body_md) values (%L, ''task'', ''card'', ''pay 4111 1111 1111 1111'')', st));
  if v like 'ERR 22023%' then pass := pass + 1; else f := f || '#14 ' || v || '; '; end if;
  v := public._st(format('insert into public.items (list_id, category, title, dedup_key) values (%L, ''task'', ''order R127909533'', ''st:dup'')', st));
  if v = 'ok:1' then pass := pass + 1; else f := f || '#15 ' || v || '; '; end if;
  v := public._st('select public.keepalive(''mk'')::text');
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#16 ' || v || '; '; end if;
  v := public._st(format('delete from public.items where id = %L', i1));
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#18 ' || v || '; '; end if;
  v := public._st(format('insert into public.items (list_id, category, title, dedup_key) values (%L, ''task'', ''dup'', ''st:dup'')', st));
  if v like 'ERR 23505%' then pass := pass + 1; else f := f || '#20 ' || v || '; '; end if;
  v := public._st(format('insert into public.items (list_id, category, title, created_via) values (%L, ''task'', ''x'', ''migration'')', st));
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#23b ' || v || '; '; end if;
  v := public._st(format('insert into public.items (list_id, category, title, body_md) values (%L, ''task'', ''reel'', ''https://www.facebook.com/reel/921326843740504 order 111-1234567-1234567'')', st));
  if v = 'ok:1' then pass := pass + 1; else f := f || '#24 ' || v || '; '; end if;
  v := public._st(format('delete from public.list_members where list_id = %L and profile_id = %L', st, tg));
  if v = 'ok:1' then pass := pass + 1; else f := f || '#25a ' || v || '; '; end if;
  v := public._st(format('insert into public.list_members (list_id, profile_id, role) values (%L, %L, ''contributor'')', st, tg));
  if v = 'ok:1' then pass := pass + 1; else f := f || '#25b ' || v || '; '; end if;

  -- 25c telegram-bot cannot remove anastasiia
  perform public._st_as(tg);
  total := total + 1;
  v := public._st(format('delete from public.list_members where list_id = %L and profile_id = %L', st, an));
  if v = 'ok:0' then pass := pass + 1; else f := f || '#25c ' || v || '; '; end if;

  -- 19 anastasiia as viewer cannot update
  perform public._st_as(mk);
  perform public._st(format('update public.list_members set role = ''viewer'' where list_id = %L and profile_id = %L', st, an));
  perform public._st_as(an);
  total := total + 1;
  v := public._st(format('update public.items set title = ''viewer edit'' where id = %L', i1));
  if v = 'ok:0' then pass := pass + 1; else f := f || '#19 ' || v || '; '; end if;

  -- 28-35 fixes from the B5 review
  perform public._st_as(mk);
  total := total + 6;
  v := public._st(format('update public.list_members set role = ''editor'' where list_id = %L and profile_id = %L', bl, an));
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#28 demote owner ' || v || '; '; end if;
  v := public._st(format('delete from public.list_members where list_id = %L and profile_id = %L', bl, an));
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#29 remove owner ' || v || '; '; end if;
  v := public._st(format('update public.items set review_state = ''confirmed'' where id = %L', i3));
  if v = 'ok:1' then pass := pass + 1; else f := f || '#30a human confirms ' || v || '; '; end if;
  sa := public.create_list('st-archived', 'st-archived', false);
  perform public._st(format('update public.lists set archived_at = now() where id = %L', sa));
  v := public._st(format('insert into public.items (list_id, category, title) values (%L, ''task'', ''late'')', sa));
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#32 archived list ' || v || '; '; end if;
  v := public._st(format('insert into public.items (list_id, category, title, tags) values (%L, ''task'', ''tagged'', ''{4111111111111111}'')', st));
  if v like 'ERR 22023%' then pass := pass + 1; else f := f || '#34 card in tags ' || v || '; '; end if;
  v := public._st(format('select added_by::text from public.list_members where list_id = %L and profile_id = %L', st, tg));
  if v = mk::text then pass := pass + 1; else f := f || '#35 added_by ' || v || '; '; end if;
  perform public._st_as(ag);
  total := total + 2;
  v := public._st(format('update public.items set review_state = ''none'' where id = %L', i3));
  if v like 'ERR 42501%' then pass := pass + 1; else f := f || '#30b agent undoes review ' || v || '; '; end if;
  v := public._st(format('update public.items set title = ''agent rewrite'' where id = %L', i2));
  v := public._st(format('select validation from public.items where id = %L', i2));
  if v = 'unverified' then pass := pass + 1; else f := f || '#31 verified after agent edit ' || v || '; '; end if;
  perform public._st_as(nx);
  total := total + 3;
  v := public._st('select count(*)::text from public.profiles');
  if v = '0' then pass := pass + 1; else f := f || '#33a no-profile reads profiles ' || v || '; '; end if;
  v := public._st('select count(*)::text from public.categories');
  if v = '0' then pass := pass + 1; else f := f || '#33b no-profile reads categories ' || v || '; '; end if;
  v := public._st('select count(*)::text from public.keepalive_status()');
  if v = '0' then pass := pass + 1; else f := f || '#33c no-profile reads keepalive ' || v || '; '; end if;

  -- 17b, 18b, 27 privileges (admin)
  perform public._st_as(null);
  total := total + 4;
  if not has_schema_privilege('authenticated', 'ops', 'usage') then pass := pass + 1; else f := f || '#17b ops usage; '; end if;
  if not has_table_privilege('authenticated', 'public.items', 'delete') then pass := pass + 1; else f := f || '#18b delete grant; '; end if;
  if not has_function_privilege('authenticated', 'public.assert_no_sensitive(text)', 'execute') then pass := pass + 1; else f := f || '#27 rpc; '; end if;
  if not has_table_privilege('anon', 'public.items', 'select') then pass := pass + 1; else f := f || '#1d anon grant; '; end if;
  total := total + 1;
  if not has_function_privilege('authenticated', 'public.items_before_write()', 'execute') then pass := pass + 1; else f := f || '#36 trigger fn grant; '; end if;

  -- 37 sort_key (db/005): an owner sets it and reads it back
  perform public._st_as(mk);
  total := total + 1;
  v := public._st(format('update public.items set sort_key = 512.5 where id = %L', i1));
  v := v || '/' || public._st(format('select sort_key::text from public.items where id = %L', i1));
  if v = 'ok:1/512.5' then pass := pass + 1; else f := f || '#37 sort_key ' || v || '; '; end if;

  -- 38 archived list (db/006): a person cannot update its items; admin SQL still can
  perform public._st_as(null);
  insert into public.items (list_id, category, title, created_by) values (sa, 'task', 'frozen', mk) returning id into i4;
  perform public._st_as(mk);
  total := total + 1;
  v := public._st(format('update public.items set title = ''thawed'' where id = %L', i4));
  perform public._st_as(null);
  v := v || ' / admin ' || public._st(format('update public.items set title = ''admin edit'' where id = %L', i4));
  if v like 'ERR 42501%this list is archived% / admin ok:1' then pass := pass + 1; else f := f || '#38 archived list ' || v || '; '; end if;

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %', pass, total, coalesce(nullif(f, ''), 'none');
end $do$;
