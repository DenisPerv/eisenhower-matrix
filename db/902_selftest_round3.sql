-- db/902_selftest_round3.sql: the round-3 selftest (HomeOS round3-plan.md D2) as admin SQL. Rolls everything back and
-- reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900 and 901.
-- Cases: R1 "My tags"; R2 list names and slugs; R3 V4-8 (no joining an archived list or tag list); R4-R6 a first share
-- joins (same answer, notice, leave, a re-share needs Accept, a block wins); R7 tag-list roles viewer / contributor /
-- editor (G4, G5) and a tag made after the share; G48-G58, G60 (tag-lists-design.md §6; G59 is an app unit test);
-- R9 urgency_settings access; R10 V4-1 (the allowlist nonce); R11 mine_tag_ids; R12 agents; R13 the notice's block.
-- Fixtures as in 901: H1 (household) and AG (agent) through allowlist rows, A, B, C as Google users with identities.
-- Run after 003, 011, the 012 policy block, 900 and 901.

do $do$
declare
  h1 uuid := gen_random_uuid(); ag uuid := gen_random_uuid(); a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
  c uuid := gen_random_uuid(); pw uuid := gen_random_uuid(); px uuid := gen_random_uuid(); gx uuid := gen_random_uuid();
  ae text := 'st-r3-a@example.invalid'; be text := 'st-r3-b@example.invalid'; ce text := 'st-r3-c@example.invalid';
  he text := 'st-r3-h1@example.invalid';
  am uuid; l1 uuid; l2 uuid; la uuid; lj uuid; lk uuid; ls uuid; s1 uuid; ic uuid;
  adef uuid; bdef uuid; work uuid; arch uuid; arch2 uuid; pm uuid; l2t uuid; t8 uuid;
  tu uuid; tl uuid; told uuid; tx uuid; ty uuid; tdup1 uuid; tdup2 uuid;
  inv uuid; nid uuid; j jsonb; v text; w text;
