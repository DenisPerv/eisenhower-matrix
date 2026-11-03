-- db/910_selftest_consultancy.sql: the consulting-call request selftest (db/025) as admin SQL. Rolls everything back and
-- reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-909.
-- Cases: C1 the list; C2 who may request; C3 a request (task as homeos-agent, contacts as links, note, due, notify);
-- C4 a second call; C5 my_consultation_request; C6 what the requester cannot read; C7 who reads the task; C8 bad values;
-- C9 a new request after done; C10 a phone number that looks like a card number; C11 caps (54000); C12 rights.
-- Fixtures: G, N, X, Y as Google users with identities, AG an agent; the real maksym, anastasiia, homeos-agent and
-- telegram-bot profiles are read, never changed for good. Run after 025, 003, 011, the 012 policy block and 900-909.

do $do$
declare
  ag uuid := gen_random_uuid(); g uuid := gen_random_uuid(); n uuid := gen_random_uuid();
  x uuid := gen_random_uuid(); y uuid := gen_random_uuid();
  ge text := 'st-con-g@example.invalid';
  mk uuid; an uuid; ha uuid; tb uuid; cl uuid; iid uuid; j jsonb;
begin
  execute $f$create function public._cr_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true);
      else perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
           set local role authenticated; end if; end $b$$f$;
  execute $f$create function public._cr(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute $f$create function public._cr_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('cr.total', (coalesce(nullif(current_setting('cr.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('cr.nf', (coalesce(nullif(current_setting('cr.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('cr.f', coalesce(current_setting('cr.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  execute 'grant execute on function public._cr_as(uuid), public._cr(text), public._cr_chk(text, text, text) to authenticated';
  perform set_config('cr.total', '0', true); perform set_config('cr.nf', '0', true); perform set_config('cr.f', '', true);

  -- ---------- fixtures (admin) ----------
  select id into mk from public.profiles where handle = 'maksym';
  select id into an from public.profiles where handle = 'anastasiia';
  select id into ha from public.profiles where handle = 'homeos-agent';
  select id into tb from public.profiles where handle = 'telegram-bot';
  cl := public.consult_list_id();
  -- earlier real requests do not count against the caps in this test
  update public.items set status = 'done' where list_id = cl and status not in ('done','cancelled');
  update ops.settings set value = 1000 where key in ('consult_requests_per_day', 'consult_requests_open');
  insert into ops.signup_allowlist (email_lower, kind, is_household) values ('st-con-ag@example.invalid', 'agent', true);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (ag, 'st-con-ag@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (g, upper(ge), 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Ada"}'),
    (n, 'st-con-n@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"N"}'),
    (x, 'st-con-x@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"X"}'),
    (y, 'st-con-y@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Y"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), g, 'st-con-sub-g', 'google', json_build_object('sub', 'st-con-sub-g', 'email', upper(ge), 'email_verified', true)),
    (gen_random_uuid(), n, 'st-con-sub-n', 'google', json_build_object('sub', 'st-con-sub-n', 'email', 'st-con-n@example.invalid', 'email_verified', false)),
    (gen_random_uuid(), x, 'st-con-sub-x', 'google', json_build_object('sub', 'st-con-sub-x', 'email', 'st-con-x@example.invalid', 'email_verified', true)),
    (gen_random_uuid(), y, 'st-con-sub-y', 'google', json_build_object('sub', 'st-con-sub-y', 'email', 'st-con-y@example.invalid', 'email_verified', true));

  -- C1 the list: owner maksym, homeos-agent and telegram-bot editors, live, Anastasiia not a member
  perform public._cr_chk('C1 list', (select string_agg(p.handle || ':' || m.role, ',' order by p.handle) from public.list_members m
                                       join public.profiles p on p.id = m.profile_id where m.list_id = cl)
                                    || '/' || (select (owner_id = mk and archived_at is null and name = 'Consultancy Request')::text from public.lists where id = cl),
                         'homeos-agent:editor,maksym:owner,telegram-bot:editor/true');

  -- C2 who may request: not signed in, an unverified Google identity, an agent
  perform public._cr_as(null);
  perform public._cr_chk('C2a anonymous', public._cr('select public.request_consultation()::text'), 'ERR 42501%');
  perform public._cr_as(n);
  perform public._cr_chk('C2b unverified', public._cr('select public.request_consultation()::text'), 'ERR 42501%');
  perform public._cr_as(ag);
  perform public._cr_chk('C2c agent', public._cr('select public.request_consultation()::text'), 'ERR 42501%');

  -- C3 a request: one task by homeos-agent, the contacts as links, the note without control characters
  perform public._cr_as(g);
  j := public.request_consultation('@ada_lovelace', '+351 (912) 345-678', E'Planning help\nfor a team of 5\x07');
  perform public._cr_chk('C3a answer', concat_ws('|', j->>'created', j->>'status', j->>'email', j->>'telegram', j->>'whatsapp', (j ? 'item_id')::text),
                         'true|open|' || ge || '|https://t.me/ada_lovelace|https://wa.me/351912345678|false');
  perform public._cr_chk('C3b claims back', public._cr('select auth.uid()::text'), g::text);
  perform public._cr_as(null);
  select id into iid from public.items where list_id = cl and details->>'requested_by' = g::text;
  perform public._cr_chk('C3c task', (select concat_ws('|', created_by = ha, actor_kind, created_via, category, status, title, details->'notify',
                                                       dedup_key like 'consult-request:%', source_ref = g::text)
                                        from public.items where id = iid),
                         't|agent|rpc:request_consultation|task|open|Consulting call: ' || ge || '|["maksym"]|t|t');
  perform public._cr_chk('C3d body', (select (body_md like '%- Email: ' || ge || E'\n- Telegram: https://t.me/ada_lovelace\n- WhatsApp: https://wa.me/351912345678\n%'
                                              and body_md like E'%Note from the requester:\n\nPlanning help\nfor a team of 5'
                                              and body_md not like '%' || chr(7) || '%')::text from public.items where id = iid), 'true');
  perform public._cr_chk('C3e due', (select (to_char(due_at at time zone 'Europe/Lisbon', 'HH24:MI') = '09:00' and due_at > now()
                                              and due_at <= now() + interval '1 day')::text from public.items where id = iid), 'true');

  -- C4 a second call: the open request comes back, no second task, contacts unchanged
  perform public._cr_as(g);
  perform public._cr_chk('C4a', public._cr('select concat_ws(''|'', r->>''created'', r->>''telegram'') from public.request_consultation(''other_name'') r'),
                         'false|https://t.me/ada_lovelace');
  perform public._cr_as(null);
  perform public._cr_chk('C4b count', (select count(*)::text from public.items where list_id = cl and details->>'requested_by' = g::text), '1');

  -- C5 my_consultation_request: own; null for someone without one and for anonymous
  perform public._cr_as(g);
  perform public._cr_chk('C5a own', public._cr('select public.my_consultation_request() ->> ''status'''), 'open');
  perform public._cr_as(y);
  perform public._cr_chk('C5b none', public._cr('select public.my_consultation_request()::text'), 'null');

  -- C6 the requester reads neither the task nor the list, and the helpers are not RPCs
  perform public._cr_as(g);
  perform public._cr_chk('C6a task and list', public._cr(format('select count(*)::text from public.items where id = %L', iid)) || '/'
                                             || public._cr(format('select count(*)::text from public.lists where id = %L', cl)), '0/0');
  perform public._cr_chk('C6b helpers', public._cr('select public.consult_list_id()::text') || '/'
                                       || public._cr(format('select public.consult_request_json(%L)::text', iid)) || '/'
                                       || public._cr(format('select public.consult_latest(%L)::text', g)), 'ERR 42501%/ERR 42501%/ERR 42501%');

  -- C7 maksym, homeos-agent and telegram-bot read the task; anastasiia does not
  perform public._cr_as(mk);
  perform public._cr_chk('C7a maksym', public._cr(format('select count(*)::text from public.items where id = %L', iid)), '1');
  perform public._cr_as(ha);
  perform public._cr_chk('C7b agent', public._cr(format('select count(*)::text from public.items where id = %L', iid)), '1');
  perform public._cr_as(tb);
  perform public._cr_chk('C7c telegram-bot', public._cr(format('select count(*)::text from public.items where id = %L', iid)), '1');
  perform public._cr_as(an);
  perform public._cr_chk('C7d anastasiia', public._cr(format('select count(*)::text from public.items where id = %L', iid)), '0');

  -- C8 bad values are refused before anything is written
  perform public._cr_as(y);
  perform public._cr_chk('C8a short telegram', public._cr('select public.request_consultation(''ab'')::text'), 'ERR 22023%');
  perform public._cr_chk('C8b telegram with spaces', public._cr('select public.request_consultation(''ada lovelace'')::text'), 'ERR 22023%');
  perform public._cr_chk('C8c whatsapp letters', public._cr('select public.request_consultation(null, ''call me'')::text'), 'ERR 22023%');
  perform public._cr_chk('C8d whatsapp short', public._cr('select public.request_consultation(null, ''12345'')::text'), 'ERR 22023%');
  perform public._cr_chk('C8e long note', public._cr(format('select public.request_consultation(null, null, %L)::text', repeat('a', 501))), 'ERR 22023%');
  perform public._cr_as(null);
  perform public._cr_chk('C8f nothing written', (select count(*)::text from public.items where list_id = cl and details->>'requested_by' = y::text), '0');

  -- C9 once the request is done a new one is a new task; no contacts at all is fine; a t.me link is taken
  perform public._cr_as(null);
  update public.items set status = 'done' where id = iid;
  perform public._cr_as(g);
  perform public._cr_chk('C9a after done', public._cr('select concat_ws(''|'', r->>''created'', r->>''telegram'') from public.request_consultation(''https://t.me/ada_l2'') r'),
                         'true|https://t.me/ada_l2');
  perform public._cr_as(x);
  j := public.request_consultation();
  perform public._cr_chk('C9b no contacts', concat_ws('|', j->>'created', coalesce(j->>'telegram', '-'), coalesce(j->>'whatsapp', '-')), 'true|-|-');
  perform public._cr_as(null);
  perform public._cr_chk('C9c body dashes', (select (body_md like E'%- Telegram: -\n- WhatsApp: -\n%' and body_md not like '%Note from%')::text
                                               from public.items where list_id = cl and details->>'requested_by' = x::text), 'true');

  -- C10 a WhatsApp number that passes the card check (13 digits, Luhn) is stored: links are skipped by assert_no_sensitive
  perform public._cr_as(y);
  perform public._cr_chk('C10 card-like phone', public._cr('select public.request_consultation(null, ''+4222222222222'') ->> ''whatsapp'''),
                         'https://wa.me/4222222222222');

  -- C11 caps: the open cap and the daily cap answer 54000 and write nothing
  perform public._cr_as(null);
  update public.items set status = 'done' where list_id = cl and details->>'requested_by' = y::text;
  update ops.settings set value = (select count(*) from public.items where list_id = cl and deleted_at is null and status not in ('done','cancelled'))
   where key = 'consult_requests_open';
  perform public._cr_as(y);
  perform public._cr_chk('C11a open cap', public._cr('select public.request_consultation()::text'), 'ERR 54000%');
  perform public._cr_as(null);
  update ops.settings set value = 1000 where key = 'consult_requests_open';
  update ops.settings set value = (select count(*) from public.items where list_id = cl and created_via = 'rpc:request_consultation'
                                     and created_at > now() - interval '24 hours') where key = 'consult_requests_per_day';
  perform public._cr_as(y);
  perform public._cr_chk('C11b daily cap', public._cr('select public.request_consultation()::text'), 'ERR 54000%');
  perform public._cr_as(null);
  perform public._cr_chk('C11c nothing written', (select count(*)::text from public.items where list_id = cl and details->>'requested_by' = y::text), '1');

  -- C12 rights: anon executes nothing; the helpers are not RPCs
  perform public._cr_chk('C12a anon', (has_function_privilege('anon', 'public.request_consultation(text, text, text)', 'execute')
                                       or has_function_privilege('anon', 'public.my_consultation_request()', 'execute'))::text, 'false');
  perform public._cr_chk('C12b authenticated', (has_function_privilege('authenticated', 'public.request_consultation(text, text, text)', 'execute')
                                                and has_function_privilege('authenticated', 'public.my_consultation_request()', 'execute'))::text, 'true');
  perform public._cr_chk('C12c helpers', (has_function_privilege('authenticated', 'public.consult_list_id()', 'execute')
                                          or has_function_privilege('authenticated', 'public.consult_request_json(uuid)', 'execute')
                                          or has_function_privilege('authenticated', 'public.consult_latest(uuid)', 'execute'))::text, 'false');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('cr.total')::int - current_setting('cr.nf')::int,
    current_setting('cr.total'), coalesce(nullif(current_setting('cr.f'), ''), 'none');
end $do$;
