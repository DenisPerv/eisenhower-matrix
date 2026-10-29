-- db/018_task_links.sql: task links (HomeOS task-links-plan.md). Two kinds the app shows, both stored with "from" = the
-- dependent side: depends_on (from_item comes after to_item, its predecessor; soft: nothing is refused for an open
-- predecessor) and parent (from_item is a child of to_item; one live parent per task). relates and duplicates stay as they are
-- (written by HomeOS skills, not shown); blocks is the reverse of depends_on: existing rows are turned into depends_on and new
-- ones refused, so one direction is stored.
-- Removal is soft (removed_at, like item_tags in 009) so a poll sees it through changed_at. The trigger keeps the rules for
-- every write path (REST insert by agents, the RPCs): no loop, one parent, live ends, no archived end. The RPCs link_items and
-- unlink_items give the picker its rights: edit rights on one end and read on both. links_read (011, read on both ends) is
-- unchanged, so a link to an item someone cannot read never reaches them. Idempotent.
-- After it: 003, 011, the 012 policy block, then 900, 901 (71 of 73 since 012), 902, 903, 904, 905, 906.

alter table public.item_links add column if not exists changed_at timestamptz not null default now();
alter table public.item_links add column if not exists removed_at timestamptz;
create index if not exists item_links_changed_idx on public.item_links (changed_at);
create index if not exists item_links_to_idx      on public.item_links (to_item);

-- one direction for sequence links: blocks (from before to) becomes depends_on (to after from)
insert into public.item_links (from_item, to_item, kind, created_by, created_at)
  select to_item, from_item, 'depends_on', created_by, created_at from public.item_links where kind = 'blocks'
  on conflict (from_item, to_item, kind) do nothing;
delete from public.item_links where kind = 'blocks';

-- one live parent per task (a removed parent link does not count)
create unique index if not exists item_links_one_parent on public.item_links (from_item) where kind = 'parent' and removed_at is null;

-- true when a live link from p_from to p_to of kind p_kind would close a loop: p_to already reaches p_from through live
-- links of that kind (depends_on: the predecessor chain; parent: the ancestor chain)
create or replace function public.link_would_loop(p_from uuid, p_to uuid, p_kind text) returns boolean
language sql stable security definer set search_path = '' as $$
  with recursive up(id, depth) as (
    select p_to, 0
    union
    select l.to_item, up.depth + 1 from public.item_links l join up on l.from_item = up.id
     where l.kind = p_kind and l.removed_at is null and up.depth < 1000
  )
  select exists (select 1 from up where id = p_from)
$$;
revoke all on function public.link_would_loop(uuid, uuid, text) from public, anon, authenticated;

-- the rules for every live link of kind depends_on or parent, whoever writes it; texts name no item
create or replace function public.item_links_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'blocks' then
    raise exception 'blocks links are stored as depends_on (from = the later task)' using errcode = '22023';
  end if;
  new.changed_at := clock_timestamp();
  if new.removed_at is not null or new.kind not in ('depends_on', 'parent') then return new; end if;
  if exists (select 1 from public.items i where i.id in (new.from_item, new.to_item) and i.deleted_at is not null) then
    raise exception 'a linked task is deleted' using errcode = '22023';
  end if;
  if exists (select 1 from public.items i join public.lists l on l.id = i.list_id
              where i.id in (new.from_item, new.to_item) and l.archived_at is not null) then
    raise exception 'this list is archived' using errcode = '42501';
  end if;
  if public.link_would_loop(new.from_item, new.to_item, new.kind) then
    raise exception 'this link would make a loop' using errcode = '22023';
  end if;
  if new.kind = 'parent' and exists (select 1 from public.item_links l where l.from_item = new.from_item and l.kind = 'parent'
                                        and l.removed_at is null and l.to_item <> new.to_item) then
    raise exception 'this task already has a parent' using errcode = '22023';
  end if;
  if (select count(*) from public.item_links l where l.removed_at is null and (l.from_item = new.from_item or l.to_item = new.from_item)) >= 200 then
    raise exception 'too many links on this task' using errcode = '54000';
  end if;
  return new;