begin
  execute $f$create function public._r3_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true);
      else perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
           set local role authenticated; end if; end $b$$f$;
  execute $f$create function public._r3(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  -- an error's code, details and hint, for answers the app reads (23505 'live'/'archived' and the list id)
  execute $f$create function public._r3_err(q text) returns text language plpgsql as $b$
    declare s text; d text; h text;
    begin execute q; return 'ok';
    exception when others then get stacked diagnostics s = returned_sqlstate, d = pg_exception_detail, h = pg_exception_hint;
      return s || '/' || coalesce(d, '') || '/' || coalesce(h, ''); end $b$$f$;
  execute $f$create function public._r3_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('r3.total', (coalesce(nullif(current_setting('r3.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('r3.nf', (coalesce(nullif(current_setting('r3.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('r3.f', coalesce(current_setting('r3.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  execute 'grant execute on function public._r3_as(uuid), public._r3(text), public._r3_err(text), public._r3_chk(text, text, text) to authenticated';
  perform set_config('r3.total', '0', true); perform set_config('r3.nf', '0', true); perform set_config('r3.f', '', true);

  -- ---------- fixtures (admin) ----------
  insert into ops.signup_allowlist (email_lower, kind, is_household) values (he, 'human', true), ('st-r3-ag@example.invalid', 'agent', true);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1, he, 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (ag, 'st-r3-ag@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), h1, h1::text, 'email', json_build_object('sub', h1, 'email', he)),
    (gen_random_uuid(), ag, ag::text, 'email', json_build_object('sub', ag, 'email', 'st-r3-ag@example.invalid'));
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (a, ae, 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest A"}'),
    (b, be, 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest B"}'),
    (c, ce, 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest C"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), a, 'st-r3-sub-a', 'google', json_build_object('sub', 'st-r3-sub-a', 'email', ae, 'email_verified', true)),
    (gen_random_uuid(), b, 'st-r3-sub-b', 'google', json_build_object('sub', 'st-r3-sub-b', 'email', be, 'email_verified', true)),
    (gen_random_uuid(), c, 'st-r3-sub-c', 'google', json_build_object('sub', 'st-r3-sub-c', 'email', ce, 'email_verified', true)),
    (gen_random_uuid(), b, 'st-r3-b2', 'email', json_build_object('sub', b, 'email', 'st-r3-b2@example.invalid'));   -- B's second address
  select l.id into am from public.lists l where l.owner_id = a;
  select t.id into adef from public.tag_lists t where t.owner_id = a and t.is_default;
  select t.id into bdef from public.tag_lists t where t.owner_id = b and t.is_default;

  -- R1 G7: no default tag list is still "Default"; a new person's is "My tags"
  perform public._r3_chk('R1 My tags', (select count(*) from public.tag_lists where is_default and name = 'Default')
                                       || '/' || (select name from public.tag_lists where id = adef), '0/My tags');

  -- R2 list names and slugs (adjustment 1, bugs 1 and 2)
  perform public._r3_as(a);
  l1 := public.create_list('Shop');
  perform public._r3_chk('R2a same name, live', public._r3_err('select public.create_list(''SHOP '')'), '23505/live/' || l1);
  perform public._r3_as(b);
  perform public._r3_chk('R2b same name, another owner', public._r3('select (public.create_list(''Shop'') is not null)::text'), 'true');
  perform public._r3_as(a);
  perform public._r3(format('update public.lists set archived_at = now() where id = %L', l1));
  perform public._r3_chk('R2c same name, archived', public._r3_err('select public.create_list(''shop'')'), '23505/archived/' || l1);
  l2 := public.create_list('Shop!!');
  perform public._r3_chk('R2d a new name past an archived slug', (select slug from public.lists where id = l2), 'shop-2');
  j := public.create_list_row('Shop & Co');
  perform public._r3_chk('R2e create_list_row', (j->>'slug') || '/' || (j->>'name') || '/' || (j->>'owner_id') || '/'
                                                || coalesce(j->>'archived_at', 'null') || '/' || ((j->>'sort')::int > 0),
                         'shop-co/Shop & Co/' || a || '/null/true');
  j := public.create_list_row('Shop Co');
  perform public._r3_chk('R2f slug suffix', j->>'slug', 'shop-co-2');
  j := public.create_list_row('Покупки');
  perform public._r3_chk('R2g non-ASCII name', ((j->>'slug') ~ '^list-[0-9a-f]{6}$')::text || '/' || (j->>'name'), 'true/Покупки');
  perform public._r3_chk('R2h explicit slug taken', public._r3_err('select public.create_list(''Other'', ''shop-co'')'), '23505/%');

  -- R3 V4-8: no invitation into an archived list or tag list is shown or accepted; an archived tag list is not shared
  la := public.create_list('Archive me');
  perform public.share_list(la, ce, 'viewer');
  t8 := (public.create_tag_list('Arch8') ->> 'id')::uuid;
  perform public.share_tag_list(t8, ce, 'viewer');
  perform public._r3(format('update public.lists set archived_at = now() where id = %L', la));
  perform public.set_tag_list_archived(t8, true);
  perform public._r3_chk('R3d G58 share an archived tag list', public._r3(format('select public.share_tag_list(%L, %L, ''viewer'', true)::text', t8, be)), 'ERR 22023%');
  perform public._r3_as(c);
  perform public._r3_chk('R3a none shown', public._r3('select count(*)::text from public.my_invitations()'), '0');
  select id into inv from public.invites where list_id = la;
  perform public._r3_chk('R3b accept into an archived list', public._r3(format('select public.accept_invite(%L)::text', inv)), 'ERR 22023%');
  select id into inv from public.invites where tag_list_id = t8;
  perform public._r3_chk('R3c accept into an archived tag list', public._r3(format('select public.accept_invite(%L)::text', inv)), 'ERR 22023%');
  perform public._r3_chk('R3e decline still works', public._r3(format('select public.decline_invite(%L, false) ->> ''ok''', inv)), 'true');

  -- R4 a first share joins at once (adjustment 3, G1): the same answer for a person, an unknown address and an agent
  perform public._r3_as(a);
  lj := public.create_list('Joined');
  insert into public.items (list_id, category, title) values (lj, 'task', 'j1');
  v := public._r3(format('select public.share_list(%L, %L, ''editor'', true)::text', lj, be))
    || '|' || public._r3(format('select public.share_list(%L, ''st-r3-nobody@example.invalid'', ''editor'', true)::text', lj))
    || '|' || public._r3(format('select public.share_list(%L, ''st-r3-ag@example.invalid'', ''editor'', true)::text', lj));
  perform public._r3_chk('R4a same answer', v, '{"ok": true}|{"ok": true}|{"ok": true}');
  perform public._r3_chk('R4b B a member, the others pending',
    public._r3(format('select string_agg(state || '':'' || coalesce(email, ''-''), '','' order by state, email) from public.list_people(%L) where role = ''editor''', lj)),
    'member:-,pending:st-r3-ag@example.invalid,pending:st-r3-nobody@example.invalid');
  perform public._r3_chk('R4e the invitation row', public._r3(format('select auto_joined || ''/'' || (accepted_at is not null) from public.invites where list_id = %L and email_lower = %L', lj, be)), 'true/true');
  perform public._r3_as(b);
  perform public._r3_chk('R4c B is in, nothing to accept', public._r3(format('select count(*)::text from public.items where list_id = %L', lj))
                                                        || '/' || public._r3('select count(*)::text from public.my_invitations()'), '1/0');
  perform public._r3_chk('R4d the notice', public._r3('select inviter_name || ''/'' || target_name || ''/'' || role || ''/'' || (seen_at is null) from public.shared_notices'),
                         'Guest A/Joined/editor/true');
  perform public._r3_as(a);
  perform public._r3_chk('R4f notices are own rows only', public._r3('select count(*)::text from public.shared_notices'), '0');

  -- R5 leave from the notice; a re-share needs Accept
  perform public._r3_as(b);
  select id into nid from public.shared_notices where list_id = lj;
  perform public._r3_chk('R5a leave', public._r3(format('select public.answer_shared_notice(%L, ''leave'') ->> ''ok''', nid))
                                     || '/' || public._r3(format('select count(*)::text from public.items where list_id = %L', lj)), 'true/0');
  perform public._r3_as(a);
  perform public.share_list(lj, be, 'viewer', true);
  perform public._r3_as(b);
  perform public._r3_chk('R5b re-share is an invitation', public._r3(format('select count(*)::text from public.items where list_id = %L', lj))
                                                       || '/' || public._r3('select count(*)::text from public.my_invitations()'), '0/1');
  perform public._r3_as(a);
  perform public.share_list(lj, 'st-r3-b2@example.invalid', 'viewer', true);
  perform public._r3_as(b);
  perform public._r3_chk('R5c not through a second address', public._r3(format('select count(*)::text from public.items where list_id = %L', lj)), '0');

  -- R6 a block wins (G2): no join, the same answer, the owner sees "pending", C sees nothing
  perform public._r3_as(c);
  perform public._r3(format('insert into public.invite_blocks (profile_id, blocked_id) values (%L, %L)', c, a));
  perform public._r3_as(a);
  lk := public.create_list('Blocked');
  perform public._r3_chk('R6a same answer', public._r3(format('select public.share_list(%L, %L, ''viewer'', true)::text', lk, ce)), '{"ok": true}');
  perform public._r3_chk('R6b pending', public._r3(format('select string_agg(state, '','') from public.list_people(%L) where email = %L', lk, ce)), 'pending');
  perform public._r3_as(c);
  perform public._r3_chk('R6c C not in', public._r3(format('select count(*)::text from public.lists where id = %L', lk))
                                        || '/' || public._r3('select count(*)::text from public.my_invitations()')
                                        || '/' || public._r3('select count(*)::text from public.shared_notices'), '0/0/0');

  -- R7 tag-list roles (G4, G5); a tag made after the share is readable (adjustment 4)
  perform public._r3_as(a);
  work := (public.create_tag_list('Work') ->> 'id')::uuid;
  insert into public.tags (tag_list_id, name) values (work, 'urgent') returning id into tu;
  ls := public.create_list('Shared S');
  insert into public.items (list_id, category, title) values (ls, 'task', 's1') returning id into s1;
  perform public.share_list(ls, be, 'editor', true);
  perform public.share_tag_list(work, be, 'viewer', true);
  insert into public.tags (tag_list_id, name) values (work, 'late') returning id into tl;
  perform public._r3_as(b);
  perform public._r3_chk('R7a a tag made after the share', public._r3('select count(*)::text from public.tags where name = ''late'' and updated_at is not null'), '1');
  perform public._r3_chk('R7b viewer uses tags', public._r3(format('insert into public.item_tags (item_id, tag_id) values (%L, %L)', s1, tu)), 'ok:1');
  perform public._r3_chk('R7c viewer adds no tag', public._r3(format('insert into public.tags (tag_list_id, name) values (%L, ''b-new'')', work)), 'ERR 42501%');
  perform public._r3_chk('R7d viewer shares not', public._r3(format('select public.share_tag_list(%L, %L, ''viewer'', true)::text', work, ce)), 'ERR 42501%');
  perform public._r3_as(a);
  perform public._r3(format('update public.tag_list_members set role = ''contributor'' where tag_list_id = %L and profile_id = %L', work, b));
  perform public._r3_as(b);
  v := public._r3(format('insert into public.tags (tag_list_id, name) values (%L, ''b-made'')', work))
    || '/' || public._r3(format('update public.tags set name = ''b-made-2'', sort = 5 where tag_list_id = %L and name = ''b-made''', work))
    || '/' || public._r3(format('update public.tags set deleted_at = now() where id = %L', tl))
    || '/' || public._r3(format('update public.tag_lists set name = ''Work 2'' where id = %L', work))
    || '/' || public._r3(format('select public.share_tag_list(%L, %L, ''viewer'', true)::text', work, ce));
  perform public._r3_chk('R7e contributor', v, 'ok:1/ok:1/ERR 42501%/ok:0/ERR 42501%');
  perform public._r3_as(a);
  perform public._r3(format('update public.tag_list_members set role = ''editor'' where tag_list_id = %L and profile_id = %L', work, b));
  perform public.share_tag_list(work, he, 'viewer', true);
  perform public._r3_as(b);
  v := public._r3(format('update public.tags set deleted_at = now() where id = %L', tl))
    || '/' || public._r3(format('update public.tag_lists set name = ''Work 2'' where id = %L', work))
    || '/' || public._r3(format('select public.share_tag_list(%L, ''st-r3-friend@example.invalid'', ''editor'', false)::text', work))
    || '/' || public._r3(format('select public.share_tag_list(%L, ''st-r3-friend2@example.invalid'', ''owner'', false)::text', work))
    || '/' || public._r3(format('delete from public.tag_list_members where tag_list_id = %L and profile_id = %L', work, h1))
    || '/' || public._r3(format('update public.tag_list_members set role = ''editor'' where tag_list_id = %L and profile_id = %L', work, h1));
  perform public._r3_chk('R7f editor', v, 'ok:1/ok:1/{"ok": true}/ERR 22023%/ok:0/ok:0');
  perform public._r3_chk('R7i editor share, the owner blocked', public._r3(format('select public.share_tag_list(%L, %L, ''viewer'', true)::text', work, ce)), '{"ok": true}');
  perform public._r3_as(c);
  perform public._r3_chk('R7j no join', public._r3(format('select count(*)::text from public.tag_lists where id = %L', work)), '0');
  perform public._r3_as(b);
  select id into inv from public.invites where tag_list_id = work and email_lower = 'st-r3-friend@example.invalid';
  perform public._r3_chk('R7g editor revokes own pending', public._r3(format('select public.revoke_invite(%L) ->> ''ok''', inv)), 'true');
  perform public._r3_as(a);
  perform public.share_tag_list(work, 'st-r3-friend3@example.invalid', 'viewer', false);
  select id into inv from public.invites where tag_list_id = work and email_lower = 'st-r3-friend3@example.invalid';
  perform public._r3_as(b);
  perform public._r3_chk('R7h editor revokes not the owner''s', public._r3(format('select public.revoke_invite(%L)::text', inv)), 'ERR 42501%');

  -- G49 G50 G51 G52 G53
  perform public._r3_as(a);
  perform public._r3_chk('G49 no direct insert', public._r3(format('insert into public.tag_lists (owner_id, name) values (%L, ''x'')', a)), 'ERR 42501%');
  perform public._r3_chk('G50 live name taken', public._r3('select public.create_tag_list(''WORK 2'')::text'), 'ERR 23505%');
  perform public._r3_as(null);
  insert into public.tag_list_members (tag_list_id, profile_id, role) values (adef, ag, 'editor');
  perform public._r3_as(a);
  perform public.set_default_tag_list(work);
  perform public._r3_as(null);
  perform public._r3_chk('G51b agents follow the default', (select role from public.tag_list_members where tag_list_id = work and profile_id = ag), 'editor');
  perform public._r3_as(a);
  insert into public.items (list_id, category, title, tags) values (am, 'task', 'compat', '{st-r3-compat}') returning id into ic;
  perform public._r3_chk('G51 one default, compatibility tags land there',
    (select count(*) from public.tag_lists where owner_id = a and is_default) || '/'
    || (select min(t.tag_list_id::text) from public.item_tags it join public.tags t on t.id = it.tag_id where it.item_id = ic), '1/' || work);
  perform public._r3_chk('G52 the default is not archived', public._r3(format('select public.set_tag_list_archived(%L, true)::text', work)), 'ERR 22023%');
  perform public._r3_as(b);
  perform public._r3_chk('G53 an editor moves no tag into own list', public._r3(format('select public.move_tags(array[%L]::uuid[], %L)::text', tu, bdef)), 'ERR 42501%');

  -- G54 a move from shared Work to private M: B loses sight of the tag, the item_tags row stays
  perform public._r3_as(a);
  pm := (public.create_tag_list('Private') ->> 'id')::uuid;
  perform public._r3_chk('G54a', public._r3(format('select public.move_tags(array[%L]::uuid[], %L) ->> ''moved''', tu, pm)), '1');
  perform public._r3_as(b);
  perform public._r3_chk('G54b', public._r3(format('select count(*)::text from public.item_tags where item_id = %L and tag_id = %L', s1, tu))
                              || public._r3(format('select count(*)::text from public.tags where id = %L', tu)), '00');
  perform public._r3_as(null);
  perform public._r3_chk('G54c', (select count(*)::text from public.item_tags where item_id = s1 and tag_id = tu and removed_at is null), '1');

  -- G55 merge_tags
  perform public._r3_as(a);
  insert into public.tags (tag_list_id, name) values (pm, 'x') returning id into tx;
  insert into public.tags (tag_list_id, name) values (pm, 'y') returning id into ty;
  insert into public.item_tags (item_id, tag_id) values (s1, tx), (s1, ty);
  perform public.merge_tags(tx, ty);
  perform public._r3_as(null);
  perform public._r3_chk('G55', (select count(*) from public.item_tags where item_id = s1 and tag_id = ty and removed_at is null)
                              || '/' || (select (removed_at is not null)::text from public.item_tags where item_id = s1 and tag_id = tx)
                              || '/' || (select (deleted_at is not null)::text from public.tags where id = tx), '1/true/true');

  -- G56 merge_tag_lists: L2 archived, its tags in M, the clash merged, L2's members not added to M
  perform public._r3_as(a);
  l2t := (public.create_tag_list('L2') ->> 'id')::uuid;
  insert into public.tags (tag_list_id, name) values (l2t, 'dup') returning id into tdup1;
  insert into public.tags (tag_list_id, name) values (l2t, 'solo');
  insert into public.tags (tag_list_id, name) values (pm, 'dup') returning id into tdup2;
  insert into public.item_tags (item_id, tag_id) values (s1, tdup1);
  perform public.share_tag_list(l2t, he, 'viewer', true);
  j := public.merge_tag_lists(l2t, pm);
  perform public._r3_as(null);
  perform public._r3_chk('G56', (j->>'moved') || '/' || (j->>'merged') || '/' || (j->>'members_lost')
                              || '/' || (select (archived_at is not null)::text from public.tag_lists where id = l2t)
                              || '/' || (select count(*) from public.tag_list_members where tag_list_id = pm and profile_id = h1)
                              || '/' || (select count(*) from public.item_tags where item_id = s1 and tag_id = tdup2 and removed_at is null),
                         '1/1/1/true/0/1');

  -- G57 an archived tag list is read-only, also for its editor; restore checks the live name
  perform public._r3_as(a);
  arch := (public.create_tag_list('Arch') ->> 'id')::uuid;
  insert into public.tags (tag_list_id, name) values (arch, 'old') returning id into told;
  perform public.share_tag_list(arch, be, 'editor', true);
  perform public.set_tag_list_archived(arch, true);
  perform public._r3_as(b);
  v := public._r3(format('insert into public.item_tags (item_id, tag_id) values (%L, %L)', s1, told))
    || '/' || public._r3(format('update public.tags set name = ''old2'' where id = %L', told))
    || '/' || public._r3(format('update public.tag_lists set name = ''Arch2'' where id = %L', arch))
    || '/' || public._r3(format('insert into public.tags (tag_list_id, name) values (%L, ''new'')', arch));
  perform public._r3_chk('G57', v, 'ERR 42501%/ERR 42501%/ERR 42501%/ERR 42501%');
  perform public._r3_as(a);
  arch2 := (public.create_tag_list('arch') ->> 'id')::uuid;
  perform public._r3_chk('G57b restore over a live name', public._r3(format('select public.set_tag_list_archived(%L, false)::text', arch)), 'ERR 23505%');

  -- G48 the cap counts live tag lists only
  perform public._r3_as(null);
  update ops.settings set value = (select count(*) from public.tag_lists where owner_id = a and archived_at is null) where key = 'guest_tag_lists';
  perform public._r3_as(a);
  v := public._r3('select public.create_tag_list(''over'')::text')
    || '|' || public._r3(format('select public.set_tag_list_archived(%L, true) ->> ''ok''', arch2))
    || '|' || public._r3('select (public.create_tag_list(''over'') ->> ''name'')')
    || '|' || public._r3(format('select public.set_tag_list_archived(%L, false)::text', arch2));
  perform public._r3_as(null);
  update ops.settings set value = 10 where key = 'guest_tag_lists';
  perform public._r3_chk('G48', v, 'ERR 54000%|true|over|ERR 54000%');

  -- G60 H1 reads the item, not the tags of lists H1 is not in
  perform public._r3_as(a);
  perform public.share_list(ls, he, 'viewer', true);
  perform public._r3_as(h1);
  perform public._r3_chk('G60', public._r3(format('select count(*)::text from public.item_tags where item_id = %L and tag_id in (%L, %L, %L)', s1, tu, ty, tdup2))
                              || '/' || public._r3(format('select count(*)::text from public.items where id = %L', s1)), '0/1');

  -- R9 urgency_settings (G12): own; household profiles for household members and agents; nothing else
  perform public._r3_as(null);
  insert into public.preferences (profile_id, prefs) values (h1, '{"settings":{"windowDays":5,"threshold":40,"doLimit":3}}');
  perform public._r3_as(ag);
  perform public._r3_chk('R9a agent reads household', public._r3(format('select (public.urgency_settings(%L) ->> ''windowDays'') || ''/'' || (public.urgency_settings(%L) ->> ''doLimit'')', h1, h1)), '5/3');
  perform public._r3_chk('R9b unknown profile', public._r3(format('select public.urgency_settings(%L)::text', gen_random_uuid())), 'ERR 42501%');
  perform public._r3_as(h1);
  perform public._r3_chk('R9c own', public._r3('select public.urgency_settings() ->> ''threshold'''), '40');
  perform public._r3_chk('R9d household reads no guest', public._r3(format('select public.urgency_settings(%L)::text', a)), 'ERR 42501%');
  perform public._r3_as(a);
  perform public._r3_chk('R9e guest reads no household', public._r3(format('select public.urgency_settings(%L)::text', h1)), 'ERR 42501%');
  perform public._r3_chk('R9f unset is null', public._r3('select coalesce(public.urgency_settings() ->> ''windowDays'', ''null'')'), 'null');

  -- R10 V4-1: a password login made through the API (as GoTrue: not admin SQL) needs its allowlist row's nonce
  perform public._r3_as(null);
  insert into ops.signup_allowlist (email_lower, kind, is_household, nonce) values ('st-r3-pw@example.invalid', 'human', true, 'st-r3-nonce-1');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v := public._r3(format('insert into auth.users (id, email, aud, role, raw_app_meta_data) values (%L, ''st-r3-pw@example.invalid'', ''authenticated'', ''authenticated'', ''{"provider":"email","providers":["email"]}'')', pw))
    || '/' || public._r3(format('insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values (%L, ''st-r3-pw@example.invalid'', ''authenticated'', ''authenticated'', ''{"provider":"email","providers":["email"]}'', ''{"signup_nonce":"wrong"}'')', pw))
    || '/' || public._r3(format('insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values (%L, ''st-r3-pw@example.invalid'', ''authenticated'', ''authenticated'', ''{"provider":"email","providers":["email"]}'', ''{"signup_nonce":"st-r3-nonce-1"}'')', pw))
    || '/' || public._r3(format('insert into auth.users (id, email, aud, role, raw_app_meta_data) values (%L, ''st-r3-stranger@example.invalid'', ''authenticated'', ''authenticated'', ''{"provider":"email","providers":["email"]}'')', px))
    || '/' || public._r3(format('insert into auth.users (id, email, aud, role, raw_app_meta_data) values (%L, ''st-r3-g@example.invalid'', ''authenticated'', ''authenticated'', ''{"provider":"google","providers":["google"]}'')', gx));
  perform public._r3_as(null);
  perform public._r3_chk('R10a nonce', v, 'ERR 42501%/ERR 42501%/ok:1/ERR 42501%/ok:1');
  perform public._r3_chk('R10b the row''s kind', (select is_household::text from public.profiles where id = pw)
    || '/' || (select count(*) from ops.signup_allowlist where nonce = 'st-r3-nonce-1' and used_at is not null)
    || '/' || (select name from public.tag_lists where owner_id = pw and is_default)
    || '/' || (select is_household::text from public.profiles where id = gx), 'true/1/My tags/false');

  -- R11 mine_tag_ids: own row, at most 50
  perform public._r3_as(a);
  perform public._r3_chk('R11', public._r3(format('update public.profiles set mine_tag_ids = array[%L]::uuid[] where id = %L', ty, a))
                              || '/' || public._r3(format('update public.profiles set mine_tag_ids = array_fill(%L::uuid, array[51]) where id = %L', ty, a)),
                         'ok:1/ERR 23514%');

  -- R12 agents create no tag lists
  perform public._r3_as(ag);
  perform public._r3_chk('R12', public._r3('select public.create_tag_list(''agent tags'')::text'), 'ERR 42501%');

  -- R13 the notice's Block: B leaves Work and blocks A; a bad action and someone else's notice are refused
  perform public._r3_as(b);
  select id into nid from public.shared_notices where tag_list_id = work;
  perform public._r3_chk('R13a bad action', public._r3(format('select public.answer_shared_notice(%L, ''x'')::text', nid)), 'ERR 22023%');
  perform public._r3_as(c);
  perform public._r3_chk('R13b not own', public._r3(format('select public.answer_shared_notice(%L, ''seen'')::text', nid)), 'ERR 42501%');
  perform public._r3_as(b);
  perform public._r3_chk('R13c block', public._r3(format('select public.answer_shared_notice(%L, ''block'') ->> ''ok''', nid))
                                    || '/' || public._r3(format('select count(*)::text from public.tag_lists where id = %L', work))
                                    || '/' || public._r3(format('select count(*)::text from public.invite_blocks where blocked_id = %L', a)), 'true/0/1');
  perform public._r3_chk('R13d every first-share join of that sharer left', public._r3(format('select count(*)::text from public.items where id = %L', s1))
                                    || public._r3(format('select count(*)::text from public.tag_lists where id = %L', arch)), '00');

  -- the 012 policy block is in force (a lone re-run of 003 and 011 would bring back the v1 tag policies)
  perform public._r3_as(null);
  perform public._r3_chk('P2 policies',
    (select string_agg(policyname, ',' order by policyname) from pg_policies
      where schemaname = 'public' and ((policyname = 'item_tags_add' and with_check like '%viewer%')
         or (policyname = 'tags_add' and with_check like '%contributor%')
         or (policyname = 'shared_notices_own'))), 'item_tags_add,shared_notices_own,tags_add');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('r3.total')::int - current_setting('r3.nf')::int,
    current_setting('r3.total'), coalesce(nullif(current_setting('r3.f'), ''), 'none');
end $do$;
