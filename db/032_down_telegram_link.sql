-- db/032_down_telegram_link.sql: rollback of db/032_telegram_link.sql. Its name sorts before 032, so a set-up that runs
-- db/ in file order runs it first as a no-op. Drops what 032 adds; keeps the list "HomeOS - Global" and its members
-- (a household list with items; remove it from the app if wanted) and the bot's membership of default lists (remove it
-- in the app's Share dialog) and the ops tables (below). The bucket is emptied only through the Storage API; this file drops its policies and,
-- when it is empty, the bucket.

do $$
begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists workorder_material_insert on storage.objects;
    drop policy if exists workorder_material_select on storage.objects;
    drop policy if exists workorder_material_delete on storage.objects;
    if not exists (select 1 from storage.objects where bucket_id = 'workorder-material') then
      begin
        delete from storage.buckets where id = 'workorder-material';
      exception when others then null;   -- newer Storage refuses direct deletes: delete the bucket in the dashboard
      end;
    end if;
  end if;
  if to_regclass('public.users_pending_for_decision') is not null then
    drop trigger if exists access_request_telegram on public.users_pending_for_decision;
  end if;
end $$;
drop trigger if exists items_telegram_claim on public.items;
drop function if exists public.access_request_telegram();
drop function if exists public.items_telegram_claim();
drop function if exists public.telegram_member(bigint);
drop function if exists public.telegram_redeem_link(text, bigint, text);
drop function if exists public.telegram_unlink();
drop function if exists public.set_telegram_claim(text);
drop function if exists public.my_telegram_link();
drop function if exists public.telegram_link_token();
drop function if exists public.telegram_member_json(uuid);
drop function if exists public.telegram_unshare_default(uuid);
drop function if exists public.telegram_share_default(uuid);
drop function if exists public.telegram_group(uuid);
drop function if exists public.telegram_default_list(uuid);
drop function if exists public.is_homeos_agent();
drop function if exists public.is_telegram_login();
drop function if exists public.telegram_login_id();
-- The ops tables (links, claims, tokens) are kept with their data: a set-up that runs db/ in file order runs this file
-- before 032 again, and must not lose the links. Nothing can reach them once the functions are gone. To drop them for
-- good, by hand: drop table ops.telegram_link_tokens, ops.telegram_claims, ops.telegram_links;
delete from ops.settings where key in ('telegram_link_minutes', 'telegram_link_tokens_per_hour');
