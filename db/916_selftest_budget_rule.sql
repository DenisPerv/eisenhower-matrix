-- db/916_selftest_budget_rule.sql: the overall-cap rule of set_budget (db/033) as admin SQL. Rolls everything back and reports
-- "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-915.
-- Cases: O a list cap above the overall cap of its period is refused (22023, the overall cap in the text), equal is allowed; the
-- overall cap below a list cap is refused (22023, the list and its cap in the text); a refused call writes nothing; removing a cap
-- is always allowed; caps of the other period are not compared; K what set_budget did before is kept (period, range, roles, log).
-- Fixtures: H1 (household person), AG (a household agent); L1 "st-bu one" and L2 "st-bu two", both owned by H1. Existing budget
-- rows are removed inside the transaction first, so the cases do not depend on live caps (nothing reads the ledger).
-- Run after 033 (and after 032 again, then 033 again: 032 re-creates set_budget without the rule).

do $do$
declare
  h1 uuid := gen_random_uuid(); ag uuid := gen_random_uuid(); l1 uuid; l2 uuid;
begin
  execute $f$create function public._bu_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
      set local role authenticated; end $b$$f$;
  execute $f$create function public._bu(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 120); end $b$$f$;
  execute $f$create function public._bu_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('bu.total', (coalesce(nullif(current_setting('bu.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('bu.nf', (coalesce(nullif(current_setting('bu.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('bu.f', coalesce(current_setting('bu.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  execute 'grant execute on function public._bu_as(uuid), public._bu(text), public._bu_chk(text, text, text) to authenticated';
  perform set_config('bu.total', '0', true); perform set_config('bu.nf', '0', true); perform set_config('bu.f', '', true);

  -- ---------- fixtures ----------
  delete from public.budgets;
  insert into ops.signup_allowlist (email_lower, kind, is_household) values
    ('st-bu-h1@example.invalid', 'human', true), ('st-bu-ag@example.invalid', 'agent', true);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1, 'st-bu-h1@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (ag, 'st-bu-ag@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  update public.profiles set handle = 'st-bu-' || left(id::text, 8) where id in (h1, ag);
  perform public._bu_chk('F0 fixtures: H1 a household person, AG a household agent',
    (select string_agg(kind || ':' || is_household, ',' order by kind) from public.profiles where id in (h1, ag)), 'agent:true,human:true');
  perform public._bu_as(h1);
  l1 := public.create_list('st-bu one', 'st-bu-one', true);
  l2 := public.create_list('st-bu two', 'st-bu-two', true);

  -- ---------- O: the overall cap is the ceiling ----------
  perform public._bu_chk('O1 overall month cap 100', public._bu('select public.set_budget(null, ''month'', 100)'), '');
  perform public._bu_chk('O2 L1 month cap 50 fits', public._bu(format('select public.set_budget(%L, %L, 50)', l1, 'month')), '');
  perform public._bu_chk('O3 L1 month cap 150 is above the overall cap',
    public._bu(format('select public.set_budget(%L, %L, 150)', l1, 'month')), 'ERR 22023 a list cap may not be above the overall cap ($100)');
  perform public._bu_chk('O4 the refused call wrote nothing', (select cap_usd::text from public.budgets where list_id = l1 and period = 'month'), '50.00');
  perform public._bu_chk('O5 equal to the overall cap is allowed', public._bu(format('select public.set_budget(%L, %L, 100)', l1, 'month')), '');
  perform public._bu_chk('O6 L2 month cap 30', public._bu(format('select public.set_budget(%L, %L, 30)', l2, 'month')), '');
  perform public._bu_chk('O7 overall month 80 is below L1 (the highest list cap is named)',
    public._bu('select public.set_budget(null, ''month'', 80)'), 'ERR 22023 the overall cap may not be below a list cap: st-bu one $100');
  perform public._bu_chk('O8 the overall cap is unchanged', (select cap_usd::text from public.budgets where list_id is null and period = 'month'), '100.00');
  perform public._bu_chk('O9 overall month raised to 200', public._bu('select public.set_budget(null, ''month'', 200)'), '');
  -- the other period is not compared
  perform public._bu_chk('O10 overall day cap 1 below a month list cap', public._bu('select public.set_budget(null, ''day'', 1)'), '');
  perform public._bu_chk('O11 L2 day cap 5 above the overall day cap',
    public._bu(format('select public.set_budget(%L, %L, 5)', l2, 'day')), 'ERR 22023 a list cap may not be above the overall cap ($1)');
  perform public._bu_chk('O12 L2 day cap 0.5 fits', public._bu(format('select public.set_budget(%L, %L, 0.5)', l2, 'day')), '');
  -- removing a cap is always allowed
  perform public._bu_chk('O13 L1 month cap removed', public._bu(format('select public.set_budget(%L, %L, null)', l1, 'month')), '');
  perform public._bu_chk('O14 overall month 40 now fits (L2 30)', public._bu('select public.set_budget(null, ''month'', 40)'), '');
  perform public._bu_chk('O15 overall month removed while list caps exist', public._bu('select public.set_budget(null, ''month'', null)'), '');
  perform public._bu_chk('O16 with no overall cap a list cap has no ceiling', public._bu(format('select public.set_budget(%L, %L, 500)', l1, 'month')), '');
  perform public._bu_chk('O17 overall month 400 is below L1 500',
    public._bu('select public.set_budget(null, ''month'', 400)'), 'ERR 22023 the overall cap may not be below a list cap: st-bu one $500');
  perform public._bu_chk('O18 a decimal cap is shown without trailing zeros',
    public._bu('select public.set_budget(null, ''day'', 0.25)'), 'ERR 22023 the overall cap may not be below a list cap: st-bu two $0.5');

  -- ---------- K: what set_budget did before is kept ----------
  perform public._bu_chk('K1 a bad period', public._bu(format('select public.set_budget(%L, %L, 2)', l1, 'week')), 'ERR 22023 period is day or month%');
  perform public._bu_chk('K2 a cap out of range', public._bu('select public.set_budget(null, ''month'', 100001)'), 'ERR 22023 cap out of range%');
  perform public._bu_chk('K3 every change is logged',
    public._bu(format('select count(*)::text from public.autonomy_events where action = %L and actor_id = %L', 'budget', h1)), '11');
  perform public._bu_as(ag);
  perform public._bu_chk('K4 the agent cannot set a budget', public._bu(format('select public.set_budget(%L, %L, 1)', l1, 'month')), 'ERR 42501%');
  perform public._bu_chk('K5 the agent cannot set the overall cap', public._bu('select public.set_budget(null, ''month'', 1000)'), 'ERR 42501%');

  reset role; perform set_config('request.jwt.claims', '', true);
  perform public._bu_chk('Z1 set_budget is a definer with an empty search_path',
    (select (prosecdef and coalesce(proconfig, '{}') @> array['search_path=""'])::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' and p.proname = 'set_budget'), 'true');
  perform public._bu_chk('Z2 anon cannot run set_budget',
    (select has_function_privilege('anon', 'public.set_budget(uuid, text, numeric)', 'execute')::text), 'false');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('bu.total')::int - current_setting('bu.nf')::int,
    current_setting('bu.total'), coalesce(nullif(current_setting('bu.f'), ''), 'none');
end $do$;