end $$;
revoke all on function public.item_links_guard() from public, anon, authenticated;
drop trigger if exists item_links_guard on public.item_links;
create trigger item_links_guard before insert or update on public.item_links for each row execute function public.item_links_guard();

-- add a link (or bring back a removed one). Rights: edit rights on at least one end (can_edit_item: editor and up, or the
-- contributor who made it) and read on both. A parent link replaces the task's current parent in the same call.
-- Errors: 42501 not allowed (no titles: the caller may not read one end), 22023 bad kind, self link, loop, deleted end;
-- 42501 archived list; 54000 too many links.
create or replace function public.link_items(p_from uuid, p_to uuid, p_kind text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_read text[] := array['owner','editor','contributor','viewer'];
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if p_kind not in ('depends_on', 'parent') then raise exception 'kind must be depends_on or parent' using errcode = '22023'; end if;
  if p_from is null or p_to is null or p_from = p_to then raise exception 'a task cannot link to itself' using errcode = '22023'; end if;
  if not (public.has_item_role(p_from, v_read) and public.has_item_role(p_to, v_read)
          and (public.can_edit_item(p_from) or public.can_edit_item(p_to))) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_kind = 'parent' then
    update public.item_links set removed_at = now()
     where from_item = p_from and kind = 'parent' and to_item <> p_to and removed_at is null;
  end if;
  insert into public.item_links (from_item, to_item, kind, created_by) values (p_from, p_to, p_kind, auth.uid())
  on conflict (from_item, to_item, kind) do update set removed_at = null, created_by = auth.uid()
    where public.item_links.removed_at is not null;
  return 'ok';
end $$;
revoke all on function public.link_items(uuid, uuid, text) from public, anon;
grant execute on function public.link_items(uuid, uuid, text) to authenticated;

-- remove a link (soft). Rights: edit rights on either end, or the one who made the link, and read on both ends.
-- Errors: 42501 not allowed or archived list, 22023 bad kind. A link that is not there answers 'none'.
create or replace function public.unlink_items(p_from uuid, p_to uuid, p_kind text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_read text[] := array['owner','editor','contributor','viewer']; v_by uuid; v_n int;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if p_kind not in ('depends_on', 'parent', 'relates', 'duplicates') then raise exception 'bad kind' using errcode = '22023'; end if;
  select created_by into v_by from public.item_links where from_item = p_from and to_item = p_to and kind = p_kind and removed_at is null;
  if not (public.has_item_role(p_from, v_read) and public.has_item_role(p_to, v_read)
          and (public.can_edit_item(p_from) or public.can_edit_item(p_to) or v_by = auth.uid())) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from public.items i join public.lists l on l.id = i.list_id
              where i.id in (p_from, p_to) and l.archived_at is not null) then
    raise exception 'this list is archived' using errcode = '42501';
  end if;
  update public.item_links set removed_at = now()
   where from_item = p_from and to_item = p_to and kind = p_kind and removed_at is null;
  get diagnostics v_n = row_count;
  return case when v_n > 0 then 'ok' else 'none' end;
end $$;
revoke all on function public.unlink_items(uuid, uuid, text) from public, anon;
grant execute on function public.unlink_items(uuid, uuid, text) to authenticated;

-- final check: definer functions with a fixed search_path, the RPCs for authenticated only, helpers for nobody
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('link_items', 'unlink_items', 'link_would_loop', 'item_links_guard')
                and (not p.prosecdef or not coalesce(p.proconfig, '{}') @> array['search_path=""'])) then
    raise exception '018: link functions must be security definer with search_path ''''';
  end if;
  if has_function_privilege('anon', 'public.link_items(uuid, uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.unlink_items(uuid, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.link_would_loop(uuid, uuid, text)', 'execute') then
    raise exception '018: a link function is executable by anon, or the loop helper by authenticated';
  end if;
  if not has_function_privilege('authenticated', 'public.link_items(uuid, uuid, text)', 'execute')
     or not has_function_privilege('authenticated', 'public.unlink_items(uuid, uuid, text)', 'execute') then
    raise exception '018: link_items or unlink_items is not executable by authenticated';
  end if;
  if exists (select 1 from public.item_links where kind = 'blocks') then
    raise exception '018: blocks rows left';
  end if;
end $$;
