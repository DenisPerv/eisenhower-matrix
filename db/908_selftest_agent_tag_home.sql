-- db/908_selftest_agent_tag_home.sql: the agent home tag list selftest (HomeOS tags-round-plan.md #2b, db/023) as admin
-- SQL. Rolls everything back and reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text,
-- like 900-907. Cases: A1 an agent with a home row files by-name tags there (reuses, revives, creates) and never touches
-- the person's default; A2 on behalf of the other person, the home list too; A3 an UPDATE files there too; A4 no row ->
-- the default (old rule); A5 a person writer is unchanged; A6 a home the agent cannot edit, A7 an archived home: 42501;
-- G1 archive, G2 merge away refused (merge into it allowed), G3 the agent's membership stays (remove, lower, leave, admin);
-- T1 ops.agent_tag_home closed to authenticated, T2 agents only; R rights. Fixtures: H1, H2 (household people), AG, AG2
-- (agents) through allowlist rows; nothing real is read or changed. Run after 023, 003, 011, the 012 policy block and
-- 900-907.

do $do$
declare
  h1 uuid := gen_random_uuid(); h2 uuid := gen_random_uuid(); ag uuid := gen_random_uuid(); ag2 uuid := gen_random_uuid();
  hl uuid; h1def uuid; h2def uuid; home uuid; tl2 uuid; tl3 uuid; tl4 uuid; t_reuse uuid; t_gone uuid; t_def uuid;
  i1 uuid; i2 uuid; i3 uuid; i4 uuid; v text; n1 int; n2 int;
begin
  execute $f$create function public._ah_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true);
      else perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
           set local role authenticated; end if; end $b$$f$;
  execute $f$create function public._ah(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute $f$create function public._ah_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('ah.total', (coalesce(nullif(current_setting('ah.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('ah.nf', (coalesce(nullif(current_setting('ah.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('ah.f', coalesce(current_setting('ah.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  -- the tag lists an item's live tags sit in, as a sorted string of 'name@list'
  execute $f$create function public._ah_tags(p_item uuid) returns text language sql as $b$
    select coalesce(string_agg(t.name || '@' || l.name, ',' order by lower(t.name), t.name), '-')
      from public.item_tags it join public.tags t on t.id = it.tag_id join public.tag_lists l on l.id = t.tag_list_id
     where it.item_id = p_item and it.removed_at is null $b$$f$;
  execute 'grant execute on function public._ah_as(uuid), public._ah(text), public._ah_chk(text, text, text), public._ah_tags(uuid) to authenticated';
  perform set_config('ah.total', '0', true); perform set_config('ah.nf', '0', true); perform set_config('ah.f', '', true);

  -- ---------- fixtures (admin) ----------
  insert into ops.signup_allowlist (email_lower, kind, is_household) values
    ('st-ah-h1@example.invalid', 'human', true), ('st-ah-h2@example.invalid', 'human', true),
    ('st-ah-ag@example.invalid', 'agent', true), ('st-ah-ag2@example.invalid', 'agent', true);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1,  'st-ah-h1@example.invalid',  'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (h2,  'st-ah-h2@example.invalid',  'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (ag,  'st-ah-ag@example.invalid',  'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (ag2, 'st-ah-ag2@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  select id into h1def from public.tag_lists where owner_id = h1 and is_default;
  select id into h2def from public.tag_lists where owner_id = h2 and is_default;
  perform public._ah_as(h1);
  hl := public.create_list('st-ah household', 'st-ah-household', true);
  home := (public.create_tag_list('st-ah home') ->> 'id')::uuid;
  tl2  := (public.create_tag_list('st-ah not editable') ->> 'id')::uuid;
  tl3  := (public.create_tag_list('st-ah archived') ->> 'id')::uuid;
  tl4  := (public.create_tag_list('st-ah merge in') ->> 'id')::uuid;
  insert into public.tags (tag_list_id, name) values (home, 'st-ah-reuse') returning id into t_reuse;
  insert into public.tags (tag_list_id, name) values (home, 'st-ah-gone') returning id into t_gone;
  insert into public.tags (tag_list_id, name) values (h1def, 'st-ah-reuse') returning id into t_def;
  insert into public.tags (tag_list_id, name) values (tl4, 'st-ah-m') ;
  update public.tags set deleted_at = now() where id = t_gone;
  perform public.set_tag_list_archived(tl3, true);
  perform public._ah_as(null);
  insert into public.list_members (list_id, profile_id, role) values (hl, ag, 'editor'), (hl, ag2, 'editor') on conflict do nothing;
  insert into public.tag_list_members (tag_list_id, profile_id, role) values
    (h1def, ag, 'editor'), (h2def, ag, 'editor'), (h1def, ag2, 'editor'), (home, ag, 'editor'), (home, h2, 'viewer'),
    (tl3, ag2, 'editor');
  insert into ops.agent_tag_home (agent_id, tag_list_id) values (ag, home);
  n1 := (select count(*) from public.tags where tag_list_id = h1def);
  n2 := (select count(*) from public.tags where tag_list_id = h2def);

  -- ---------- A1 the home list: reuse, revive, create; the default untouched ----------
  perform public._ah_as(ag);
  perform public._ah_chk('A1a insert', public._ah(format('insert into public.items (list_id, category, title, created_via, on_behalf_of, tags) values (%L, ''task'', ''st-ah a1'', ''skill:st-ah'', %L, ''{st-ah-reuse,st-ah-gone,St-Ah-New}'')', hl, h1)), 'ok:1');
  perform public._ah_as(null);
  select id into i1 from public.items where list_id = hl and title = 'st-ah a1';
  perform public._ah_chk('A1b all three in the home list', public._ah_tags(i1), 'st-ah-gone@st-ah home,St-Ah-New@st-ah home,st-ah-reuse@st-ah home');
  perform public._ah_chk('A1c the same tag reused and the soft-deleted one revived',
    (select count(*) from public.item_tags where item_id = i1 and tag_id in (t_reuse, t_gone))::text || '/'
    || (select (deleted_at is null)::text from public.tags where id = t_gone) || '/'
    || (select count(*) from public.tags where tag_list_id = home and lower(name) = 'st-ah-new')::text, '2/true/1');
  perform public._ah_chk('A1d the default list untouched', (select count(*) from public.tags where tag_list_id = h1def)::text || '/'
    || (select count(*) from public.item_tags where tag_id = t_def)::text || '/' || n1, n1 || '/0/' || n1);
  perform public._ah_chk('A1e items.tags cleared', (select cardinality(tags)::text from public.items where id = i1), '0');

  -- ---------- A2 on behalf of the other person ----------
  perform public._ah_as(ag);
  perform public._ah_chk('A2a insert', public._ah(format('insert into public.items (list_id, category, title, created_via, on_behalf_of, tags) values (%L, ''task'', ''st-ah a2'', ''skill:st-ah'', %L, ''{st-ah-two}'')', hl, h2)), 'ok:1');
  perform public._ah_as(null);
  select id into i2 from public.items where list_id = hl and title = 'st-ah a2';
  perform public._ah_chk('A2b home list, not H2''s default', public._ah_tags(i2) || '/' || (select count(*) from public.tags where tag_list_id = h2def), 'st-ah-two@st-ah home/' || n2);

  -- ---------- A3 an update files into the home list too ----------
  perform public._ah_as(ag);
  perform public._ah_chk('A3a update', public._ah(format('update public.items set tags = ''{st-ah-upd}'' where id = %L', i2)), 'ok:1');
  perform public._ah_as(null);
  perform public._ah_chk('A3b added to the home list', public._ah_tags(i2), 'st-ah-two@st-ah home,st-ah-upd@st-ah home');

  -- ---------- A4 no home row: the default (old rule) ----------
  perform public._ah_as(ag2);
  perform public._ah_chk('A4a insert', public._ah(format('insert into public.items (list_id, category, title, created_via, on_behalf_of, tags) values (%L, ''task'', ''st-ah a4'', ''skill:st-ah'', %L, ''{st-ah-reuse}'')', hl, h1)), 'ok:1');
  perform public._ah_as(null);
  select id into i3 from public.items where list_id = hl and title = 'st-ah a4';
  perform public._ah_chk('A4b H1''s default, its own tag', public._ah_tags(i3) || '/' || (select count(*) from public.item_tags where item_id = i3 and tag_id = t_def),
    'st-ah-reuse@' || (select name from public.tag_lists where id = h1def) || '/1');

  -- ---------- A5 a person writer is unchanged ----------
  perform public._ah_as(h1);
  perform public._ah_chk('A5a insert', public._ah(format('insert into public.items (list_id, category, title, tags) values (%L, ''task'', ''st-ah a5'', ''{st-ah-person}'')', hl)), 'ok:1');
  perform public._ah_as(null);
  select id into i4 from public.items where list_id = hl and title = 'st-ah a5';
  perform public._ah_chk('A5b H1''s default', public._ah_tags(i4), 'st-ah-person@' || (select name from public.tag_lists where id = h1def));

  -- ---------- A6, A7 a home the agent cannot write ----------
  insert into ops.agent_tag_home (agent_id, tag_list_id) values (ag2, tl2);
  perform public._ah_as(ag2);
  perform public._ah_chk('A6 not an editor of its home', public._ah(format('insert into public.items (list_id, category, title, created_via, on_behalf_of, tags) values (%L, ''task'', ''st-ah a6'', ''skill:st-ah'', %L, ''{st-ah-six}'')', hl, h1)),
    'ERR 42501 agent tag home not writable');
  perform public._ah_as(null);
  update ops.agent_tag_home set tag_list_id = tl3 where agent_id = ag2;
  perform public._ah_as(ag2);
  perform public._ah_chk('A7 an archived home', public._ah(format('insert into public.items (list_id, category, title, created_via, on_behalf_of, tags) values (%L, ''task'', ''st-ah a7'', ''skill:st-ah'', %L, ''{st-ah-seven}'')', hl, h1)),
    'ERR 42501 agent tag home not writable');
  perform public._ah_as(null);
  perform public._ah_chk('A6c nothing written', (select count(*)::text from public.items where list_id = hl and title in ('st-ah a6', 'st-ah a7'))
    || '/' || (select count(*)::text from public.tags where name in ('st-ah-six', 'st-ah-seven')), '0/0');
  delete from ops.agent_tag_home where agent_id = ag2;

  -- ---------- G1, G2 archive and merge away ----------
  perform public._ah_as(h1);
  perform public._ah_chk('G1 archive refused', public._ah(format('select public.set_tag_list_archived(%L, true)::text', home)), 'ERR 22023%');
  perform public._ah_chk('G2a merge away refused', public._ah(format('select public.merge_tag_lists(%L, %L)::text', home, h1def)), 'ERR 22023%');
  perform public._ah_as(null);
  perform public._ah_chk('G2b the home list and its tags stay',
    (select (archived_at is null)::text from public.tag_lists where id = home) || '/'
    || (select count(*) from public.tags where tag_list_id = home and deleted_at is null)::text || '/'
    || (select count(*) from public.tags where tag_list_id = h1def)::text, 'true/5/' || (n1 + 1));
  perform public._ah_chk('G2c an admin archive is refused too', public._ah(format('update public.tag_lists set archived_at = now() where id = %L', home)), 'ERR 22023%');
  perform public._ah_as(h1);
  perform public._ah_chk('G2d merging another list into it is allowed', public._ah(format('select (public.merge_tag_lists(%L, %L) ->> ''ok'')', tl4, home)), 'true');
  perform public._ah_chk('G2e the home list may be renamed', public._ah(format('update public.tag_lists set name = ''st-ah home 2'' where id = %L', home)), 'ok:1');

  -- ---------- G3 the agent's membership stays ----------
  perform public._ah_chk('G3a the owner cannot remove it', public._ah(format('delete from public.tag_list_members where tag_list_id = %L and profile_id = %L', home, ag)), 'ERR 42501%');
  perform public._ah_chk('G3b nor lower its role', public._ah(format('update public.tag_list_members set role = ''viewer'' where tag_list_id = %L and profile_id = %L', home, ag)), 'ERR 42501%');
  perform public._ah_chk('G3c other members still go', public._ah(format('delete from public.tag_list_members where tag_list_id = %L and profile_id = %L', home, h2)), 'ok:1');
  perform public._ah_as(ag);
  perform public._ah_chk('G3d the agent cannot leave', public._ah(format('select public.leave_tag_list(%L)::text', home)), 'ERR 42501%');
  perform public._ah_as(null);
  perform public._ah_chk('G3e nor admin SQL while the row is there', public._ah(format('delete from public.tag_list_members where tag_list_id = %L and profile_id = %L', home, ag)), 'ERR 42501%');
  perform public._ah_chk('G3f still an editor', (select role from public.tag_list_members where tag_list_id = home and profile_id = ag), 'editor');
  perform public._ah_chk('G3g the agent leaves its old default as before', public._ah(format('delete from public.tag_list_members where tag_list_id = %L and profile_id = %L', h2def, ag)), 'ok:1');

  -- ---------- T1, T2 the table ----------
  perform public._ah_as(h1);
  perform public._ah_chk('T1a a person cannot read or write it', public._ah('select count(*)::text from ops.agent_tag_home') || '|'
    || public._ah(format('insert into ops.agent_tag_home (agent_id, tag_list_id) values (%L, %L)', ag2, home)), 'ERR 42501%|ERR 42501%');
  perform public._ah_as(ag);
  perform public._ah_chk('T1b nor an agent', public._ah('select count(*)::text from ops.agent_tag_home') || '|'
    || public._ah(format('update ops.agent_tag_home set tag_list_id = %L where agent_id = %L', h1def, ag)), 'ERR 42501%|ERR 42501%');
  perform public._ah_as(null);
  perform public._ah_chk('T2 agents only', public._ah(format('insert into ops.agent_tag_home (agent_id, tag_list_id) values (%L, %L)', h1, home)), 'ERR 22023%');

  -- ---------- R rights ----------
  perform public._ah_chk('R1 definers with an empty search_path',
    (select string_agg(p.proname || ':' || p.prosecdef || ':' || (coalesce(p.proconfig, '{}') @> array['search_path=""']), ',' order by p.proname)
       from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' and p.proname in ('agent_tag_home_check', 'items_tags_compat_after', 'tag_lists_home_guard', 'tag_members_keep_home')),
    'agent_tag_home_check:true:true,items_tags_compat_after:true:true,tag_lists_home_guard:true:true,tag_members_keep_home:true:true');
  perform public._ah_chk('R2 no grants',
    has_table_privilege('authenticated', 'ops.agent_tag_home', 'select')::text || '/' || has_table_privilege('anon', 'ops.agent_tag_home', 'select')::text || '/'
    || has_function_privilege('authenticated', 'public.tag_members_keep_home()', 'execute')::text || '/'
    || has_function_privilege('anon', 'public.agent_tag_home_check()', 'execute')::text, 'false/false/false/false');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('ah.total')::int - current_setting('ah.nf')::int,
    current_setting('ah.total'), coalesce(nullif(current_setting('ah.f'), ''), 'none');
end $do$;
