-- db/915_selftest_autonomy.sql: autonomy, intake, budgets, precedents and the list brief (db/032) as admin SQL. Rolls everything
-- back and reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-914.
-- Cases: A homeos-agent changes none of it (RPCs, direct PATCH and insert on items and lists, the tables); E people set modes
-- (owner, household editor, expected mode, version kept, list never inherit); G a guest editor sets Manual or Guided only, no
-- intake, no brief; V a viewer changes nothing; M a Manual list's task is widened only by its household owner; I intake;
-- R the list brief; B budgets and reservations; P precedents from a household person's ticked answer only; Z rights.
-- Fixtures: H1, H2 (household people), AG (a household agent, like homeos-agent), G (guest, editor of L1), GV (guest, viewer
-- of L1); L1 (owner H1, shared with the household, AG editor), L2 (owner H2, AG not a member); item I1 in L1.
-- Run after 032, 003, 011, the 012 policy block, 026, 030, 031 and 032 again (003 revokes 032's table grants).

do $do$
declare
  h1 uuid := gen_random_uuid(); h2 uuid := gen_random_uuid(); ag uuid := gen_random_uuid();
  g uuid := gen_random_uuid(); gv uuid := gen_random_uuid();
  l1 uuid; l2 uuid; i1 uuid; v0 int; r1 bigint; r2 bigint; ev bigint; pid uuid; v text;
begin
  execute $f$create function public._au_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true); set local role anon; return; end if;
      perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
      set local role authenticated; end $b$$f$;
  execute $f$create function public._au(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute $f$create function public._au_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('au.total', (coalesce(nullif(current_setting('au.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('au.nf', (coalesce(nullif(current_setting('au.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('au.f', coalesce(current_setting('au.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  -- blocked: a refusal or a write that matched no row
  execute $f$create function public._au_blk(r text) returns text language sql as $b$
    select case when r like 'ERR%' or r = 'ok:0' then 'blocked' else r end $b$$f$;
  execute 'grant execute on function public._au_as(uuid), public._au(text), public._au_chk(text, text, text), public._au_blk(text) to authenticated, anon';
  perform set_config('au.total', '0', true); perform set_config('au.nf', '0', true); perform set_config('au.f', '', true);

  -- ---------- fixtures ----------
  insert into ops.signup_allowlist (email_lower, kind, is_household) values
    ('st-au-h1@example.invalid', 'human', true), ('st-au-h2@example.invalid', 'human', true),
    ('st-au-ag@example.invalid', 'agent', true);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1, 'st-au-h1@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (h2, 'st-au-h2@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (ag, 'st-au-ag@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (g, 'st-au-g@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest G"}'),
    (gv, 'st-au-gv@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest GV"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), g, 'st-au-sub-g', 'google', json_build_object('sub', 'st-au-sub-g', 'email', 'st-au-g@example.invalid', 'email_verified', true)),
    (gen_random_uuid(), gv, 'st-au-sub-gv', 'google', json_build_object('sub', 'st-au-sub-gv', 'email', 'st-au-gv@example.invalid', 'email_verified', true));
  update public.profiles set handle = 'st-au-' || left(id::text, 8) where id in (h1, h2, ag, g, gv);
  perform public._au_chk('F0 fixtures: AG is a household agent, G is a guest',
    (select string_agg(kind || ':' || is_household, ',' order by kind) from public.profiles where id in (ag, g)), 'agent:true,human:false');

  perform public._au_as(h1);
  l1 := public.create_list('st-au one', 'st-au-one', true);
  insert into public.items (list_id, category, title) values (l1, 'task', 'st-au item') returning id into i1;
  perform public._au_as(h2);
  l2 := public.create_list('st-au two', 'st-au-two', true);
  reset role; perform set_config('request.jwt.claims', '', true);
  insert into public.list_members (list_id, profile_id, role, added_by) values
    (l1, ag, 'editor', h1), (l1, g, 'editor', h1), (l1, gv, 'viewer', h1)
  on conflict (list_id, profile_id) do update set role = excluded.role;
  insert into public.deploy_targets (key, label) values ('st-au-site', 'Test site');
  perform public._au_chk('F1 defaults: list guided, item inherit',
    (select l.autonomy::text || '/' || i.autonomy::text from public.lists l join public.items i on i.list_id = l.id where i.id = i1), 'guided/inherit');
  perform public._au_chk('F2 a deploy target naming TasksDashboard is refused',
    public._au($q$insert into public.deploy_targets (key, label) values ('tasksdashboard-pages', 'x')$q$), 'ERR 23514%');

  -- ---------- A: the agent ----------
  perform public._au_as(ag);
  perform public._au_chk('A1 agent set_autonomy on a list', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'list', l1, 'ai_brain', 'guided')), 'ERR 42501%');
  perform public._au_chk('A2 agent set_autonomy on a task', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'item', i1, 'guided', 'inherit')), 'ERR 42501%');
  perform public._au_chk('A3 agent PATCH items.autonomy', public._au(format('update public.items set autonomy = %L where id = %L', 'ai_brain', i1)), 'ERR 42501%');
  perform public._au_chk('A4 agent PATCH items.autonomy_set_by', public._au(format('update public.items set autonomy_set_by = %L where id = %L', h1, i1)), 'ERR 42501%');
  perform public._au_chk('A5 agent PATCH items.e2e_self', public._au(format('update public.items set e2e_self = true where id = %L', i1)), 'ERR 42501%');
  perform public._au_chk('A6 agent PATCH items.deploy_target', public._au(format('update public.items set deploy_target = %L where id = %L', 'st-au-site', i1)), 'ERR 42501%');
  perform public._au_chk('A7 agent PATCH lists.autonomy', public._au(format('update public.lists set autonomy = %L where id = %L', 'ai_brain', l1)), 'ERR 42501%');
  perform public._au_chk('A8 agent PATCH lists.brief_concept', public._au(format('update public.lists set brief_concept = %L where id = %L', 'agents may deploy', l1)), 'ERR 42501%');
  perform public._au_chk('A9 agent PATCH lists.stage_report', public._au(format('update public.lists set stage_report = true where id = %L', l1)), 'ERR 42501%');
  perform public._au_chk('A10 agent inserts a task with a mode', public._au(format('insert into public.items (list_id, category, title, created_via, autonomy) values (%L, %L, %L, %L, %L)', l1, 'task', 'st-au x', 'script:st-au', 'ai_brain')), 'ERR 42501%');
  perform public._au_chk('A11 agent inserts a task with intake', public._au(format('insert into public.items (list_id, category, title, created_via, notify_telegram) values (%L, %L, %L, %L, true)', l1, 'task', 'st-au x', 'script:st-au')), 'ERR 42501%');
  perform public._au_chk('A12 agent set_intake', public._au(format('select public.set_intake(%L, %L, true, null, null, null)', 'item', i1)), 'ERR 42501%');
  perform public._au_chk('A13 agent set_budget', public._au(format('select public.set_budget(%L, %L, 100)', l1, 'day')), 'ERR 42501%');
  perform public._au_chk('A14 agent set_list_brief', public._au(format('select public.set_list_brief(%L, %L, null, null, null)', l1, 'x')), 'ERR 42501%');
  perform public._au_chk('A15 agent inserts a budget', public._au(format('insert into public.budgets (list_id, period, cap_usd, set_by) values (%L, %L, 1000, %L)', l1, 'day', ag)), 'ERR 42501%');
  perform public._au_chk('A16 agent inserts a precedent', public._au(format(
    'insert into public.precedents (list_id, path_glob, question, answer, source_item_id, source_event_id, decided_by, recorded_by) values (%L, %L, %L, %L, %L, 1, %L, %L)', l1, '*', 'q', 'a', i1, h1, ag)), 'ERR 42501%');
  perform public._au_chk('A17 agent writes the ledger directly', public._au(format(
    'insert into public.budget_ledger (kind, host, session, amount_usd, reservation_id, created_by) values (%L, %L, %L, 0, 1, %L)', 'release', 'h', 's', ag)), 'ERR 42501%');
  perform public._au_chk('A18 agent writes the audit table', public._au(format('insert into public.autonomy_events (target_kind, action) values (%L, %L)', 'list', 'autonomy')), 'ERR 42501%');
  perform public._au_chk('A19 agent still edits the task title', public._au(format('update public.items set title = %L where id = %L', 'st-au item by agent', i1)), 'ok:1');
  perform public._au_chk('A20 agent reads the mode', public._au(format('select autonomy::text from public.items where id = %L', i1)), 'inherit');

  -- ---------- E: people ----------
  perform public._au_as(h1);
  perform public._au_chk('E1 owner sets the list to AI Brain', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'list', l1, 'ai_brain', 'guided')), 'ai_brain');
  perform public._au_chk('E2 a stale expected mode is refused', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'list', l1, 'guided', 'guided')), 'ERR 40001%');
  perform public._au_chk('E3 a list never inherits', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'list', l1, 'inherit', 'ai_brain')), 'ERR 22023%');
  perform public._au_chk('E4 an unknown mode', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'list', l1, 'yolo', 'ai_brain')), 'ERR 22023%');
  perform public._au_chk('E5 no expected mode', public._au(format('select public.set_autonomy(%L, %L, %L, null)', 'list', l1, 'guided')), 'ERR 22023%');
  reset role; perform set_config('request.jwt.claims', '', true);
  select version into v0 from public.items where id = i1;
  perform public._au_as(h2);
  perform public._au_chk('E6 household editor sets the task to Guided', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'item', i1, 'guided', 'inherit')), 'guided');
  reset role; perform set_config('request.jwt.claims', '', true);
  perform public._au_chk('E7 the task version is unchanged, set_by is H2',
    (select (version = v0)::text || '/' || (autonomy_set_by = h2)::text from public.items where id = i1), 'true/true');
  perform public._au_chk('E8 the change is in item_events by H2',
    (select count(*)::text from public.item_events where item_id = i1 and actor_id = h2 and diff ? 'autonomy'), '1');
  perform public._au_as(h2);
  perform public._au_chk('E9 household editor sets the task back to inherit', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'item', i1, 'inherit', 'guided')), 'inherit');
  perform public._au_chk('E10 kind other than list or item', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'tag', i1, 'guided', 'inherit')), 'ERR 22023%');
  perform public._au_chk('E11 H2 owns L2 and sets it to Manual', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'list', l2, 'manual', 'guided')), 'manual');

  -- ---------- G: the guest editor ----------
  perform public._au_as(g);
  perform public._au_chk('G1 guest editor sets the task to Guided', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'item', i1, 'guided', 'inherit')), 'guided');
  perform public._au_chk('G2 guest editor cannot set AI Brain', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'item', i1, 'ai_brain', 'guided')), 'ERR 42501%');
  perform public._au_chk('G3 guest editor cannot set Project rules', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'item', i1, 'project_rules', 'guided')), 'ERR 42501%');
  perform public._au_chk('G4 guest editor cannot set AI Brain on the list', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'list', l1, 'ai_brain', 'ai_brain')), 'ERR 42501%');
  perform public._au_chk('G5 guest editor cannot set intake', public._au(format('select public.set_intake(%L, %L, true, null, null, null)', 'item', i1)), 'ERR 42501%');
  perform public._au_chk('G6 guest editor cannot write the brief', public._au(format('select public.set_list_brief(%L, %L, null, null, null)', l1, 'x')), 'ERR 42501%');
  perform public._au_chk('G7 guest editor PATCH items.autonomy', public._au(format('update public.items set autonomy = %L where id = %L', 'ai_brain', i1)), 'ERR 42501%');
  perform public._au_chk('G8 guest cannot set a budget', public._au(format('select public.set_budget(%L, %L, 1)', l1, 'day')), 'ERR 42501%');
  perform public._au_chk('G9 guest cannot reserve', public._au(format('select public.budget_reserve(%L, %L, %L, null, 1)', 'h', 's', l1)), 'ERR 42501%');
  perform public._au_chk('G10 guest reads no budgets, ledger, precedents, events',
    public._au('select (select count(*) from public.budgets) + (select count(*) from public.budget_ledger) + (select count(*) from public.precedents) + (select count(*) from public.autonomy_events)'), '0');

  -- ---------- V: the viewer ----------
  perform public._au_as(gv);
  perform public._au_chk('V1 viewer set_autonomy', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'item', i1, 'manual', 'guided')), 'ERR 42501%');
  perform public._au_chk('V2 viewer PATCH items.autonomy', public._au_blk(public._au(format('update public.items set autonomy = %L where id = %L', 'manual', i1))), 'blocked');
  perform public._au_chk('V3 viewer PATCH a task title', public._au_blk(public._au(format('update public.items set title = %L where id = %L', 'x', i1))), 'blocked');
  perform public._au_chk('V4 viewer set_intake', public._au(format('select public.set_intake(%L, %L, true, null, null, null)', 'item', i1)), 'ERR 42501%');

  -- ---------- M: a Manual list ----------
  perform public._au_as(h1);
  perform public._au_chk('M1 owner sets L1 to Manual', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'list', l1, 'manual', 'ai_brain')), 'manual');
  perform public._au_as(h2);
  perform public._au_chk('M2 household editor (not owner) cannot widen a task of a Manual list', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'item', i1, 'ai_brain', 'guided')), 'ERR 42501%');
  perform public._au_chk('M3 ... but may narrow it to Manual', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'item', i1, 'manual', 'guided')), 'manual');
  perform public._au_as(g);
  perform public._au_chk('M4 guest editor cannot widen it', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'item', i1, 'guided', 'manual')), 'ERR 42501%');
  perform public._au_as(h1);
  perform public._au_chk('M5 the household owner widens it', public._au(format('select public.set_autonomy(%L, %L, %L, %L)', 'item', i1, 'ai_brain', 'manual')), 'ai_brain');

  -- ---------- I: intake ----------
  reset role; perform set_config('request.jwt.claims', '', true);
  select version into v0 from public.items where id = i1;
  perform public._au_as(h1);
  perform public._au_chk('I1 owner sets intake on the task', public._au(format('select public.set_intake(%L, %L, true, %L, false, true)', 'item', i1, 'st-au-site')), '');
  perform public._au_chk('I2 an unknown deploy target', public._au(format('select public.set_intake(%L, %L, true, %L, false, true)', 'item', i1, 'nowhere')), 'ERR 22023%');
  perform public._au_chk('I3 list intake defaults', public._au(format('select public.set_intake(%L, %L, false, null, true, null)', 'list', l1)), '');
  reset role; perform set_config('request.jwt.claims', '', true);
  perform public._au_chk('I4 stored, version unchanged',
    (select concat_ws('/', e2e_self, deploy_target, notify_telegram, stage_report, (version = v0)) from public.items where id = i1), 't/st-au-site/f/t/t');
  perform public._au_chk('I5 list defaults stored', (select concat_ws('/', e2e_self, notify_telegram, coalesce(stage_report::text, 'unset')) from public.lists where id = l1), 'f/t/unset');

  -- ---------- R: the list brief ----------
  perform public._au_as(h2);
  perform public._au_chk('R1 household editor writes the brief', public._au(format('select public.set_list_brief(%L, %L, %L, %L, %L)', l1, 'D1 use pnpm', 'kebab-case', 'a test list', 'nothing alone')), '');
  perform public._au_chk('R2 a card number in the brief is refused', public._au(format('select public.set_list_brief(%L, %L, null, null, null)', l1, 'card 4111 1111 1111 1111')), 'ERR%');
  perform public._au_as(ag);
  perform public._au_chk('R3 the agent reads the brief', public._au(format('select brief_naming || %L || (brief_updated_by = %L)::text from public.lists where id = %L', '/', h2, l1)), 'kebab-case/true');

  -- ---------- B: budgets ----------
  perform public._au_as(h1);
  perform public._au_chk('B1 overall day cap', public._au(format('select public.set_budget(null, %L, 5)', 'day')), '');
  perform public._au_chk('B2 L1 day cap', public._au(format('select public.set_budget(%L, %L, 2)', l1, 'day')), '');
  perform public._au_chk('B3 a bad period', public._au(format('select public.set_budget(%L, %L, 2)', l1, 'week')), 'ERR 22023%');
  perform public._au_as(ag);
  r1 := public.budget_reserve('st-au-pc', 'do-1', l1, i1, 1.5);
  perform public._au_chk('B4 a reservation within the cap', (r1 is not null)::text, 'true');
  perform public._au_chk('B5 a second one would pass the L1 cap', public._au(format('select public.budget_reserve(%L, %L, %L, null, 1.0)', 'st-au-pc', 'do-2', l1)), 'ERR 54000%');
  perform public._au_chk('B6 a list the agent has no role on', public._au(format('select public.budget_reserve(%L, %L, %L, null, 0.1)', 'st-au-pc', 'do-3', l2)), 'ERR 42501%');
  perform public._au_chk('B7 a task of another list', public._au(format('select public.budget_reserve(%L, %L, null, %L, 0.1)', 'st-au-pc', 'do-3', i1)), 'ERR 22023%');
  perform public._au_chk('B8 settle at 1.2', public._au(format('select public.budget_settle(%L, 1.2)', r1)), '');
  perform public._au_chk('B9 settle twice', public._au(format('select public.budget_settle(%L, 1.2)', r1)), 'ERR%');
  r2 := public.budget_reserve('st-au-pc', 'do-2', l1, null, 0.5);
  perform public._au_chk('B10 0.5 fits again (1.2 + 0.5 <= 2)', (r2 is not null)::text, 'true');
  perform public._au_chk('B11 0.4 more does not', public._au(format('select public.budget_reserve(%L, %L, %L, null, 0.4)', 'st-au-pc', 'do-4', l1)), 'ERR 54000%');
  perform public._au_chk('B12 overall cap with no list: 1.2 + 0.5 + 3.4 > 5', public._au(format('select public.budget_reserve(%L, %L, null, null, 3.4)', 'st-au-pc', 'master')), 'ERR 54000%');
  perform public._au_as(h1);
  perform public._au_chk('B13 another login cannot release the agent''s reservation', public._au(format('select public.budget_release(%L)', r2)), 'ERR 42501%');
  perform public._au_chk('B14 status of L1', public._au(format(
    $q$select string_agg(scope || ':' || cap_usd || ':' || spent_usd::numeric(10,2) || ':' || reserved_usd::numeric(10,2), ',' order by scope desc) from public.budget_status(%L)$q$, l1)), 'overall:5.00:1.20:0.50,list:2.00:1.20:0.50');
  perform public._au_as(ag);
  perform public._au_chk('B15 the agent releases its reservation', public._au(format('select public.budget_release(%L)', r2)), '');
  perform public._au_chk('B16 the ledger is insert-only for the agent', public._au(format('update public.budget_ledger set amount_usd = 0 where id = %L', r1)), 'ERR 42501%');
  perform public._au_as(h1);
  perform public._au_chk('B17 a null cap removes it', public._au(format('select public.set_budget(%L, %L, null)', l1, 'day')), '');

  -- ---------- P: precedents ----------
  perform public._au_as(ag);
  perform public._au(format($q$update public.items set details = details || '{"decision":{"use_as_precedent":true}}'::jsonb where id = %L$q$, i1));
  reset role; perform set_config('request.jwt.claims', '', true);
  select max(id) into ev from public.item_events where item_id = i1;
  perform public._au_as(ag);
  perform public._au_chk('P1 an agent''s own edit is no precedent', public._au(format('select public.record_precedent(%L, %L, %L, %L, %L)', ev, l1, 'src/**', 'q', 'a')), 'ERR 42501%');
  perform public._au_as(h1);
  perform public._au(format($q$update public.items set details = details - 'decision' where id = %L$q$, i1));
  perform public._au(format($q$update public.items set details = details || '{"answer":"yes"}'::jsonb where id = %L$q$, i1));
  reset role; perform set_config('request.jwt.claims', '', true);
  select max(id) into ev from public.item_events where item_id = i1;
  perform public._au_as(ag);
  perform public._au_chk('P2 a person''s answer without the tick', public._au(format('select public.record_precedent(%L, %L, %L, %L, %L)', ev, l1, 'src/**', 'q', 'a')), 'ERR 22023%');
  perform public._au_as(g);
  perform public._au(format($q$update public.items set details = details || '{"decision":{"use_as_precedent":true}}'::jsonb where id = %L$q$, i1));
  reset role; perform set_config('request.jwt.claims', '', true);
  select max(id) into ev from public.item_events where item_id = i1;
  perform public._au_as(ag);
  perform public._au_chk('P3 a guest''s ticked answer is no precedent', public._au(format('select public.record_precedent(%L, %L, %L, %L, %L)', ev, l1, 'src/**', 'q', 'a')), 'ERR 42501%');
  perform public._au_as(h1);
  perform public._au(format($q$update public.items set details = details - 'decision' where id = %L$q$, i1));
  perform public._au(format($q$update public.items set details = details || '{"decision":{"use_as_precedent":true}}'::jsonb where id = %L$q$, i1));
  reset role; perform set_config('request.jwt.claims', '', true);
  select max(id) into ev from public.item_events where item_id = i1;
  perform public._au_as(ag);
  perform public._au_chk('P4 the wrong list', public._au(format('select public.record_precedent(%L, %L, %L, %L, %L)', ev, l2, 'src/**', 'q', 'a')), 'ERR 22023%');
  perform public._au_chk('P5 a path that climbs', public._au(format('select public.record_precedent(%L, %L, %L, %L, %L)', ev, l1, '../etc/*', 'q', 'a')), 'ERR 23514%');
  pid := public.record_precedent(ev, l1, 'src/**', 'May I add a test file?', 'yes');
  reset role; perform set_config('request.jwt.claims', '', true);
  perform public._au_chk('P6 recorded from H1''s answer: class E1, decided by H1, recorded by AG, 90 days',
    (select concat_ws('/', class, decided_by = h1, recorded_by = ag, expires_at::date = (now() + interval '90 days')::date) from public.precedents where id = pid), 'E1/t/t/t');
  perform public._au_as(ag);
  perform public._au_chk('P7 the same answer twice', public._au(format('select public.record_precedent(%L, %L, %L, %L, %L)', ev, l1, 'src/**', 'q', 'a')), 'ERR 23505%');
  perform public._au_chk('P8 the agent cannot revoke', public._au(format('select public.revoke_precedent(%L)', pid)), 'ERR 42501%');
  perform public._au_chk('P9 the agent cannot edit a precedent', public._au(format('update public.precedents set class = %L where id = %L', 'E2', pid)), 'ERR 42501%');
  perform public._au_as(h2);
  perform public._au_chk('P10 a household person revokes', public._au(format('select public.revoke_precedent(%L)', pid)), '');
  perform public._au_as(h1);
  perform public._au_chk('P11 the household reads the audit trail of L1',
    public._au(format('select string_agg(distinct action, %L order by action) from public.autonomy_events where target_id = %L', ',', l1)), 'autonomy,brief,budget,intake,precedent,precedent_revoke');

  -- ---------- Z: rights ----------
  reset role; perform set_config('request.jwt.claims', '', true);
  perform public._au_chk('Z1 no API role writes the new tables',
    (select count(*)::text from unnest(array['anon', 'authenticated']) r,
       unnest(array['public.budgets', 'public.budget_ledger', 'public.precedents', 'public.autonomy_events', 'public.deploy_targets']) t,
       unnest(array['insert', 'update', 'delete']) p where has_table_privilege(r, t, p)), '0');
  perform public._au_chk('Z2 no API role updates the new list columns',
    (select count(*)::text from unnest(array['anon', 'authenticated']) r,
       unnest(array['autonomy', 'autonomy_set_by', 'e2e_self', 'deploy_target', 'notify_telegram', 'stage_report',
                    'brief_decisions', 'brief_naming', 'brief_instruction', 'brief_concept']) c
      where has_column_privilege(r, 'public.lists', c, 'update')), '0');
  perform public._au_chk('Z3 anon runs none of the new functions',
    (select count(*)::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' and p.proname in ('set_autonomy', 'set_intake', 'set_list_brief', 'set_budget', 'budget_reserve',
            'budget_settle', 'budget_release', 'budget_status', 'record_precedent', 'revoke_precedent', 'budget_close',
            'autonomy_log', 'autonomy_is_household_human', 'budget_used', 'items_settings_guard')
        and has_function_privilege('anon', p.oid, 'execute')), '0');
  perform public._au_chk('Z4 helpers are no endpoints',
    (select count(*)::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' and p.proname in ('budget_close', 'autonomy_log', 'autonomy_is_household_human', 'budget_used', 'items_settings_guard')
        and has_function_privilege('authenticated', p.oid, 'execute')), '0');
  perform public._au_chk('Z5 definers with an empty search_path',
    (select count(*)::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' and p.proname in ('set_autonomy', 'set_intake', 'set_list_brief', 'set_budget', 'budget_reserve',
            'budget_settle', 'budget_release', 'budget_status', 'record_precedent', 'revoke_precedent', 'budget_close',
            'autonomy_log', 'autonomy_is_household_human', 'budget_used')
        and (not p.prosecdef or not coalesce(p.proconfig, '{}') @> array['search_path=""'])), '0');
  perform public._au_chk('Z6 the guard is no definer', (select (not prosecdef)::text from pg_proc where proname = 'items_settings_guard'), 'true');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('au.total')::int - current_setting('au.nf')::int,
    current_setting('au.total'), coalesce(nullif(current_setting('au.f'), ''), 'none');
end $do$;
