-- db/905_selftest_telegram.sql: the bot scope selftest (HomeOS telegram-rework-plan.md T1) as admin SQL. Rolls everything
-- back and reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-904.
-- Cases: T1 a linked person's new list and tag list get the bot (editor, viewer); T2 a guest's do not; T3 each person's
-- scope holds only the lists both they and the bot are in (H2 never gets H1's private list, and the reverse); T4 a
-- guest-owned list is never returned, even with the bot and the person in it; T5 archived lists never, '_' lists only
-- with p_include_test; T6 tag lists both are in, live tags only, a guest's tag list never; T7 members are household
-- profiles only; T8 callers: a person, an unlinked bot, a person the bot is not linked to -> 42501; T9 a viewer list is
-- not offered for writing; T10 rights (definer, search_path, not for anon, ops.bot_links closed); T11 the seed (live DB);
-- T12 (db/019) a removed bot stays out: an insert without a person behind it (a 017 re-run) is undone, a person adding it
-- back clears the opt-out, the same for tag lists, Access requests opted out; T13 review_quadrant (db/016) gives the
-- shared quadrant cases (the rows between the quadrant-cases markers equal telegram-integration/tests/quadrant_cases.json;
-- test/telegram-parity.test.js checks that).
-- Fixtures: H1, H2 (household people), B and B2 (agents), G (a Google guest). Run after 019, 003, 011, the 012 policy
-- block and 900-904.

do $do$
declare
  h1 uuid := gen_random_uuid(); h2 uuid := gen_random_uuid(); b uuid := gen_random_uuid(); b2 uuid := gen_random_uuid();
  g uuid := gen_random_uuid();
  l1 uuid; l2 uuid; lg uuid; la uuid; lt uuid; lv uuid; t1 uuid; tg uuid; x jsonb; v text;
begin
  execute $f$create function public._tg_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true);
      else perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
           set local role authenticated; end if; end $b$$f$;
  execute $f$create function public._tg(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute $f$create function public._tg_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('tg.total', (coalesce(nullif(current_setting('tg.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('tg.nf', (coalesce(nullif(current_setting('tg.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('tg.f', coalesce(current_setting('tg.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  -- the list names of a scope, sorted, or 'none'
  execute $f$create function public._tg_names(j jsonb, k text) returns text language sql as $b$
    select coalesce(string_agg(e->>'name', ',' order by e->>'name'), 'none') from jsonb_array_elements(j->k) e $b$$f$;
  execute 'grant execute on function public._tg_as(uuid), public._tg(text), public._tg_chk(text, text, text), public._tg_names(jsonb, text) to authenticated';
  perform set_config('tg.total', '0', true); perform set_config('tg.nf', '0', true); perform set_config('tg.f', '', true);

  -- ---------- fixtures (admin) ----------
  insert into ops.signup_allowlist (email_lower, kind, is_household) values
    ('st-tg-h1@example.invalid', 'human', true), ('st-tg-h2@example.invalid', 'human', true),
    ('st-tg-b@example.invalid', 'agent', true), ('st-tg-b2@example.invalid', 'agent', true);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1, 'st-tg-h1@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (h2, 'st-tg-h2@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (b,  'st-tg-b@example.invalid',  'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (b2, 'st-tg-b2@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data)
  select gen_random_uuid(), u.id, u.id::text, 'email', json_build_object('sub', u.id, 'email', u.email)
    from auth.users u where u.id in (h1, h2, b, b2);
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (g, 'st-tg-g@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest TG"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), g, 'st-tg-sub-g', 'google', json_build_object('sub', 'st-tg-sub-g', 'email', 'st-tg-g@example.invalid', 'email_verified', true));
  insert into ops.bot_links (bot_id, person_id) values (b, h1), (b, h2);

  perform public._tg_as(h1);
  l1 := public.create_list('TG private');              -- H1 and the bot
  l2 := public.create_list('TG shared');               -- H1, H2 (added below) and the bot
  la := public.create_list('TG archived');
  lt := public.create_list('_tg test', '_tg-test');    -- a test list: the trigger leaves it alone
  lv := public.create_list('TG viewer');               -- H2 only views it
  perform public._tg_as(g);
  lg := public.create_list('TG guest');                -- a guest's list
  perform public._tg_as(null);
  insert into public.list_members (list_id, profile_id, role) values (l2, h2, 'editor'), (lv, h2, 'viewer'), (l2, g, 'viewer'),
    (lg, h1, 'editor'), (lg, b, 'editor'), (lt, b, 'editor');
  update public.lists set archived_at = now() where id = la;
  insert into public.tag_lists (owner_id, name, is_default, sort) values (h1, 'TG tags', false, 5) returning id into t1;
  insert into public.tag_lists (owner_id, name, is_default, sort) values (g, 'TG guest tags', false, 5) returning id into tg;
  insert into public.tag_list_members (tag_list_id, profile_id, role) values (t1, h1, 'owner'), (tg, g, 'owner'), (tg, h1, 'viewer'), (tg, b, 'viewer')
    on conflict do nothing;
  insert into public.tags (tag_list_id, name) values (t1, 'alpha'), (tg, 'gamma');
  insert into public.tags (tag_list_id, name, deleted_at) values (t1, 'beta', now());

  -- T1 the trigger adds the bot to a linked person's new list and tag list
  perform public._tg_chk('T1a list', (select role from public.list_members where list_id = l1 and profile_id = b), 'editor');
  perform public._tg_chk('T1b tag list', (select role from public.tag_list_members where tag_list_id = t1 and profile_id = b), 'viewer');
  perform public._tg_chk('T1c test list skipped', (select count(*)::text from public.list_members where list_id = lt and profile_id = b and added_by is not null), '0');
  -- T2 not to a guest's
  perform public._tg_chk('T2a guest list', (select count(*)::text from public.list_members m join public.lists l on l.id = m.list_id
                                              where l.owner_id = g and m.profile_id = b and m.added_by is not null), '0');
  perform public._tg_chk('T2b guest tag list', (select count(*)::text from public.tag_list_members where tag_list_id in
                                                  (select id from public.tag_lists where owner_id = g and id <> tg) and profile_id = b), '0');

  -- T3 each person's scope: only what both share
  perform public._tg_as(b);
  x := public.telegram_scope(h1);
  perform public._tg_chk('T3a H1', public._tg_names(x, 'lists'), 'TG private,TG shared,TG viewer');
  x := public.telegram_scope(h2);
  perform public._tg_chk('T3b H2', public._tg_names(x, 'lists'), 'TG shared');
  -- T4 a guest's list never, though the bot and H1 are editors there (T3a has no 'TG guest')
  perform public._tg_chk('T4 guest list', (public.telegram_scope(h1)::text like '%TG guest"%')::text, 'false');
  -- T5 archived never; '_' only with the flag
  v := public._tg_names(public.telegram_scope(h1, true), 'lists');
  perform public._tg_chk('T5a test flag', (position('_tg test' in v) > 0)::text || '/' || jsonb_array_length(public.telegram_scope(h1, true)->'lists'), 'true/4');
  perform public._tg_chk('T5c no flag', (position('_tg test' in public._tg_names(public.telegram_scope(h1), 'lists')) > 0)::text, 'false');
  perform public._tg_chk('T5b archived', (public.telegram_scope(h1, true)::text like '%TG archived%')::text, 'false');
  -- T6 tag lists both are in, live tags only; the guest's tag list never
  x := public.telegram_scope(h1);
  perform public._tg_chk('T6a H1 tag lists', (select string_agg((e->>'name') || '=' || (select coalesce(string_agg(t->>'name', '+'), '') from jsonb_array_elements(e->'tags') t), ',')
                                                from jsonb_array_elements(x->'tag_lists') e), 'TG tags=alpha');
  perform public._tg_chk('T6b H2 tag lists', public._tg_names(public.telegram_scope(h2), 'tag_lists'), 'none');
  -- T7 members: household profiles only (the guest viewer of TG shared is left out)
  perform public._tg_chk('T7 members', (select string_agg(m->>'role', ',' order by m->>'role') from jsonb_array_elements(x->'lists') e,
                                          jsonb_array_elements(e->'members') m where e->>'name' = 'TG shared'), 'editor,editor,owner');
  -- T9 a list H2 only views is not hers to write into
  perform public._tg_chk('T9 viewer', (public.telegram_scope(h2)::text like '%TG viewer%')::text, 'false');
  -- T8 callers
  perform public._tg_chk('T8a bot for an unlinked person', public._tg(format('select public.telegram_scope(%L)::text', g)), 'ERR 42501%');
  perform public._tg_as(b2);
  perform public._tg_chk('T8b unlinked bot', public._tg(format('select public.telegram_scope(%L)::text', h1)), 'ERR 42501%');
  perform public._tg_as(h1);
  perform public._tg_chk('T8c a person', public._tg(format('select public.telegram_scope(%L)::text', h1)), 'ERR 42501%');
  perform public._tg_chk('T10a links closed', public._tg('select count(*)::text from ops.bot_links'), 'ERR 42501%');

  -- T10 rights
  perform public._tg_as(null);
  perform public._tg_chk('T10b anon', has_function_privilege('anon', 'public.telegram_scope(uuid, boolean)', 'execute')::text, 'false');
  perform public._tg_chk('T10c authenticated', has_function_privilege('authenticated', 'public.telegram_scope(uuid, boolean)', 'execute')::text, 'true');
  perform public._tg_chk('T10d definer and search_path', (select string_agg(p.proname || ':' || p.prosecdef || ':' || (coalesce(p.proconfig, '{}') @> array['search_path=""']), ',' order by p.proname)
                                                            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                                           where n.nspname = 'public' and p.proname in ('telegram_scope', 'bot_join_list', 'bot_join_tag_list')),
                         'bot_join_list:true:true,bot_join_tag_list:true:true,telegram_scope:true:true');

  -- T11 the seed on the live household
  perform public._tg_chk('T11a links', (select string_agg(p.handle, ',' order by p.handle) from ops.bot_links k
                                          join public.profiles bb on bb.id = k.bot_id and bb.handle = 'telegram-bot'
                                          join public.profiles p on p.id = k.person_id), 'anastasiia,maksym');
  perform public._tg_chk('T11b access requests closed', (select count(*)::text from public.list_members m join public.lists l on l.id = m.list_id
                                                           join public.profiles p on p.id = m.profile_id
                                                          where l.slug = 'access-requests' and p.handle = 'telegram-bot'), '0');
  perform public._tg_chk('T11c household lists open', (select count(*)::text from public.lists l
                                                         where l.archived_at is null and l.slug not like '\_%' and l.slug <> 'access-requests'
                                                           and l.owner_id in (select id from public.profiles where handle in ('maksym','anastasiia'))
                                                           and not exists (select 1 from public.list_members m join public.profiles p on p.id = m.profile_id
                                                                            where m.list_id = l.id and p.handle = 'telegram-bot')), '0');

  -- T12 a removed bot stays out (db/019)
  perform public._tg_as(h1);
  perform public._tg_chk('T12a owner removes the bot', public._tg(format('delete from public.list_members where list_id = %L and profile_id = %L', l1, b)), 'ok:1');
  perform public._tg_as(null);
  perform public._tg_chk('T12b opt-out recorded', (select count(*)::text from ops.bot_opt_out where bot_id = b and list_id = l1), '1');
  insert into public.list_members (list_id, profile_id, role) values (l1, b, 'editor');   -- as a 017 re-run would
  perform public._tg_chk('T12c admin insert undone', (select count(*)::text from public.list_members where list_id = l1 and profile_id = b), '0');
  perform public._tg_as(b);
  perform public._tg_chk('T12d out of scope', (position('TG private' in public._tg_names(public.telegram_scope(h1), 'lists')) > 0)::text, 'false');
  perform public._tg_as(h1);
  perform public._tg_chk('T12e a person adds it back', public._tg(format('insert into public.list_members (list_id, profile_id, role) values (%L, %L, ''editor'')', l1, b)), 'ok:1');
  perform public._tg_as(null);
  perform public._tg_chk('T12f opt-out cleared', (select count(*)::text from ops.bot_opt_out where bot_id = b and list_id = l1)
                                                 || '/' || (select count(*) from public.list_members where list_id = l1 and profile_id = b), '0/1');
  delete from public.tag_list_members where tag_list_id = t1 and profile_id = b;
  insert into public.tag_list_members (tag_list_id, profile_id, role) values (t1, b, 'viewer');
  perform public._tg_chk('T12g tag list stays out', (select count(*)::text from public.tag_list_members where tag_list_id = t1 and profile_id = b)
                                                    || '/' || (select count(*) from ops.bot_opt_out where bot_id = b and tag_list_id = t1), '0/1');
  perform public._tg_chk('T12h access requests opted out', (select count(*)::text from ops.bot_opt_out o join public.lists l on l.id = o.list_id
                                                             join public.profiles p on p.id = o.bot_id
                                                            where l.slug = 'access-requests' and p.handle = 'telegram-bot'), '1');
  perform public._tg_chk('T12i guard rights', (select string_agg(p.proname || ':' || p.prosecdef || ':' || (coalesce(p.proconfig, '{}') @> array['search_path=""'])
                                                                 || ':' || has_function_privilege('authenticated', p.oid, 'execute'), ',' order by p.proname)
                                                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                                where n.nspname = 'public' and p.proname in ('bot_member_guard', 'by_person')),
                         'bot_member_guard:true:true:false,by_person:true:true:false');

  -- T13 review_quadrant (db/016) on the shared cases: n, stored, priority, category, pin, deadline in hours, window, expected
  select coalesce(string_agg(format('%s=%s', n, got), ','), 'none') into v from (
    select n, ex, public.review_quadrant(st, pr, ca, pin,
             case when h is null then null else timestamptz '2026-10-29 10:00+00' + h * interval '1 hour' end,
             timestamptz '2026-10-29 10:00+00', w) as got
      from (values
        -- >>> quadrant cases
        (1, 'C', 5, 'reminder', true, 1, 7, 'C'),
        (2, null, null, 'task', null, null, 7, 'D'),
        (3, null, 3, 'task', null, null, 7, 'B'),
        (4, null, 2, 'task', null, 24, 7, 'C'),
        (5, null, null, 'reminder', null, 24, 7, 'A'),
        (6, null, null, 'tbd', null, 400, 7, 'B'),
        (7, null, null, 'decision', false, 1, 7, 'B'),
        (8, null, null, 'task', true, null, 7, 'C'),
        (9, null, 4, 'task', null, -48, 7, 'A'),
        (10, null, null, 'task', null, 168, 7, 'C'),
        (11, null, null, 'task', null, 169, 7, 'D'),
        (12, null, null, 'task', null, 40, 1, 'D'),
        (13, 'X', 3, 'task', null, null, 7, 'B')
        -- <<< quadrant cases
      ) c(n, st, pr, ca, pin, h, w, ex)
  ) r where got is distinct from ex;
  perform public._tg_chk('T13 review_quadrant', v, 'none');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('tg.total')::int - current_setting('tg.nf')::int,
    current_setting('tg.total'), coalesce(nullif(current_setting('tg.f'), ''), 'none');
end $do$;
