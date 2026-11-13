-- db/922_selftest_drop_deploy_target.sql: db/042 (deploy target removed) as admin SQL. Rolls everything back and reports
-- "SELFTEST <n> of <n> passed (rolled back). Failures: none" as the error text, like 900-921.
-- Cases: S schema (columns and table gone, guard without the column); F set_intake (both signatures, grants, anon none).
-- Behaviour of set_intake for people stays covered by 915 (run after 042).

do $do$
declare n int := 0; nf int := 0; f text := ''; got text;
begin
  -- S1-S3 schema
  n := n + 1; select count(*)::text into got from information_schema.columns
    where table_schema = 'public' and table_name in ('lists', 'items') and column_name = 'deploy_target';
  if got <> '0' then nf := nf + 1; f := f || 'S1 columns left ' || got || '; '; end if;
  n := n + 1; if to_regclass('public.deploy_targets') is not null then nf := nf + 1; f := f || 'S2 table left; '; end if;
  n := n + 1; select pg_get_functiondef('public.items_settings_guard()'::regprocedure) into got;
  if got like '%deploy_target%' then nf := nf + 1; f := f || 'S3 guard still names deploy_target; '; end if;

  -- F1-F5 set_intake
  n := n + 1; if to_regprocedure('public.set_intake(text, uuid, boolean, boolean, boolean)') is null then
    nf := nf + 1; f := f || 'F1 5-argument set_intake missing; '; end if;
  n := n + 1; if to_regprocedure('public.set_intake(text, uuid, boolean, text, boolean, boolean)') is null then
    nf := nf + 1; f := f || 'F2 6-argument overload missing; '; end if;
  n := n + 1; if not has_function_privilege('authenticated', 'public.set_intake(text, uuid, boolean, boolean, boolean)', 'execute')
     or not has_function_privilege('authenticated', 'public.set_intake(text, uuid, boolean, text, boolean, boolean)', 'execute') then
    nf := nf + 1; f := f || 'F3 authenticated cannot execute; '; end if;
  n := n + 1; if has_function_privilege('anon', 'public.set_intake(text, uuid, boolean, boolean, boolean)', 'execute')
     or has_function_privilege('anon', 'public.set_intake(text, uuid, boolean, text, boolean, boolean)', 'execute') then
    nf := nf + 1; f := f || 'F4 anon can execute; '; end if;
  n := n + 1; select pg_get_functiondef('public.set_intake(text, uuid, boolean, text, boolean, boolean)'::regprocedure) into got;
  if got not like '%public.set_intake(p_kind, p_id, p_e2e_self, p_notify_telegram, p_stage_report)%' then
    nf := nf + 1; f := f || 'F5 overload does not delegate; '; end if;
  n := n + 1; select count(*)::text into got from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and p.proname = 'set_intake' and not p.prosecdef;
  if got <> '0' then nf := nf + 1; f := f || 'F6 not security definer; '; end if;

  raise exception 'SELFTEST % of % passed (rolled back). Failures: %', n - nf, n, coalesce(nullif(f, ''), 'none');
end $do$;
