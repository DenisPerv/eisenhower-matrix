-- db/901_selftest_multiuser.sql: the multi-user selftest (HomeOS multi-user-review.md §10, G1-G22 and G25-G46) as admin
-- SQL. Rolls everything back and reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text,
-- like 900. G23, G24 (authcheck, a person) and G47 (tasksdb.js, live) are not here; G30 is 900 itself.
-- Fixtures: H1, H2 (household people) and AG (agent) are created through one-shot allowlist rows and A, B, C as Google
-- users with identities, so the sign-up trigger and the identity guards run. Limits are lowered inside the transaction
-- (ops.settings) instead of writing a thousand rows. Run after 003, 011 and 900.

do $do$
declare
  h1 uuid := gen_random_uuid(); h2 uuid := gen_random_uuid(); ag uuid := gen_random_uuid(); pw uuid := gen_random_uuid();
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  ae text := 'st-mu-a@example.invalid'; be text := 'st-mu-b@example.invalid'; ce text := 'st-mu-c@example.invalid';
  hl uuid; hi uuid; am uuid; al uuid; bg uuid; ia1 uuid; ia2 uuid; ip uuid; ib uuid;
  adef uuid; bdef uuid; h1def uuid; tu uuid; tb uuid; inv uuid; v text; w text; n int; i int;
