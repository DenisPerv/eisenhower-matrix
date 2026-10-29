-- db/023_agent_tag_home.sql: an agent's home tag list (HomeOS tags-round-plan.md #2b; Maksym 2026-10-29: HomeOS and
-- Telegram use their own tag lists, "Always HomeOS tags"). Tags typed by name (items.tags) by an agent login with a row in
-- ops.agent_tag_home land in that tag list, not in the on-behalf person's default (landing) list.
--   (a) ops.agent_tag_home (agent_id, tag_list_id): one home per agent, agent logins only, admin SQL only (no API grants).
--   (b) items_tags_compat_after() from 010 with one change: an agent writer with a home row files the names into that list,
--       reusing a live or soft-deleted tag by lower(name), else inserting one. The list must be live and the agent its owner
--       or editor, else 42501 "agent tag home not writable". With no row the old rule applies; people are unchanged.
--   (c) guards, as for the default (landing) list: a home list is not archived or merged away (set_tag_list_archived,
--       merge_tag_lists and any other update of archived_at: 22023), and the agent's membership of its home list is not
--       removed or lowered below editor (42501). Remove the home row first (admin SQL) to do either.
-- Every function is security definer with search_path = ''. Re-runnable. Order rule after this file: 003_rls.sql,
-- 011_multiuser_rls.sql, the 012 policy block, then 900-908. 010 replaces items_tags_compat_after again: re-running 010
-- means re-running this file after it.
--
-- Rollback (not applied; admin SQL, in this order):
--   drop trigger if exists tag_members_keep_home on public.tag_list_members;
--   drop trigger if exists tag_lists_home_guard on public.tag_lists;
--   drop function if exists public.tag_members_keep_home();
--   drop function if exists public.tag_lists_home_guard();
--   -- items_tags_compat_after back to 010's body: run the "create or replace function public.items_tags_compat_after()"
--   -- statement of 010_multiuser_functions.sql (section "tags") again, alone (not the whole file)
--   drop table if exists ops.agent_tag_home;          -- its own trigger and the check function go with it:
--   drop function if exists public.agent_tag_home_check();

-- ---------- (a) the table ----------

create table if not exists ops.agent_tag_home (
  agent_id    uuid primary key references public.profiles(id),
  tag_list_id uuid not null references public.tag_lists(id)
);
revoke all on ops.agent_tag_home from public, anon, authenticated;
alter table ops.agent_tag_home enable row level security;
create index if not exists agent_tag_home_list_idx on ops.agent_tag_home (tag_list_id);

-- agent logins only
create or replace function public.agent_tag_home_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = new.agent_id and kind = 'agent') then
    raise exception 'a tag home is for agent logins only' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists agent_tag_home_check on ops.agent_tag_home;
create trigger agent_tag_home_check before insert or update on ops.agent_tag_home
  for each row execute function public.agent_tag_home_check();

-- ---------- (b) tags by name ----------

-- Compatibility (review §6): writers may still send items.tags. The names are filed into a tag list and the column is
-- cleared. Which list: an agent with a home row (023), its home list; else a Default (landing) list: a person's own; an
-- agent's on_behalf_of person's, else the list owner's (the agent must edit that Default, else 42501); admin SQL: the list
-- owner's. Additive on INSERT and UPDATE: names are added (a removed one comes back), nothing is removed; an empty array
-- changes nothing. Removal goes through item_tags.
create or replace function public.items_tags_compat_after() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_key   text := 'tdb.tags_' || replace(new.id::text, '-', '');
  v_raw   text := nullif(current_setting(v_key, true), '');
  v_names text[];
  v_uid   uuid := auth.uid();
  v_kind  text;
  v_who   uuid;
  v_tl    uuid;
  v_home  uuid;
  v_tag   uuid;
  v_name  text;
