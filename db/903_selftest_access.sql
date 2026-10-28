-- db/903_selftest_access.sql: the access-request selftest (HomeOS access-backup-plan.md D2) as admin SQL. Rolls
-- everything back and reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-902.
-- Cases: Q1 the list; Q2 who may request; Q3 a request (row, task as homeos-agent, due, notify); Q4 a second call;
-- Q5 my_access_request; Q6 what a guest cannot read or write; Q7 what the household and the agent read; Q8 decisions
-- (agent only, transitions); Q9 a request after removal; Q10 caps (54000); Q11 rights and the created_via rule.
-- Fixtures as in 902: H1 (household) and AG (agent) through allowlist rows, G, N, X, Y as Google users with identities;
-- the real maksym, anastasiia, homeos-agent and telegram-bot profiles are read, never changed for good.
-- Run after 015, 003, 011, the 012 policy block, 900, 901 and 902.

do $do$
declare
  h1 uuid := gen_random_uuid(); ag uuid := gen_random_uuid(); g uuid := gen_random_uuid(); n uuid := gen_random_uuid();
  x uuid := gen_random_uuid(); y uuid := gen_random_uuid();
  ge text := 'st-acc-g@example.invalid'; he text := 'st-acc-h1@example.invalid';
  mk uuid; an uuid; ha uuid; tb uuid; acc uuid; rid uuid; rid2 uuid; iid uuid; j jsonb; v text;
