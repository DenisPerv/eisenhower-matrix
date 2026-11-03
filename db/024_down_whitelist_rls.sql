-- db/024_down_whitelist_rls.sql: rollback of db/024_whitelist_rls.sql. Drops exactly what 024 adds (30 restrictive
-- policies wl_<table>_insert / _update / _delete, 10 triggers whitelist_write_guard, the functions whitelist_base,
-- is_whitelisted_login and whitelist_write_guard); every older policy, trigger and function stays as it is. Re-runnable
-- and a no-op when 024 is not applied, so a set-up that runs db/ in file order (this file sorts before 024) is safe.
-- Apply only to undo 024 (for example when a selftest fails after it), then re-run the selftests.

do $wl_down$
declare
  t text;
begin
  foreach t in array array['lists', 'items', 'tags', 'tag_lists', 'list_members', 'tag_list_members',
                           'item_links', 'item_refs', 'item_tags', 'invites'] loop
    execute format('drop trigger if exists whitelist_write_guard on public.%I', t);
    execute format('drop policy if exists %I on public.%I', 'wl_' || t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', 'wl_' || t || '_update', t);
    execute format('drop policy if exists %I on public.%I', 'wl_' || t || '_delete', t);
  end loop;
end $wl_down$;

drop function if exists public.whitelist_write_guard();
drop function if exists public.is_whitelisted_login(uuid);
drop function if exists public.whitelist_base(uuid);

do $chk$
begin
  if exists (select 1 from pg_policies where schemaname = 'public' and policyname like 'wl\_%')
     or exists (select 1 from pg_trigger where not tgisinternal and tgname = 'whitelist_write_guard')
     or exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                 where s.nspname = 'public' and p.proname in ('whitelist_base', 'is_whitelisted_login', 'whitelist_write_guard')) then
    raise exception '024 down check failed: a wl_ policy, a whitelist_write_guard trigger or a 024 function is still there';
  end if;
end $chk$;