begin
  if v_raw is null then return null; end if;
  perform set_config(v_key, '', true);
  select array_agg(distinct trim(x)) into v_names from unnest(string_to_array(v_raw, chr(31))) x where trim(x) <> '';
  if v_names is null then return null; end if;
  select kind into v_kind from public.profiles where id = v_uid;
  if v_kind = 'agent' and not public.is_admin_sql() then
    select h.tag_list_id into v_home from ops.agent_tag_home h where h.agent_id = v_uid;
  end if;
  if v_home is not null then
    -- 023: the agent's home list, live, and the agent may edit it
    if not exists (select 1 from public.tag_lists where id = v_home and archived_at is null)
       or not public.has_tag_list_role(v_home, array['owner','editor']) then
      raise exception 'agent tag home not writable' using errcode = '42501';
    end if;
    v_tl := v_home;
  else
    if public.is_admin_sql() or v_uid is null then
      v_who := new.space_owner_id;
    elsif v_kind = 'agent' then
      v_who := coalesce(new.on_behalf_of, new.space_owner_id);
    else
      v_who := v_uid;
    end if;
    select id into v_tl from public.tag_lists where owner_id = v_who and is_default;
    if v_tl is null then raise exception 'no Default tag list for this writer' using errcode = '42501'; end if;
    if v_kind = 'agent' and not public.is_admin_sql()
       and not public.has_tag_list_role(v_tl, array['owner','editor']) then
      raise exception 'this agent may not file tags for that person' using errcode = '42501';
    end if;
  end if;
  foreach v_name in array v_names loop
    select id into v_tag from public.tags where tag_list_id = v_tl and lower(name) = lower(v_name);
    if v_tag is null then
      insert into public.tags (tag_list_id, name, created_by) values (v_tl, left(v_name, 40), coalesce(v_uid, v_who))
      returning id into v_tag;
    elsif exists (select 1 from public.tags where id = v_tag and deleted_at is not null) then
      update public.tags set deleted_at = null where id = v_tag;
    end if;
    insert into public.item_tags (item_id, tag_id, added_by) values (new.id, v_tag, coalesce(v_uid, v_who))
    on conflict (item_id, tag_id) do update set removed_at = null, changed_at = now()
      where public.item_tags.removed_at is not null;
  end loop;
  return null;
end $$;
drop trigger if exists items_tags_compat_after on public.items;
create trigger items_tags_compat_after after insert or update on public.items
  for each row execute function public.items_tags_compat_after();

-- ---------- (c) guards ----------

-- a home list is not archived (set_tag_list_archived) or merged away (merge_tag_lists archives the source last, so the
-- whole merge is undone); 22023 like "the default tag list is not archived"
create or replace function public.tag_lists_home_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.archived_at is not null and old.archived_at is null
     and exists (select 1 from ops.agent_tag_home h where h.tag_list_id = new.id) then
    raise exception 'an agent files tags into this tag list: it is not archived or merged away' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists tag_lists_home_guard on public.tag_lists;
create trigger tag_lists_home_guard before update of archived_at on public.tag_lists
  for each row execute function public.tag_lists_home_guard();

-- the agent stays an owner or editor of its home list (remove, leave, revoke or a lower role: 42501)
create or replace function public.tag_members_keep_home() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from ops.agent_tag_home h where h.agent_id = old.profile_id and h.tag_list_id = old.tag_list_id)
     and (tg_op = 'DELETE' or new.role not in ('owner','editor') or new.profile_id <> old.profile_id
          or new.tag_list_id <> old.tag_list_id) then
    raise exception 'an agent files tags into this tag list: its membership stays (remove its tag home first)' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists tag_members_keep_home on public.tag_list_members;
create trigger tag_members_keep_home before update or delete on public.tag_list_members
  for each row execute function public.tag_members_keep_home();

-- ---------- rights ----------

revoke all on function public.agent_tag_home_check(), public.items_tags_compat_after(), public.tag_lists_home_guard(),
  public.tag_members_keep_home() from public, anon, authenticated;

-- final check
do $$
declare v text;
begin
  select string_agg(p.proname, ', ') into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('agent_tag_home_check','items_tags_compat_after','tag_lists_home_guard','tag_members_keep_home')
     and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']);
  if v is not null then raise exception '023: not a definer with search_path '''': %', v; end if;
  if has_table_privilege('authenticated', 'ops.agent_tag_home', 'select') or has_table_privilege('authenticated', 'ops.agent_tag_home', 'insert')
     or has_table_privilege('anon', 'ops.agent_tag_home', 'select') then
    raise exception '023: ops.agent_tag_home has API grants';
  end if;
  if has_function_privilege('authenticated', 'public.tag_members_keep_home()', 'execute')
     or has_function_privilege('authenticated', 'public.items_tags_compat_after()', 'execute') then
    raise exception '023: a trigger function is executable by authenticated';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'items_tags_compat_after' and tgrelid = 'public.items'::regclass)
     or position('agent_tag_home' in pg_get_functiondef('public.items_tags_compat_after()'::regprocedure)) = 0 then
    raise exception '023: items_tags_compat_after is not the 023 version';
  end if;
end $$;