begin
  execute $f$create function public._mt_as(p uuid, p_email text default null) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true);
      else perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated', 'email', p_email)::text, true);
           set local role authenticated; end if; end $b$$f$;
  execute $f$create function public._mt(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  -- one check: counts it, records a failure as "<tag> <got>"
  execute $f$create function public._mt_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('mt.total', (coalesce(nullif(current_setting('mt.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('mt.nf', (coalesce(nullif(current_setting('mt.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('mt.f', coalesce(current_setting('mt.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  execute 'grant execute on function public._mt_as(uuid, text), public._mt(text), public._mt_chk(text, text, text) to authenticated';
  perform set_config('mt.total', '0', true); perform set_config('mt.nf', '0', true); perform set_config('mt.f', '', true);

  -- ---------- fixtures (admin) ----------
  insert into ops.signup_allowlist (email_lower, kind, is_household) values
    ('st-mu-h1@example.invalid', 'human', true), ('st-mu-h2@example.invalid', 'human', true),
    ('st-mu-ag@example.invalid', 'agent', true);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1, 'st-mu-h1@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (h2, 'st-mu-h2@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (ag, 'st-mu-ag@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), h1, h1::text, 'email', json_build_object('sub', h1, 'email', 'st-mu-h1@example.invalid')),
    (gen_random_uuid(), h2, h2::text, 'email', json_build_object('sub', h2, 'email', 'st-mu-h2@example.invalid')),
    (gen_random_uuid(), ag, ag::text, 'email', json_build_object('sub', ag, 'email', 'st-mu-ag@example.invalid'));

  -- G1 A arrives as a Google user: a guest profile, "My tasks" and "Default", A sole owner of each
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (a, ae, 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest A"}'),
    (b, be, 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest B"}'),
    (c, ce, 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"name":"Guest\u0007 C"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), a, 'st-mu-sub-a', 'google', json_build_object('sub', 'st-mu-sub-a', 'email', ae, 'email_verified', true)),
    (gen_random_uuid(), b, 'st-mu-sub-b', 'google', json_build_object('sub', 'st-mu-sub-b', 'email', be, 'email_verified', true)),
    (gen_random_uuid(), c, 'st-mu-sub-c', 'google', json_build_object('sub', 'st-mu-sub-c', 'email', ce, 'email_verified', true));
  select l.id into am from public.lists l where l.owner_id = a;
  select t.id into adef from public.tag_lists t where t.owner_id = a and t.is_default;
  select t.id into bdef from public.tag_lists t where t.owner_id = b and t.is_default;
  select t.id into h1def from public.tag_lists t where t.owner_id = h1 and t.is_default;
  v := (select p.kind || '/' || p.is_household || '/' || (p.handle ~ '^u-[0-9a-f]{8}$') || '/' || p.display_name from public.profiles p where p.id = a)
    || '/' || (select count(*) from public.lists where owner_id = a) || ':' || (select name from public.lists where id = am)
    || '/' || (select string_agg(profile_id::text || '=' || role, ',') from public.list_members where list_id = am)
    || '/' || (select count(*) from public.tag_list_members where tag_list_id = adef and profile_id = a and role = 'owner')
    || (select count(*) from public.tag_list_members where tag_list_id = adef);
  perform public._mt_chk('G1', v, 'human/false/true/Guest A/1:My tasks/' || a || '=owner/11');
  perform public._mt_chk('G1b agents and household from the allowlist',
    (select string_agg(kind || ':' || is_household, ',' order by kind) from public.profiles where id in (h1, ag))
    || '/' || (select count(*) from ops.signup_allowlist where email_lower like 'st-mu-%' and used_at is null),
    'agent:true,human:true/0');
  perform public._mt_chk('G1c control characters stripped from the name', (select display_name from public.profiles where id = c), 'Guest C');

  -- household fixture: H1's household list with an item; H1's Default edited by AG (D-i)
  perform public._mt_as(h1);
  hl := public.create_list('st-mu household', 'st-mu-household', true);
  insert into public.items (list_id, category, title, dedup_key) values (hl, 'task', 'household item', 'st-mu:hh') returning id into hi;
  perform public._mt_as(null);
  insert into public.tag_list_members (tag_list_id, profile_id, role) values (h1def, ag, 'editor'), (h1def, h2, 'viewer');
  insert into public.list_members (list_id, profile_id, role) values (hl, ag, 'editor');

  -- G2 A sees only A's own rows
  perform public._mt_as(a);
  v := public._mt('select (select count(*) from public.lists) || ''/'' || (select count(*) from public.list_members) || ''/''
      || (select count(*) from public.items) || ''/'' || (select count(*) from public.profiles) || ''/''
      || (select count(*) from public.categories where audience <> ''all'') || ''/'' || (select count(*) from public.tag_lists) || ''/''
      || (select count(*) from public.tag_list_members) || ''/'' || (select count(*) from public.invites) || ''/''
      || (select count(*) from public.visible_profiles()) || ''/'' || (select count(*) from public.keepalive_status()) || ''/''
      || (select count(*) from public.item_events) || ''/'' || (select count(*) from public.preferences)');
  perform public._mt_chk('G2', v, '1/1/0/1/0/1/1/0/0/0/0/0');
  perform public._mt_chk('G2b categories all', public._mt('select count(*)::text from public.categories'), '_%');
  -- G3 G4 household list
  perform public._mt_chk('G3', public._mt(format('insert into public.items (list_id, category, title) values (%L, ''task'', ''x'')', hl)), 'ERR 42501%');
  perform public._mt_chk('G4a', public._mt(format('update public.items set title = ''x'' where id = %L', hi)), 'ok:0');
  perform public._mt_chk('G4b', public._mt(format('update public.items set deleted_at = now() where id = %L', hi)), 'ok:0');
  -- G5 G6
  perform public._mt_chk('G5', public._mt('select public.create_list(''shared'', null, true)::text'), 'ERR 42501%');
  al := public.create_list('Groceries');
  perform public._mt_as(b);
  bg := public.create_list('Groceries');
  perform public._mt_as(null);
  perform public._mt_chk('G6', (select count(*)::text from public.lists where slug = 'groceries' and id in (al, bg)), '2');
  perform public._mt_as(b);
  -- G7 a household dedup key in B's own list
  perform public._mt_chk('G7', public._mt(format('insert into public.items (list_id, category, title, dedup_key) values (%L, ''task'', ''b'', ''st-mu:hh'')', bg)), 'ok:1');

  -- G8 identical answers for B, an unknown email and the agent's email
  perform public._mt_as(a);
  insert into public.items (list_id, category, title) values (al, 'task', 'milk') returning id into ia1;
  insert into public.items (list_id, category, title) values (al, 'task', 'bread') returning id into ia2;
  insert into public.items (list_id, category, title) values (am, 'task', 'private') returning id into ip;
  v := public._mt(format('select public.share_list(%L, %L, ''editor'')::text', al, be));
  w := public._mt(format('select public.share_list(%L, ''st-mu-nobody@example.invalid'', ''editor'')::text', al));
  perform public._mt_chk('G8', v || '|' || w || '|' || public._mt(format('select public.share_list(%L, ''st-mu-ag@example.invalid'', ''editor'')::text', al)),
                         '{"ok": true}|{"ok": true}|{"ok": true}');
  -- G45 before Accept, A does not see B
  perform public._mt_chk('G45', public._mt(format('select count(*)::text from public.visible_profiles() where id = %L', b)), '0');
  -- G9 B before Accept
  perform public._mt_as(b);
  perform public._mt_chk('G9a', public._mt(format('select count(*)::text from public.items where list_id = %L', al))
                             || public._mt(format('select count(*)::text from public.lists where id = %L', al)), '00');
  perform public._mt_chk('G9b', public._mt('select kind || ''/'' || target_name || ''/'' || inviter_name || ''/'' || role from public.my_invitations()'),
                         'list/Groceries/Guest A/editor');
  -- G31 C cannot see or accept B's invitation
  select id into inv from public.invites where list_id = al and email_lower = be;
  perform public._mt_as(c);
  perform public._mt_chk('G31a', public._mt(format('select count(*)::text from public.invites where id = %L', inv)), '0');
  perform public._mt_chk('G31b', public._mt(format('select public.accept_invite(%L)::text', inv)), 'ERR 42501%');
  -- G40 B with C's address in the JWT email claim still does not see C's invitations
  perform public._mt_as(a);
  perform public.share_list(al, ce, 'viewer');
  perform public._mt_as(b, ce);
  perform public._mt_chk('G40', public._mt('select count(*)::text from public.my_invitations() where role = ''viewer''')
                             || public._mt(format('select count(*)::text from public.invites where email_lower = %L', ce)), '00');
  -- G25 the agent sees nothing of A and cannot accept the invitation sent to its address
  perform public._mt_as(ag);
  perform public._mt_chk('G25a', public._mt(format('select count(*)::text from public.lists where id in (%L, %L)', al, am))
                              || public._mt(format('select count(*)::text from public.items where list_id in (%L, %L)', al, am)), '00');
  select id into inv from public.invites where list_id = al and email_lower = 'st-mu-ag@example.invalid';
  perform public._mt_chk('G25b', public._mt(format('select public.accept_invite(%L)::text', inv)), 'ERR 42501%');
  -- G10 B accepts, reads and edits; still nothing else
  perform public._mt_as(b);
  select id into inv from public.my_invitations() where role = 'editor';
  perform public._mt_chk('G10a', public._mt(format('select (public.accept_invite(%L) ->> ''ok'')', inv)), 'true');
  perform public._mt_chk('G10b', public._mt(format('select count(*)::text from public.items where list_id = %L', al))
                              || '/' || public._mt(format('update public.items set title = ''oat milk'' where id = %L', ia1))
                              || '/' || public._mt(format('select count(*)::text from public.lists where id <> %L and owner_id <> %L', al, b)), '2/ok:1/0');
  -- G11 visible profiles after Accept
  perform public._mt_chk('G11b', public._mt('select string_agg(id::text, '','') from public.visible_profiles()'), a::text);
  perform public._mt_as(a);
  perform public._mt_chk('G11a', public._mt('select string_agg(id::text, '','') from public.visible_profiles()'), b::text);
  -- G21 A does not read B's mine_tags or reminder_channel, even as co-members
  perform public._mt_chk('G21', public._mt(format('select count(*)::text from public.profiles where id = %L', b)), '0');
  -- G20 categories are read only; B's preferences are not visible
  perform public._mt_as(null);
  insert into public.preferences (profile_id, prefs) values (b, '{"theme":"dark"}');
  perform public._mt_as(a);
  perform public._mt_chk('G20a', public._mt('insert into public.categories (slug, name) values (''st-mu'', ''x'')'), 'ERR 42501%');
  perform public._mt_chk('G20b', public._mt('update public.categories set name = ''x'' where slug = ''task'''), 'ERR 42501%');
  perform public._mt_chk('G20c', public._mt(format('select count(*)::text from public.preferences where profile_id = %L', b)), '0');
  -- G19 category audience
  perform public._mt_chk('G19a', public._mt(format('insert into public.items (list_id, category, title) values (%L, ''tbd'', ''q'')', al)), 'ERR 42501%');
  perform public._mt_chk('G19b', public._mt(format('insert into public.items (list_id, category, title) values (%L, ''task'', ''q'')', al)), 'ok:1');
  -- G12 an editor cannot share
  perform public._mt_as(b);
  perform public._mt_chk('G12', public._mt(format('select public.share_list(%L, %L)::text', al, ce)), 'ERR 42501%');
  -- G18 owner_id must be a member
  perform public._mt_chk('G18', public._mt(format('update public.items set owner_id = %L where id = %L', c, ia1)), 'ERR 22023%');

  -- G32 A's tag on a shared item, A's Default not shared: B sees the item, not the tag
  perform public._mt_as(a);
  insert into public.tags (tag_list_id, name) values (adef, 'urgent') returning id into tu;
  insert into public.item_tags (item_id, tag_id) values (ia1, tu);
  perform public._mt_as(b);
  perform public._mt_chk('G32', public._mt(format('select count(*)::text from public.items where id = %L', ia1))
                             || public._mt(format('select count(*)::text from public.item_tags where item_id = %L', ia1))
                             || public._mt('select count(*)::text from public.tags where name = ''urgent'''), '100');
  -- G33 A shares the Default with B as viewer: tags appear, no item is gained
  n := (select count(*) from public.items);
  perform public._mt_as(a);
  perform public.share_tag_list(adef, be, 'viewer');
  perform public._mt_as(b);
  select id into inv from public.my_invitations() where kind = 'tag_list';
  perform public.accept_invite(inv);
  perform public._mt_chk('G33', public._mt(format('select count(*)::text from public.item_tags where item_id = %L', ia1))
                             || '/' || public._mt(format('select (count(*) = %s)::text from public.items', n)), '1/true');
  -- G34 a viewer of the tag list cannot use or add its tags
  perform public._mt_chk('G34a', public._mt(format('insert into public.item_tags (item_id, tag_id) values (%L, %L)', ia2, tu)), 'ERR 42501%');
  perform public._mt_chk('G34b', public._mt(format('insert into public.tags (tag_list_id, name) values (%L, ''b-tag'')', adef)), 'ERR 42501%');
  -- G35 as editor of the tag list: ok on an item B edits, refused on one B cannot edit
  perform public._mt_as(a);
  perform public._mt(format('update public.tag_list_members set role = ''editor'' where tag_list_id = %L and profile_id = %L', adef, b));
  perform public._mt_as(b);
  perform public._mt_chk('G35a', public._mt(format('insert into public.item_tags (item_id, tag_id) values (%L, %L)', ia2, tu)), 'ok:1');
  perform public._mt_chk('G35b', public._mt(format('insert into public.item_tags (item_id, tag_id) values (%L, %L)', ip, tu)), 'ERR 42501%');
  -- G36 B's own tag on A's shared item: A does not see it
  insert into public.tags (tag_list_id, name) values (bdef, 'b-only') returning id into tb;
  perform public._mt_chk('G36a', public._mt(format('insert into public.item_tags (item_id, tag_id) values (%L, %L)', ia1, tb)), 'ok:1');
  perform public._mt_as(a);
  perform public._mt_chk('G36b', public._mt(format('select count(*)::text from public.item_tags where tag_id = %L', tb))
                              || public._mt('select count(*)::text from public.tags where name = ''b-only'''), '00');
  -- G46 B removes a tag; A's poll sees the row with removed_at
  perform public._mt_as(b);
  perform public._mt_chk('G46a', public._mt(format('update public.item_tags set removed_at = now() where item_id = %L and tag_id = %L', ia2, tu)), 'ok:1');
  perform public._mt_as(a);
  perform public._mt_chk('G46b', public._mt(format('select count(*)::text from public.item_tags where changed_at >= now() - interval ''120 seconds'' and item_id = %L and removed_at is not null', ia2)), '1');
  -- G37 the compatibility input: items.tags filed into A's Default, the column cleared
  insert into public.items (list_id, category, title, tags) values (am, 'task', 'shop', '{groceries}') returning id into ib;
  perform public._mt_chk('G37', public._mt(format('select string_agg(t.name, '','') || ''/'' || min(t.tag_list_id::text) from public.item_tags it join public.tags t on t.id = it.tag_id where it.item_id = %L', ib))
                             || '/' || public._mt(format('select cardinality(tags)::text from public.items where id = %L', ib)), 'groceries/' || adef || '/0');

  -- G17 a link from a shared item to a private one: B does not see it
  insert into public.item_links (from_item, to_item, kind) values (ia1, ip, 'relates');
  insert into public.item_refs (item_id, kind, target) values (ia2, 'url', 'https://example.invalid/st-mu');
  insert into public.item_links (from_item, to_item, kind) values (ia2, ia1, 'relates');
  perform public._mt_as(b);
  perform public._mt_chk('G17', public._mt(format('select count(*)::text from public.item_links where from_item = %L', ia1)), '0');
  -- G16 A moves an item out of the shared list: B loses the item, its links, refs, events and tags
  perform public._mt_as(a);
  perform public._mt(format('update public.item_tags set removed_at = null where item_id = %L and tag_id = %L', ia2, tu));
  perform public._mt_chk('G16a', public._mt(format('update public.items set list_id = %L where id = %L', am, ia2)), 'ok:1');
  perform public._mt_as(b);
  perform public._mt_chk('G16b', public._mt(format('select (select count(*) from public.items where id = %1$L) || ''/'' || (select count(*) from public.item_links where from_item = %1$L or to_item = %1$L) || ''/'' || (select count(*) from public.item_refs where item_id = %1$L) || ''/'' || (select count(*) from public.item_events where item_id = %1$L) || ''/'' || (select count(*) from public.item_tags where item_id = %1$L)', ia2)), '0/0/0/0/0');

  -- G13 viewer, then contributor
  perform public._mt_as(a);
  perform public._mt(format('update public.list_members set role = ''viewer'' where list_id = %L and profile_id = %L', al, b));
  perform public._mt_as(b);
  perform public._mt_chk('G13a', public._mt(format('update public.items set title = ''v'' where id = %L', ia1)), 'ok:0');
  perform public._mt_as(a);
  perform public._mt(format('update public.list_members set role = ''contributor'' where list_id = %L and profile_id = %L', al, b));
  perform public._mt_chk('G13d owner not grantable', public._mt(format('update public.list_members set role = ''owner'' where list_id = %L and profile_id = %L', al, b)), 'ERR 42501%');
  perform public._mt_as(b);
  perform public._mt_chk('G13b', public._mt(format('update public.items set title = ''c'' where id = %L', ia1)), 'ok:0');
  perform public._mt_chk('G13c', public._mt(format('insert into public.items (list_id, category, title) values (%L, ''task'', ''own'')', al))
                              || '/' || public._mt(format('update public.items set title = ''own 2'' where list_id = %L and created_by = %L', al, b)), 'ok:1/ok:1');
  -- G28 B hides A's list for B only
  perform public.set_list_hidden(al, true);
  perform public._mt_as(null);
  perform public._mt_chk('G28', (select string_agg((hidden_at is not null)::text, ',' order by role) from public.list_members where list_id = al), 'true,false');
  -- G14 B leaves; then sees nothing; A's item owned by B is cleared
  perform public._mt_as(a);
  perform public._mt(format('update public.list_members set role = ''editor'' where list_id = %L and profile_id = %L', al, b));
  perform public._mt(format('update public.items set owner_id = %L where id = %L', b, ia1));
  perform public._mt_as(b);
  perform public._mt_chk('G14', public._mt(format('select (public.leave_list(%L) ->> ''ok'')', al))
                             || '/' || public._mt(format('select count(*)::text from public.items where list_id = %L', al)), 'true/0');
  perform public._mt_as(null);
  perform public._mt_chk('G14b owner cleared', (select coalesce(owner_id::text, 'null') from public.items where id = ia1), 'null');
  -- G15 A removes B; B's update affects nothing
  perform public._mt_as(a);
  perform public.share_list(al, be, 'editor');
  perform public._mt_as(b);
  select id into inv from public.my_invitations() where kind = 'list';
  perform public.accept_invite(inv);
  perform public._mt_as(a);
  perform public._mt_chk('G15a', public._mt(format('delete from public.list_members where list_id = %L and profile_id = %L', al, b)), 'ok:1');
  perform public._mt_as(b);
  perform public._mt_chk('G15b', public._mt(format('update public.items set title = ''gone'' where id = %L', ia1)), 'ok:0');
  -- G43 B declines and blocks A; A's new share gets the same answer, B sees nothing, A sees "pending"
  perform public._mt_as(a);
  perform public.share_list(al, be, 'viewer');
  perform public._mt_as(b);
  select id into inv from public.my_invitations() where kind = 'list';
  perform public.decline_invite(inv, true);
  perform public._mt_as(a);
  v := public._mt(format('select public.share_list(%L, %L, ''editor'')::text', al, be));
  perform public._mt_chk('G43a', v || '|' || public._mt(format('select state from public.list_people(%L) where email = %L', al, be)), '{"ok": true}|pending');
  perform public._mt_as(b);
  perform public._mt_chk('G43b', public._mt('select count(*)::text from public.my_invitations()'), '0');

  -- G26 a household list shared with the household: household editors only, no guest
  perform public._mt_as(null);
  perform public._mt_chk('G26', (select bool_and(p.is_household)::text || '/' || bool_or(m.profile_id = h2 and m.role = 'editor')::text
                                   || '/' || count(*) filter (where m.role = 'editor' and p.handle = 'homeos-agent')
                                   || '/' || count(*) filter (where p.id in (a, b, c))
                                   from public.list_members m join public.profiles p on p.id = m.profile_id where m.list_id = hl), 'true/true/_/0');
  -- G38 the agent files tags on behalf of H1 (into H1's Default); on behalf of a guest it is refused
  perform public._mt_as(ag);
  perform public._mt_chk('G38a', public._mt(format('insert into public.items (list_id, category, title, created_via, on_behalf_of, tags) values (%L, ''task'', ''tagged'', ''skill:st-mu'', %L, ''{st-mu-x}'')', hl, h1)), 'ok:1');
  perform public._mt_as(null);
  perform public._mt_chk('G38b', (select min(t.tag_list_id::text) from public.items i join public.item_tags it on it.item_id = i.id join public.tags t on t.id = it.tag_id where i.title = 'tagged' and i.list_id = hl), h1def::text);
  perform public._mt_as(ag);
  perform public._mt_chk('G38c', public._mt(format('insert into public.items (list_id, category, title, created_via, on_behalf_of, tags) values (%L, ''task'', ''t2'', ''skill:st-mu'', %L, ''{st-mu-y}'')', hl, a)), 'ERR 22023%');
  -- G39 H2 reads the tag names a household item had (admin migration path into the list owner's Default)
  perform public._mt_as(null);
  update public.items set tags = '{st-mu-p,st-mu-q}' where id = hi;
  perform public._mt_as(h2);
  perform public._mt_chk('G39', public._mt(format('select string_agg(t.name, '','' order by t.name) from public.item_tags it join public.tags t on t.id = it.tag_id where it.item_id = %L and it.removed_at is null', hi)), 'st-mu-p,st-mu-q');

  -- G22 the sign-up hook
  perform public._mt_as(null);
  insert into ops.signup_allowlist (email_lower) values ('st-mu-pw@example.invalid');
  insert into ops.signup_allowlist (email_lower, expires_at) values ('st-mu-old@example.invalid', now() - interval '1 minute');
  v := (public.hook_before_user_created('{"user":{"email":"st-mu-friend@example.invalid","app_metadata":{"provider":"email"}}}') ? 'error')::text
    || ',' || (public.hook_before_user_created('{"user":{"email":"st-mu-new@example.invalid","app_metadata":{"provider":"google"}}}') ? 'error')::text
    || ',' || (public.hook_before_user_created('{"user":{"email":"ST-MU-PW@example.invalid","app_metadata":{"provider":"email"}}}') ? 'error')::text;
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (pw, 'st-mu-pw@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  v := v || ',' || (public.hook_before_user_created('{"user":{"email":"st-mu-pw@example.invalid","app_metadata":{"provider":"email"}}}') ? 'error')::text
    || ',' || (public.hook_before_user_created('{"user":{"email":"st-mu-old@example.invalid","app_metadata":{"provider":"email"}}}') ? 'error')::text
    || ',' || (public.hook_before_user_created('{"user":{"email":"st-mu-anon@example.invalid","app_metadata":{"provider":"anonymous"}}}') ? 'error')::text;
  update ops.settings set value = 0 where key = 'max_users';
  v := v || ',' || (public.hook_before_user_created('{"user":{"email":"st-mu-new@example.invalid","app_metadata":{"provider":"google"}}}') ? 'error')::text;
  update ops.settings set value = 200 where key = 'max_users';
  perform public._mt_chk('G22', v, 'true,false,false,true,true,true,true');

  -- G41 identity guards: a Google identity on the agent is refused, on a person allowed
  perform public._mt_chk('G41a', public._mt(format('insert into auth.identities (id, user_id, provider_id, provider, identity_data) values (gen_random_uuid(), %L, ''st-mu-sub-ag'', ''google'', ''{"email":"st-mu-ag@example.invalid","email_verified":true}'')', ag)), 'ERR 42501%');
  perform public._mt_chk('G41b', public._mt(format('insert into auth.identities (id, user_id, provider_id, provider, identity_data) values (gen_random_uuid(), %L, ''st-mu-sub-h1'', ''google'', ''{"email":"st-mu-h1@example.invalid","email_verified":true}'')', h1)), 'ok:1');
  -- G42 an email change from a request (as GoTrue would make it) is refused; admin SQL may
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public._mt_chk('G42', public._mt(format('update auth.users set email = %L where id = %L', ce, a)), 'ERR 42501%');
  perform public._mt_as(null);

  -- G27 limits (lowered for the test): lists, invitations per day, items, body length
  update ops.settings set value = (select count(*) from public.lists where owner_id = a and archived_at is null) where key = 'guest_lists';
  update ops.settings set value = (select count(*) from public.invites where invited_by = a) where key = 'invites_per_day';
  update ops.settings set value = (select count(*) from public.items where created_by = a and deleted_at is null) where key = 'guest_items';
  perform public._mt_as(a);
  v := public._mt('select public.create_list(''one more'')::text') || '|' || public._mt(format('select public.share_list(%L, ''st-mu-x@example.invalid'')::text', al))
    || '|' || public._mt(format('insert into public.items (list_id, category, title) values (%L, ''task'', ''late'')', am));
  perform public._mt_as(null);
  update ops.settings set value = 1000000 where key in ('guest_items', 'guest_lists', 'invites_per_day');
  perform public._mt_as(a);
  v := v || '|' || public._mt(format('insert into public.items (list_id, category, title, body_md) values (%L, ''task'', ''long'', repeat(''x'', 10001))', am));
  perform public._mt_chk('G27', v, 'ERR 54000%|ERR 54000%|ERR 54000%|ERR 54000%');

  -- G29 A archives the shared list: B sees it frozen; sharing it is refused
  perform public._mt_as(a);
  perform public.share_list(al, be, 'editor');
  perform public._mt_as(b);
  perform public._mt(format('delete from public.invite_blocks where blocked_id = %L', a));
  select id into inv from public.my_invitations() where kind = 'list';
  perform public.accept_invite(inv);
  perform public._mt_as(a);
  perform public._mt(format('update public.lists set archived_at = now() where id = %L', al));
  v := public._mt(format('select public.share_list(%L, %L)::text', al, ce));
  perform public._mt_as(b);
  perform public._mt_chk('G29', public._mt(format('select (archived_at is not null)::text from public.lists where id = %L', al))
                             || '/' || public._mt(format('update public.items set title = ''thaw'' where id = %L', ia1)) || '/' || v,
                         'true/ERR 42501%/ERR 22023%');

  -- G44 write rate: the 121st item write of A in a minute is refused (this transaction's writes count)
  perform public._mt_as(null);
  n := (select count(*) from public.item_events where actor_id = a and at > now() - interval '1 minute');
  perform public._mt_as(a);
  v := null; i := 0;
  while i < 200 and v is null loop
    i := i + 1;
    w := public._mt(format('update public.items set body_md = %L where id = %L', 'rate ' || i, ib));
    if w <> 'ok:1' then v := w; end if;
  end loop;
  perform public._mt_chk('G44', (n + i)::text || ' ' || coalesce(v, 'none'), '121 ERR 54000%');

  perform public._mt_as(null);
  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('mt.total')::int - current_setting('mt.nf')::int,
    current_setting('mt.total'), coalesce(nullif(current_setting('mt.f'), ''), 'none');
end $do$;
