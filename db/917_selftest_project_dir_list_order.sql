-- db/917_selftest_project_dir_list_order.sql: the project folder, the household list order, the list-move reset and the
-- deploy_targets key rule (db/034) as admin SQL. Rolls everything back and reports
-- "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-916.
-- Cases: P set_project_dir (household owner, compare-and-set, path rules, clear, log, guest, agent, direct PATCH, archived);
-- O household_list_order (agent and person read a household person's listOrder and listBar only; null for a guest, an agent
-- or no preferences; a guest caller is refused); M a moved task inherits again (also when it was set, not on other edits; a
-- REST move that sets a mode itself is still refused); D deploy_targets keys; Z rights.
-- Fixtures: H1, H2 (household people; H2 has no preferences row), AG (a household agent, like homeos-agent), G (guest, editor
-- of L1); L1 and L2 owned by H1 (AG and G editors of L1); item I1 in L1.
-- Run after 034 (and after 003 and its followers, like every selftest).

do $do$
declare
  h1 uuid := gen_random_uuid(); h2 uuid := gen_random_uuid(); ag uuid := gen_random_uuid(); g uuid := gen_random_uuid();
  l1 uuid; l2 uuid; i1 uuid;
begin
  execute $f$create function public._pd_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true); set local role anon; return; end if;
      perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
      set local role authenticated; end $b$$f$;
  execute $f$create function public._pd(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 120); end $b$$f$;
  execute $f$create function public._pd_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('pd.total', (coalesce(nullif(current_setting('pd.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('pd.nf', (coalesce(nullif(current_setting('pd.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('pd.f', coalesce(current_setting('pd.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  execute 'grant execute on function public._pd_as(uuid), public._pd(text), public._pd_chk(text, text, text) to authenticated, anon';
  perform set_config('pd.total', '0', true); perform set_config('pd.nf', '0', true); perform set_config('pd.f', '', true);

  -- ---------- fixtures ----------
  insert into ops.signup_allowlist (email_lower, kind, is_household) values
    ('st-pd-h1@example.invalid', 'human', true), ('st-pd-h2@example.invalid', 'human', true),
    ('st-pd-ag@example.invalid', 'agent', true);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1, 'st-pd-h1@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (h2, 'st-pd-h2@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (ag, 'st-pd-ag@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (g, 'st-pd-g@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest G"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), g, 'st-pd-sub-g', 'google', json_build_object('sub', 'st-pd-sub-g', 'email', 'st-pd-g@example.invalid', 'email_verified', true));
  update public.profiles set handle = 'st-pd-' || left(id::text, 8) where id in (h1, h2, ag, g);
  perform public._pd_chk('F0 fixtures: AG a household agent, G a guest, H1 and H2 household people',
    (select string_agg(kind || ':' || is_household, ',' order by kind, is_household) from public.profiles where id in (h1, h2, ag, g)),
    'agent:true,human:false,human:true,human:true');

  perform public._pd_as(h1);
  l1 := public.create_list('st-pd one', 'st-pd-one', true);
  l2 := public.create_list('st-pd two', 'st-pd-two', false);
  insert into public.items (list_id, category, title) values (l1, 'task', 'st-pd item') returning id into i1;
  reset role; perform set_config('request.jwt.claims', '', true);
  insert into public.list_members (list_id, profile_id, role, added_by) values (l1, ag, 'editor', h1), (l1, g, 'editor', h1)
  on conflict (list_id, profile_id) do update set role = excluded.role;
  insert into public.preferences (profile_id, app, prefs) values
    (h1, 'tasksdashboard', jsonb_build_object('listOrder', jsonb_build_array(l2, l1), 'listBar',
       jsonb_build_object('two', false, 'rows', jsonb_build_array(jsonb_build_array(l2), '[]'::jsonb)), 'theme', 'dark')),
    (g, 'tasksdashboard', jsonb_build_object('listOrder', jsonb_build_array(l1)))
  on conflict (profile_id, app) do update set prefs = excluded.prefs;

  -- ---------- P: set_project_dir ----------
  perform public._pd_chk('P0 a new list has no project folder', (select coalesce(project_dir, 'null') from public.lists where id = l1), 'null');
  perform public._pd_as(h1);
  perform public._pd_chk('P1 owner sets a Windows folder',
    public._pd(format('select public.set_project_dir(%L, %L, null)', l1, 'D:\Claude\Personal\EventBoard')), 'D:_Claude_Personal_EventBoard');
  perform public._pd_chk('P2 a stale expected value is refused',
    public._pd(format('select public.set_project_dir(%L, %L, null)', l1, 'D:/Other')), 'ERR 40001%');
  perform public._pd_chk('P3 a relative path is refused',
    public._pd(format('select public.set_project_dir(%L, %L, %L)', l1, 'Claude\x', 'D:\Claude\Personal\EventBoard')), 'ERR 22023%');
  perform public._pd_chk('P4 a path with .. is refused',
    public._pd(format('select public.set_project_dir(%L, %L, %L)', l1, 'D:\Claude\..\Windows', 'D:\Claude\Personal\EventBoard')), 'ERR 22023%');
  perform public._pd_chk('P5 a path over 260 characters is refused',
    public._pd(format('select public.set_project_dir(%L, %L, %L)', l1, 'D:\' || repeat('a', 260), 'D:\Claude\Personal\EventBoard')), 'ERR 22023%');
  perform public._pd_chk('P6 a POSIX folder with the right expected value',
    public._pd(format('select public.set_project_dir(%L, %L, %L)', l1, '/home/st/project', 'D:\Claude\Personal\EventBoard')), '/home/st/project');
  perform public._pd_chk('P7 a blank value clears it', public._pd(format('select public.set_project_dir(%L, %L, %L)', l1, '  ', '/home/st/project')), 'null');
  perform public._pd_chk('P8 the list holds null', (select coalesce(project_dir, 'null') from public.lists where id = l1), 'null');
  perform public._pd_chk('P9 owner cannot PATCH project_dir directly',
    public._pd(format('update public.lists set project_dir = %L where id = %L', 'D:/x', l1)), 'ERR 42501%');
  perform public._pd_chk('P10 the folder is set again for the readers below',
    public._pd(format('select public.set_project_dir(%L, %L, null)', l1, 'D:/Claude/Personal/EventBoard')), 'D:/Claude/Personal/EventBoard');
  perform public._pd_as(g);
  perform public._pd_chk('P11 guest editor cannot set it',
    public._pd(format('select public.set_project_dir(%L, null, %L)', l1, 'D:/Claude/Personal/EventBoard')), 'ERR 42501%');
  perform public._pd_chk('P12 guest editor reads it', public._pd(format('select project_dir from public.lists where id = %L', l1)), 'D:/Claude/Personal/EventBoard');
  perform public._pd_as(ag);
  perform public._pd_chk('P13 agent cannot set it',
    public._pd(format('select public.set_project_dir(%L, null, %L)', l1, 'D:/Claude/Personal/EventBoard')), 'ERR 42501%');
  perform public._pd_chk('P14 agent cannot PATCH it', public._pd(format('update public.lists set project_dir = null where id = %L', l1)), 'ERR 42501%');
  perform public._pd_as(h2);
  perform public._pd_chk('P15 a household person who is no member of L2 cannot set it',
    public._pd(format('select public.set_project_dir(%L, %L, null)', l2, 'D:/x')), 'ERR 42501%');
  reset role; perform set_config('request.jwt.claims', '', true);
  perform public._pd_chk('P16 the table check refuses a relative path even for admin SQL',
    public._pd(format('update public.lists set project_dir = %L where id = %L', 'relative', l2)), 'ERR 23514%');
  perform public._pd_chk('P17 every change by H1 is logged',
    (select count(*)::text from public.autonomy_events where action = 'project_dir' and actor_id = h1 and target_id = l1), '4');

  -- ---------- O: household_list_order ----------
  perform public._pd_as(ag);
  perform public._pd_chk('O1 the agent reads H1''s listOrder',
    public._pd(format('select (public.household_list_order(%L)->''listOrder'')::text', h1)), format('["%s", "%s"]', l2, l1));
  perform public._pd_chk('O2 the agent reads H1''s listBar',
    public._pd(format('select (public.household_list_order(%L)->''listBar''->''rows''->0)::text', h1)), format('["%s"]', l2));
  perform public._pd_chk('O3 nothing else of the preferences',
    public._pd(format('select (select string_agg(k, '','' order by k) from jsonb_object_keys(public.household_list_order(%L)) k)', h1)), 'listBar,listOrder');
  perform public._pd_chk('O4 null for a guest', public._pd(format('select public.household_list_order(%L)::text', g)), 'null');
  perform public._pd_chk('O5 null for an agent', public._pd(format('select public.household_list_order(%L)::text', ag)), 'null');
  perform public._pd_chk('O6 null without preferences', public._pd(format('select public.household_list_order(%L)::text', h2)), 'null');
  perform public._pd_as(h2);
  perform public._pd_chk('O7 a household person reads another household person''s order',
    public._pd(format('select jsonb_array_length(public.household_list_order(%L)->''listOrder'')::text', h1)), '2');
  perform public._pd_as(g);
  perform public._pd_chk('O8 a guest caller is refused', public._pd(format('select public.household_list_order(%L)::text', h1)), 'ERR 42501%');
  perform public._pd_chk('O9 a guest cannot read H1''s preferences row', public._pd(format('select count(*)::text from public.preferences where profile_id = %L', h1)), '0');

  -- ---------- M: a moved task inherits again ----------
  perform public._pd_as(h1);
  perform public._pd_chk('M1 H1 sets the task to Guided', public._pd(format('select public.set_autonomy(%L, %L, %L, %L)', 'item', i1, 'guided', 'inherit')), 'guided');
  perform public._pd_chk('M2 a title edit keeps the mode', public._pd(format('update public.items set title = %L where id = %L', 'st-pd item 2', i1)), 'ok:1');
  perform public._pd_chk('M3 still Guided', public._pd(format('select autonomy::text from public.items where id = %L', i1)), 'guided');
  perform public._pd_chk('M4 a move that also sets a mode is refused',
    public._pd(format('update public.items set list_id = %L, autonomy = %L where id = %L', l2, 'ai_brain', i1)), 'ERR 42501%');
  perform public._pd_chk('M5 H1 moves the task to L2', public._pd(format('update public.items set list_id = %L where id = %L', l2, i1)), 'ok:1');
  reset role; perform set_config('request.jwt.claims', '', true);
  perform public._pd_chk('M6 the moved task inherits, set_by and set_at cleared',
    (select list_id = l2 and autonomy = 'inherit' and autonomy_set_by is null and autonomy_set_at is null from public.items where id = i1)::text, 'true');
  perform public._pd_chk('M7 an admin move resets too', public._pd(format(
    'update public.items set autonomy = %L, autonomy_set_by = %L, autonomy_set_at = now() where id = %L', 'manual', h1, i1)), 'ok:1');
  perform public._pd_chk('M8 (admin move)', public._pd(format('update public.items set list_id = %L where id = %L', l1, i1)), 'ok:1');
  perform public._pd_chk('M9 inherit after the admin move', (select autonomy::text || '/' || coalesce(autonomy_set_by::text, 'null') from public.items where id = i1), 'inherit/null');

  -- ---------- P (archived) ----------
  perform public._pd_as(h1);
  perform public._pd_chk('P18 H1 archives L2', public._pd(format('update public.lists set archived_at = now() where id = %L', l2)), 'ok:1');
  perform public._pd_chk('P19 an archived list''s folder is not changed',
    public._pd(format('select public.set_project_dir(%L, %L, null)', l2, 'D:/x')), 'ERR 42501%');

  -- ---------- D: deploy_targets keys ----------
  reset role; perform set_config('request.jwt.claims', '', true);
  delete from public.deploy_targets where key in ('recipes', 'repo-branch', 'landing', 'tasksdashboard', 'tasksdb-migrations', 'access-mail')
    and not exists (select 1 from public.lists where deploy_target = key) and not exists (select 1 from public.items where deploy_target = key);
  perform public._pd_chk('D1 the six planned keys are allowed', public._pd(
    $q$insert into public.deploy_targets (key, label) values ('recipes', 't'), ('repo-branch', 't'), ('landing', 't'), ('tasksdashboard', 't'),
       ('tasksdb-migrations', 't'), ('access-mail', 't') on conflict (key) do nothing$q$), 'ok:%');
  perform public._pd_chk('D2 they are all there',
    (select count(*)::text from public.deploy_targets where key in ('recipes', 'repo-branch', 'landing', 'tasksdashboard', 'tasksdb-migrations', 'access-mail')), '6');
  perform public._pd_chk('D3 another key naming TasksDashboard is still refused',
    public._pd($q$insert into public.deploy_targets (key, label) values ('tasksdashboard-pages', 'x')$q$), 'ERR 23514%');
  perform public._pd_chk('D4 the app host name is still refused',
    public._pd($q$insert into public.deploy_targets (key, label) values ('eisenhower-agentic-planner-app', 'x')$q$), 'ERR 23514%');
  perform public._pd_chk('D5 the format is unchanged', public._pd($q$insert into public.deploy_targets (key, label) values ('Bad_Key', 'x')$q$), 'ERR 23514%');
  perform public._pd_as(h1);
  perform public._pd_chk('D6 a person cannot insert a target', public._pd($q$insert into public.deploy_targets (key, label) values ('st-pd-x', 'x')$q$), 'ERR 42501%');
  perform public._pd_chk('D7 a household person sets intake to tasksdashboard',
    public._pd(format('select public.set_intake(%L, %L, true, %L, null, null)::text', 'list', l1, 'tasksdashboard')), '');

  -- ---------- Z: rights ----------
  reset role; perform set_config('request.jwt.claims', '', true);
  perform public._pd_chk('Z1 both RPCs are definers with an empty search_path',
    (select string_agg((prosecdef and coalesce(proconfig, '{}') @> array['search_path=""'])::text, ',' order by proname) from pg_proc p
      join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname in ('set_project_dir', 'household_list_order')), 'true,true');
  perform public._pd_chk('Z2 anon cannot run them',
    (has_function_privilege('anon', 'public.set_project_dir(uuid, text, text)', 'execute')
      or has_function_privilege('anon', 'public.household_list_order(uuid)', 'execute'))::text, 'false');
  perform public._pd_chk('Z3 nobody calls the trigger function',
    has_function_privilege('authenticated', 'public.items_list_move_reset()', 'execute')::text, 'false');
  perform public._pd_chk('Z4 the move trigger fires after the settings guard',
    (select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = 'public.items'::regclass and tgname like 'items_zz%'),
    'items_zz_settings,items_zzz_list_move');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('pd.total')::int - current_setting('pd.nf')::int,
    current_setting('pd.total'), coalesce(nullif(current_setting('pd.f'), ''), 'none');
end $do$;
