-- db/apply-032-check.sql: read-only state check for db/032_telegram_link.sql, run before and after the live apply
-- (procedure: db/apply-032.md). Changes nothing; safe to run any time. Returns one row, one JSON object:
--   before 032: tg_login, agent_login and maksym true, autonomy_live true (032_autonomy.sql, live since 2026-11-11),
--               the rest false, 0 or null
--   after 032 : ops_tables true, rpcs 6, anon_closed true, internal_closed true, triggers 2, settings 2, global_editors
--               "anastasiia=editor,homeos-agent=editor,maksym=owner,telegram-bot=editor" (more editors are fine),
--               bucket_private true, bucket_policies 3, items_realtime true, realtime_marker 1 (or null when items was
--               already in the publication before 032)
select json_build_object(
  'tg_login',        exists (select 1 from public.profiles where handle = 'telegram-bot' and kind = 'agent'),
  'agent_login',     exists (select 1 from public.profiles where handle = 'homeos-agent' and kind = 'agent'),
  'maksym',          exists (select 1 from public.profiles where handle = 'maksym'),
  'autonomy_live',   to_regtype('public.autonomy_mode') is not null,
  'ops_tables',      to_regclass('ops.telegram_links') is not null and to_regclass('ops.telegram_claims') is not null
                     and to_regclass('ops.telegram_link_tokens') is not null,
  'rpcs',            (select count(*) from unnest(array[
                        'public.telegram_link_token()', 'public.my_telegram_link()', 'public.set_telegram_claim(text)',
                        'public.telegram_unlink()', 'public.telegram_redeem_link(text,bigint,text)',
                        'public.telegram_member(bigint)']) f
                      where to_regprocedure(f) is not null
                        and has_function_privilege('authenticated', to_regprocedure(f), 'execute')),
  'anon_closed',     not exists (select 1 from unnest(array[
                        'public.telegram_link_token()', 'public.telegram_redeem_link(text,bigint,text)',
                        'public.telegram_member(bigint)', 'public.is_telegram_login()']) f
                      where to_regprocedure(f) is not null
                        and has_function_privilege('anon', to_regprocedure(f), 'execute')),
  'internal_closed', not exists (select 1 from unnest(array[
                        'public.telegram_login_id()', 'public.telegram_share_default(uuid)',
                        'public.telegram_member_json(uuid)', 'public.items_telegram_claim()']) f
                      where to_regprocedure(f) is not null
                        and has_function_privilege('authenticated', to_regprocedure(f), 'execute')),
  'triggers',        (select count(*) from pg_trigger
                      where tgname in ('items_telegram_claim', 'access_request_telegram') and not tgisinternal),
  'settings',        (select count(*) from ops.settings
                      where key in ('telegram_link_minutes', 'telegram_link_tokens_per_hour')),
  'global_editors',  (select string_agg(pr.handle || '=' || m.role, ',' order by pr.handle)
                      from public.lists l
                      join public.profiles o on o.id = l.owner_id and o.handle = 'maksym'
                      join public.list_members m on m.list_id = l.id
                      join public.profiles pr on pr.id = m.profile_id
                      where l.slug = 'homeos-global' and l.archived_at is null),
  'bucket_private',  case when to_regclass('storage.buckets') is null then null
                          else (select not public from storage.buckets where id = 'workorder-material') end,
  'bucket_policies', (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
                      and policyname like 'workorder_material_%'),
  'items_realtime',  exists (select 1 from pg_publication_tables
                             where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'items'),
  'realtime_marker', (select value from ops.settings where key = 'telegram_realtime_added')
) as check_032;
