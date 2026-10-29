-- db/906_selftest_task_links.sql: the task links selftest (HomeOS task-links-plan.md task 7) as admin SQL. Rolls everything
-- back and reports "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-905.
-- Cases: L1 links by the owner; L2 a viewer cannot link, a contributor links from its own item only; L3 depends_on loops
-- (2 and 3 steps); L4 parent loops; L5 a second parent: refused by insert, replaced by link_items; L6 no read on one end: no
-- row and a refusal that names nothing; L7 a cross-list link for a reader of both; L8 unlink is soft and moves changed_at, a
-- second unlink answers none, a link comes back; L9 an archived end; L10 blocks refused; L11 a deleted end; L12 rights
-- (definer, search_path, not for anon, the loop helper for nobody); L13 an agent links only inside its lists; L14 a direct
-- relates insert still works; L15 a guest cannot link to household items; L16 a self link and a bad kind; L17 the maker of a
-- link may remove it.
-- Fixtures: H1 and H2 (household), AG (household agent), G (a Google guest), as in 902. Lists: P (H1 private), S (H1's,
-- H2 viewer, AG editor), C (H1's, H2 contributor), X (H1's, archived at the end). Items are written as admin.
-- Run after 018, 003, 011, the 012 policy block and 900-905.

do $do$
declare
  h1 uuid := gen_random_uuid(); h2 uuid := gen_random_uuid(); ag uuid := gen_random_uuid(); g uuid := gen_random_uuid();
  lp uuid; ls uuid; lc uuid; lx uuid; lg uuid;
  p1 uuid; c1 uuid; c2 uuid; c3 uuid; dd uuid; s1 uuid; s2 uuid; k1 uuid; k2 uuid; x1 uuid; x2 uuid; g1 uuid;
  t0 timestamptz;
