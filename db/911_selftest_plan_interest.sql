-- db/911_selftest_plan_interest.sql: the landing page's plan-button selftest (db/026, db/030) as admin SQL. Rolls everything
-- back and reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-910.
-- Cases: P1 a press with both contacts, as anon; P2 presses with no email are refused; P3 the same contact again; P4 bad
-- values; P5 caps (54000); P6 a flood does not use up the consulting caps; P7 what anon cannot do; P8 who reads the task;
-- P9 rights. Run after 026, 003, 011, the 012 policy block, 026 and 030 again and 900-910.

do $do$
declare
  g uuid := gen_random_uuid();
  mk uuid; an uuid; ha uuid; cl uuid; iid uuid; j jsonb; n bigint;
begin
  execute $f$create function public._pi_admin() returns void language plpgsql as $b$
    begin reset role; perform set_config('request.jwt.claims', '', true); end $b$$f$;
  execute $f$create function public._pi_anon() returns void language plpgsql as $b$
    begin reset role; perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
          set local role anon; end $b$$f$;
  execute $f$create function public._pi_as(p uuid) returns void language plpgsql as $b$
    begin reset role; perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
          set local role authenticated; end $b$$f$;
  execute $f$create function public._pi(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute $f$create function public._pi_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('pi.total', (coalesce(nullif(current_setting('pi.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('pi.nf', (coalesce(nullif(current_setting('pi.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('pi.f', coalesce(current_setting('pi.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  execute 'grant execute on function public._pi_admin(), public._pi_anon(), public._pi_as(uuid), public._pi(text), public._pi_chk(text, text, text) to anon, authenticated';
  perform set_config('pi.total', '0', true); perform set_config('pi.nf', '0', true); perform set_config('pi.f', '', true);

  -- ---------- fixtures (admin) ----------
  select id into mk from public.profiles where handle = 'maksym';
  select id into an from public.profiles where handle = 'anastasiia';
  select id into ha from public.profiles where handle = 'homeos-agent';
  cl := public.consult_list_id();
  -- earlier real requests do not count against the caps in this test
  update public.items set status = 'done' where list_id = cl and status not in ('done','cancelled');
  update ops.settings set value = 1000 where key in ('plan_interest_per_day', 'plan_interest_open', 'consult_requests_per_day', 'consult_requests_open');
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (g, 'st-pi-g@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"G"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), g, 'st-pi-sub-g', 'google', json_build_object('sub', 'st-pi-sub-g', 'email', 'st-pi-g@example.invalid', 'email_verified', true));

  -- P1 a press with both contacts, as anon: a Plan task by homeos-agent with no due date, and the answer says nothing else
  perform public._pi_anon();
  j := public.request_plan_interest('Personal', '  Ada@Example.invalid ', '@ada_lovelace');
  perform public._pi_chk('P1a answer', j::text, '{"ok": true}');
  perform public._pi_chk('P1b claims back', public._pi('select coalesce(auth.uid()::text, ''none'')'), 'none');
  perform public._pi_admin();
  select id into iid from public.items where list_id = cl and details->>'email' = 'ada@example.invalid';
  perform public._pi_chk('P1c task', (select concat_ws('|', created_by = ha, actor_kind, created_via, category, status, quadrant, title,
                                                       due_at is null, details ? 'requested_by', details->>'plan', details->>'telegram',
                                                       dedup_key like 'plan-interest:%')
                                        from public.items where id = iid),
                         't|agent|rpc:request_plan_interest|task|open|B|Interest in Personal: ada@example.invalid|t|f|Personal|https://t.me/ada_lovelace|t');
  perform public._pi_chk('P1d body', (select (body_md like 'Pressed "Subscribe to Personal" on the landing page.%'
                                              and body_md like E'%- Email: ada@example.invalid\n- Telegram: https://t.me/ada_lovelace\n%')::text
                                        from public.items where id = iid), 'true');

  -- P2 no email is refused on every plan and writes nothing: no contact, blank strings, Telegram only (db/030)
  select count(*) into n from public.items where list_id = cl and created_via = 'rpc:request_plan_interest';
  perform public._pi_anon();
  perform public._pi_chk('P2a no contact', public._pi('select public.request_plan_interest(''Demo'')::text'), 'ERR 22023%');
  perform public._pi_chk('P2b team', public._pi('select public.request_plan_interest(''Team'')::text'), 'ERR 22023%');
  perform public._pi_chk('P2c blank', public._pi('select public.request_plan_interest(''Demo'', '''', ''   '')::text'), 'ERR 22023%');
  perform public._pi_chk('P2d telegram only', public._pi('select public.request_plan_interest(''Personal'', null, ''@tg_only_user'')::text'), 'ERR 22023%');
  perform public._pi_chk('P2e blank email and telegram', public._pi('select public.request_plan_interest(''Personal'', ''  '', ''@tg_only_user'')::text'), 'ERR 22023%');
  perform public._pi_admin();
  perform public._pi_chk('P2f nothing written', (select (count(*) = n)::text from public.items where list_id = cl and created_via = 'rpc:request_plan_interest'), 'true');

  -- P3 the same contact and plan again: no second task and the same answer; the same Telegram with another email is the same
  -- contact, also as a t.me link; another plan is new
  perform public._pi_anon();
  perform public._pi_chk('P3a answer', public.request_plan_interest('Personal', 'ada@example.invalid')::text, '{"ok": true}');
  perform public.request_plan_interest('Personal', 'ada2@example.invalid', 'https://t.me/ada_lovelace');
  perform public.request_plan_interest('Team', 'ada@example.invalid');
  perform public._pi_admin();
  -- counts this test's contact only: real presses may already be in the list
  perform public._pi_chk('P3b count', (select count(*)::text from public.items where list_id = cl and details->>'plan' = 'Personal'
                                         and (details->>'email' = 'ada@example.invalid' or details->>'telegram' = 'https://t.me/ada_lovelace')), '1');
  perform public._pi_chk('P3c other plan', (select count(*)::text from public.items where list_id = cl and details->>'plan' = 'Team' and details->>'email' = 'ada@example.invalid'), '1');
  -- once the task is closed the same contact files again
  update public.items set status = 'done' where id = iid;
  perform public._pi_anon();
  perform public.request_plan_interest('Personal', 'ada@example.invalid');
  perform public._pi_admin();
  perform public._pi_chk('P3d after done', (select count(*)::text from public.items where list_id = cl and details->>'plan' = 'Personal'
                                              and (details->>'email' = 'ada@example.invalid' or details->>'telegram' = 'https://t.me/ada_lovelace')), '2');

  -- P4 bad values are refused before anything is written; no text reaches the task unchecked
  perform public._pi_anon();
  perform public._pi_chk('P4a plan', public._pi('select public.request_plan_interest(''Enterprise'')::text'), 'ERR 22023%');
  perform public._pi_chk('P4b null plan', public._pi('select public.request_plan_interest(null)::text'), 'ERR 22023%');
  perform public._pi_chk('P4c email', public._pi('select public.request_plan_interest(''Team'', ''not an email'')::text'), 'ERR 22023%');
  perform public._pi_chk('P4d email markup', public._pi('select public.request_plan_interest(''Team'', ''a<b>@example.invalid'')::text'), 'ERR 22023%');
  perform public._pi_chk('P4e email newline', public._pi(format('select public.request_plan_interest(''Team'', %L)::text', E'a@example.invalid\n- x')), 'ERR 22023%');
  perform public._pi_chk('P4f long email', public._pi(format('select public.request_plan_interest(''Team'', %L)::text', repeat('a', 250) || '@example.invalid')), 'ERR 22023%');
  perform public._pi_chk('P4g telegram', public._pi('select public.request_plan_interest(''Team'', ''tg@example.invalid'', ''ab'')::text'), 'ERR 22023%');
  perform public._pi_chk('P4h telegram link', public._pi('select public.request_plan_interest(''Team'', ''tg@example.invalid'', ''https://evil.example/x_y_z'')::text'), 'ERR 22023%');
  perform public._pi_chk('P4i card-like email', public._pi('select public.request_plan_interest(''Team'', ''4111111111111111@example.invalid'')::text'), 'ERR 22023%');
  perform public._pi_admin();
  perform public._pi_chk('P4j nothing written', (select count(*)::text from public.items where list_id = cl and body_md like '%evil.example%'), '0');

  -- P5 caps: the open cap and the daily cap answer 54000 and write nothing; a repeat of a known contact still answers ok
  update ops.settings set value = (select count(*) from public.items where list_id = cl and created_via = 'rpc:request_plan_interest'
                                     and deleted_at is null and status not in ('done','cancelled'))
   where key = 'plan_interest_open';
  perform public._pi_anon();
  perform public._pi_chk('P5a open cap', public._pi('select public.request_plan_interest(''Team'', ''new@example.invalid'')::text'), 'ERR 54000%');
  perform public._pi_chk('P5b known contact', public._pi('select public.request_plan_interest(''Personal'', ''ada@example.invalid'')::text'), '{"ok": true}');
  perform public._pi_admin();
  update ops.settings set value = 1000 where key = 'plan_interest_open';
  update ops.settings set value = (select count(*) from public.items where list_id = cl and created_via = 'rpc:request_plan_interest'
                                     and created_at > now() - interval '24 hours') where key = 'plan_interest_per_day';
  perform public._pi_anon();
  perform public._pi_chk('P5c daily cap', public._pi('select public.request_plan_interest(''Team'', ''new@example.invalid'')::text'), 'ERR 54000%');
  perform public._pi_admin();
  perform public._pi_chk('P5d nothing written', (select count(*)::text from public.items where list_id = cl and details->>'email' = 'new@example.invalid'), '0');
  update ops.settings set value = 1000 where key = 'plan_interest_per_day';

  -- P6 open plan tasks do not use up the consulting caps: with the consulting cap at 1 and plan tasks open, a request goes through
  update ops.settings set value = 1 where key = 'consult_requests_open';
  perform public._pi_as(g);
  perform public._pi_chk('P6 consult free', public._pi('select public.request_consultation() ->> ''created'''), 'true');
  perform public._pi_admin();

  -- P7 anon reads and writes nothing else: no list, no item, no profile, no other function of the flow
  perform public._pi_anon();
  perform public._pi_chk('P7a items', public._pi('select count(*)::text from public.items'), 'ERR 42501%');
  perform public._pi_chk('P7b lists', public._pi('select count(*)::text from public.lists'), 'ERR 42501%');
  perform public._pi_chk('P7c profiles', public._pi('select count(*)::text from public.profiles'), 'ERR 42501%');
  perform public._pi_chk('P7d insert', public._pi(format('insert into public.items (list_id, title) values (%L, ''x'')', cl)), 'ERR 42501%');
  perform public._pi_chk('P7e consult', public._pi('select public.request_consultation()::text'), 'ERR 42501%');
  perform public._pi_chk('P7f helpers', public._pi('select public.consult_list_id()::text'), 'ERR 42501%');
  perform public._pi_chk('P7g setting', public._pi('select public.setting(''plan_interest_open'')::text'), 'ERR 42501%');
  perform public._pi_admin();

  -- P8 maksym and homeos-agent read the task; anastasiia does not
  perform public._pi_as(mk);
  perform public._pi_chk('P8a maksym', public._pi(format('select count(*)::text from public.items where id = %L', iid)), '1');
  perform public._pi_as(ha);
  perform public._pi_chk('P8b agent', public._pi(format('select count(*)::text from public.items where id = %L', iid)), '1');
  perform public._pi_as(an);
  perform public._pi_chk('P8c anastasiia', public._pi(format('select count(*)::text from public.items where id = %L', iid)), '0');
  perform public._pi_admin();

  -- P9 rights: anon and authenticated may run it; a definer with an empty search_path; public has nothing
  perform public._pi_chk('P9a anon', has_function_privilege('anon', 'public.request_plan_interest(text, text, text)', 'execute')::text, 'true');
  perform public._pi_chk('P9b authenticated', has_function_privilege('authenticated', 'public.request_plan_interest(text, text, text)', 'execute')::text, 'true');
  perform public._pi_chk('P9c definer', (select (p.prosecdef and p.proconfig @> array['search_path=""'])::text from pg_proc p
                                           where p.oid = 'public.request_plan_interest(text, text, text)'::regprocedure), 'true');
  perform public._pi_chk('P9d public', (select coalesce(bool_or(a.grantee = 0), false)::text from pg_proc p, aclexplode(p.proacl) a
                                          where p.oid = 'public.request_plan_interest(text, text, text)'::regprocedure), 'false');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('pi.total')::int - current_setting('pi.nf')::int,
    current_setting('pi.total'), coalesce(nullif(current_setting('pi.f'), ''), 'none');
end $do$;
