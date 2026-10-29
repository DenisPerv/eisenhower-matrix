-- db/907_selftest_share_by_person.sql: the share-by-person selftest (HomeOS tags-round-plan.md #2, db/022) as admin SQL.
-- Rolls everything back and reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like
-- 900-906. Cases: P1 who is listed (household yes, whitelisted guest yes by allowlist and by approved request; agent,
-- caller, a pending or removed request and a plain Google user no); P2 names and ids only, never an email; P3 who gets the
-- list (a whitelisted guest yes, a plain signed-in user none); P4 shares by id for owners (lists) and owners and editors
-- (tag lists), joined at once; P5 refused for list editors, viewers, archived lists and tag lists, people not listed, bad
-- roles; P6 rights. Fixtures: H1, H2 (household) and AG (agent) through allowlist rows, W (guest) through a guest allowlist
-- row, R, Q, X, N as Google users (R approved, Q pending, X removed, N no request). Real profiles are never changed.
-- Run after 022, 003, 011, the 012 policy block and 900-906.

do $do$
declare
  h1 uuid := gen_random_uuid(); h2 uuid := gen_random_uuid(); ag uuid := gen_random_uuid(); w uuid := gen_random_uuid();
  r uuid := gen_random_uuid(); q uuid := gen_random_uuid(); x uuid := gen_random_uuid(); n uuid := gen_random_uuid();
  fx uuid[]; hl uuid; hl2 uuid; tl uuid; tl2 uuid; v text;
begin
  execute $f$create function public._sp_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true);
      else perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
           set local role authenticated; end if; end $b$$f$;
  execute $f$create function public._sp(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute $f$create function public._sp_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('sp.total', (coalesce(nullif(current_setting('sp.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('sp.nf', (coalesce(nullif(current_setting('sp.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('sp.f', coalesce(current_setting('sp.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  execute 'grant execute on function public._sp_as(uuid), public._sp(text), public._sp_chk(text, text, text) to authenticated';
  perform set_config('sp.total', '0', true); perform set_config('sp.nf', '0', true); perform set_config('sp.f', '', true);

  -- ---------- fixtures (admin) ----------
  insert into ops.signup_allowlist (email_lower, kind, is_household) values
    ('st-sp-h1@example.invalid', 'human', true), ('st-sp-h2@example.invalid', 'human', true),
    ('st-sp-ag@example.invalid', 'agent', true), ('st-sp-w@example.invalid', 'human', false);
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (h1, 'st-sp-h1@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}', '{"full_name":"St Sp H1"}'),
    (h2, 'st-sp-h2@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}', '{"full_name":"St Sp H2"}'),
    (ag, 'st-sp-ag@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}', '{"full_name":"St Sp Agent"}'),
    (w,  'st-sp-w@example.invalid',  'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}', '{"full_name":"St Sp W"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), h1, h1::text, 'email', json_build_object('sub', h1, 'email', 'st-sp-h1@example.invalid')),
    (gen_random_uuid(), h2, h2::text, 'email', json_build_object('sub', h2, 'email', 'st-sp-h2@example.invalid')),
    (gen_random_uuid(), ag, ag::text, 'email', json_build_object('sub', ag, 'email', 'st-sp-ag@example.invalid')),
    (gen_random_uuid(), w,  w::text,  'email', json_build_object('sub', w,  'email', 'st-sp-w@example.invalid'));
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (r, 'st-sp-r@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"St Sp R"}'),
    (q, 'st-sp-q@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"St Sp Q"}'),
    (x, 'st-sp-x@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"St Sp X"}'),
    (n, 'st-sp-n@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"St Sp N"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), r, 'st-sp-sub-r', 'google', json_build_object('sub', 'st-sp-sub-r', 'email', 'st-sp-r@example.invalid', 'email_verified', true)),
    (gen_random_uuid(), q, 'st-sp-sub-q', 'google', json_build_object('sub', 'st-sp-sub-q', 'email', 'st-sp-q@example.invalid', 'email_verified', true)),
    (gen_random_uuid(), x, 'st-sp-sub-x', 'google', json_build_object('sub', 'st-sp-sub-x', 'email', 'st-sp-x@example.invalid', 'email_verified', true)),
    (gen_random_uuid(), n, 'st-sp-sub-n', 'google', json_build_object('sub', 'st-sp-sub-n', 'email', 'st-sp-n@example.invalid', 'email_verified', true));
  insert into public.users_pending_for_decision (user_id, email, status, decided_at) values
    (r, 'st-sp-r@example.invalid', 'approved', now()), (q, 'st-sp-q@example.invalid', 'pending', null),
    (x, 'st-sp-x@example.invalid', 'removed', now());
  fx := array[h1, h2, ag, w, r, q, x, n];
  perform public._sp_chk('P0 fixtures', (select string_agg(p.kind || ':' || p.is_household, ',' order by p.display_name) from public.profiles p where p.id = any (fx)),
                         'agent:true,human:true,human:true,human:false,human:false,human:false,human:false,human:false');

  -- ---------- P1 who is listed (seen by H1) ----------
  perform public._sp_as(h1);
  v := public._sp(format('select string_agg(display_name, '','' order by display_name) from public.shareable_profiles() where id = any (%L::uuid[])', fx));
  perform public._sp_chk('P1a household, allowlisted guest, approved request; not the agent, me, pending, removed, plain', v, 'St Sp H2,St Sp R,St Sp W');
  perform public._sp_chk('P1b no agent ever (real bots included)',
    public._sp('select count(*)::text from public.shareable_profiles() s join public.profiles p on p.id = s.id where p.kind <> ''human'''), '0');
  perform public._sp_chk('P1c the real household people are listed',
    public._sp('select count(*)::text from public.shareable_profiles() s join public.profiles p on p.id = s.id where p.handle in (''maksym'',''anastasiia'')'), '2');

  -- ---------- P2 names and ids only ----------
  perform public._sp_chk('P2a two keys', public._sp('select string_agg(distinct k, '','' order by k) from public.shareable_profiles() s, jsonb_object_keys(to_jsonb(s)) k'),
                         'display_name,id');
  perform public._sp_chk('P2b no address in any value', public._sp('select count(*)::text from public.shareable_profiles() s where to_jsonb(s)::text like ''%@%'''), '0');
  perform public._sp_as(null);
  perform public._sp_chk('P2c result type', pg_get_function_result('public.shareable_profiles()'::regprocedure), 'TABLE(id uuid, display_name text)');

  -- ---------- P3 who gets the list ----------
  perform public._sp_as(w);
  perform public._sp_chk('P3a a whitelisted guest sees names', public._sp(format('select string_agg(display_name, '','' order by display_name) from public.shareable_profiles() where id = any (%L::uuid[])', fx)),
                         'St Sp H1,St Sp H2,St Sp R');
  perform public._sp_as(r);
  perform public._sp_chk('P3b an approved guest sees names', public._sp(format('select count(*)::text from public.shareable_profiles() where id in (%L, %L)', h1, w)), '2');
  perform public._sp_as(n);
  perform public._sp_chk('P3c a plain signed-in user gets none', public._sp('select count(*)::text from public.shareable_profiles()'), '0');
  perform public._sp_as(q);
  perform public._sp_chk('P3d a pending request gets none', public._sp('select count(*)::text from public.shareable_profiles()'), '0');
  perform public._sp_as(ag);
  perform public._sp_chk('P3e an agent gets none', public._sp('select count(*)::text from public.shareable_profiles()'), '0');

  -- ---------- P4 shares by id ----------
  perform public._sp_as(h1);
  hl := public.create_list('st-sp list', 'st-sp-list', false);
  hl2 := public.create_list('st-sp list 2', 'st-sp-list-2', false);
  tl := (public.create_tag_list('st-sp tags') ->> 'id')::uuid;
  tl2 := (public.create_tag_list('st-sp tags 2') ->> 'id')::uuid;
  perform public._sp_chk('P4a owner shares a list with a guest by id', public._sp(format('select public.share_list_with(%L, %L, ''viewer'')::text', hl, w)), '{"ok": true}');
  perform public._sp_chk('P4b and with a household person', public._sp(format('select public.share_list_with(%L, %L, ''editor'')::text', hl, h2)), '{"ok": true}');
  perform public._sp_chk('P4c owner shares a tag list', public._sp(format('select public.share_tag_list_with(%L, %L, ''editor'')::text', tl, h2)), '{"ok": true}');
  perform public._sp_as(null);
  perform public._sp_chk('P4d joined at once with the roles asked',
    (select string_agg(p.display_name || ':' || m.role, ',' order by p.display_name) from public.list_members m join public.profiles p on p.id = m.profile_id where m.list_id = hl)
    || '/' || (select string_agg(p.display_name || ':' || m.role, ',' order by p.display_name) from public.tag_list_members m join public.profiles p on p.id = m.profile_id where m.tag_list_id = tl),
    'St Sp H1:owner,St Sp H2:editor,St Sp W:viewer/St Sp H1:owner,St Sp H2:editor');
  perform public._sp_chk('P4e the address was resolved on the server',
    (select string_agg(email_lower || ':' || auto_joined, ',' order by email_lower) from public.invites where list_id = hl), 'st-sp-h2@example.invalid:true,st-sp-w@example.invalid:true');
  perform public._sp_as(h2);
  perform public._sp_chk('P4f an editor shares a tag list', public._sp(format('select public.share_tag_list_with(%L, %L, ''viewer'')::text', tl, r)), '{"ok": true}');
  perform public._sp_as(null);
  perform public._sp_chk('P4g the approved guest joined the tag list', (select role from public.tag_list_members where tag_list_id = tl and profile_id = r), 'viewer');

  -- ---------- P5 refusals ----------
  perform public._sp_as(h2);
  perform public._sp_chk('P5a a list editor does not share (owners only, as share_list)', public._sp(format('select public.share_list_with(%L, %L, ''viewer'')::text', hl, r)), 'ERR 42501%');
  perform public._sp_as(w);
  perform public._sp_chk('P5b a list viewer does not share', public._sp(format('select public.share_list_with(%L, %L, ''viewer'')::text', hl, r)), 'ERR 42501%');
  perform public._sp_as(r);
  perform public._sp_chk('P5c a tag-list viewer does not share', public._sp(format('select public.share_tag_list_with(%L, %L, ''viewer'')::text', tl, w)), 'ERR 42501%');
  perform public._sp_as(h1);
  perform public._sp_chk('P5d not the agent, not a plain user, not a pending request, not me',
    public._sp(format('select public.share_list_with(%L, %L, ''viewer'')::text', hl2, ag)) || '|'
    || public._sp(format('select public.share_list_with(%L, %L, ''viewer'')::text', hl2, n)) || '|'
    || public._sp(format('select public.share_list_with(%L, %L, ''viewer'')::text', hl2, q)) || '|'
    || public._sp(format('select public.share_tag_list_with(%L, %L, ''viewer'')::text', tl2, h1)) || '|'
    || public._sp(format('select public.share_list_with(%L, null, ''viewer'')::text', hl2)),
    'ERR 42501 pick a name%|ERR 42501 pick a name%|ERR 42501 pick a name%|ERR 42501 pick a name%|ERR 42501 pick a name%');
  perform public._sp_chk('P5e bad roles', public._sp(format('select public.share_list_with(%L, %L, ''owner'')::text', hl2, w)) || '|'
                                       || public._sp(format('select public.share_tag_list_with(%L, %L, null)::text', tl2, w)), 'ERR 22023%|ERR 22023%');
  perform public._sp(format('update public.lists set archived_at = now() where id = %L', hl2));
  perform public.set_tag_list_archived(tl2, true);
  perform public._sp_chk('P5f archived list and tag list', public._sp(format('select public.share_list_with(%L, %L, ''viewer'')::text', hl2, w)) || '|'
                                       || public._sp(format('select public.share_tag_list_with(%L, %L, ''viewer'')::text', tl2, w)), 'ERR 22023%|ERR 22023%');
  perform public._sp_as(null);
  perform public._sp_chk('P5g nothing joined after the refusals',
    (select count(*)::text from public.list_members where list_id = hl2 and profile_id <> h1) || '/'
    || (select count(*)::text from public.tag_list_members where tag_list_id = tl2 and profile_id <> h1) || '/'
    || (select count(*)::text from public.invites where list_id = hl2 or tag_list_id = tl2), '0/0/0');

  -- ---------- P6 rights ----------
  perform public._sp_chk('P6a definers with an empty search_path',
    (select string_agg(p.proname || ':' || p.prosecdef || ':' || (coalesce(p.proconfig, '{}') @> array['search_path=""']), ',' order by p.proname)
       from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' and p.proname in ('shareable_profiles','share_list_with','share_tag_list_with','shareable_email','is_whitelisted')),
    'is_whitelisted:true:true,share_list_with:true:true,share_tag_list_with:true:true,shareable_email:true:true,shareable_profiles:true:true');
  perform public._sp_chk('P6b anon none, authenticated the three RPCs only',
    has_function_privilege('anon', 'public.shareable_profiles()', 'execute')::text || '/'
    || has_function_privilege('anon', 'public.share_list_with(uuid, uuid, text)', 'execute')::text || '/'
    || has_function_privilege('authenticated', 'public.shareable_profiles()', 'execute')::text || '/'
    || has_function_privilege('authenticated', 'public.share_list_with(uuid, uuid, text)', 'execute')::text || '/'
    || has_function_privilege('authenticated', 'public.share_tag_list_with(uuid, uuid, text)', 'execute')::text || '/'
    || has_function_privilege('authenticated', 'public.shareable_email(uuid)', 'execute')::text || '/'
    || has_function_privilege('authenticated', 'public.is_whitelisted(uuid)', 'execute')::text,
    'false/false/true/true/true/false/false');
  perform public._sp_as(h1);
  perform public._sp_chk('P6c the helpers are not endpoints', public._sp(format('select public.shareable_email(%L)', w)) || '|'
                                       || public._sp(format('select public.is_whitelisted(%L)::text', w)), 'ERR 42501%|ERR 42501%');
  perform public._sp_as(null);

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('sp.total')::int - current_setting('sp.nf')::int,
    current_setting('sp.total'), coalesce(nullif(current_setting('sp.f'), ''), 'none');
end $do$;
