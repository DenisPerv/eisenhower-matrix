-- db/915_selftest_telegram_link.sql: the Telegram link selftest (db/032, HomeOS telegram-v2 build-plan T9) as admin SQL.
-- Rolls everything back and reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like
-- 900-914.
-- Cases: L1 link tokens for people only, 40 hex; L2 redeem by the telegram login only; L3 a malformed or unknown token;
-- L4 a household link: group, default list, the bot editor of "My tasks"; L5 single use; L6 expired; L7 a new token
-- ends the earlier one, a guest link; L8 a pending guest: linked without a group, no share, approval shares, removal
-- unshares; L9 telegram_member: callers, unknown id, no email; L10 one account per user and per Telegram id (a fresh
-- proof moves the link); L11 the claim: forms, refusals, clearing; L12 the claim on a new access-request task;
-- L13 my_telegram_link, unlink takes the bot out, a new link brings it back past the opt-out; L14 rights (anon, internal
-- functions, ops tables, definer and search_path); L15 HomeOS - Global (live household only); L16 the material bucket:
-- the bot uploads only, homeos-agent reads and deletes, people nothing (where Storage is installed).
-- Fixtures: H (household person), G (approved Google guest), P (pending Google guest), Q (Google guest with a claim);
-- B the telegram login and A homeos-agent (the live profiles, or fixtures on a database without them).
-- Run after 032, 003, 011, the 012 policy block, 026, 030, 031 and 900-914.

do $do$
declare
  h uuid := gen_random_uuid(); g uuid := gen_random_uuid(); p uuid := gen_random_uuid(); q uuid := gen_random_uuid();
  b uuid; a uuid; lh uuid; lg uuid; lp uuid; t1 text; t2 text; x jsonb; v text;
