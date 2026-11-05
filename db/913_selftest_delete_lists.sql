-- db/913_selftest_delete_lists.sql: delete_archived_list, the owner-row guard and the backup time (db/029) as admin SQL. Rolls
-- everything back and reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-912.
-- Cases: R refusals; D the delete and everything hanging on it; O the owner guard; B the backup time; F every foreign key to
-- items and lists is handled; P rights. Fixtures: H1, H2 (household people), allowlist rows; homeos-agent acts inside the
-- rolled-back transaction. Run after 029, 003, 011, the 012 policy block, 026 and 900-912.

do $do$
declare
  h1 uuid := gen_random_uuid(); h2 uuid := gen_random_uuid(); ag uuid;
  doomed uuid; other uuid; live uuid; sys uuid; catl uuid; d1 uuid; d2 uuid; o1 uuid; deftl uuid; tg uuid; req uuid; v text; n int;
begin
  select id into ag from public.profiles where handle = 'homeos-agent';
  if ag is null then raise exception 'SELFTEST 0 of 1 passed (rolled back). Failures: no homeos-agent profile'; end if;

  execute $f$create function public._dl_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
      set local role authenticated; end $b$$f$;
  execute $f$create function public._dl(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute $f$create function public._dl_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('dl.total', (coalesce(nullif(current_setting('dl.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('dl.nf', (coalesce(nullif(current_setting('dl.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('dl.f', coalesce(current_setting('dl.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  execute 'grant execute on function public._dl_as(uuid), public._dl(text), public._dl_chk(text, text, text) to authenticated';
  perform set_config('dl.total', '0', true); perform set_config('dl.nf', '0', true); perform set_config('dl.f', '', true);

  insert into ops.signup_allowlist (email_lower, kind, is_household) values
    ('st-dl-h1@example.invalid', 'human', true), ('st-dl-h2@example.invalid', 'human', true);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1, 'st-dl-h1@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (h2, 'st-dl-h2@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  update public.profiles set handle = 'st-dl-h1' where id = h1;
  update public.profiles set handle = 'st-dl-h2' where id = h2;

  perform public._dl_as(h1);
  doomed := public.create_list('st-dl doomed', 'st-dl-doomed', true);
  other := public.create_list('st-dl other', 'st-dl-other', true);
  live := public.create_list('st-dl live', 'st-dl-live', true);
  sys := public.create_list('_st-dl sys', '_st-dl-sys', true);
  catl := public.create_list('st-dl cat', 'st-dl-cat', true);
  insert into public.items (list_id, category, title, created_by) values (doomed, 'task', 'st-dl d1', h1) returning id into d1;
  insert into public.items (list_id, category, title, created_by) values (doomed, 'task', 'st-dl d2', h1) returning id into d2;
  insert into public.items (list_id, category, title, created_by) values (other, 'task', 'st-dl o1', h1) returning id into o1;

  -- everything that can hang on an item, as admin
  reset role;
  insert into public.item_links (from_item, to_item, kind) values (d2, d1, 'depends_on'), (o1, d1, 'depends_on'), (d2, o1, 'depends_on');
  insert into public.item_refs (item_id, kind, target) values (d1, 'url', 'https://example.invalid/st-dl');
  insert into public.notification_deliveries (item_id, profile_id, channel, for_day) values (d1, h1, 'local', current_date);
  select id into deftl from public.tag_lists where owner_id = h1 and is_default limit 1;
  insert into public.tags (tag_list_id, name) values (deftl, 'st-dl-tag') returning id into tg;
  insert into public.item_tags (item_id, tag_id) values (d1, tg);
  insert into public.users_pending_for_decision (user_id, email, status, item_id) values (h2, 'st-dl-h2@example.invalid', 'declined', d2) returning id into req;
  update public.items set deleted_at = now() where id = d2;
  update public.lists set archived_at = now() where id in (doomed, sys, catl);
  update public.categories set default_list_id = catl where slug = (select slug from public.categories order by slug limit 1);

  -- ---------- refusals ----------
  perform public._dl_as(h2);
  perform public._dl_chk('R1 an editor is refused', public._dl(format('select public.delete_archived_list(%L)::text', doomed)), 'ERR 42501%owner%');
  perform public._dl_as(ag);
  perform public._dl_chk('R2 an agent is refused', public._dl(format('select public.delete_archived_list(%L)::text', doomed)), 'ERR 42501%people%');
  perform public._dl_as(h1);
  perform public._dl_chk('R3 a live list is refused', public._dl(format('select public.delete_archived_list(%L)::text', live)), 'ERR 55000%archive%');
  perform public._dl_chk('R4 a system list is refused', public._dl(format('select public.delete_archived_list(%L)::text', sys)), 'ERR 42501%system%');
  perform public._dl_chk('R5 a category default is refused', public._dl(format('select public.delete_archived_list(%L)::text', catl)), 'ERR 23503%category%');
  perform public._dl_chk('R6 no such list', public._dl(format('select public.delete_archived_list(%L)::text', gen_random_uuid())), 'ERR 22023%');
  perform public._dl_chk('R7 no client delete on lists', public._dl(format('delete from public.lists where id = %L', doomed)), 'ERR 42501%');
  perform public._dl_chk('R8 no client delete on items', public._dl(format('delete from public.items where id = %L', d1)), 'ERR 42501%');

  -- ---------- owner guard ----------
  -- RLS hides the row or the trigger refuses it, depending on the path: what counts is that the row stays
  v := public._dl(format('delete from public.list_members where list_id = %L and profile_id = %L', doomed, h1));
  perform public._dl_chk('O1 a direct delete of the owner row removes nothing', v, CASE WHEN v LIKE 'ERR 42501%' THEN '%' ELSE 'ok:0' END);
  reset role;
  perform public._dl_chk('O2 the owner row stays', (select count(*)::text from public.list_members where list_id = doomed and profile_id = h1), '1');
  -- the trigger itself, past RLS: with a JWT claim set and no flag
  perform set_config('td.deleting_list', '', true);
  perform public._dl_chk('O3 the trigger refuses without the flag',
    public._dl(format('delete from public.list_members where list_id = %L and profile_id = %L', doomed, h1)), 'ERR 42501%owners%');
  perform public._dl_as(h1);
  perform public._dl_chk('O4 the guard treats a missing setting as no flag',
    (select (pg_get_functiondef('public.members_keep_owner()'::regprocedure) like '%coalesce(current_setting(''td.deleting_list'', true), '''')%')::text), 'true');

  -- ---------- the delete ----------
  v := public._dl(format('select public.delete_archived_list(%L)::text', doomed));
  perform public._dl_chk('D1 returns the name', v, '%"name": "st-dl doomed"%');
  perform public._dl_chk('D2 counts soft-deleted items too', v, '%"items": 2%');
  perform public._dl_chk('D3 the flag is cleared', coalesce(nullif(current_setting('td.deleting_list', true), ''), 'empty'), 'empty');
  reset role;
  perform public._dl_chk('D4 the list is gone', (select count(*)::text from public.lists where id = doomed), '0');
  perform public._dl_chk('D5 members are gone', (select count(*)::text from public.list_members where list_id = doomed), '0');
  perform public._dl_chk('D6 items are gone', (select count(*)::text from public.items where id in (d1, d2)), '0');
  perform public._dl_chk('D7 links on either end are gone', (select count(*)::text from public.item_links where from_item in (d1, d2) or to_item in (d1, d2)), '0');
  perform public._dl_chk('D8 refs are gone', (select count(*)::text from public.item_refs where item_id in (d1, d2)), '0');
  perform public._dl_chk('D9 tags on items are gone', (select count(*)::text from public.item_tags where item_id in (d1, d2)), '0');
  perform public._dl_chk('D10 events are gone', (select count(*)::text from public.item_events where item_id in (d1, d2)), '0');
  perform public._dl_chk('D11 deliveries are gone', (select count(*)::text from public.notification_deliveries where item_id in (d1, d2)), '0');
  perform public._dl_chk('D12 the access request stays with no item', (select (item_id is null)::text from public.users_pending_for_decision where id = req), 'true');
  perform public._dl_chk('D13 the other list and its item stay', (select count(*)::text from public.items where id = o1 and list_id = other), '1');
  perform public._dl_chk('D14 the tag itself stays', (select count(*)::text from public.tags where id = tg), '1');

  -- ---------- backup time ----------
  delete from ops.settings where key = 'last_backup_at';
  perform public._dl_as(h1);
  perform public._dl_chk('B1 null before a backup', public._dl('select public.last_backup_at()::text'), 'null');
  reset role;
  perform ops.record_backup();
  perform public._dl_as(h1);
  perform public._dl_chk('B2 set after record_backup', public._dl('select (public.last_backup_at() > now() - interval ''1 minute'')::text'), 'true');
  perform public._dl_chk('B3 a person cannot record one', public._dl('select ops.record_backup()::text'), 'ERR 42501%');
  reset role;

  -- ---------- every foreign key to items and lists is handled ----------
  perform public._dl_chk('F1 no unhandled foreign key to items',
    (select coalesce(string_agg(c.conrelid::regclass::text, ',' order by c.conrelid::regclass::text), 'none')
       from pg_constraint c
      where c.contype = 'f' and c.confrelid = 'public.items'::regclass and c.confdeltype = 'a'
        and c.conrelid::regclass::text not in ('item_links', 'item_tags', 'item_refs', 'item_events', 'notification_deliveries', 'users_pending_for_decision',
                                               'public.item_links', 'public.item_tags', 'public.item_refs', 'public.item_events', 'public.notification_deliveries', 'public.users_pending_for_decision')),
    'none');
  perform public._dl_chk('F2 no unhandled foreign key to lists',
    (select coalesce(string_agg(c.conrelid::regclass::text, ',' order by c.conrelid::regclass::text), 'none')
       from pg_constraint c
      where c.contype = 'f' and c.confrelid = 'public.lists'::regclass and c.confdeltype = 'a'
        and c.conrelid::regclass::text not in ('items', 'categories', 'public.items', 'public.categories')),
    'none');

  -- ---------- rights ----------
  perform public._dl_chk('P1 definers with an empty search_path',
    (select string_agg(p.proname || ':' || p.prosecdef || ':' || (coalesce(p.proconfig, '{}') @> array['search_path=""']), ',' order by p.proname)
       from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where (s.nspname = 'public' and p.proname in ('delete_archived_list', 'last_backup_at')) or (s.nspname = 'ops' and p.proname = 'record_backup')),
    'delete_archived_list:true:true,last_backup_at:true:true,record_backup:true:true');
  perform public._dl_chk('P2 anon runs nothing, authenticated runs the two',
    has_function_privilege('anon', 'public.delete_archived_list(uuid)', 'execute')::text || '/'
    || has_function_privilege('anon', 'public.last_backup_at()', 'execute')::text || '/'
    || has_function_privilege('authenticated', 'public.delete_archived_list(uuid)', 'execute')::text || '/'
    || has_function_privilege('authenticated', 'public.last_backup_at()', 'execute')::text || '/'
    || has_function_privilege('authenticated', 'ops.record_backup()', 'execute')::text,
    'false/false/true/true/false');
  if exists (select 1 from pg_roles where rolname = 'tasksdb_backup') then
    perform public._dl_chk('P3 the backup role may record the time', has_function_privilege('tasksdb_backup', 'ops.record_backup()', 'execute')::text, 'true');
  end if;

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('dl.total')::int - current_setting('dl.nf')::int,
    current_setting('dl.total'), coalesce(nullif(current_setting('dl.f'), ''), 'none');
end $do$;
