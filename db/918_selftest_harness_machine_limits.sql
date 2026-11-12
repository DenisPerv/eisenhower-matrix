-- db/918_selftest_harness_machine_limits.sql: "mothers at once" from the web (db/036) as admin SQL. Rolls everything back and
-- reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-917.
-- Cases: M the machine scope of a limits command (the device's owner in the household may, fresh sign-in; a household non-owner,
-- a guest, and a guest who owns a device may not; out of range, not a whole number, extra keys refused; a stale sign-in refused;
-- the PC takes it); G no 40001 in harness_request (PostgREST 14 retries it forever, db/035).
-- Fixtures: H1, H2 (household), AG (agent, writer of both test devices), G (a guest, viewer of H1's list L1);
-- devices st-hm-dev1 (owner H1) and st-hm-dev2 (owner G). Run after 036, 003 and its followers.

do $do$
declare
  h1 uuid := gen_random_uuid(); h2 uuid := gen_random_uuid(); ag uuid := gen_random_uuid(); g uuid := gen_random_uuid();
  l1 uuid; ts text := to_char(now(), 'YYYY-MM-DD--HH24-MI');
begin
  execute $f$create function public._hm_as(p uuid, p_age int default 60) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true); set local role anon; return; end if;
      perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated',
        'amr', json_build_array(json_build_object('method', 'oauth', 'timestamp', floor(extract(epoch from now())) - p_age)))::text, true);
      set local role authenticated; end $b$$f$;
  execute $f$create function public._hm(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute $f$create function public._hm_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('hm.total', (coalesce(nullif(current_setting('hm.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('hm.nf', (coalesce(nullif(current_setting('hm.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('hm.f', coalesce(current_setting('hm.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  execute 'grant execute on function public._hm_as(uuid, int), public._hm(text), public._hm_chk(text, text, text) to authenticated, anon';
  perform set_config('hm.total', '0', true); perform set_config('hm.nf', '0', true); perform set_config('hm.f', '', true);

  -- ---------- fixtures ----------
  insert into ops.signup_allowlist (email_lower, kind, is_household) values
    ('st-hm-h1@example.invalid', 'human', true), ('st-hm-h2@example.invalid', 'human', true), ('st-hm-ag@example.invalid', 'agent', false);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1, 'st-hm-h1@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (h2, 'st-hm-h2@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (ag, 'st-hm-ag@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (g, 'st-hm-g@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest G"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), g, 'st-hm-sub-g', 'google', json_build_object('sub', 'st-hm-sub-g', 'email', 'st-hm-g@example.invalid', 'email_verified', true));
  update public.profiles set handle = 'st-hm-' || left(id::text, 8) where id in (h1, h2, ag, g);

  perform public._hm_as(h1);
  l1 := public.create_list('st-hm one', 'st-hm-one', true);
  reset role; perform set_config('request.jwt.claims', '', true);
  insert into public.list_members (list_id, profile_id, role, added_by) values (l1, ag, 'editor', h1), (l1, g, 'viewer', h1) on conflict do nothing;
  insert into public.harness_devices (device, label, writer_id, owner_id) values
    ('st-hm-dev1', 'Test PC 1', ag, h1), ('st-hm-dev2', 'Test PC 2', ag, g);
  perform public._hm_as(ag);
  perform public.harness_beat('st-hm-dev1', 'running', true);
  perform public.harness_beat('st-hm-dev2', 'running', true);

  -- ---------- M: the machine scope ----------
  perform public._hm_as(h1);
  perform public._hm_chk('M1 the device owner sets mothers at once', public._hm(format($q$select (public.harness_request('st-hm-dev1', %L, 'limits', null, null, '{"machine":{"max_mothers":3}}'::jsonb, null, null, 'abc123', 'idem-m1-aa')).state$q$, ts)), 'pending');
  perform public._hm_chk('M2 ... the command has no list and keeps the payload', public._hm($q$select coalesce(scope_list_id::text, 'none') || '/' || (payload #>> '{machine,max_mothers}') from public.harness_commands where idem_key = 'idem-m1-aa'$q$), 'none/3');
  perform public._hm_chk('M3 1 is the lowest', public._hm(format($q$select (public.harness_request('st-hm-dev1', %L, 'limits', null, null, '{"machine":{"max_mothers":1}}'::jsonb, null, null, 'abc123', 'idem-m3-aa')).state$q$, ts)), 'pending');
  perform public._hm_chk('M4 10 is the highest', public._hm(format($q$select (public.harness_request('st-hm-dev1', %L, 'limits', null, null, '{"machine":{"max_mothers":10}}'::jsonb, null, null, 'abc123', 'idem-m4-aa')).state$q$, ts)), 'pending');
  perform public._hm_chk('M5 0 is refused', public._hm(format($q$select (public.harness_request('st-hm-dev1', %L, 'limits', null, null, '{"machine":{"max_mothers":0}}'::jsonb, null, null, 'abc123', 'idem-m5-aa')).state$q$, ts)), 'ERR 22023%');
  perform public._hm_chk('M6 11 is refused', public._hm(format($q$select (public.harness_request('st-hm-dev1', %L, 'limits', null, null, '{"machine":{"max_mothers":11}}'::jsonb, null, null, 'abc123', 'idem-m6-aa')).state$q$, ts)), 'ERR 22023%');
  perform public._hm_chk('M7 not a whole number', public._hm(format($q$select (public.harness_request('st-hm-dev1', %L, 'limits', null, null, '{"machine":{"max_mothers":2.5}}'::jsonb, null, null, 'abc123', 'idem-m7-aa')).state$q$, ts)), 'ERR 22023%');
  perform public._hm_chk('M8 a string', public._hm(format($q$select (public.harness_request('st-hm-dev1', %L, 'limits', null, null, '{"machine":{"max_mothers":"3"}}'::jsonb, null, null, 'abc123', 'idem-m8-aa')).state$q$, ts)), 'ERR 22023%');
  perform public._hm_chk('M9 machine with defaults', public._hm(format($q$select (public.harness_request('st-hm-dev1', %L, 'limits', null, null, '{"machine":{"max_mothers":3},"defaults":{}}'::jsonb, null, null, 'abc123', 'idem-m9-aa')).state$q$, ts)), 'ERR 22023%');
  perform public._hm_chk('M10 another key in machine', public._hm(format($q$select (public.harness_request('st-hm-dev1', %L, 'limits', null, null, '{"machine":{"max_mothers":3,"x":1}}'::jsonb, null, null, 'abc123', 'idem-m10-a')).state$q$, ts)), 'ERR 22023%');
  perform public._hm_chk('M11 machine for a list is not the machine scope', public._hm(format($q$select (public.harness_request('st-hm-dev1', %L, 'limits', null, null, '{"machine":{"max_mothers":3}}'::jsonb, %L, null, 'abc123', 'idem-m11-a')).state$q$, ts, l1)), 'ERR 22023%');
  perform public._hm_as(h1, 1200);
  perform public._hm_chk('M12 a stale sign-in is refused', public._hm(format($q$select (public.harness_request('st-hm-dev1', %L, 'limits', null, null, '{"machine":{"max_mothers":3}}'::jsonb, null, null, 'abc123', 'idem-m12-a')).state$q$, ts)), 'ERR 28000%');
  perform public._hm_as(h2);
  perform public._hm_chk('M13 a household non-owner may not', public._hm(format($q$select (public.harness_request('st-hm-dev1', %L, 'limits', null, null, '{"machine":{"max_mothers":3}}'::jsonb, null, null, 'abc123', 'idem-m13-a')).state$q$, ts)), 'ERR 42501%owner of Test PC 1%');
  perform public._hm_as(g);
  perform public._hm_chk('M14 a guest may not', public._hm(format($q$select (public.harness_request('st-hm-dev1', %L, 'limits', null, null, '{"machine":{"max_mothers":3}}'::jsonb, null, null, 'abc123', 'idem-m14-a')).state$q$, ts)), 'ERR 42501%');
  perform public._hm_chk('M15 a guest may not even on a device they own', public._hm(format($q$select (public.harness_request('st-hm-dev2', %L, 'limits', null, null, '{"machine":{"max_mothers":3}}'::jsonb, null, null, 'abc123', 'idem-m15-a')).state$q$, ts)), 'ERR 42501%');
  perform public._hm_as(ag);
  perform public._hm_chk('M16 the PC takes the owner''s machine commands', public._hm($q$select count(*) from public.harness_take('st-hm-dev1')$q$), '3');

  -- ---------- G ----------
  reset role; perform set_config('request.jwt.claims', '', true);
  perform public._hm_chk('G1 harness_request raises no 40001', (pg_get_functiondef('public.harness_request'::regproc) not like '%40001%')::text, 'true');
  perform public._hm_chk('G2 anon may not run harness_request', has_function_privilege('anon', 'public.harness_request'::regproc, 'execute')::text, 'false');
  perform public._hm_chk('G3 authenticated may', has_function_privilege('authenticated', 'public.harness_request'::regproc, 'execute')::text, 'true');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('hm.total')::int - current_setting('hm.nf')::int,
    current_setting('hm.total'), coalesce(nullif(current_setting('hm.f'), ''), 'none');
end $do$;