begin
  execute $f$create function public._ac_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true);
      else perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
           set local role authenticated; end if; end $b$$f$;
  execute $f$create function public._ac(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute $f$create function public._ac_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('ac.total', (coalesce(nullif(current_setting('ac.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('ac.nf', (coalesce(nullif(current_setting('ac.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('ac.f', coalesce(current_setting('ac.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  execute 'grant execute on function public._ac_as(uuid), public._ac(text), public._ac_chk(text, text, text) to authenticated';
  perform set_config('ac.total', '0', true); perform set_config('ac.nf', '0', true); perform set_config('ac.f', '', true);

  -- ---------- fixtures (admin) ----------
  select id into mk from public.profiles where handle = 'maksym';
  select id into an from public.profiles where handle = 'anastasiia';
  select id into ha from public.profiles where handle = 'homeos-agent';
  select id into tb from public.profiles where handle = 'telegram-bot';
  acc := public.access_list_id();
  insert into ops.signup_allowlist (email_lower, kind, is_household) values (he, 'human', true), ('st-acc-ag@example.invalid', 'agent', true);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1, he, 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (ag, 'st-acc-ag@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (g, upper(ge), 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Ada Lovelace King"}'),
    (n, 'st-acc-n@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Not Verified"}'),
    (x, 'st-acc-x@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Xavier"}'),
    (y, 'st-acc-y@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Y"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), g, 'st-acc-sub-g', 'google', json_build_object('sub', 'st-acc-sub-g', 'email', upper(ge), 'email_verified', true, 'full_name', 'Ada Lovelace King')),
    (gen_random_uuid(), n, 'st-acc-sub-n', 'google', json_build_object('sub', 'st-acc-sub-n', 'email', 'st-acc-n@example.invalid', 'email_verified', false)),
    (gen_random_uuid(), x, 'st-acc-sub-x', 'google', json_build_object('sub', 'st-acc-sub-x', 'email', 'st-acc-x@example.invalid', 'email_verified', true,
                                                                        'given_name', 'Xavier', 'family_name', 'de la Cruz')),
    (gen_random_uuid(), y, 'st-acc-sub-y', 'google', json_build_object('sub', 'st-acc-sub-y', 'email', 'st-acc-y@example.invalid', 'email_verified', true));

  -- Q1 the list: owner maksym, anastasiia and homeos-agent editors, live
  perform public._ac_chk('Q1 list', (select string_agg(p.handle || ':' || m.role, ',' order by p.handle) from public.list_members m
                                       join public.profiles p on p.id = m.profile_id where m.list_id = acc)
                                    || '/' || (select (owner_id = mk and archived_at is null)::text from public.lists where id = acc),
                         'anastasiia:editor,homeos-agent:editor,maksym:owner/true');

  -- Q2 who may request: not signed in, an unverified Google identity, a household person, an agent
  perform public._ac_as(null);
  perform public._ac_chk('Q2a anonymous', public._ac('select public.request_access()::text'), 'ERR 42501%');
  perform public._ac_as(n);
  perform public._ac_chk('Q2b unverified', public._ac('select public.request_access()::text'), 'ERR 42501%');
  perform public._ac_as(h1);
  perform public._ac_chk('Q2c household', public._ac('select public.request_access()::text'), 'ERR 22023%');
  perform public._ac_as(ag);
  perform public._ac_chk('Q2d agent', public._ac('select public.request_access()::text'), 'ERR 42501%');

  -- Q3 a request: one row (email lower case, names from full_name), one task as homeos-agent in the list
  perform public._ac_as(g);
  j := public.request_access();
  rid := (j->>'id')::uuid; iid := (j->>'item_id')::uuid;
  perform public._ac_chk('Q3a answer', concat_ws('|', j->>'status', j->>'email', j->>'first_name', j->>'last_name', (iid is not null)::text),
                         'pending|' || ge || '|Ada|Lovelace King|true');
  perform public._ac_chk('Q3b claims back', public._ac('select auth.uid()::text'), g::text);
  perform public._ac_as(null);
  perform public._ac_chk('Q3c row', (select count(*)::text || '/' || (item_id = iid)::text from public.users_pending_for_decision
                                      where user_id = g group by item_id), '1/true');
  perform public._ac_chk('Q3d task', (select concat_ws('|', list_id = acc, created_by = ha, actor_kind, created_via, category, status, title,
                                                       details->'notify', details->>'access_request_id' = rid::text, dedup_key = 'access-request:' || rid,
                                                       body_md like 'Write Approved or Declined as the first word of this description.%')
                                        from public.items where id = iid),
                         't|t|agent|rpc:request_access|task|open|Access request: ' || ge || '|["maksym", "anastasiia"]|t|t|t');
  perform public._ac_chk('Q3e due', (select (to_char(due_at at time zone 'Europe/Lisbon', 'HH24:MI') = '09:00' and due_at > now()
                                              and due_at <= now() + interval '1 day')::text from public.items where id = iid), 'true');
  perform public._ac_chk('Q3f event by the agent', (select string_agg(actor_id::text || ':' || action, ',') from public.item_events where item_id = iid),
                         ha::text || ':create');
  perform public._ac_as(x);
  j := public.request_access();
  perform public._ac_chk('Q3g given and family name', concat_ws('|', j->>'first_name', j->>'last_name'), 'Xavier|de la Cruz');

  -- Q4 a second call: the same row, no second task
  perform public._ac_as(g);
  perform public._ac_chk('Q4', public._ac('select public.request_access() ->> ''id''') || '/'
                               || public._ac('select public.request_access() ->> ''status'''), rid::text || '/pending');
  perform public._ac_as(null);
  perform public._ac_chk('Q4b counts', (select count(*)::text from public.users_pending_for_decision where user_id = g) || '/'
                                       || (select count(*)::text from public.items where list_id = acc and title = 'Access request: ' || ge), '1/1');

  -- Q5 my_access_request: own row; null for someone without one
  perform public._ac_as(g);
  perform public._ac_chk('Q5a own', public._ac('select public.my_access_request() ->> ''id'''), rid::text);
  perform public._ac_as(y);
  perform public._ac_chk('Q5b none', public._ac('select public.my_access_request()::text'), 'null');

  -- Q6 a guest neither reads nor writes the table, the list or the task, nor decides
  perform public._ac_as(g);
  perform public._ac_chk('Q6a table read', public._ac('select count(*)::text from public.users_pending_for_decision'), 'ERR 42501%');
  perform public._ac_chk('Q6b table write', public._ac(format('update public.users_pending_for_decision set status = ''approved'' where id = %L', rid)), 'ERR 42501%');
  perform public._ac_chk('Q6c table insert', public._ac(format('insert into public.users_pending_for_decision (user_id, email) values (%L, ''a@b.c'')', g)), 'ERR 42501%');
  perform public._ac_chk('Q6d task and list', public._ac(format('select count(*)::text from public.items where id = %L', iid)) || '/'
                                             || public._ac(format('select count(*)::text from public.lists where id = %L', acc)), '0/0');
  perform public._ac_chk('Q6e list of requests', public._ac('select count(*)::text from public.access_requests()'), 'ERR 42501%');
  perform public._ac_chk('Q6f decide', public._ac(format('select public.access_request_decided(%L, ''approved'')::text', rid)), 'ERR 42501%');
  perform public._ac_chk('Q6g internal helpers', public._ac(format('select public.access_request_json(%L)::text', rid)) || '/'
                                                || public._ac('select public.access_list_id()::text'), 'ERR 42501%/ERR 42501%');

  -- Q7 the household and the agent read the requests and the task; the table itself has no API grants
  perform public._ac_as(mk);
  perform public._ac_chk('Q7a maksym', public._ac(format('select count(*)::text from public.access_requests() r where r->>''id'' = %L', rid)) || '/'
                                      || public._ac(format('select count(*)::text from public.items where id = %L', iid)), '1/1');
  perform public._ac_as(an);
  perform public._ac_chk('Q7b anastasiia', public._ac('select count(*)::text from public.access_requests(''pending'') r where r->>''email'' like ''st-acc-%''') || '/'
                                          || public._ac(format('select count(*)::text from public.items where id = %L', iid)), '2/1');
  perform public._ac_as(ha);
  perform public._ac_chk('Q7c agent', public._ac(format('select count(*)::text from public.access_requests() r where r->>''id'' = %L', rid)), '1');
  perform public._ac_as(tb);
  perform public._ac_chk('Q7d telegram-bot', public._ac('select count(*)::text from public.access_requests()'), 'ERR 42501%');
  perform public._ac_as(mk);
  perform public._ac_chk('Q7e no table grant', public._ac('select count(*)::text from public.users_pending_for_decision'), 'ERR 42501%');

  -- Q8 decisions: homeos-agent only; a bad status, a skipped step and an unknown id are refused
  perform public._ac_as(mk);
  perform public._ac_chk('Q8a person', public._ac(format('select public.access_request_decided(%L, ''approved'')::text', rid)), 'ERR 42501%');
  perform public._ac_as(tb);
  perform public._ac_chk('Q8b telegram-bot', public._ac(format('select public.access_request_decided(%L, ''approved'')::text', rid)), 'ERR 42501%');
  perform public._ac_as(ag);
  perform public._ac_chk('Q8c agent off the list', public._ac(format('select public.access_request_decided(%L, ''approved'')::text', rid)), 'ERR 42501%');
  perform public._ac_as(ha);
  perform public._ac_chk('Q8d bad status', public._ac(format('select public.access_request_decided(%L, ''maybe'')::text', rid)), 'ERR 22023%');
  perform public._ac_chk('Q8e pending to removed', public._ac(format('select public.access_request_decided(%L, ''removed'')::text', rid)), 'ERR 22023%');
  perform public._ac_chk('Q8f unknown id', public._ac(format('select public.access_request_decided(%L, ''approved'')::text', gen_random_uuid())), 'ERR 22023%');
  j := public.access_request_decided(rid, 'approved');
  perform public._ac_chk('Q8g approved', concat_ws('|', j->>'status', (j->>'decided_at' is not null), (j->>'applied_at' is not null)), 'approved|t|t');
  perform public._ac_chk('Q8h same again', public._ac(format('select public.access_request_decided(%L, ''approved'') ->> ''status''', rid)), 'approved');
  perform public._ac_chk('Q8i approved to declined', public._ac(format('select public.access_request_decided(%L, ''declined'')::text', rid)), 'ERR 22023%');
  perform public._ac_as(g);
  perform public._ac_chk('Q8j requester sees approved', public._ac('select public.request_access() ->> ''status''') || '/'
                                                       || public._ac('select public.my_access_request() ->> ''status'''), 'approved/approved');

  -- Q9 after removal a new request is a new row and a new task
  perform public._ac_as(ha);
  perform public._ac_chk('Q9a removed', public._ac(format('select public.access_request_decided(%L, ''removed'') ->> ''status''', rid)), 'removed');
  perform public._ac_as(g);
  j := public.request_access();
  rid2 := (j->>'id')::uuid;
  perform public._ac_as(null);
  perform public._ac_chk('Q9b new request', concat_ws('|', j->>'status', rid2 <> rid,
                                            (select count(*) from public.users_pending_for_decision where user_id = g),
                                            (select count(*) from public.items where list_id = acc and title = 'Access request: ' || ge)), 'pending|t|2|2');

  -- Q10 caps: the open cap and the daily cap answer 54000 and write nothing
  perform public._ac_as(null);
  update ops.settings set value = (select count(*) from public.users_pending_for_decision where status = 'pending') where key = 'access_requests_open';
  perform public._ac_as(y);
  perform public._ac_chk('Q10a open cap', public._ac('select public.request_access()::text'), 'ERR 54000%');
  perform public._ac_as(null);
  update ops.settings set value = 1000 where key = 'access_requests_open';
  update ops.settings set value = (select count(*) from public.users_pending_for_decision where requested_at > now() - interval '24 hours')
   where key = 'access_requests_per_day';
  perform public._ac_as(y);
  perform public._ac_chk('Q10b daily cap', public._ac('select public.request_access()::text'), 'ERR 54000%');
  perform public._ac_as(null);
  perform public._ac_chk('Q10c nothing written', (select count(*)::text from public.users_pending_for_decision where user_id = y), '0');

  -- Q11 rights: anon executes nothing, RLS is on, the internal helpers are not RPCs; created_via takes rpc: and no other prefix
  perform public._ac_chk('Q11a anon', (has_function_privilege('anon', 'public.request_access()', 'execute')
                                       or has_function_privilege('anon', 'public.my_access_request()', 'execute')
                                       or has_function_privilege('anon', 'public.access_requests(text)', 'execute')
                                       or has_function_privilege('anon', 'public.access_request_decided(uuid, text)', 'execute'))::text, 'false');
  perform public._ac_chk('Q11b rls', (select relrowsecurity::text from pg_class where oid = 'public.users_pending_for_decision'::regclass), 'true');
  perform public._ac_chk('Q11c helpers', (has_function_privilege('authenticated', 'public.access_request_json(uuid)', 'execute')
                                          or has_function_privilege('authenticated', 'public.access_list_id()', 'execute'))::text, 'false');
  perform public._ac_chk('Q11d created_via', ('rpc:request_access' ~ (select substring(pg_get_constraintdef(oid) from '''(\^.*\$)''')
                                                                     from pg_constraint where conname = 'items_created_via_check'))::text
                                           || '/' || ('foo:x' ~ (select substring(pg_get_constraintdef(oid) from '''(\^.*\$)''')
                                                                from pg_constraint where conname = 'items_created_via_check'))::text, 'true/false');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('ac.total')::int - current_setting('ac.nf')::int,
    current_setting('ac.total'), coalesce(nullif(current_setting('ac.f'), ''), 'none');
end $do$;
