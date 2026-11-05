-- db/029_delete_lists.sql: delete an archived list with its tasks, and the time of the last backup (2026-11-05, Maksym:
-- "Списки удаляются вместе с задачами после попапа что удаление необратимо. показывай дату и время последнего бэкапа мелким
-- шрифтом. Удалять списки можно только из архива.").
--
--   - delete_archived_list: a person who owns the list, the list archived, not a system list (slug access-requests or starting
--     '_'), not a category's default list. Removes everything that hangs on its items, every item (soft-deleted ones too) and
--     the list, in one transaction. An access request keeps its row and loses only the item link. It cannot be undone.
--   - members_keep_owner: as in 010, plus the owner row may go while delete_archived_list deletes that same list
--     (the transaction-local td.deleting_list, set only inside that function; PostgREST exposes no way to set it).
--   - last_backup_at: when the last backup finished, for the delete popup. Null until a run has recorded one.
--   - ops.record_backup: the one write the read-only backup role may make, called by .github/workflows/tasksdb-backup.yml in a
--     read-write transaction. It stores epoch seconds under ops.settings key last_backup_at.
--
-- Error codes: 42501 not allowed, 55000 not archived, 23503 a category's default list, 22023 no such list.
-- Additive and re-runnable. 003 revokes functions from public and anon only, so these grants survive it. Re-running 010 means
-- re-running this file after it (010 replaces members_keep_owner). Selftest: 913.

create or replace function public.members_keep_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if ((old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner'))
      or (tg_op = 'UPDATE' and new.role = 'owner' and old.role <> 'owner'))
     and not (session_user in ('postgres','supabase_admin')
              and nullif(current_setting('request.jwt.claims', true), '') is null)
     and not (tg_op = 'DELETE' and coalesce(current_setting('td.deleting_list', true), '') = old.list_id::text) then
    raise exception 'owners are changed by admin SQL only' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

create or replace function public.delete_archived_list(p_list uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_name text; v_slug text; v_arch timestamptz; v_n int; v_cat text;
begin
  if not public.is_human() then raise exception 'only people delete lists' using errcode = '42501'; end if;
  select name, slug, archived_at into v_name, v_slug, v_arch from public.lists where id = p_list for update;
  if not found then raise exception 'no such list' using errcode = '22023'; end if;
  if not public.has_list_role(p_list, array['owner']) then
    raise exception 'only the owner deletes a list' using errcode = '42501';
  end if;
  if v_arch is null then raise exception 'archive the list before deleting it' using errcode = '55000'; end if;
  if v_slug = 'access-requests' or v_slug like '\_%' then
    raise exception 'this is a system list, scripts use it' using errcode = '42501';
  end if;
  select slug into v_cat from public.categories where default_list_id = p_list limit 1;
  if v_cat is not null then
    raise exception 'this list is the default list of the category %', v_cat using errcode = '23503';
  end if;

  perform set_config('td.deleting_list', p_list::text, true);
  update public.users_pending_for_decision set item_id = null
   where item_id in (select id from public.items where list_id = p_list);
  delete from public.item_links
   where from_item in (select id from public.items where list_id = p_list)
      or to_item   in (select id from public.items where list_id = p_list);
  delete from public.item_tags where item_id in (select id from public.items where list_id = p_list);
  delete from public.item_refs where item_id in (select id from public.items where list_id = p_list);
  delete from public.item_events where item_id in (select id from public.items where list_id = p_list);
  delete from public.notification_deliveries where item_id in (select id from public.items where list_id = p_list);
  delete from public.items where list_id = p_list;
  get diagnostics v_n = row_count;
  delete from public.lists where id = p_list;
  perform set_config('td.deleting_list', '', true);
  return jsonb_build_object('name', v_name, 'items', v_n);
end $$;

create or replace function ops.record_backup() returns void
language sql security definer set search_path = '' as $$
  insert into ops.settings (key, value, note)
  values ('last_backup_at', extract(epoch from now()), 'epoch seconds of the last finished backup (tasksdb-backup workflow)')
  on conflict (key) do update set value = excluded.value;
$$;

create or replace function public.last_backup_at() returns timestamptz
language sql stable security definer set search_path = '' as $$
  select to_timestamp(value::double precision) from ops.settings where key = 'last_backup_at';
$$;

revoke all on function public.delete_archived_list(uuid), public.last_backup_at() from public, anon;
grant execute on function public.delete_archived_list(uuid), public.last_backup_at() to authenticated;
revoke all on function ops.record_backup() from public, anon, authenticated;
do $do$
begin
  if exists (select 1 from pg_roles where rolname = 'tasksdb_backup') then
    execute 'grant execute on function ops.record_backup() to tasksdb_backup';
  end if;
end $do$;
