-- db/021_drop_priority.sql: priority by position (HomeOS priority-position-plan.md, 2026-10-29). Drops items.priority and its
-- values. Irreversible without a backup restore. Apply only after 020 and once every client runs code without priority: the hosted
-- page (deploy-pages.js --status shows a release with 020), both household machines synced to that pointer, the Telegram bot on a
-- branch that does not select it. An older page would fail to add or save a task (PGRST204, unknown column). Idempotent.
-- After it: 003, 011, the 012 policy block, then 900-906.

-- before the drop: no function, view or policy may still mention the column
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc ~* '\mpriority\M') then
    raise exception '021: a public function still mentions priority; apply 020 first';
  end if;
  if exists (select 1 from pg_views where schemaname = 'public' and definition ~* '\mpriority\M') then
    raise exception '021: a view still mentions priority';
  end if;
end $$;

alter table public.items drop column if exists priority;

-- final check
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'items' and column_name = 'priority') then
    raise exception '021: items.priority is still there';
  end if;
end $$;