begin
  execute $f$create function public._tl_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true);
      else perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
           set local role authenticated; end if; end $b$$f$;
  execute $f$create function public._tl(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute $f$create function public._tl_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('tl.total', (coalesce(nullif(current_setting('tl.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('tl.nf', (coalesce(nullif(current_setting('tl.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('tl.f', coalesce(current_setting('tl.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  execute 'grant execute on function public._tl_as(uuid), public._tl(text), public._tl_chk(text, text, text) to authenticated';
  perform set_config('tl.total', '0', true); perform set_config('tl.nf', '0', true); perform set_config('tl.f', '', true);

  -- ---------- fixtures (admin) ----------
  insert into ops.signup_allowlist (email_lower, kind, is_household) values ('st-tl-h@example.invalid', 'human', true);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h, 'st-tl-h@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data)
  values (gen_random_uuid(), h, h::text, 'email', json_build_object('sub', h, 'email', 'st-tl-h@example.invalid'));
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (g, 'st-tl-g@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest TL"}'),
    (p, 'st-tl-p@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Pending TL"}'),
    (q, 'st-tl-q@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Claim TL"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data)
  select gen_random_uuid(), u.id, 'st-tl-sub-' || u.id, 'google',
         json_build_object('sub', 'st-tl-sub-' || u.id, 'email', u.email, 'email_verified', true)
    from auth.users u where u.id in (g, p, q);
  insert into public.users_pending_for_decision (user_id, email, status, decided_at, applied_at)
  values (g, 'st-tl-g@example.invalid', 'approved', now(), now());
  insert into public.users_pending_for_decision (user_id, email, status) values (p, 'st-tl-p@example.invalid', 'pending');

  b := public.telegram_login_id();
  if b is null then
    b := gen_random_uuid();
    insert into ops.signup_allowlist (email_lower, kind, is_household) values ('st-tl-b@example.invalid', 'agent', true);
    insert into auth.users (id, email, aud, role, raw_app_meta_data) values
      (b, 'st-tl-b@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
    update public.profiles set handle = 'telegram-bot' where id = b;
  end if;
  select id into a from public.profiles where handle = 'homeos-agent' and kind = 'agent';
  if a is null then
    a := gen_random_uuid();
    insert into ops.signup_allowlist (email_lower, kind, is_household) values ('st-tl-a@example.invalid', 'agent', true);
    insert into auth.users (id, email, aud, role, raw_app_meta_data) values
      (a, 'st-tl-a@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
    update public.profiles set handle = 'homeos-agent' where id = a;
  end if;
  lh := public.telegram_default_list(h); lg := public.telegram_default_list(g); lp := public.telegram_default_list(p);
  perform public._tl_chk('L0 fixtures', (lh is not null and lg is not null and lp is not null and b is not null)::text, 'true');

  -- L1 link tokens: people only, 40 hex
  perform public._tl_as(h);
  x := public.telegram_link_token(); t1 := x->>'token';
  perform public._tl_chk('L1a token', (t1 ~ '^[0-9a-f]{40}$')::text, 'true');
  perform public._tl_chk('L1b expiry', ((x->>'expires_at')::timestamptz between now() + interval '14 minutes' and now() + interval '16 minutes')::text, 'true');
  perform public._tl_as(b);
  perform public._tl_chk('L1c agent', public._tl('select public.telegram_link_token()::text'), 'ERR 42501%');
  perform public._tl_as(null);
  perform public._tl_chk('L1d stored hashed', (select count(*)::text from ops.telegram_link_tokens where token_hash = t1), '0');

  -- L2 redeem by the telegram login only
  perform public._tl_as(h);
  perform public._tl_chk('L2a person', public._tl(format('select public.telegram_redeem_link(%L, 111)::text', t1)), 'ERR 42501%');
  perform public._tl_as(a);
  perform public._tl_chk('L2b homeos-agent', public._tl(format('select public.telegram_redeem_link(%L, 111)::text', t1)), 'ERR 42501%');

  -- L3 malformed and unknown tokens get the same answer
  perform public._tl_as(b);
  perform public._tl_chk('L3a malformed', public._tl('select public.telegram_redeem_link(''abc'', 111)::text'), 'ERR 22023 link code invalid%');
  perform public._tl_chk('L3b unknown', public._tl(format('select public.telegram_redeem_link(%L, 111)::text', repeat('a', 40))), 'ERR 22023 link code invalid%');
  perform public._tl_chk('L3c bad id', public._tl(format('select public.telegram_redeem_link(%L, 0)::text', t1)), 'ERR 22023%');

  -- L4 a household link
  x := public.telegram_redeem_link(t1, 111, '@st_tl_h');
  perform public._tl_chk('L4a group', x->>'group', 'household');
  perform public._tl_chk('L4b default list', (x->>'default_list_id' = lh::text)::text, 'true');
  perform public._tl_chk('L4c username', x->>'tg_username', 'st_tl_h');
  perform public._tl_as(null);
  perform public._tl_chk('L4d bot editor', (select role from public.list_members where list_id = lh and profile_id = b), 'editor');

  -- L5 single use
  perform public._tl_as(b);
  perform public._tl_chk('L5 reuse', public._tl(format('select public.telegram_redeem_link(%L, 111)::text', t1)), 'ERR 22023%');

  -- L6 expired
  perform public._tl_as(g);
  t1 := public.telegram_link_token()->>'token';
  perform public._tl_as(null);
  update ops.telegram_link_tokens set expires_at = now() - interval '1 minute' where user_id = g and used_at is null;
  perform public._tl_as(b);
  perform public._tl_chk('L6 expired', public._tl(format('select public.telegram_redeem_link(%L, 222)::text', t1)), 'ERR 22023%');

  -- L7 a new token ends the earlier one; a guest link
  perform public._tl_as(g);
  t1 := public.telegram_link_token()->>'token';
  t2 := public.telegram_link_token()->>'token';
  perform public._tl_as(b);
  perform public._tl_chk('L7a earlier token', public._tl(format('select public.telegram_redeem_link(%L, 222)::text', t1)), 'ERR 22023%');
  x := public.telegram_redeem_link(t2, 222, 'bad name!');
  perform public._tl_chk('L7b guest', x->>'group', 'guest');
  perform public._tl_chk('L7c bad username dropped', coalesce(x->>'tg_username', 'null'), 'null');
  perform public._tl_as(null);
  perform public._tl_chk('L7d bot editor', (select role from public.list_members where list_id = lg and profile_id = b), 'editor');

  -- L8 a pending guest: linked without a group, no share; approval shares; removal unshares
  perform public._tl_as(p);
  t1 := public.telegram_link_token()->>'token';
  perform public._tl_as(b);
  x := public.telegram_redeem_link(t1, 333);
  perform public._tl_chk('L8a no group', coalesce(x->>'group', 'null'), 'null');
  perform public._tl_chk('L8b member null', coalesce(public.telegram_member(333)::text, 'null'), 'null');
  perform public._tl_as(null);
  perform public._tl_chk('L8c not shared', (select count(*)::text from public.list_members where list_id = lp and profile_id = b), '0');
  update public.users_pending_for_decision set status = 'approved', decided_at = now() where user_id = p;
  perform public._tl_chk('L8d shared on approval', (select role from public.list_members where list_id = lp and profile_id = b), 'editor');
  perform public._tl_as(b);
  perform public._tl_chk('L8e member guest', public.telegram_member(333)->>'group', 'guest');
  perform public._tl_as(null);
  update public.users_pending_for_decision set status = 'removed' where user_id = p;
  perform public._tl_chk('L8f unshared on removal', (select count(*)::text from public.list_members where list_id = lp and profile_id = b), '0');
  perform public._tl_as(b);
  perform public._tl_chk('L8g member null again', coalesce(public.telegram_member(333)::text, 'null'), 'null');

  -- L9 telegram_member: callers, unknown id, no email
  perform public._tl_chk('L9a unknown id', coalesce(public.telegram_member(999999999)::text, 'null'), 'null');
  x := public.telegram_member(111);
  perform public._tl_chk('L9b household', (x->>'user_id' = h::text)::text || '/' || (x->>'group'), 'true/household');
  perform public._tl_chk('L9c no email', (x ? 'email')::text, 'false');
  perform public._tl_as(h);
  perform public._tl_chk('L9d person', public._tl('select public.telegram_member(111)::text'), 'ERR 42501%');
  perform public._tl_as(a);
  perform public._tl_chk('L9e homeos-agent', public._tl('select public.telegram_member(111)::text'), 'ERR 42501%');

  -- L10 a fresh proof moves the link: H re-links with 444 (111 is free), then G proves 444 (H loses it)
  perform public._tl_as(h);
  t1 := public.telegram_link_token()->>'token';
  perform public._tl_as(b);
  x := public.telegram_redeem_link(t1, 444);
  perform public._tl_chk('L10a old id free', coalesce(public.telegram_member(111)::text, 'null'), 'null');
  perform public._tl_as(g);
  t1 := public.telegram_link_token()->>'token';
  perform public._tl_as(b);
  x := public.telegram_redeem_link(t1, 444);
  perform public._tl_chk('L10b id moved', (public.telegram_member(444)->>'user_id' = g::text)::text, 'true');
  perform public._tl_chk('L10c guest old id free', coalesce(public.telegram_member(222)::text, 'null'), 'null');
  perform public._tl_as(null);
  perform public._tl_chk('L10d H unlinked', (select count(*)::text from ops.telegram_links where user_id = h), '0');

  -- L11 the claim
  perform public._tl_as(q);
  perform public._tl_chk('L11a @name', public.set_telegram_claim('@st_tl_q')->>'claim', '@st_tl_q');
  perform public._tl_chk('L11b bare name', public.set_telegram_claim(' st_tl_q ')->>'claim', '@st_tl_q');
  perform public._tl_chk('L11c t.me link', public.set_telegram_claim('https://t.me/st_tl_q')->>'claim', '@st_tl_q');
  perform public._tl_chk('L11d id', public.set_telegram_claim('123456789')->>'claim', '123456789');
  perform public._tl_chk('L11e bad', public._tl('select public.set_telegram_claim(''no spaces!'')::text'), 'ERR 22023%');
  perform public._tl_chk('L11f short', public._tl('select public.set_telegram_claim(''@abc'')::text'), 'ERR 22023%');
  perform public._tl_chk('L11g clear', coalesce(public.set_telegram_claim('')->>'claim', 'null'), 'null');
  perform public._tl_as(b);
  perform public._tl_chk('L11h agent', public._tl('select public.set_telegram_claim(''@st_tl_b'')::text'), 'ERR 42501%');

  -- L12 the claim on a new access-request task (skipped where the Access requests list is missing)
  perform public._tl_as(q);
  perform public.set_telegram_claim('@st_tl_q');
  v := public._tl('select public.request_access()::text');
  perform public._tl_as(null);
  if v like 'ERR 55000%' then
    perform public._tl_chk('L12 skipped: no Access requests list', 'skip', 'skip');
  else
    perform public._tl_chk('L12a request', v, '{%');
    perform public._tl_chk('L12b claim line', (select (i.body_md like '%Telegram (claimed, not yet proved): @st_tl_q%')::text || '/' || (i.details->>'telegram_claim')
                                                from public.users_pending_for_decision r join public.items i on i.id = r.item_id
                                               where r.user_id = q), 'true/@st_tl_q');
  end if;

  -- L13 my_telegram_link; unlink takes the bot out; a new link brings it back past the opt-out
  perform public._tl_as(g);
  x := public.my_telegram_link();
  perform public._tl_chk('L13a linked', (x->>'linked'), 'true');
  x := public.telegram_unlink();
  perform public._tl_chk('L13b unlinked', (public.my_telegram_link()->>'linked'), 'false');
  perform public._tl_as(null);
  perform public._tl_chk('L13c bot out', (select count(*)::text from public.list_members where list_id = lg and profile_id = b), '0');
  perform public._tl_as(g);
  t1 := public.telegram_link_token()->>'token';
  perform public._tl_as(b);
  x := public.telegram_redeem_link(t1, 555);
  perform public._tl_as(null);
  perform public._tl_chk('L13d bot back', (select role from public.list_members where list_id = lg and profile_id = b), 'editor');
  perform public._tl_as(null);
  perform public._tl_chk('L13e signed out', coalesce(public.my_telegram_link()::text, 'null'), 'null');

  -- L14 rights
  perform public._tl_chk('L14a anon', (select coalesce(string_agg(f, ','), 'none') from unnest(array[
      'public.telegram_link_token()', 'public.my_telegram_link()', 'public.set_telegram_claim(text)', 'public.telegram_unlink()',
      'public.telegram_redeem_link(text, bigint, text)', 'public.telegram_member(bigint)']) f
     where has_function_privilege('anon', f, 'execute')), 'none');
  perform public._tl_chk('L14b authenticated', (select bool_and(has_function_privilege('authenticated', f, 'execute'))::text from unnest(array[
      'public.telegram_link_token()', 'public.my_telegram_link()', 'public.set_telegram_claim(text)', 'public.telegram_unlink()',
      'public.telegram_redeem_link(text, bigint, text)', 'public.telegram_member(bigint)', 'public.is_telegram_login()', 'public.is_homeos_agent()']) f), 'true');
  perform public._tl_chk('L14c internal', (select coalesce(string_agg(f, ','), 'none') from unnest(array[
      'public.telegram_login_id()', 'public.telegram_default_list(uuid)', 'public.telegram_group(uuid)', 'public.telegram_share_default(uuid)',
      'public.telegram_unshare_default(uuid)', 'public.telegram_member_json(uuid)']) f
     where has_function_privilege('authenticated', f, 'execute')), 'none');
  perform public._tl_chk('L14d ops tables', (select coalesce(string_agg(t, ','), 'none') from unnest(array['ops.telegram_links', 'ops.telegram_claims', 'ops.telegram_link_tokens']) t
     where has_table_privilege('authenticated', t, 'select') or has_table_privilege('anon', t, 'select')), 'none');
  perform public._tl_chk('L14e definer and search_path', (select coalesce(string_agg(p2.proname, ','), 'none') from pg_proc p2 join pg_namespace n on n.oid = p2.pronamespace
     where n.nspname = 'public' and (p2.proname like 'telegram\_%' or p2.proname in ('my_telegram_link', 'set_telegram_claim', 'is_telegram_login',
                                     'is_homeos_agent', 'items_telegram_claim', 'access_request_telegram'))
       and p2.proname <> 'telegram_scope'
       and not (p2.prosecdef and coalesce(p2.proconfig, '{}') @> array['search_path=""'])), 'none');
  perform public._tl_as(h);
  perform public._tl_chk('L14f tables closed', public._tl('select count(*)::text from ops.telegram_links'), 'ERR 42501%');

  -- L15 HomeOS - Global on the live household
  perform public._tl_as(null);
  if exists (select 1 from public.profiles where handle = 'maksym' and kind = 'human') then
    perform public._tl_chk('L15 global editors', (select string_agg(pr.handle || '=' || m.role, ',' order by pr.handle)
        from public.lists l join public.profiles o on o.id = l.owner_id and o.handle = 'maksym'
        join public.list_members m on m.list_id = l.id join public.profiles pr on pr.id = m.profile_id
       where (l.slug = 'homeos-global' or lower(l.name) = 'homeos - global') and l.archived_at is null
         and pr.handle in ('homeos-agent', 'telegram-bot')), 'homeos-agent=editor,telegram-bot=editor');
  else
    perform public._tl_chk('L15 skipped: no household seed', 'skip', 'skip');
  end if;

  -- L16 the material bucket
  if to_regclass('storage.objects') is not null then
    perform public._tl_chk('L16a private bucket', (select public::text from storage.buckets where id = 'workorder-material'), 'false');
    perform public._tl_as(b);
    perform public._tl_chk('L16b bot uploads', public._tl('insert into storage.objects (bucket_id, name) values (''workorder-material'', ''st-tl/one.png'')'), 'ok:1');
    perform public._tl_chk('L16c bot cannot read', public._tl('select count(*)::text from storage.objects where bucket_id = ''workorder-material'' and name like ''st-tl/%'''), '0');
    perform public._tl_chk('L16d bot other bucket', public._tl('insert into storage.objects (bucket_id, name) values (''avatars'', ''st-tl/x.png'')'), 'ERR%');
    perform public._tl_as(h);
    perform public._tl_chk('L16e person uploads', public._tl('insert into storage.objects (bucket_id, name) values (''workorder-material'', ''st-tl/two.png'')'), 'ERR 42501%');
    perform public._tl_chk('L16f person reads', public._tl('select count(*)::text from storage.objects where bucket_id = ''workorder-material'' and name like ''st-tl/%'''), '0');
    perform public._tl_as(a);
    perform public._tl_chk('L16g agent reads', public._tl('select count(*)::text from storage.objects where bucket_id = ''workorder-material'' and name like ''st-tl/%'''), '1');
    perform public._tl_chk('L16h agent cannot upload', public._tl('insert into storage.objects (bucket_id, name) values (''workorder-material'', ''st-tl/three.png'')'), 'ERR 42501%');
    perform set_config('storage.allow_delete_query', 'true', true);   -- newer Storage refuses direct deletes without it
    perform public._tl_as(b);
    perform public._tl_chk('L16i bot cannot delete', public._tl('delete from storage.objects where bucket_id = ''workorder-material'' and name like ''st-tl/%'''), 'ok:0');
    perform public._tl_as(a);
    perform public._tl_chk('L16j agent deletes', public._tl('delete from storage.objects where bucket_id = ''workorder-material'' and name like ''st-tl/%'''), 'ok:1');
  else
    perform public._tl_chk('L16 skipped: no Storage', 'skip', 'skip');
  end if;

  perform public._tl_as(null);
  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('tl.total')::int - current_setting('tl.nf')::int,
    current_setting('tl.total'), coalesce(nullif(current_setting('tl.f'), ''), 'none');
end $do$;
