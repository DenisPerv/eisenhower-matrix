-- db/024_whitelist_rls.sql: the whitelist enforced in the database (Eisenhower publish plan, task 3c, security finding S1).
-- Before it, any Google account could sign up and write to its own "My tasks" list and "My tags" through the REST API
-- or the security definer RPCs; the whitelist lived only at Cloudflare Access.
--
-- What it adds (nothing existing is replaced or dropped):
--   - public.whitelist_base(uuid): household (people and agents), a used ops.signup_allowlist row of the login's kind,
--     or an approved access request (public.is_whitelisted, db/022). Internal: not callable through the API.
--   - public.is_whitelisted_login(uuid): whitelist_base, or a member of a list or tag list owned by a whitelisted
--     login, or an open invitation from one (so accept_invite works). Granted to authenticated (the policies run as the
--     caller); asked about anyone but the caller through the API it answers false, so it cannot be used to probe ids.
--     (db/022 already has public.is_whitelisted(uuid) for share-by-name, humans only and closed to the API by design,
--     checked by 907; so this function has its own name.)
--   - RESTRICTIVE policies wl_<table>_insert / _update / _delete on lists, items, tags, tag_lists and their link tables
--     (list_members, tag_list_members, item_links, item_refs, item_tags, invites): AND-ed with every existing permissive
--     policy, which stays as it is.
--   - trigger whitelist_write_guard (before insert, update or delete, for each statement) on the same tables: RLS does
--     not apply inside the security definer RPCs (create_list, create_tag_list, share_list, link_items, ...), so the
--     trigger refuses any write made for an API caller (role authenticated or anon) that is not whitelisted (42501
--     "access not approved yet"). Admin SQL, the sign-up trigger (GoTrue) and request_access (which writes as
--     homeos-agent) pass.
-- Reads are unchanged: a login that is not whitelisted already sees nothing but its own empty "My tasks" and "My tags".
-- It can still call my_access_request() and request_access(); every other RPC that writes is refused by the trigger.
--
-- Rollback: db/024_down_whitelist_rls.sql drops exactly what this file adds (its name sorts before this file, so a set-up
-- that runs db/ in file order runs it first as a no-op). Selftest: db/909_selftest_whitelist.sql. Re-runnable.

-- ---------- functions ----------

create or replace function public.whitelist_base(p_uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
     where p.id = p_uid
       and (p.is_household
            or public.is_whitelisted(p.id)
            or exists (select 1 from ops.signup_allowlist a
                        where a.used_at is not null and a.kind = p.kind and a.email_lower = lower(p.email))))
$$;

create or replace function public.is_whitelisted_login(p_uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    p_uid is not null
    and (p_uid = auth.uid() or coalesce(nullif(current_setting('role', true), ''), 'none') not in ('authenticated', 'anon'))
    and (public.whitelist_base(p_uid)
         or exists (select 1 from public.list_members m join public.lists l on l.id = m.list_id
                     where m.profile_id = p_uid and l.owner_id <> p_uid and public.whitelist_base(l.owner_id))
         or exists (select 1 from public.tag_list_members m join public.tag_lists t on t.id = m.tag_list_id
                     where m.profile_id = p_uid and t.owner_id <> p_uid and public.whitelist_base(t.owner_id))
         or exists (select 1 from public.invites i join public.profiles p on p.id = p_uid
                     where i.email_lower = lower(p.email) and i.invited_by <> p_uid
                       and i.accepted_at is null and i.declined_at is null and i.revoked_at is null
                       and (i.expires_at is null or i.expires_at > now())
                       and public.whitelist_base(i.invited_by))),
    false)
$$;

create or replace function public.whitelist_write_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(nullif(current_setting('role', true), ''), 'none') in ('authenticated', 'anon')
     and not public.is_whitelisted_login(auth.uid()) then
    raise exception 'access not approved yet' using errcode = '42501';
  end if;
  return null;
end $$;

revoke all on function public.whitelist_base(uuid), public.is_whitelisted_login(uuid), public.whitelist_write_guard()
  from public, anon, authenticated;
grant execute on function public.is_whitelisted_login(uuid) to authenticated;

-- ---------- restrictive policies and the guard trigger ----------

do $wl$
declare
  t text;
begin
  foreach t in array array['lists', 'items', 'tags', 'tag_lists', 'list_members', 'tag_list_members',
                           'item_links', 'item_refs', 'item_tags', 'invites'] loop
    execute format('drop policy if exists %I on public.%I', 'wl_' || t || '_insert', t);
    execute format('create policy %I on public.%I as restrictive for insert to authenticated '
                   'with check ((select public.is_whitelisted_login(auth.uid())))', 'wl_' || t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', 'wl_' || t || '_update', t);
    execute format('create policy %I on public.%I as restrictive for update to authenticated '
                   'using ((select public.is_whitelisted_login(auth.uid()))) '
                   'with check ((select public.is_whitelisted_login(auth.uid())))', 'wl_' || t || '_update', t);
    execute format('drop policy if exists %I on public.%I', 'wl_' || t || '_delete', t);
    execute format('create policy %I on public.%I as restrictive for delete to authenticated '
                   'using ((select public.is_whitelisted_login(auth.uid())))', 'wl_' || t || '_delete', t);
    execute format('drop trigger if exists whitelist_write_guard on public.%I', t);
    execute format('create trigger whitelist_write_guard before insert or update or delete on public.%I '
                   'for each statement execute function public.whitelist_write_guard()', t);
  end loop;
end $wl$;

-- ---------- check ----------

do $chk$
declare n_pol int; n_trg int; v text;
begin
  select count(*) into n_pol from pg_policies
   where schemaname = 'public' and policyname like 'wl\_%' and permissive = 'RESTRICTIVE' and roles = '{authenticated}';
  select count(*) into n_trg from pg_trigger where not tgisinternal and tgname = 'whitelist_write_guard';
  select string_agg(p.proname || ':' || p.prosecdef || ':' || coalesce(array_to_string(p.proconfig, ','), '')
                    || ':' || has_function_privilege('anon', p.oid, 'execute')
                    || ':' || has_function_privilege('authenticated', p.oid, 'execute'), ',' order by p.proname)
    into v from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname in ('whitelist_base', 'is_whitelisted_login', 'whitelist_write_guard');
  if n_pol <> 30 or n_trg <> 10
     or v is distinct from 'is_whitelisted_login:true:search_path="":false:true,whitelist_base:true:search_path="":false:false,'
                           'whitelist_write_guard:true:search_path="":false:false' then
    raise exception '024 check failed: % policies, % triggers, %', n_pol, n_trg, v;
  end if;
end $chk$;
