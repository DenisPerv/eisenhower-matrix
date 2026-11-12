-- db/919_selftest_budget_spent.sql: the settle-only budget row of db/037 (budget_spent) as admin SQL. Rolls everything back and
-- reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-918.
-- Cases: S a household person and a household agent record a cost (one 'settle' row, no reservation, no expiry); the amount range;
-- a task outside its list; at a cap the row is still written while budget_reserve is refused; budget_status sums it per list and
-- overall; G a guest is refused and writes nothing; C the ledger check still refuses a reserve with a reservation and a release
-- without one; Z definer with an empty search_path, anon cannot run it.
-- Fixtures: H1 (household person), AG (household agent, like homeos-agent), G (guest); L1 "st-bs one" owned by H1 with AG as
-- editor. Existing budget rows are removed inside the transaction first; the overall cap is set out of reach and the overall sum
-- is compared with the live month spend read before the cases, so they depend on neither live caps nor live spend.

do $do$
declare
  h1 uuid := gen_random_uuid(); ag uuid := gen_random_uuid(); g uuid := gen_random_uuid(); l1 uuid; i1 uuid; n0 bigint; b0 numeric;
begin
  execute $f$create function public._bs_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
      set local role authenticated; end $b$$f$;
  execute $f$create function public._bs(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 120); end $b$$f$;
  execute $f$create function public._bs_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('bs.total', (coalesce(nullif(current_setting('bs.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('bs.nf', (coalesce(nullif(current_setting('bs.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('bs.f', coalesce(current_setting('bs.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  execute 'grant execute on function public._bs_as(uuid), public._bs(text), public._bs_chk(text, text, text) to authenticated';
  perform set_config('bs.total', '0', true); perform set_config('bs.nf', '0', true); perform set_config('bs.f', '', true);

  -- ---------- fixtures ----------
  delete from public.budgets;
  insert into ops.signup_allowlist (email_lower, kind, is_household) values
    ('st-bs-h1@example.invalid', 'human', true), ('st-bs-ag@example.invalid', 'agent', true);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1, 'st-bs-h1@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (ag, 'st-bs-ag@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (g, 'st-bs-g@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest G"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), g, 'st-bs-sub-g', 'google', json_build_object('sub', 'st-bs-sub-g', 'email', 'st-bs-g@example.invalid', 'email_verified', true));
  update public.profiles set handle = 'st-bs-' || left(id::text, 8) where id in (h1, ag, g);
  perform public._bs_chk('F0 fixtures: H1 household person, AG household agent, G guest',
    (select string_agg(kind || ':' || is_household, ',' order by kind, is_household) from public.profiles where id in (h1, ag, g)),
    'agent:true,human:false,human:true');
  perform public._bs_as(h1);
  l1 := public.create_list('st-bs one', 'st-bs-one', true);
  insert into public.items (list_id, category, title) values (l1, 'task', 'st-bs item') returning id into i1;
  reset role; perform set_config('request.jwt.claims', '', true);
  insert into public.list_members (list_id, profile_id, role) values (l1, ag, 'editor') on conflict do nothing;
  insert into public.budgets (list_id, period, cap_usd, set_by) values (null, 'month', 100000, h1), (l1, 'month', 2, h1);
  select spent into b0 from public.budget_used(null, 'month');
  select count(*) into n0 from public.budget_ledger;

  -- ---------- S: household callers record a cost ----------
  perform public._bs_as(h1);
  perform public._bs_chk('S1 H1 records 1.5 on L1',
    public._bs(format('select (public.budget_spent(%L, %L, %L, %L, 1.5) > 0)::text', 'st-host', 'st-bs-s1', l1, i1)), 'true');
  perform public._bs_chk('S2 one settle row, no reservation, no expiry',
    public._bs(format('select kind || '':'' || (reservation_id is null) || '':'' || (expires_at is null) || '':'' || amount_usd from public.budget_ledger where session = %L', 'st-bs-s1')),
    'settle:true:true:1.5000');
  perform public._bs_as(ag);
  perform public._bs_chk('S3 the agent records 0.4 on L1',
    public._bs(format('select (public.budget_spent(%L, %L, %L, null, 0.4) > 0)::text', 'st-host', 'st-bs-s3', l1)), 'true');
  perform public._bs_chk('S4 the agent records 0.25 with no list (overall only)',
    public._bs(format('select (public.budget_spent(%L, %L, null, null, 0.25) > 0)::text', 'st-host', 'st-bs-s4')), 'true');
  perform public._bs_chk('S5 amount 0 refused', public._bs(format('select public.budget_spent(%L, %L, %L, null, 0)::text', 'st-host', 'st-bs-x', l1)), 'ERR 22023 amount out of range%');
  perform public._bs_chk('S6 amount above 1000 refused', public._bs(format('select public.budget_spent(%L, %L, %L, null, 1000.01)::text', 'st-host', 'st-bs-x', l1)), 'ERR 22023 amount out of range%');
  perform public._bs_chk('S7 null amount refused', public._bs(format('select public.budget_spent(%L, %L, %L, null, null)::text', 'st-host', 'st-bs-x', l1)), 'ERR 22023 amount out of range%');
  perform public._bs_chk('S8 a task outside the list refused', public._bs(format('select public.budget_spent(%L, %L, null, %L, 1)::text', 'st-host', 'st-bs-x', i1)), 'ERR 22023 the task is not in that list%');
  perform public._bs_chk('S9 a bad host refused by the ledger check', public._bs(format('select public.budget_spent(%L, %L, %L, null, 1)::text', 'bad host!', 'st-bs-x', l1)), 'ERR 23514%');

  -- ---------- at the cap: L1 has 1.9 of 2 spent ----------
  perform public._bs_chk('S10 a reservation of 0.5 is refused at the L1 cap',
    public._bs(format('select public.budget_reserve(%L, %L, %L, null, 0.5, 5)::text', 'st-host', 'st-bs-r', l1)), 'ERR 54000 budget reached: list month%');
  perform public._bs_chk('S11 a spent of 0.5 past the cap is still recorded',
    public._bs(format('select (public.budget_spent(%L, %L, %L, null, 0.5) > 0)::text', 'st-host', 'st-bs-s11', l1)), 'true');
  perform public._bs_chk('S12 budget_status: L1 spent 2.4 (over its cap), overall up by 2.65',
    public._bs(format('select string_agg(scope || '':'' || trim_scale(case when scope = ''overall'' then spent_usd - %s else spent_usd end), '','' order by scope) from public.budget_status(%L)', b0, l1)),
    'list:2.4,overall:2.65');
  perform public._bs_chk('S13 written rows', (select (count(*) - n0)::text from public.budget_ledger), '4');

  -- ---------- G: a guest ----------
  perform public._bs_as(g);
  perform public._bs_chk('G1 a guest is refused', public._bs(format('select public.budget_spent(%L, %L, null, null, 1)::text', 'st-host', 'st-bs-g')), 'ERR 42501%');
  perform public._bs_chk('G2 a guest on a list is refused', public._bs(format('select public.budget_spent(%L, %L, %L, null, 1)::text', 'st-host', 'st-bs-g', l1)), 'ERR 42501%');
  reset role; perform set_config('request.jwt.claims', '', true);
  perform public._bs_chk('G3 the guest wrote nothing', (select (count(*) - n0)::text from public.budget_ledger), '4');

  -- ---------- C: the ledger check ----------
  perform public._bs_chk('C1 a release without a reservation is refused',
    public._bs(format('insert into public.budget_ledger (kind, host, session, amount_usd, created_by) values (''release'', ''h'', ''s'', 0, %L)', h1)), 'ERR 23514%');
  perform public._bs_chk('C2 a reserve that names a reservation is refused',
    public._bs(format('insert into public.budget_ledger (kind, host, session, amount_usd, reservation_id, expires_at, created_by) select ''reserve'', ''h'', ''s'', 1, max(id), now(), %L from public.budget_ledger', h1)), 'ERR 23514%');
  perform public._bs_chk('C3 the old check is gone, the new one is there',
    (select string_agg(conname, ',' order by conname) from pg_constraint where conrelid = 'public.budget_ledger'::regclass and conname in ('budget_ledger_check', 'budget_ledger_reservation_link')),
    'budget_ledger_reservation_link');

  -- ---------- Z ----------
  perform public._bs_chk('Z1 budget_spent is a definer with an empty search_path',
    (select (prosecdef and coalesce(proconfig, '{}') @> array['search_path=""'])::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' and p.proname = 'budget_spent'), 'true');
  perform public._bs_chk('Z2 anon cannot run budget_spent',
    (select has_function_privilege('anon', 'public.budget_spent(text, text, uuid, uuid, numeric)', 'execute')::text), 'false');
  perform public._bs_chk('Z3 authenticated can run budget_spent',
    (select has_function_privilege('authenticated', 'public.budget_spent(text, text, uuid, uuid, numeric)', 'execute')::text), 'true');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('bs.total')::int - current_setting('bs.nf')::int,
    current_setting('bs.total'), coalesce(nullif(current_setting('bs.f'), ''), 'none');
end $do$;
