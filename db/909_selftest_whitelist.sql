-- db/909_selftest_whitelist.sql: the whitelist selftest (db/024, security finding S1) as admin SQL. Rolls everything back
-- and reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-908.
-- Cases: W1 who is whitelisted; W2-W8 a Google sign-up nobody let in writes nothing (REST and RPCs), reads nothing of
-- anyone else, cannot probe ids, and can still use my_access_request and request_access; W9 after approval it writes;
-- W10 an approved and a declined request; W11 a member of a household list; W12 an open invitation from the household;
-- W13 the real logins on _selftest (maksym writes, the agents are whitelisted); W14 admin SQL and a household owner
-- removing a member; W15 rights, policies and triggers.
-- Fixtures: H1 (household) and AG (agent, not household) through allowlist rows; G, P, D, M, I as Google users with
-- identities, so the sign-up trigger runs; the real maksym, anastasiia, homeos-agent and telegram-bot profiles and
-- maksym's _selftest list are read, and written only inside this rolled-back transaction.
-- Run after 024, 003, 011 and the 012 policy block.

do $do$
declare
  h1 uuid := gen_random_uuid(); ag uuid := gen_random_uuid();
  g uuid := gen_random_uuid(); p uuid := gen_random_uuid(); d uuid := gen_random_uuid();
  m uuid := gen_random_uuid(); i uuid := gen_random_uuid();
  ge text := 'st-wl-g@example.invalid'; pe text := 'st-wl-p@example.invalid'; de text := 'st-wl-d@example.invalid';
  me text := 'st-wl-m@example.invalid'; ie text := 'st-wl-i@example.invalid';
  mk uuid; an uuid; ha uuid; tb uuid; st uuid; hl uuid; gm uuid; gdef uuid; pm uuid; dm uuid; mm uuid; inv uuid; si uuid; v text;
