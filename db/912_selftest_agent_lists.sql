-- db/912_selftest_agent_lists.sql: the agent list functions selftest (db/027) as admin SQL. Rolls everything back and reports
-- "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-911. Cases: C create (owner, slug,
-- members, refused callers, bad owner, bad name, sensitive name, name taken, limit); R rename (slug kept, refused callers, not
-- a member, archived, name taken, bad name); G the people-only paths stay closed to agents; P rights. Fixtures: H1, H2
-- (household people), GU (a guest), AG2 (another agent) through allowlist rows; the real homeos-agent profile acts inside the
-- rolled-back transaction. Run after 027, 003, 011, the 012 policy block, 026 and 900-911.

do $do$
declare
  h1 uuid := gen_random_uuid(); h2 uuid := gen_random_uuid(); gu uuid := gen_random_uuid(); ag2 uuid := gen_random_uuid();
  ag uuid; shared uuid; private uuid; arch uuid; made uuid; other uuid; v text; n int;
begin
  select id into ag from public.profiles where handle = 'homeos-agent';
  if ag is null then raise exception 'SELFTEST 0 of 1 passed (rolled back). Failures: no homeos-agent profile'; end if;

  execute $f$create function public._al_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
      set local role authenticated; end $b$$f$;
  execute $f$create function public._al(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute $f$create function public._al_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('al.total', (coalesce(nullif(current_setting('al.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('al.nf', (coalesce(nullif(current_setting('al.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('al.f', coalesce(current_setting('al.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  execute 'grant execute on function public._al_as(uuid), public._al(text), public._al_chk(text, text, text) to authenticated';
  perform set_config('al.total', '0', true); perform set_config('al.nf', '0', true); perform set_config('al.f', '', true);

  insert into ops.signup_allowlist (email_lower, kind, is_household) values
    ('st-al-h1@example.invalid', 'human', true), ('st-al-h2@example.invalid', 'human', true),
    ('st-al-gu@example.invalid', 'human', false), ('st-al-ag2@example.invalid', 'agent', true);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1,  'st-al-h1@example.invalid',  'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (h2,  'st-al-h2@example.invalid',  'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (gu,  'st-al-gu@example.invalid',  'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (ag2, 'st-al-ag2@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  update public.profiles set handle = 'st-al-h1' where id = h1;
  update public.profiles set handle = 'st-al-h2' where id = h2;
  update public.profiles set handle = 'st-al-gu' where id = gu;
  update public.profiles set handle = 'st-al-ag2' where id = ag2;

  perform public._al_as(h1);
  shared := public.create_list('st-al shared', 'st-al-shared', true);
  private := public.create_list('st-al private', 'st-al-private', false);
  arch := public.create_list('st-al archived', 'st-al-archived', true);
  update public.lists set archived_at = now() where id = arch;

  -- ---------- create ----------
  perform public._al_as(ag);
  v := public._al($q$select public.agent_create_list('St-al  Made - One', 'ST-AL-H1')::text$q$);
  perform public._al_chk('C1 create returns the row', v, '%"name": "St-al  Made - One"%');
  perform public._al_chk('C1b slug from the name', v, '%"slug": "st-al-made-one"%');
  reset role;
  select id into made from public.lists where slug = 'st-al-made-one' and owner_id = h1;
  perform public._al_chk('C2 the person owns it, the agent made it',
    (select (owner_id = h1)::text || '/' || (created_by = ag)::text from public.lists where id = made), 'true/true');
  perform public._al_chk('C3 owner role',
    (select role from public.list_members where list_id = made and profile_id = h1), 'owner');
  perform public._al_chk('C4 the other household person is an editor',
    (select role from public.list_members where list_id = made and profile_id = h2), 'editor');
  perform public._al_chk('C5 the agent is an editor, not an owner',
    (select role from public.list_members where list_id = made and profile_id = ag), 'editor');
  perform public._al_chk('C6 no guest member',
    (select count(*)::text from public.list_members where list_id = made and profile_id = gu), '0');
  perform public._al_chk('C7 another agent is not a member',
    (select count(*)::text from public.list_members where list_id = made and profile_id = ag2), '0');

  perform public._al_as(h1);
  perform public._al_chk('C8 a person is refused', public._al($q$select public.agent_create_list('st-al x', 'st-al-h1')::text$q$), 'ERR 42501%');
  perform public._al_as(gu);
  perform public._al_chk('C9 a guest is refused', public._al($q$select public.agent_create_list('st-al x', 'st-al-h1')::text$q$), 'ERR 42501%');
  perform public._al_as(ag2);
  perform public._al_chk('C10 another agent is refused', public._al($q$select public.agent_create_list('st-al x', 'st-al-h1')::text$q$), 'ERR 42501%');

  perform public._al_as(ag);
  perform public._al_chk('C11 unknown owner', public._al($q$select public.agent_create_list('st-al x', 'nobody-here')::text$q$), 'ERR 22023%');
  perform public._al_chk('C12 a guest cannot own it', public._al($q$select public.agent_create_list('st-al x', 'st-al-gu')::text$q$), 'ERR 22023%');
  perform public._al_chk('C13 an agent cannot own it', public._al($q$select public.agent_create_list('st-al x', 'homeos-agent')::text$q$), 'ERR 22023%');
  perform public._al_chk('C14 empty name', public._al($q$select public.agent_create_list('   ', 'st-al-h1')::text$q$), 'ERR 22023%');
  perform public._al_chk('C15 name over 60', public._al(format($q$select public.agent_create_list(%L, 'st-al-h1')::text$q$, repeat('x', 61))), 'ERR 22023%');
  perform public._al_chk('C16 a card number in the name', public._al($q$select public.agent_create_list('st-al 4111 1111 1111 1111', 'st-al-h1')::text$q$), 'ERR %');
  perform public._al_chk('C17 name taken, any case', public._al($q$select public.agent_create_list('ST-AL SHARED', 'st-al-h1')::text$q$), 'ERR 23505%');
  reset role;
  update ops.settings set value = 0 where key = 'household_lists';
  perform public._al_as(ag);
  perform public._al_chk('C18 the list limit applies', public._al($q$select public.agent_create_list('st-al limit', 'st-al-h1')::text$q$), 'ERR 54000%');
  reset role;
  update ops.settings set value = 50 where key = 'household_lists';

  -- ---------- rename ----------
  perform public._al_as(ag);
  v := public._al(format($q$select public.agent_rename_list(%L, 'St-al Renamed')::text$q$, shared));
  perform public._al_chk('R1 rename', v, '%"name": "St-al Renamed"%');
  perform public._al_chk('R2 the slug stays', v, '%"slug": "st-al-shared"%');
  perform public._al_chk('R3 not a member', public._al(format($q$select public.agent_rename_list(%L, 'st-al y')::text$q$, private)), 'ERR 42501%');
  perform public._al_chk('R4 an archived list', public._al(format($q$select public.agent_rename_list(%L, 'st-al y')::text$q$, arch)), 'ERR 55000%');
  perform public._al_chk('R5 name taken', public._al(format($q$select public.agent_rename_list(%L, 'st-al  made - one')::text$q$, shared)), 'ERR 23505%');
  perform public._al_chk('R6 empty name', public._al(format($q$select public.agent_rename_list(%L, '')::text$q$, shared)), 'ERR 22023%');
  perform public._al_chk('R7 a card number in the name', public._al(format($q$select public.agent_rename_list(%L, 'st-al 4111 1111 1111 1111')::text$q$, shared)), 'ERR %');
  perform public._al_chk('R8 no such list', public._al(format($q$select public.agent_rename_list(%L, 'st-al y')::text$q$, gen_random_uuid())), 'ERR 42501%');
  perform public._al_as(h2);
  perform public._al_chk('R9 a person is refused', public._al(format($q$select public.agent_rename_list(%L, 'st-al y')::text$q$, shared)), 'ERR 42501%');
  perform public._al_as(ag2);
  perform public._al_chk('R10 another agent is refused', public._al(format($q$select public.agent_rename_list(%L, 'st-al y')::text$q$, shared)), 'ERR 42501%');

  -- ---------- the people-only paths stay closed to agents ----------
  perform public._al_as(ag);
  perform public._al_chk('G1 create_list still refuses the agent', public._al($q$select public.create_list('st-al z')::text$q$), 'ERR 42501%');
  perform public._al_chk('G2 create_list_row still refuses the agent', public._al($q$select public.create_list_row('st-al z')::text$q$), 'ERR 42501%');
  perform public._al_chk('G3 a direct rename changes nothing', public._al(format($q$update public.lists set name = 'st-al z' where id = %L$q$, shared)), 'ok:0');
  perform public._al_chk('G4 a direct archive changes nothing', public._al(format($q$update public.lists set archived_at = now() where id = %L$q$, shared)), 'ok:0');
  perform public._al_chk('G5 a direct delete is refused', public._al(format($q$delete from public.lists where id = %L$q$, shared)), 'ERR 42501%');
  reset role;
  perform public._al_chk('G6 the renamed list still has its owner',
    (select (owner_id = h1)::text from public.lists where id = shared), 'true');

  -- ---------- rights ----------
  perform public._al_chk('P1 definers with an empty search_path',
    (select string_agg(p.proname || ':' || p.prosecdef || ':' || (coalesce(p.proconfig, '{}') @> array['search_path=""']), ',' order by p.proname)
       from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' and p.proname in ('agent_create_list', 'agent_lists_caller', 'agent_lists_name', 'agent_rename_list')),
    'agent_create_list:true:true,agent_lists_caller:true:true,agent_lists_name:true:true,agent_rename_list:true:true');
  perform public._al_chk('P2 anon runs neither, authenticated runs both, helpers are closed',
    has_function_privilege('anon', 'public.agent_create_list(text, text, text)', 'execute')::text || '/'
    || has_function_privilege('anon', 'public.agent_rename_list(uuid, text)', 'execute')::text || '/'
    || has_function_privilege('authenticated', 'public.agent_create_list(text, text, text)', 'execute')::text || '/'
    || has_function_privilege('authenticated', 'public.agent_rename_list(uuid, text)', 'execute')::text || '/'
    || has_function_privilege('authenticated', 'public.agent_lists_caller()', 'execute')::text || '/'
    || has_function_privilege('authenticated', 'public.agent_lists_name(text)', 'execute')::text,
    'false/false/true/true/false/false');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('al.total')::int - current_setting('al.nf')::int,
    current_setting('al.total'), coalesce(nullif(current_setting('al.f'), ''), 'none');
end $do$;