begin
  execute $f$create function public._ln_as(p uuid) returns void language plpgsql as $b$
    begin reset role;
      if p is null then perform set_config('request.jwt.claims', '', true);
      else perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
           set local role authenticated; end if; end $b$$f$;
  execute $f$create function public._ln(q text) returns text language plpgsql as $b$
    declare n int; v text;
    begin if q ~* '^\s*select' then execute q into v; return coalesce(v, 'null');
          else execute q; get diagnostics n = row_count; return 'ok:' || n; end if;
    exception when others then return 'ERR ' || sqlstate || ' ' || left(sqlerrm, 80); end $b$$f$;
  execute $f$create function public._ln_chk(p_tag text, p_got text, p_pat text) returns void language plpgsql as $b$
    begin perform set_config('ln.total', (coalesce(nullif(current_setting('ln.total', true), ''), '0')::int + 1)::text, true);
      if p_got is null or p_got not like p_pat then
        perform set_config('ln.nf', (coalesce(nullif(current_setting('ln.nf', true), ''), '0')::int + 1)::text, true);
        perform set_config('ln.f', coalesce(current_setting('ln.f', true), '') || p_tag || ' ' || coalesce(p_got, 'null') || '; ', true);
      end if; end $b$$f$;
  -- link_items / unlink_items as the current login
  execute $f$create function public._ln_link(f uuid, t uuid, k text) returns text language sql as $b$
    select public._ln(format('select public.link_items(%L, %L, %L)', f, t, k)) $b$$f$;
  execute $f$create function public._ln_unlink(f uuid, t uuid, k text) returns text language sql as $b$
    select public._ln(format('select public.unlink_items(%L, %L, %L)', f, t, k)) $b$$f$;
  execute 'grant execute on function public._ln_as(uuid), public._ln(text), public._ln_chk(text, text, text), public._ln_link(uuid, uuid, text), public._ln_unlink(uuid, uuid, text) to authenticated';
  perform set_config('ln.total', '0', true); perform set_config('ln.nf', '0', true); perform set_config('ln.f', '', true);

  -- ---------- fixtures (admin) ----------
  insert into ops.signup_allowlist (email_lower, kind, is_household) values
    ('st-ln-h1@example.invalid', 'human', true), ('st-ln-h2@example.invalid', 'human', true), ('st-ln-ag@example.invalid', 'agent', true);
  insert into auth.users (id, email, aud, role, raw_app_meta_data) values
    (h1, 'st-ln-h1@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (h2, 'st-ln-h2@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}'),
    (ag, 'st-ln-ag@example.invalid', 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), h1, h1::text, 'email', json_build_object('sub', h1, 'email', 'st-ln-h1@example.invalid')),
    (gen_random_uuid(), h2, h2::text, 'email', json_build_object('sub', h2, 'email', 'st-ln-h2@example.invalid')),
    (gen_random_uuid(), ag, ag::text, 'email', json_build_object('sub', ag, 'email', 'st-ln-ag@example.invalid'));
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    (g, 'st-ln-g@example.invalid', 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{"full_name":"Guest LN"}');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), g, 'st-ln-sub-g', 'google', json_build_object('sub', 'st-ln-sub-g', 'email', 'st-ln-g@example.invalid', 'email_verified', true));

  perform public._ln_as(h1);
  lp := public.create_list('LN private');
  ls := public.create_list('LN shared');
  lc := public.create_list('LN contrib');
  lx := public.create_list('LN archived');
  perform public._ln_as(g);
  lg := public.create_list('LN guest');
  perform public._ln_as(null);
  insert into public.list_members (list_id, profile_id, role) values (ls, h2, 'viewer'), (ls, ag, 'editor'), (lc, h2, 'contributor');

  insert into public.items (list_id, category, title, created_by) values (lp, 'task', 'ln-p1', h1) returning id into p1;
  insert into public.items (list_id, category, title, created_by) values (lp, 'task', 'ln-c1', h1) returning id into c1;
  insert into public.items (list_id, category, title, created_by) values (lp, 'task', 'ln-c2', h1) returning id into c2;
  insert into public.items (list_id, category, title, created_by) values (lp, 'task', 'ln-c3', h1) returning id into c3;
  insert into public.items (list_id, category, title, created_by) values (lp, 'task', 'ln-dd', h1) returning id into dd;
  insert into public.items (list_id, category, title, created_by) values (ls, 'task', 'ln-s1', h1) returning id into s1;
  insert into public.items (list_id, category, title, created_by) values (ls, 'task', 'ln-s2', h1) returning id into s2;
  insert into public.items (list_id, category, title, created_by) values (lc, 'task', 'ln-k1', h2) returning id into k1;
  insert into public.items (list_id, category, title, created_by) values (lc, 'task', 'ln-k2', h1) returning id into k2;
  insert into public.items (list_id, category, title, created_by) values (lx, 'task', 'ln-x1', h1) returning id into x1;
  insert into public.items (list_id, category, title, created_by) values (lx, 'task', 'ln-x2', h1) returning id into x2;
  insert into public.items (list_id, category, title, created_by) values (lg, 'task', 'ln-g1', g) returning id into g1;
  update public.items set deleted_at = now() where id = dd;
  update public.lists set archived_at = now() where id = lx;

  -- ---------- L1 the owner links a parent tree ----------
  perform public._ln_as(h1);
  perform public._ln_chk('L1a', public._ln_link(c1, p1, 'parent'), 'ok');
  perform public._ln_chk('L1b', public._ln_link(c2, p1, 'parent') || '/' || public._ln_link(c3, c2, 'parent'), 'ok/ok');
  perform public._ln_chk('L1c', public._ln(format('select count(*)::text from public.item_links where to_item = %L and kind = ''parent'' and removed_at is null', p1)), '2');
  perform public._ln_chk('L1d', public._ln_link(c1, p1, 'parent'), 'ok');

  -- ---------- L4 parent loops ----------
  perform public._ln_chk('L4a', public._ln_link(p1, c1, 'parent'), 'ERR 22023 %loop%');
  perform public._ln_chk('L4b', public._ln_link(p1, c3, 'parent'), 'ERR 22023 %loop%');

  -- ---------- L3 depends_on loops ----------
  perform public._ln_chk('L3a', public._ln_link(c2, c1, 'depends_on') || '/' || public._ln_link(c3, c2, 'depends_on'), 'ok/ok');
  perform public._ln_chk('L3b', public._ln_link(c1, c2, 'depends_on'), 'ERR 22023 %loop%');
  perform public._ln_chk('L3c', public._ln_link(c1, c3, 'depends_on'), 'ERR 22023 %loop%');

  -- ---------- L5 a second parent ----------
  perform public._ln_chk('L5a', public._ln(format('insert into public.item_links (from_item, to_item, kind) values (%L, %L, ''parent'')', c1, c2)), 'ERR 22023 %parent%');
  perform public._ln_chk('L5b', public._ln_link(c1, s1, 'parent'), 'ok');
  perform public._ln_chk('L5c', public._ln(format('select string_agg(to_item::text, '','') from public.item_links where from_item = %L and kind = ''parent'' and removed_at is null', c1)), s1::text);
  perform public._ln_chk('L5d', public._ln(format('select count(*)::text from public.item_links where from_item = %L and to_item = %L and kind = ''parent'' and removed_at is not null', c1, p1)), '1');

  -- ---------- L10 blocks, L16 self link and bad kind, L14 relates ----------
  perform public._ln_chk('L10', public._ln(format('insert into public.item_links (from_item, to_item, kind) values (%L, %L, ''blocks'')', c1, p1)), 'ERR 22023 %depends_on%');
  perform public._ln_chk('L16a', public._ln_link(c1, c1, 'depends_on'), 'ERR 22023 %itself%');
  perform public._ln_chk('L16b', public._ln_link(c1, p1, 'relates'), 'ERR 22023 %kind%');
  perform public._ln_chk('L14', public._ln(format('insert into public.item_links (from_item, to_item, kind) values (%L, %L, ''relates'')', c1, p1)), 'ok:1');

  -- ---------- L11 a deleted end, L9 an archived end ----------
  perform public._ln_chk('L11', public._ln_link(c1, dd, 'depends_on'), 'ERR 22023 %deleted%');
  perform public._ln_chk('L9a', public._ln_link(x1, x2, 'depends_on'), 'ERR 42501 %archived%');
  perform public._ln_chk('L9b', public._ln_link(c2, x1, 'depends_on'), 'ERR 42501 %archived%');

  -- a cross-list link H1 can make: S1 after C1 (H2 cannot read C1)
  perform public._ln_chk('L7a', public._ln_link(s1, c1, 'depends_on'), 'ok');

  -- ---------- L8 unlink ----------
  t0 := (select changed_at from public.item_links where from_item = c3 and to_item = c2 and kind = 'depends_on');
  perform pg_sleep(0.01);
  perform public._ln_chk('L8a', public._ln_unlink(c3, c2, 'depends_on'), 'ok');
  perform public._ln_chk('L8b', public._ln(format('select (removed_at is not null and changed_at > %L)::text from public.item_links where from_item = %L and to_item = %L and kind = ''depends_on''', t0, c3, c2)), 'true');
  perform public._ln_chk('L8c', public._ln_unlink(c3, c2, 'depends_on'), 'none');
  perform public._ln_chk('L8d', public._ln_link(c3, c2, 'depends_on') || '/' || public._ln(format('select (removed_at is null)::text from public.item_links where from_item = %L and to_item = %L and kind = ''depends_on''', c3, c2)), 'ok/true');

  -- ---------- L2 viewer and contributor ----------
  perform public._ln_as(h2);
  perform public._ln_chk('L2a', public._ln_link(s2, s1, 'depends_on'), 'ERR 42501 not allowed%');
  perform public._ln_chk('L2b', public._ln_link(k1, s1, 'depends_on'), 'ok');
  perform public._ln_chk('L2c', public._ln_link(k2, s2, 'depends_on'), 'ERR 42501 not allowed%');
  perform public._ln_chk('L2d', public._ln(format('select count(*)::text from public.item_links where from_item = %L', s2)), '0');

  -- ---------- L6 no read on one end ----------
  perform public._ln_chk('L6a', public._ln_link(k1, p1, 'parent'), 'ERR 42501 not allowed');
  perform public._ln_chk('L6b', public._ln(format('select count(*)::text from public.item_links where from_item = %L or from_item = %L', s1, c1)), '0');
  perform public._ln_chk('L6c', public._ln(format('select count(*)::text from public.item_links where to_item = %L', c1)), '0');
  perform public._ln_chk('L6d', public._ln_unlink(s1, c1, 'depends_on'), 'ERR 42501 not allowed');

  -- ---------- L7 a cross-list link for a reader of both, L17 its maker removes it ----------
  perform public._ln_chk('L7b', public._ln(format('select count(*)::text from public.item_links where from_item = %L and to_item = %L and removed_at is null', k1, s1)), '1');
  perform public._ln_as(h1);
  perform public._ln_chk('L7c', public._ln(format('select count(*)::text from public.item_links where to_item = %L and removed_at is null', s1)), '2');
  perform public._ln_as(h2);
  perform public._ln_chk('L17', public._ln_unlink(k1, s1, 'depends_on'), 'ok');

  -- ---------- L13 the agent ----------
  perform public._ln_as(ag);
  perform public._ln_chk('L13a', public._ln_link(s2, s1, 'depends_on'), 'ok');
  perform public._ln_chk('L13b', public._ln_link(s2, p1, 'parent'), 'ERR 42501 not allowed');

  -- ---------- L15 the guest ----------
  perform public._ln_as(g);
  perform public._ln_chk('L15a', public._ln_link(g1, p1, 'depends_on') || '/' || public._ln_link(g1, s1, 'parent'), 'ERR 42501 not allowed/ERR 42501 not allowed');
  perform public._ln_chk('L15b', public._ln(format('select count(*)::text from public.item_links where from_item = %L or to_item = %L', g1, g1)), '0');

  -- ---------- L12 rights ----------
  perform public._ln_as(null);
  perform public._ln_chk('L12a', (select string_agg(p.proname || ':' || p.prosecdef || ':' || (coalesce(p.proconfig, '{}') @> array['search_path=""']), ',' order by p.proname)
                                    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                   where n.nspname = 'public' and p.proname in ('link_items', 'unlink_items', 'link_would_loop', 'item_links_guard')),
                         'item_links_guard:true:true,link_items:true:true,link_would_loop:true:true,unlink_items:true:true');
  perform public._ln_chk('L12b', has_function_privilege('anon', 'public.link_items(uuid, uuid, text)', 'execute')::text || '/'
                              || has_function_privilege('anon', 'public.unlink_items(uuid, uuid, text)', 'execute')::text || '/'
                              || has_function_privilege('authenticated', 'public.link_would_loop(uuid, uuid, text)', 'execute')::text || '/'
                              || has_function_privilege('authenticated', 'public.link_items(uuid, uuid, text)', 'execute')::text, 'false/false/false/true');

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %',
    current_setting('ln.total')::int - current_setting('ln.nf')::int,
    current_setting('ln.total'), coalesce(nullif(current_setting('ln.f'), ''), 'none');
end $do$;
