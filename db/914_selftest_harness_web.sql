-- db/914_selftest_harness_web.sql: the web copy of the Eisenhower Harness page (db/031) as admin SQL. Rolls everything back and
-- reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-913.
-- Cases: V who reads what (household all; a guest the head, their list and its feed; not whitelisted and anon nothing);
-- W no API role writes a table; P push (CAS, writer, device, list role, sizes, window); R requests (decision 2: list owners,
-- the PC's owner for the master and the default limits, fresh sign-in, idempotency, silent device, controls off, rates);
-- T take (once, rights again, another device's writer, expiry); D done, recover, sweep; G grants.
-- Fixtures: H1, H2 (household people), AG and AG2 (agents, writers of two test devices), G (a guest who is a viewer of H1's list),
-- O (a Google sign-up nobody let in); lists L1 (owner H1), L2 (owner H2), L3 (owner H1, no agent). Run after 031, 003, 011,
-- the 012 policy block, 026, 030 and 031 again (003 revokes 031's table grants).

do $do$
declare
  h1 uuid := gen_random_uuid(); h2 uuid := gen_random_uuid(); ag uuid := gen_random_uuid(); ag2 uuid := gen_random_uuid();
  g uuid := gen_random_uuid(); o uuid := gen_random_uuid();
  l1 uuid; l2 uuid; l3 uuid; ts text := to_char(now(), 'YYYY-MM-DD--HH24-MI'); head jsonb; put jsonb; v text; c1 uuid; c2 uuid;
begin
  execute $f$create function public._hw_as(p uuid, p_age int default 60) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true); set local role anon; return; end if;
      perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated',
        'amr', json_build_array(json_build_object('method', 'oauth', 'timestamp', floor(extract(epoch from now())) - p_age)))::text, true);
      set local role authenticated; end $b$$f$;
  execute $f$create function public._hw(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute $f$create function public._hw_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('hw.total', (coalesce(nullif(current_setting('hw.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('hw.nf', (coalesce(nullif(current_setting('hw.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('hw.f', coalesce(current_setting('hw.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  execute 'grant execute on function public._hw_as(uuid, int), public._hw(text), public._hw_chk(text, text, text) to authenticated, anon';
  perform set_config('hw.total', '0', true); perform set_config('hw.nf', '0', true); perform set_config('hw.f', '', true);

  -- ---------- fixtures ----------
  insert into ops.signup_allowlist (email_lower, kind, is_household) values
    ('st-hw-h1@example.invalid', 'human', true), ('st-hw-h2@example.invalid', 'human', true),
    ('st-hw-ag@example.invalid', 'agent', false), ('st-hw-ag2@example.invalid', 'agent', false);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1, 'st-hw-h1@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (h2, 'st-hw-h2@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (ag, 'st-hw-ag@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (ag2, 'st-hw-ag2@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (g, 'st-hw-g@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest G"}'),
    (o, 'st-hw-o@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest O"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), g, 'st-hw-sub-g', 'google', json_build_object('sub', 'st-hw-sub-g', 'email', 'st-hw-g@example.invalid', 'email_verified', true)),
    (gen_random_uuid(), o, 'st-hw-sub-o', 'google', json_build_object('sub', 'st-hw-sub-o', 'email', 'st-hw-o@example.invalid', 'email_verified', true));
  update public.profiles set handle = 'st-hw-' || left(id::text, 8) where id in (h1, h2, ag, ag2, g, o);

  perform public._hw_as(h1);
  l1 := public.create_list('st-hw one', 'st-hw-one', true);   -- H2 is an editor (household share), not an owner
  l3 := public.create_list('st-hw three', 'st-hw-three', false);
  perform public._hw_as(h2);
  l2 := public.create_list('st-hw two', 'st-hw-two', true);   -- H1 is an editor here
  reset role; perform set_config('request.jwt.claims', '', true);
  insert into public.list_members (list_id, profile_id, role, added_by) values
    (l1, ag, 'editor', h1), (l2, ag, 'editor', h2), (l1, g, 'viewer', h1)
  on conflict do nothing;
  insert into public.harness_devices (device, label, writer_id, owner_id) values
    ('st-hw-dev1', 'Test PC 1', ag, h1), ('st-hw-dev2', 'Test PC 2', ag2, h2);
  head := jsonb_build_object('sessions', jsonb_build_object('master', 'master', 'do-l1-1', l1::text, 'do-l2-1', l2::text, 'do-x-1', null));
  put := jsonb_build_object(
    'household', jsonb_build_object('list_id', null, 'hash', 'h0', 'body', jsonb_build_object('decisions', jsonb_build_array('st-hw household'))),
    'list:' || l1, jsonb_build_object('list_id', l1, 'hash', 'h1', 'body', jsonb_build_object('sessions', jsonb_build_array('st-hw l1'))),
    'list:' || l2, jsonb_build_object('list_id', l2, 'hash', 'h2', 'body', jsonb_build_object('sessions', jsonb_build_array('st-hw l2'))),
    'feed:do-l1-1:0', jsonb_build_object('list_id', l1, 'hash', 'f1', 'body', jsonb_build_object('entries', jsonb_build_array())),
    'feed:do-l2-1:0', jsonb_build_object('list_id', l2, 'hash', 'f2', 'body', jsonb_build_object('entries', jsonb_build_array())),
    'feed:master:0', jsonb_build_object('list_id', null, 'hash', 'f0', 'body', jsonb_build_object('entries', jsonb_build_array())));

  -- ---------- P: push ----------
  perform public._hw_as(ag);
  perform public._hw_chk('P1 the writer pushes', public._hw(format('select public.harness_push(%L, %L, 0, true, %L::jsonb, %L::jsonb)', 'st-hw-dev1', ts, head, put)), '1');
  perform public._hw_chk('P2 a stale seq is refused', public._hw(format('select public.harness_push(%L, %L, 0, true, %L::jsonb, %L::jsonb)', 'st-hw-dev1', ts, head, '{}')), 'ERR 40001%');
  perform public._hw_chk('P3 the next seq', public._hw(format('select public.harness_push(%L, %L, 1, true, %L::jsonb, %L::jsonb, %L::text[])', 'st-hw-dev1', ts, head, '{}', '{}')), '2');
  perform public._hw_chk('P4 a part of a list the agent has no role on', public._hw(format('select public.harness_push(%L, %L, 2, true, %L::jsonb, %L::jsonb)', 'st-hw-dev1', ts, head,
    jsonb_build_object('list:' || l3, jsonb_build_object('list_id', l3, 'hash', 'x', 'body', '{}'::jsonb)))), 'ERR 42501%');
  perform public._hw_chk('P5 a part naming another list', public._hw(format('select public.harness_push(%L, %L, 2, true, %L::jsonb, %L::jsonb)', 'st-hw-dev1', ts, head,
    jsonb_build_object('list:' || l1, jsonb_build_object('list_id', l2, 'hash', 'x', 'body', '{}'::jsonb)))), 'ERR 22023%');
  perform public._hw_chk('P6 an oversize part', public._hw(format('select public.harness_push(%L, %L, 2, true, %L::jsonb, %L::jsonb)', 'st-hw-dev1', ts, head,
    jsonb_build_object('household', jsonb_build_object('hash', 'x', 'body', jsonb_build_object('t', repeat('y', 600000)))))), 'ERR 54000%');
  perform public._hw_chk('P7 an old run', public._hw(format('select public.harness_push(%L, %L, 0, true, %L::jsonb, %L::jsonb)', 'st-hw-dev1', '2026-01-01--04-06', head, '{}')), 'ERR 22023%');
  perform public._hw_chk('P8 another device''s writer', public._hw(format('select public.harness_push(%L, %L, 2, true, %L::jsonb, %L::jsonb)', 'st-hw-dev2', ts, head, '{}')), 'ERR 42501%');
  perform public._hw_chk('P9 an unbound device', public._hw(format('select public.harness_push(%L, %L, 0, true, %L::jsonb, %L::jsonb)', 'st-hw-nodev', ts, head, '{}')), 'ERR 42501%');
  perform public._hw_as(h1);
  perform public._hw_chk('P10 a person cannot push', public._hw(format('select public.harness_push(%L, %L, 2, true, %L::jsonb, %L::jsonb)', 'st-hw-dev1', ts, head, '{}')), 'ERR 42501%');

  -- ---------- V: reading ----------
  perform public._hw_chk('V1 household reads the head and every part', public._hw(format(
    $q$select (select count(*) from public.harness_heads where device = 'st-hw-dev1') || '/' || (select count(*) from public.harness_parts where device = 'st-hw-dev1')$q$)), '1/6');
  perform public._hw_as(g);
  perform public._hw_chk('V2 a guest reads the head, their list and its feed only', public._hw(
    $q$select (select count(*) from public.harness_heads where device = 'st-hw-dev1') || '/' || (select string_agg(left(part, 6), ',' order by part) from public.harness_parts where device = 'st-hw-dev1')$q$), '1/feed:d,list:%');
  perform public._hw_chk('V3 the guest''s two parts are of their list', public._hw(format(
    $q$select count(*) from public.harness_parts where device = 'st-hw-dev1' and list_id = %L$q$, l1)), '2');
  perform public._hw_as(o);
  perform public._hw_chk('V4 not whitelisted reads nothing', public._hw(
    $q$select (select count(*) from public.harness_heads) || '/' || (select count(*) from public.harness_parts) || '/' || (select count(*) from public.harness_devices)$q$), '0/0/0');
  perform public._hw_as(null);
  perform public._hw_chk('V5 anon reads nothing', public._hw($q$select count(*) from public.harness_heads$q$), 'ERR 42501%');

  -- ---------- W: no direct writes ----------
  perform public._hw_as(h1);
  perform public._hw_chk('W1 a person inserts no head', public._hw(format($q$insert into public.harness_heads (device, run_ts) values ('st-hw-dev1', %L)$q$, '2026-11-09--00-00')), 'ERR 42501%');
  perform public._hw_chk('W2 a person inserts no command', public._hw(format(
    $q$insert into public.harness_commands (device, run_ts, name, action, expect_state, idem_key, requested_by) values ('st-hw-dev1', %L, 'do-l1-1', 'stop', 'running', 'abcdefgh', %L)$q$, ts, h1)), 'ERR 42501%');
  perform public._hw_as(ag);
  perform public._hw_chk('W3 the agent updates no part', public._hw($q$update public.harness_parts set body = '{}' where device = 'st-hw-dev1'$q$), 'ERR 42501%');
  perform public._hw_chk('W4 the agent changes no device', public._hw($q$update public.harness_devices set controls = true$q$), 'ERR 42501%');

  -- ---------- R: requests ----------
  perform public._hw_as(h1);
  perform public._hw_chk('R1 the device is silent before a beat', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'stop', 'do-l1-1', null, null, null, 'running', null, 'idem-r1-aa')).state$q$, ts)), 'ERR 55000%');
  perform public._hw_as(ag);
  perform public.harness_beat('st-hw-dev1', 'running', false);
  perform public._hw_as(h1);
  perform public._hw_chk('R2 remote control off', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'stop', 'do-l1-1', null, null, null, 'running', null, 'idem-r2-aa')).state$q$, ts)), 'ERR 55000%remote control is off%');
  perform public._hw_as(ag);
  perform public.harness_beat('st-hw-dev1', 'running', true);
  perform public._hw_as(h1);
  perform public._hw_chk('R3 a list owner stops a session of the list', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'stop', 'do-l1-1', null, null, null, 'running', null, 'idem-r3-aa')).state$q$, ts)), 'pending');
  perform public._hw_chk('R4 the same click again gets the same row', public._hw(format(
    $q$select count(distinct (public.harness_request('st-hw-dev1', %L, 'stop', 'do-l1-1', null, null, null, 'running', null, 'idem-r3-aa')).id) || '/' || (select count(*) from public.harness_commands where idem_key = 'idem-r3-aa')$q$, ts)), '1/1');
  perform public._hw_chk('R5 the session''s list comes from the head', public._hw($q$select scope_list_id::text from public.harness_commands where idem_key = 'idem-r3-aa'$q$), l1::text);
  perform public._hw_chk('R6 the PC''s owner controls its master', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'stop', 'master', null, null, null, 'running', null, 'idem-r6-aa')).state$q$, ts)), 'pending');
  perform public._hw_chk('R7 a non-owner member (editor of L2) may not', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'stop', 'do-l2-1', null, null, null, 'running', null, 'idem-r7-aa')).state$q$, ts)), 'ERR 42501%owners of this list%');
  perform public._hw_chk('R8 the default limits by the PC''s owner, fresh', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'limits', null, null, '{"defaults":{"max_sessions":2}}'::jsonb, null, null, 'abc123', 'idem-r8-aa')).state$q$, ts)), 'pending');
  perform public._hw_chk('R9 a list''s limits by a non-owner', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'limits', null, null, %L::jsonb, %L, null, 'abc123', 'idem-r9-aa')).state$q$, ts, '{"slug":"st-hw-two"}', l2)), 'ERR 42501%');
  perform public._hw_chk('R10 a payload naming another list', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'limits', null, null, %L::jsonb, %L, null, 'abc123', 'idem-r10-a')).state$q$, ts, '{"slug":"st-hw-two"}', l1)), 'ERR 22023%');
  perform public._hw_chk('R11 a session not in the head', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'stop', 'do-x-1', null, null, null, 'running', null, 'idem-r11-a')).state$q$, ts)), 'ERR 42501%');
  perform public._hw_as(h1, 1200);
  perform public._hw_chk('R12 limits need a sign-in from the last 15 minutes', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'limits', null, null, '{"defaults":{}}'::jsonb, null, null, 'abc123', 'idem-r12-a')).state$q$, ts)), 'ERR 28000%');
  perform public._hw_chk('R13 so does a note', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'continue', 'do-l1-1', 'go on', null, null, 'stopped', null, 'idem-r13-a')).state$q$, ts)), 'ERR 28000%');
  perform public._hw_chk('R14 continue with no note does not', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'continue', 'do-l1-1', null, null, null, 'stopped', null, 'idem-r14-a')).state$q$, ts)), 'pending');
  perform public._hw_as(h2);
  perform public._hw_chk('R15 not the PC''s owner: no master', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'stop', 'master', null, null, null, 'running', null, 'idem-r15-a')).state$q$, ts)), 'ERR 42501%');
  perform public._hw_chk('R16 not the PC''s owner: no default limits', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'limits', null, null, '{"defaults":{}}'::jsonb, null, null, 'abc123', 'idem-r16-a')).state$q$, ts)), 'ERR 42501%');
  perform public._hw_chk('R17 an editor of L1 may not stop its session', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'stop', 'do-l1-1', null, null, null, 'running', null, 'idem-r17-a')).state$q$, ts)), 'ERR 42501%');
  perform public._hw_chk('R18 the owner of L2 may', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'release', 'do-l2-1', null, null, null, 'stopped', null, 'idem-r18-a')).state$q$, ts)), 'pending');
  perform public._hw_chk('R19 the owner of L2 sets its limits', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'limits', null, null, %L::jsonb, %L, null, 'abc123', 'idem-r19-a')).state$q$, ts, '{"slug":"st-hw-two","enabled":true}', l2)), 'pending');
  perform public._hw_as(g);
  perform public._hw_chk('R20 a guest viewer may not press', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'stop', 'do-l1-1', null, null, null, 'running', null, 'idem-r20-a')).state$q$, ts)), 'ERR 42501%');
  perform public._hw_as(o);
  perform public._hw_chk('R21 not whitelisted may not', public._hw(format($q$select (public.harness_request('st-hw-dev1', %L, 'stop', 'do-l1-1', null, null, null, 'running', null, 'idem-r21-a')).state$q$, ts)), 'ERR 42501%');
  perform public._hw_as(h1);
  perform public._hw_chk('R22 the dev2 device is silent', public._hw(format($q$select (public.harness_request('st-hw-dev2', %L, 'stop', 'master', null, null, null, 'running', null, 'idem-r22-a')).state$q$, ts)), 'ERR 55000%');
  perform public._hw_chk('R23 the household sees every command', public._hw($q$select count(*) from public.harness_commands where idem_key like 'idem-r%'$q$), '6');

  -- ---------- T: take ----------
  reset role; perform set_config('request.jwt.claims', '', true);
  select id into c1 from public.harness_commands where idem_key = 'idem-r6-aa';   -- the master stop by H1
  update public.harness_devices set owner_id = h2 where device = 'st-hw-dev1';     -- H1 no longer owns the PC
  update public.harness_commands set expires_at = now() - interval '1 second' where idem_key = 'idem-r14-a';
  perform public._hw_as(ag2);
  perform public._hw_chk('T1 another device''s writer takes nothing of dev1', public._hw($q$select count(*) from public.harness_take('st-hw-dev1')$q$), 'ERR 42501%');
  perform public._hw_chk('T2 dev2 has nothing', public._hw($q$select count(*) from public.harness_take('st-hw-dev2')$q$), '0');
  perform public._hw_as(ag);
  perform public._hw_chk('T3 the writer takes the valid ones', public._hw($q$select string_agg(coalesce(name, 'limits'), ',' order by coalesce(name, 'zzz')) from public.harness_take('st-hw-dev1')$q$), 'do-l1-1,do-l2-1,limits');
  perform public._hw_chk('T4 a second take gets nothing', public._hw($q$select count(*) from public.harness_take('st-hw-dev1')$q$), '0');
  perform public._hw_chk('T4b the agent selects no command row (household or requester only)', public._hw($q$select count(*) from public.harness_commands$q$), '0');
  -- the states are read as admin: the select policy hides commands from the agent (T4b)
  reset role; perform set_config('request.jwt.claims', '', true);
  perform public._hw_chk('T5 rights checked again at take', public._hw(format($q$select state || ':' || left(result, 26) from public.harness_commands where id = %L$q$, c1)), 'refused:refused when taken: on%');
  perform public._hw_chk('T6 an expired command is not taken', public._hw($q$select state from public.harness_commands where idem_key = 'idem-r14-a'$q$), 'expired');
  perform public._hw_chk('T7 the default limits of the old owner refused too', public._hw($q$select state from public.harness_commands where idem_key = 'idem-r8-aa'$q$), 'refused');

  -- ---------- D: done, recover, sweep ----------
  select id into c2 from public.harness_commands where idem_key = 'idem-r3-aa';   -- as admin (the agent cannot select it)
  select id into c1 from public.harness_commands where idem_key = 'idem-r18-a';
  perform public._hw_as(ag);
  perform public._hw_chk('D1 done', public._hw(format($q$select public.harness_done(%L, 'done', 'stopped')::text$q$, c2)), '');
  perform public._hw_chk('D2 done twice is refused', public._hw(format($q$select public.harness_done(%L, 'done', 'stopped')::text$q$, c2)), 'ERR 22023%');
  perform public._hw_as(ag2);
  perform public._hw_chk('D3 another writer cannot finish it', public._hw(format($q$select public.harness_done(%L, 'done', 'x')::text$q$, c1)), 'ERR 42501%');
  reset role; perform set_config('request.jwt.claims', '', true);
  update public.harness_commands set state = 'taken' where idem_key = 'idem-r14-a';   -- as if the PC took a continue and crashed
  perform public._hw_as(ag);
  perform public._hw_chk('D4 recover returns the stop/release/limits still taken', public._hw($q$select string_agg(action, ',' order by action desc) from public.harness_recover('st-hw-dev1')$q$), 'release,limits');
  reset role; perform set_config('request.jwt.claims', '', true);
  perform public._hw_chk('D5 a taken continue becomes unknown', public._hw($q$select state from public.harness_commands where idem_key = 'idem-r14-a'$q$), 'unknown');
  perform public._hw_chk('D5b the done stop keeps its result', public._hw($q$select state || ':' || result from public.harness_commands where idem_key = 'idem-r3-aa'$q$), 'done:stopped');
  perform public._hw_as(ag);
  perform public._hw_chk('D6 sweep', public._hw($q$select (public.harness_sweep('st-hw-dev1')) ->> 'runs_deleted'$q$), '0');
  perform public._hw_as(h1);
  perform public._hw_chk('D7 a reader marks the page viewed', public._hw($q$select public.harness_view('st-hw-dev1')::text$q$), '');

  -- ---------- G: grants ----------
  reset role; perform set_config('request.jwt.claims', '', true);
  perform public._hw_chk('G1 no API role may write a table',
    (select string_agg(has_table_privilege(r, t, p)::text, ',') from unnest(array['anon', 'authenticated']) r,
       unnest(array['public.harness_devices', 'public.harness_heads', 'public.harness_parts', 'public.harness_commands']) t,
       unnest(array['insert', 'update', 'delete']) p), 'false%' );
  perform public._hw_chk('G1b ... and none is true',
    (select count(*)::text from unnest(array['anon', 'authenticated']) r,
       unnest(array['public.harness_devices', 'public.harness_heads', 'public.harness_parts', 'public.harness_commands']) t,
       unnest(array['insert', 'update', 'delete']) p where has_table_privilege(r, t, p)), '0');
  perform public._hw_chk('G2 anon runs no harness function',
    (select count(*)::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' and p.proname like 'harness\_%' and has_function_privilege('anon', p.oid, 'execute')), '0');
  perform public._hw_chk('G3 helpers are no endpoints',
    (has_function_privilege('authenticated', 'public.harness_right(uuid, text, text, text, text, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.harness_is_writer(text)', 'execute'))::text, 'false');
  perform public._hw_chk('G4 writer and owner ids of a device are not readable as columns',
    has_column_privilege('authenticated', 'public.harness_devices', 'writer_id', 'select')::text, 'false');
  perform public._hw_chk('G5 definers with an empty search_path',
    (select count(*)::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' and p.proname like 'harness\_%' and p.prosecdef and not coalesce(p.proconfig, '{}') @> array['search_path=""']), '0');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('hw.total')::int - current_setting('hw.nf')::int,
    current_setting('hw.total'), coalesce(nullif(current_setting('hw.f'), ''), 'none');
end $do$;
