-- db/921_selftest_harness_prefs.sql: the harness settings row and the published configuration (db/041) as admin SQL. Rolls
-- everything back and reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-919.
-- Cases: P the person's own row (create, stale create, update, stale update, privacy between people, bad shape), A the device's
-- writer reads and writes its owner's row and nobody else's, C the published configuration (writer only, household select),
-- Z grants and no 40001. Fixtures: H1, H2 (household), AG (agent, writer of st-hp-dev1, owner H1), G (a guest, viewer of H1's list);
-- st-hp-dev2 (writer and owner H2). Run after 041, 003 and its followers.

do $do$
declare
  h1 uuid := gen_random_uuid(); h2 uuid := gen_random_uuid(); ag uuid := gen_random_uuid(); g uuid := gen_random_uuid(); l1 uuid;
  ok jsonb := '{"defaults":{"max_sessions":2,"max_agents_per_session":2},"lists":{},"devices":{"st-hp-dev1":{"max_mothers":2}}}';
begin
  execute $f$create function public._hp_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true); set local role anon; return; end if;
      perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
      set local role authenticated; end $b$$f$;
  execute $f$create function public._hp(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute $f$create function public._hp_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('hp.total', (coalesce(nullif(current_setting('hp.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('hp.nf', (coalesce(nullif(current_setting('hp.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('hp.f', coalesce(current_setting('hp.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  execute 'grant execute on function public._hp_as(uuid), public._hp(text), public._hp_chk(text, text, text) to authenticated, anon';
  perform set_config('hp.total', '0', true); perform set_config('hp.nf', '0', true); perform set_config('hp.f', '', true);

  -- ---------- fixtures ----------
  insert into ops.signup_allowlist (email_lower, kind, is_household) values
    ('st-hp-h1@example.invalid', 'human', true), ('st-hp-h2@example.invalid', 'human', true), ('st-hp-ag@example.invalid', 'agent', false);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1, 'st-hp-h1@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (h2, 'st-hp-h2@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (ag, 'st-hp-ag@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (g, 'st-hp-g@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest G"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), g, 'st-hp-sub-g', 'google', json_build_object('sub', 'st-hp-sub-g', 'email', 'st-hp-g@example.invalid', 'email_verified', true));
  update public.profiles set handle = 'st-hp-' || left(id::text, 8) where id in (h1, h2, ag, g);
  perform public._hp_as(h1);
  l1 := public.create_list('st-hp one', 'st-hp-one', true);
  reset role; perform set_config('request.jwt.claims', '', true);
  insert into public.list_members (list_id, profile_id, role, added_by) values (l1, g, 'viewer', h1) on conflict do nothing;
  insert into public.harness_devices (device, label, writer_id, owner_id) values ('st-hp-dev1', 'Test PC 1', ag, h1), ('st-hp-dev2', 'Test PC 2', h2, h2);
  delete from public.preferences where profile_id in (h1, h2, ag, g) and app = 'harness';

  -- ---------- P: the person's own row ----------
  perform public._hp_as(h1);
  perform public._hp_chk('P1 no row yet reads null', public._hp('select public.harness_prefs_read()::text'), 'null');
  perform public._hp_chk('P2 the first save creates version 1', public._hp(format('select public.harness_prefs_write(%L::jsonb, null)::text', ok)), '1');
  perform public._hp_chk('P3 a second create is stale', public._hp(format('select public.harness_prefs_write(%L::jsonb, null)::text', ok)), 'ERR PT409%now version 1%');
  perform public._hp_chk('P4 a save with the right version', public._hp(format('select public.harness_prefs_write(%L::jsonb, 1)::text', ok)), '2');
  perform public._hp_chk('P5 a save with an old version is stale', public._hp(format('select public.harness_prefs_write(%L::jsonb, 1)::text', ok)), 'ERR PT409%now version 2%');
  perform public._hp_chk('P6 the read shows prefs and version', public._hp($q$select (r->>'version') || '/' || (r #>> '{prefs,devices,st-hp-dev1,max_mothers}') from (select public.harness_prefs_read() r) x$q$), '2/2');
  perform public._hp_chk('P7 no lists object is refused', public._hp($q$select public.harness_prefs_write('{"defaults":{}}'::jsonb, 2)::text$q$), 'ERR 22023%');
  perform public._hp_chk('P8 an array is refused', public._hp($q$select public.harness_prefs_write('[]'::jsonb, 2)::text$q$), 'ERR 22023%');
  perform public._hp_chk('P9 devices not an object is refused', public._hp($q$select public.harness_prefs_write('{"defaults":{},"lists":{},"devices":[]}'::jsonb, 2)::text$q$), 'ERR 22023%');
  perform public._hp_as(h2);
  perform public._hp_chk('P10 another person reads only their own (none)', public._hp('select public.harness_prefs_read()::text'), 'null');
  perform public._hp_chk('P11 ... and cannot select the row', public._hp(format($q$select count(*)::text from public.preferences where profile_id = %L and app = 'harness'$q$, h1)), '0');
  perform public._hp_chk('P12 ... nor read it through a device it does not write', public._hp($q$select public.harness_prefs_read('st-hp-dev1')::text$q$), 'ERR 42501%');
  perform public._hp_as(g);
  perform public._hp_chk('P13 a guest keeps a private row of their own', public._hp(format('select public.harness_prefs_write(%L::jsonb, null)::text', ok)), '1');

  -- ---------- A: the device's writer ----------
  perform public._hp_as(ag);
  perform public._hp_chk('A1 the writer reads the owner''s row', public._hp($q$select public.harness_prefs_read('st-hp-dev1') ->> 'version'$q$), '2');
  perform public._hp_chk('A2 the writer saves it with the version', public._hp(format($q$select public.harness_prefs_write(%L::jsonb, 2, 'st-hp-dev1')::text$q$, ok)), '3');
  perform public._hp_chk('A3 a stale writer save', public._hp(format($q$select public.harness_prefs_write(%L::jsonb, 2, 'st-hp-dev1')::text$q$, ok)), 'ERR PT409%');
  perform public._hp_chk('A4 an agent has no own row', public._hp('select public.harness_prefs_read()::text'), 'ERR 42501%');
  perform public._hp_chk('A5 another device is refused', public._hp($q$select public.harness_prefs_read('st-hp-dev2')::text$q$), 'ERR 42501%');
  perform public._hp_chk('A6 an unknown device', public._hp($q$select public.harness_prefs_read('st-hp-none')::text$q$), 'ERR 22023%');

  -- ---------- C: the published configuration ----------
  perform public._hp_chk('C1 the writer publishes', public._hp($q$select (public.harness_config_publish('st-hp-dev1', '{"board":null}'::jsonb) is not null)::text$q$), 'true');
  perform public._hp_chk('C2 a second publish replaces it', public._hp($q$select (public.harness_config_publish('st-hp-dev1', '{"board":{"lists":[]}}'::jsonb) is not null)::text$q$), 'true');
  perform public._hp_chk('C3 not an object', public._hp($q$select public.harness_config_publish('st-hp-dev1', '[]'::jsonb)::text$q$), 'ERR 22023%');
  perform public._hp_as(h1);
  perform public._hp_chk('C4 a person may not publish', public._hp($q$select public.harness_config_publish('st-hp-dev1', '{}'::jsonb)::text$q$), 'ERR 42501%');
  perform public._hp_chk('C5 the household reads it', public._hp($q$select config::text from public.harness_configs where device = 'st-hp-dev1'$q$), '{"board": {"lists": []}}');
  perform public._hp_chk('C6 nobody writes it by REST', public._hp($q$update public.harness_configs set config = '{}' where device = 'st-hp-dev1'$q$), 'ERR 42501%');
  perform public._hp_as(g);
  perform public._hp_chk('C7 a guest does not see it', public._hp($q$select count(*)::text from public.harness_configs$q$), '0');
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ---------- Z ----------
  perform public._hp_chk('Z1 anon cannot run the RPCs',
    (select (has_function_privilege('anon', 'public.harness_prefs_read(text)', 'execute') or has_function_privilege('anon', 'public.harness_prefs_write(jsonb, integer, text)', 'execute')
      or has_function_privilege('anon', 'public.harness_config_publish(text, jsonb)', 'execute'))::text), 'false');
  perform public._hp_chk('Z2 authenticated cannot run the internal target', (select has_function_privilege('authenticated', 'public.harness_prefs_target(text)', 'execute')::text), 'false');
  perform public._hp_chk('Z3 no 40001 in the new functions',
    (select count(*)::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public'
      and p.proname in ('harness_prefs_target', 'harness_prefs_read', 'harness_prefs_write', 'harness_config_publish') and p.prosrc like '%40001%'), '0');
  perform public._hp_chk('Z4 definers with an empty search_path',
    (select count(*)::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public'
      and p.proname in ('harness_prefs_target', 'harness_prefs_read', 'harness_prefs_write', 'harness_config_publish') and prosecdef and coalesce(proconfig, '{}') @> array['search_path=""']), '4');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('hp.total')::int - current_setting('hp.nf')::int,
    current_setting('hp.total'), coalesce(nullif(current_setting('hp.f'), ''), 'none');
end $do$;