begin
  execute $f$create function public._wl_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true);
      else perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
           set local role authenticated; end if; end $b$$f$;
  execute $f$create function public._wl(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute $f$create function public._wl_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('wl.total', (coalesce(nullif(current_setting('wl.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('wl.nf', (coalesce(nullif(current_setting('wl.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('wl.f', coalesce(current_setting('wl.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  execute 'grant execute on function public._wl_as(uuid), public._wl(text), public._wl_chk(text, text, text) to authenticated';
  perform set_config('wl.total', '0', true); perform set_config('wl.nf', '0', true); perform set_config('wl.f', '', true);

  -- ---------- fixtures (admin) ----------
  select id into mk from public.profiles where handle = 'maksym';
  select id into an from public.profiles where handle = 'anastasiia';
  select id into ha from public.profiles where handle = 'homeos-agent';
  select id into tb from public.profiles where handle = 'telegram-bot';
  select id into st from public.lists where slug = '_selftest' and owner_id = mk;
  update public.lists set archived_at = null where id = st;
  insert into ops.signup_allowlist (email_lower, kind, is_household) values
    ('st-wl-h1@example.invalid', 'human', true), ('st-wl-ag@example.invalid', 'agent', false);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1, 'st-wl-h1@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (ag, 'st-wl-ag@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (g, ge, 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest G"}'),
    (p, pe, 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest P"}'),
    (d, de, 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest D"}'),
    (m, me, 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest M"}'),
    (i, ie, 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest I"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), g, 'st-wl-sub-g', 'google', json_build_object('sub', 'st-wl-sub-g', 'email', ge, 'email_verified', true)),
    (gen_random_uuid(), p, 'st-wl-sub-p', 'google', json_build_object('sub', 'st-wl-sub-p', 'email', pe, 'email_verified', true)),
    (gen_random_uuid(), d, 'st-wl-sub-d', 'google', json_build_object('sub', 'st-wl-sub-d', 'email', de, 'email_verified', true)),
    (gen_random_uuid(), m, 'st-wl-sub-m', 'google', json_build_object('sub', 'st-wl-sub-m', 'email', me, 'email_verified', true)),
    (gen_random_uuid(), i, 'st-wl-sub-i', 'google', json_build_object('sub', 'st-wl-sub-i', 'email', ie, 'email_verified', true));
  select id into gm from public.lists where owner_id = g;
  select id into pm from public.lists where owner_id = p;
  select id into dm from public.lists where owner_id = d;
  select id into mm from public.lists where owner_id = m;
  select id into gdef from public.tag_lists where owner_id = g and is_default;
  -- the caps must not decide these cases
  update ops.settings set value = 1000 where key in ('access_requests_per_day', 'access_requests_open');
  -- P approved, D declined (requests made by themselves, decisions written as admin)
  perform public._wl_as(p); perform public.request_access();
  perform public._wl_as(d); perform public.request_access();
  perform public._wl_as(null);
  update public.users_pending_for_decision set status = 'approved', decided_at = now(), applied_at = now() where user_id = p;
  update public.users_pending_for_decision set status = 'declined', decided_at = now(), applied_at = now() where user_id = d;
  -- H1's household list: M an editor (admin), I invited (open invitation, admin)
  perform public._wl_as(h1);
  hl := public.create_list('st-wl household', 'st-wl-household', true);
  perform public._wl_as(null);
  insert into public.list_members (list_id, profile_id, role) values (hl, m, 'editor');
  insert into public.invites (list_id, email_lower, role, invited_by, target_name, expires_at)
  values (hl, ie, 'viewer', h1, 'st-wl household', now() + interval '7 days') returning id into inv;

  -- W1 who is whitelisted (asked as admin)
  perform public._wl_chk('W1 whitelisted', (select string_agg(x.k || '=' || public.is_whitelisted_login(x.id), ',' order by x.k)
      from (values ('a-maksym', mk), ('b-anastasiia', an), ('c-homeos-agent', ha), ('d-telegram-bot', tb), ('e-h1', h1),
                   ('f-ag', ag), ('g-approved', p), ('h-member', m), ('i-invited', i), ('j-guest', g), ('k-declined', d),
                   ('l-null', null::uuid)) x(k, id)),
    'a-maksym=true,b-anastasiia=true,c-homeos-agent=true,d-telegram-bot=true,e-h1=true,f-ag=true,g-approved=true,'
    'h-member=true,i-invited=true,j-guest=false,k-declined=false,l-null=false');

  -- W2 G (nobody let it in) writes nothing through REST, not even in its own "My tasks" and "My tags"
  perform public._wl_as(g);
  perform public._wl_chk('W2a item in own list', public._wl(format('insert into public.items (list_id, category, title) values (%L, ''task'', ''x'')', gm)), 'ERR 42501%');
  perform public._wl_chk('W2b rename own list', public._wl(format('update public.lists set name = ''x'' where id = %L', gm)), 'ERR 42501%');
  perform public._wl_chk('W2c tag in own tag list', public._wl(format('insert into public.tags (tag_list_id, name) values (%L, ''x'')', gdef)), 'ERR 42501%');
  perform public._wl_chk('W2d rename own tag list', public._wl(format('update public.tag_lists set name = ''x'' where id = %L', gdef)), 'ERR 42501%');
  perform public._wl_chk('W2e leave own list row', public._wl(format('delete from public.list_members where list_id = %L and profile_id = %L', gm, g)), 'ERR 42501%');
  -- W3 nor through the RPCs that write
  perform public._wl_chk('W3a create_tag_list', public._wl('select public.create_tag_list(''x'')::text'), 'ERR 42501%');
  perform public._wl_chk('W3b create_list', public._wl('select public.create_list(''x'', ''x'', false)::text'), 'ERR 42501%');
  perform public._wl_chk('W3c share_list', public._wl(format('select public.share_list(%L, ''st-wl-x@example.invalid'', ''viewer'')::text', gm)), 'ERR 42501%');
  perform public._wl_chk('W3d set_list_hidden', public._wl(format('select public.set_list_hidden(%L, true)::text', gm)), 'ERR 42501%');
  -- W4 reads: nothing of anyone else
  perform public._wl_chk('W4 reads', public._wl(format('select (select count(*) from public.lists where owner_id <> %1$L) || ''/'' || (select count(*) from public.items) || ''/'' || (select count(*) from public.tag_lists where owner_id <> %1$L) || ''/'' || (select count(*) from public.tags) || ''/'' || (select count(*) from public.list_members where profile_id <> %1$L)', g)), '0/0/0/0/0');
  -- W5 no probing: the function answers only for the caller
  perform public._wl_chk('W5 probe', public._wl(format('select public.is_whitelisted_login(%L)::text || ''/'' || public.is_whitelisted_login(%L)::text', mk, g)), 'false/false');
  -- W6 my_access_request and request_access still work
  perform public._wl_chk('W6a my_access_request before', public._wl('select public.my_access_request()::text'), 'null');
  perform public._wl_chk('W6b request_access', public._wl('select public.request_access()->>''status'''), 'pending');
  perform public._wl_chk('W6c my_access_request after', public._wl('select public.my_access_request()->>''status'''), 'pending');
  perform public._wl_as(null);
  -- W7 the request's task is written as homeos-agent in Access requests
  perform public._wl_chk('W7 task by the agent', (select (i2.created_by = ha)::text || '/' || (i2.list_id = public.access_list_id())::text
      from public.users_pending_for_decision r join public.items i2 on i2.id = r.item_id where r.user_id = g), 'true/true');
  -- W8 still nothing written by G
  perform public._wl_chk('W8 nothing by G', (select count(*)::text from public.items where created_by = g), '0');

  -- W9 once approved, G writes in its own list
  update public.users_pending_for_decision set status = 'approved', decided_at = now(), applied_at = now() where user_id = g;
  perform public._wl_as(g);
  perform public._wl_chk('W9a approved writes', public._wl(format('insert into public.items (list_id, category, title) values (%L, ''task'', ''x'')', gm)), 'ok:1');
  perform public._wl_chk('W9b approved self', public._wl(format('select public.is_whitelisted_login(%L)::text', g)), 'true');

  -- W10 an approved request writes; a declined one does not, and its request reads as declined
  perform public._wl_as(p);
  perform public._wl_chk('W10a approved P', public._wl(format('insert into public.items (list_id, category, title) values (%L, ''task'', ''x'')', pm)), 'ok:1');
  perform public._wl_as(d);
  perform public._wl_chk('W10b declined D', public._wl(format('insert into public.items (list_id, category, title) values (%L, ''task'', ''x'')', dm)), 'ERR 42501%');
  perform public._wl_chk('W10c declined request', public._wl('select public.request_access()->>''status'''), 'declined');

  -- W11 a member of a household list writes there and in its own list
  perform public._wl_as(m);
  perform public._wl_chk('W11a member in household list', public._wl(format('insert into public.items (list_id, category, title) values (%L, ''task'', ''x'')', hl)), 'ok:1');
  perform public._wl_chk('W11b member in own list', public._wl(format('insert into public.items (list_id, category, title) values (%L, ''task'', ''x'')', mm)), 'ok:1');

  -- W12 an open invitation from the household: whitelisted, and it can accept
  perform public._wl_as(i);
  perform public._wl_chk('W12a invited self', public._wl(format('select public.is_whitelisted_login(%L)::text', i)), 'true');
  perform public._wl_chk('W12b accept', public._wl(format('select public.accept_invite(%L)::text', inv)), '%');
  perform public._wl_as(null);
  perform public._wl_chk('W12c member', (select count(*)::text from public.list_members where list_id = hl and profile_id = i), '1');

  -- W13 the real logins: maksym writes in _selftest; the agents answer true for themselves
  perform public._wl_as(mk);
  perform public._wl_chk('W13a maksym insert', public._wl(format('insert into public.items (list_id, category, title, dedup_key) values (%L, ''task'', ''st-wl'', ''st-wl:mk'')', st)), 'ok:1');
  perform public._wl_chk('W13b maksym update', public._wl('update public.items set title = ''st-wl 2'' where dedup_key = ''st-wl:mk'''), 'ok:1');
  perform public._wl_as(ha);
  perform public._wl_chk('W13c homeos-agent', public._wl(format('select public.is_whitelisted_login(%L)::text', ha)), 'true');
  perform public._wl_as(tb);
  perform public._wl_chk('W13d telegram-bot', public._wl(format('select public.is_whitelisted_login(%L)::text', tb)), 'true');
  perform public._wl_as(ag);
  perform public._wl_chk('W13e allowlisted agent', public._wl(format('select public.is_whitelisted_login(%L)::text', ag)), 'true');

  -- W14 admin SQL is not stopped; a household owner removes a member
  perform public._wl_as(null);
  insert into public.items (list_id, category, title, created_by) values (st, 'task', 'st-wl admin', mk) returning id into si;
  perform public._wl_chk('W14a admin insert', (si is not null)::text, 'true');
  perform public._wl_as(h1);
  perform public._wl_chk('W14b owner removes member', public._wl(format('delete from public.list_members where list_id = %L and profile_id = %L', hl, m)), 'ok:1');
  perform public._wl_as(null);

  -- W15 rights, policies, triggers
  perform public._wl_chk('W15a functions', (select string_agg(p2.proname || ':' || p2.prosecdef || ':' || coalesce(array_to_string(p2.proconfig, ','), '')
                    || ':' || has_function_privilege('anon', p2.oid, 'execute') || ':' || has_function_privilege('authenticated', p2.oid, 'execute'), ',' order by p2.proname)
      from pg_proc p2 join pg_namespace s on s.oid = p2.pronamespace
     where s.nspname = 'public' and p2.proname in ('whitelist_base', 'is_whitelisted_login', 'whitelist_write_guard')),
    'is_whitelisted_login:true:search_path="":false:true,whitelist_base:true:search_path="":false:false,whitelist_write_guard:true:search_path="":false:false');
  perform public._wl_chk('W15b restrictive policies', (select count(*)::text from pg_policies where schemaname = 'public' and policyname like 'wl\_%'
                                                         and permissive = 'RESTRICTIVE' and roles = '{authenticated}'), '30');
  perform public._wl_chk('W15c no permissive policy for anon', (select count(*)::text from pg_policies where schemaname = 'public' and 'anon' = any(roles)), '0');
  perform public._wl_chk('W15d triggers', (select count(*)::text from pg_trigger where not tgisinternal and tgname = 'whitelist_write_guard'
                                             and tgtype & 1 = 0), '10');
  perform public._wl_chk('W15e is_whitelisted (022) still closed', has_function_privilege('authenticated', 'public.is_whitelisted(uuid)', 'execute')::text, 'false');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('wl.total')::int - current_setting('wl.nf')::int,
    current_setting('wl.total'), coalesce(nullif(current_setting('wl.f'), ''), 'none');
end $do$;
