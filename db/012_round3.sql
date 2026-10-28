-- db/012_round3.sql: round 3 (HomeOS round3-plan.md D1, L1, adjustments 1, 3, 4, 5; review G1-G8, G12).
-- Same list names (create_list slugs and clash answers, create_list_row), a first share joins without Accept (share_*
-- with p_join, shared_notices), several tag lists per person with the roles viewer / contributor / editor (archive,
-- default, move, merge, caps), tags.updated_at for pollers, profiles.mine_tag_ids, urgency_settings for HomeOS readers,
-- V4-1 (a password login needs its allowlist row's nonce), V4-8 (no invitation into an archived list or tag list), and
-- the Default tag lists renamed "My tags". Every function is security definer with search_path = ''. Error codes:
-- 42501 not allowed, 22023 bad value, 23505 name taken, 54000 limit reached. Additive and re-runnable.
-- Order rule after this file: 003_rls.sql, 011_multiuser_rls.sql, this file's policy block (the end of this file;
-- tasksdb.js apply-sql appends it after 003 and 011), 900, 901, 902.

-- ---------- schema ----------

-- tag lists: archive (never delete); the default list is never archived; live names unique per owner
alter table public.tag_lists add column if not exists archived_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tag_lists_default_live') then
    alter table public.tag_lists add constraint tag_lists_default_live check (not (is_default and archived_at is not null));
  end if;
end $$;
create unique index if not exists tag_lists_owner_name_live on public.tag_lists (owner_id, lower(name)) where archived_at is null;

-- the contributor role on tag lists (adds, renames and reorders tags), for members and invitations
alter table public.tag_list_members drop constraint if exists tag_list_members_role_check;
alter table public.tag_list_members add constraint tag_list_members_role_check
  check (role in ('owner','editor','contributor','viewer'));
do $$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.invites'::regclass and contype = 'c' and conname <> 'invites_role_check'
              and pg_get_constraintdef(oid) like '%role%'
  loop execute format('alter table public.invites drop constraint %I', c); end loop;
  if not exists (select 1 from pg_constraint where conname = 'invites_role_check') then
    alter table public.invites add constraint invites_role_check check (role in ('editor','contributor','viewer'));
  end if;
end $$;

-- a first share that joined at once (adjustment 3); the invitee's one-time notice, own rows only
alter table public.invites add column if not exists auto_joined boolean not null default false;
create table if not exists public.shared_notices (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id) on delete cascade,   -- the invitee
  list_id      uuid references public.lists(id) on delete cascade,
  tag_list_id  uuid references public.tag_lists(id) on delete cascade,
  invite_id    uuid references public.invites(id) on delete set null,
  invited_by   uuid not null references public.profiles(id) on delete cascade,
  inviter_name text not null,
  target_name  text not null,
  role         text not null,
  created_at   timestamptz not null default now(),
  seen_at      timestamptz,
  check (num_nonnulls(list_id, tag_list_id) = 1)
);
alter table public.shared_notices enable row level security;
create index if not exists shared_notices_open_idx on public.shared_notices (profile_id) where seen_at is null;

-- tags: pollers read changes since their last poll (adjustment 4)
alter table public.tags add column if not exists updated_at timestamptz not null default now();
create index if not exists tags_updated_idx on public.tags (updated_at);

-- "Mine" by tag id (several lists can hold the same name); mine_tags stays until the app reads ids
alter table public.profiles add column if not exists mine_tag_ids uuid[] not null default '{}';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_mine_tag_ids_len') then
    alter table public.profiles add constraint profiles_mine_tag_ids_len check (cardinality(mine_tag_ids) <= 50);
  end if;
end $$;

-- V4-1: a password login claims its allowlist row only with the row's nonce (tasksdb.js add-login sends it)
alter table ops.signup_allowlist add column if not exists nonce text not null default replace(gen_random_uuid()::text, '-', '');

insert into ops.settings (key, value, note) values
  ('guest_tag_lists',       10, 'live tag lists a guest owns'),
  ('guest_tag_lists_total', 50, 'tag lists a guest owns, archived included'),
  ('household_tag_lists',   30, 'live tag lists a household member owns')
on conflict (key) do nothing;

-- G7: the default tag lists are "My tags", once (a marker row), never over a name someone chose later
do $$ begin
  if not exists (select 1 from ops.settings where key = 'round3_my_tags_done') then
    update public.tag_lists t set name = 'My tags' where t.is_default and t.name = 'Default'
       and not exists (select 1 from public.tag_lists o where o.owner_id = t.owner_id and o.archived_at is null and lower(o.name) = 'my tags');
    insert into ops.settings (key, value, note) values ('round3_my_tags_done', 1, '012: Default tag lists renamed once');
  end if;
end $$;

-- ---------- lists (adjustment 1) ----------

-- New list: people only. Private unless p_shared (household members only: the other household people and homeos-agent
-- as editors). 012: a name the caller already uses for one of their lists (archived included, any case) is 23505 with
-- details 'live' or 'archived' and the list id as hint. A derived slug is the name's ASCII letters and digits, or
-- list-<6 hex> when none are left, suffixed -2, -3 ... on a clash with any of the caller's lists; an explicit p_slug is
-- used as given. Returns the id (create_list_row returns the row).
create or replace function public.create_list(p_name text, p_slug text default null,
                                              p_shared boolean default false, p_default_category text default 'task')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_hh boolean := public.is_household(); v_n int; v_i int := 1;
        v_name text := trim(coalesce(p_name, '')); v_base text; v_slug text; v_clash uuid; v_arch timestamptz;
begin
  if not public.is_human() then raise exception 'only people create lists' using errcode = '42501'; end if;
  if p_shared and not v_hh then raise exception 'only household members share with the household' using errcode = '42501'; end if;
  if char_length(v_name) not between 1 and 60 then raise exception 'a list name has 1 to 60 characters' using errcode = '22023'; end if;
  if p_slug is not null then
    v_slug := p_slug;
    if v_slug !~ '^[a-z0-9_][a-z0-9-]*$' then raise exception 'a list slug needs letters or digits' using errcode = '22023'; end if;
  end if;
  if p_default_category is not null and not public.can_use_category(p_default_category) then
    raise exception 'this category is not available' using errcode = '42501';
  end if;
  select count(*) into v_n from public.lists where owner_id = auth.uid() and archived_at is null;
  if v_n >= public.setting(case when v_hh then 'household_lists' else 'guest_lists' end)
     or (not v_hh and (select count(*) from public.lists where owner_id = auth.uid()) >= public.setting('guest_lists_total')) then
    raise exception 'list limit reached' using errcode = '54000';
  end if;
  select id, archived_at into v_clash, v_arch from public.lists
   where owner_id = auth.uid() and lower(trim(name)) = lower(v_name) order by archived_at nulls first limit 1;
  if v_clash is not null then
    raise exception 'you already have a list named %', v_name using errcode = '23505',
      detail = case when v_arch is null then 'live' else 'archived' end, hint = v_clash::text;
  end if;
  if v_slug is null then
    v_base := trim(both '-' from left(lower(regexp_replace(v_name, '[^A-Za-z0-9]+', '-', 'g')), 50));
    if v_base = '' then v_base := 'list-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6); end if;
    v_slug := v_base;
    while exists (select 1 from public.lists where owner_id = auth.uid() and slug = v_slug) loop
      v_i := v_i + 1; v_slug := v_base || '-' || v_i;
    end loop;
  end if;
  insert into public.lists (slug, name, default_category, owner_id, created_by, sort)
  values (v_slug, v_name, p_default_category, auth.uid(), auth.uid(),
          coalesce((select max(sort) + 1 from public.lists where owner_id = auth.uid()), 1))
  returning id into v_id;
  insert into public.list_members (list_id, profile_id, role, added_by) values (v_id, auth.uid(), 'owner', auth.uid());
  if p_shared then
    insert into public.list_members (list_id, profile_id, role, added_by)
    select v_id, p.id, 'editor', auth.uid() from public.profiles p
     where p.id <> auth.uid() and p.is_household and (p.kind = 'human' or p.handle = 'homeos-agent');
  end if;
  return v_id;
end $$;

-- the same, answering with the new row, so the app inserts it at once (adjustment 2)
create or replace function public.create_list_row(p_name text, p_slug text default null,
                                                  p_shared boolean default false, p_default_category text default 'task')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid := public.create_list(p_name, p_slug, p_shared, p_default_category);
begin
  return (select jsonb_build_object('id', l.id, 'slug', l.slug, 'name', l.name, 'sort', l.sort, 'owner_id', l.owner_id,
                                    'archived_at', l.archived_at, 'default_category', l.default_category)
            from public.lists l where l.id = v_id);
end $$;

-- ---------- tags ----------

-- tags: trimmed names, the sensitive-data screen, the per-owner limit (tags not deleted, archived lists included, so
-- archiving never frees room). 012: an archived tag
-- list is read-only; deleting a tag is for owners and editors; the list changes only inside move_tags / merge_tags
-- (tdb.tag_move) or admin SQL; updated_at on every write.
create or replace function public.tags_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_hh boolean; v_n int; v_admin boolean := public.is_admin_sql();
        v_fn boolean := coalesce(current_setting('tdb.tag_move', true), '') = '1';
begin
  new.name := trim(new.name);
  if tg_op = 'UPDATE' then
    if not (v_fn or v_admin) then new.tag_list_id := old.tag_list_id; end if;
    new.created_by := old.created_by; new.created_at := old.created_at;
  else new.created_by := coalesce(auth.uid(), new.created_by); new.created_at := now(); end if;
  new.updated_at := now();
  if not (v_fn or v_admin)
     and exists (select 1 from public.tag_lists where id = new.tag_list_id and archived_at is not null) then
    raise exception 'this tag list is archived' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.deleted_at is distinct from old.deleted_at and not v_admin and auth.uid() is not null
     and not public.has_tag_list_role(new.tag_list_id, array['owner','editor']) then
    raise exception 'only owners and editors delete tags' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' or new.name is distinct from old.name then
    perform public.assert_no_sensitive(new.name);
  end if;
  if tg_op = 'INSERT' or (old.deleted_at is not null and new.deleted_at is null) then
    select tl.owner_id, p.is_household into v_owner, v_hh
      from public.tag_lists tl join public.profiles p on p.id = tl.owner_id where tl.id = new.tag_list_id;
    select count(*) into v_n from public.tags t join public.tag_lists tl on tl.id = t.tag_list_id
     where tl.owner_id = v_owner and t.deleted_at is null;
    if v_n >= public.setting(case when v_hh then 'household_tags' else 'guest_tags' end) then
      raise exception 'tag limit reached' using errcode = '54000';
    end if;
  end if;
  return new;
end $$;

-- item_tags: who added it, when it changed; the pair never changes. 012: a tag of an archived tag list is not added
-- (or put back) on an item; definer so the check sees the list whatever the caller can read.
create or replace function public.item_tags_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.item_id := old.item_id; new.tag_id := old.tag_id; new.added_by := old.added_by; new.created_at := old.created_at;
  else
    new.added_by := coalesce(auth.uid(), new.added_by); new.created_at := now();
  end if;
  new.changed_at := now();
  if new.removed_at is null and (tg_op = 'INSERT' or old.removed_at is not null) and not public.is_admin_sql()
     and exists (select 1 from public.tags t join public.tag_lists l on l.id = t.tag_list_id
                  where t.id = new.tag_id and l.archived_at is not null) then
    raise exception 'this tag list is archived' using errcode = '42501';
  end if;
  return new;
end $$;

-- tag lists: owner, created_at and the default flag are not changed through the API (column grants allow name, sort);
-- an archived list keeps its name and order until it is restored
create or replace function public.tag_lists_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.name := trim(new.name);
  if tg_op = 'UPDATE' then
    new.owner_id := old.owner_id; new.created_at := old.created_at;
    if old.archived_at is not null and new.archived_at is not null and not public.is_admin_sql()
       and (new.name, new.sort) is distinct from (old.name, old.sort) then
      raise exception 'this tag list is archived' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' or new.name is distinct from old.name then
    perform public.assert_no_sensitive(new.name);
  end if;
  return new;
end $$;
drop trigger if exists tag_lists_before_write on public.tag_lists;
create trigger tag_lists_before_write before insert or update on public.tag_lists
  for each row execute function public.tag_lists_before_write();

-- one owner's tag lists that the caller may reorganise: owner or editor on each (moving a tag changes who sees it, so
-- both lists must have the same owner: an editor never pulls tags into their own list)
create or replace function public.tag_lists_same_editable(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select a.owner_id = b.owner_id and a.archived_at is null and b.archived_at is null
                     from public.tag_lists a, public.tag_lists b where a.id = p_a and b.id = p_b), false)
     and public.has_tag_list_role(p_a, array['owner','editor']) and public.has_tag_list_role(p_b, array['owner','editor'])
$$;

-- merge one tag into another (internal): every live use of p_from becomes a use of p_into, p_from is deleted
create or replace function public.merge_tag_into(p_from uuid, p_into uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if not public.is_admin_sql() and not public.tag_lists_same_editable(
       (select tag_list_id from public.tags where id = p_from), (select tag_list_id from public.tags where id = p_into)) then
    raise exception 'no such tags to merge' using errcode = '42501';
  end if;
  perform set_config('tdb.tag_move', '1', true);
  insert into public.item_tags (item_id, tag_id)
  select it.item_id, p_into from public.item_tags it where it.tag_id = p_from and it.removed_at is null
  on conflict (item_id, tag_id) do update set removed_at = null where public.item_tags.removed_at is not null;
  update public.item_tags set removed_at = now() where tag_id = p_from and removed_at is null;
  get diagnostics v_n = row_count;
  update public.tags set deleted_at = now() where id = p_from and deleted_at is null;
  update public.tags set deleted_at = null where id = p_into and deleted_at is not null;
  perform set_config('tdb.tag_move', '', true);
  return v_n;
end $$;

-- a new tag list: people only, under the cap (live lists), a live name unique per owner
create or replace function public.create_tag_list(p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_name text := trim(coalesce(p_name, '')); v_id uuid; v_sort int;
begin
  if not public.is_human() then raise exception 'only people create tag lists' using errcode = '42501'; end if;
  if char_length(v_name) not between 1 and 60 then raise exception 'a tag list name has 1 to 60 characters' using errcode = '22023'; end if;
  if (select count(*) from public.tag_lists where owner_id = auth.uid() and archived_at is null)
     >= public.setting(case when public.is_household() then 'household_tag_lists' else 'guest_tag_lists' end) then
    raise exception 'tag list limit reached' using errcode = '54000';
  end if;
  if not public.is_household()
     and (select count(*) from public.tag_lists where owner_id = auth.uid()) >= public.setting('guest_tag_lists_total') then
    raise exception 'tag list limit reached' using errcode = '54000';
  end if;
  if exists (select 1 from public.tag_lists where owner_id = auth.uid() and archived_at is null and lower(name) = lower(v_name)) then
    raise exception 'you already have a tag list named %', v_name using errcode = '23505';
  end if;
  v_sort := coalesce((select max(sort) + 1 from public.tag_lists where owner_id = auth.uid()), 1);
  insert into public.tag_lists (owner_id, name, is_default, sort) values (auth.uid(), v_name, false, v_sort) returning id into v_id;
  insert into public.tag_list_members (tag_list_id, profile_id, role, added_by) values (v_id, auth.uid(), 'owner', auth.uid());
  return jsonb_build_object('id', v_id, 'name', v_name, 'sort', v_sort, 'is_default', false);
end $$;

-- where the owner's new tags go when nobody names a list (items.tags from HomeOS, the bot, the CLI): owner only
create or replace function public.set_default_tag_list(p_tag_list uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.tag_lists where id = p_tag_list and owner_id = auth.uid()) then
    raise exception 'only the owner chooses the default tag list' using errcode = '42501';
  end if;
  if exists (select 1 from public.tag_lists where id = p_tag_list and archived_at is not null) then
    raise exception 'this tag list is archived' using errcode = '22023';
  end if;
  -- agents that file the owner's items.tags (editors of the old default, D-i) follow to the new default
  insert into public.tag_list_members (tag_list_id, profile_id, role, added_by)
  select p_tag_list, m.profile_id, m.role, auth.uid()
    from public.tag_list_members m join public.tag_lists t on t.id = m.tag_list_id join public.profiles p on p.id = m.profile_id
   where t.owner_id = auth.uid() and t.is_default and t.id <> p_tag_list and p.kind = 'agent' and m.role <> 'owner'
  on conflict (tag_list_id, profile_id) do nothing;
  update public.tag_lists set is_default = false where owner_id = auth.uid() and is_default and id <> p_tag_list;
  update public.tag_lists set is_default = true where id = p_tag_list and not is_default;
  return jsonb_build_object('ok', true);
end $$;

-- "Delete list" archives it for everyone (owner or editor); restore checks the live name and the cap
create or replace function public.set_tag_list_archived(p_tag_list uuid, p_archived boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.tag_lists;
begin
  select * into v from public.tag_lists where id = p_tag_list;
  if v.id is null or not public.has_tag_list_role(p_tag_list, array['owner','editor']) then
    raise exception 'only owners and editors archive a tag list' using errcode = '42501';
  end if;
  if p_archived and v.is_default then raise exception 'the default tag list is not archived' using errcode = '22023'; end if;
  if not p_archived and v.archived_at is not null then
    if exists (select 1 from public.tag_lists where owner_id = v.owner_id and archived_at is null and lower(name) = lower(v.name)) then
      raise exception 'a live tag list is named %', v.name using errcode = '23505';
    end if;
    if (select count(*) from public.tag_lists where owner_id = v.owner_id and archived_at is null)
       >= public.setting(case when (select is_household from public.profiles where id = v.owner_id) then 'household_tag_lists' else 'guest_tag_lists' end) then
      raise exception 'tag list limit reached' using errcode = '54000';
    end if;
  end if;
  update public.tag_lists set archived_at = case when p_archived then coalesce(archived_at, now()) end where id = p_tag_list;
  -- pollers see the change through tags.updated_at
  perform set_config('tdb.tag_move', '1', true);
  update public.tags set updated_at = now() where tag_list_id = p_tag_list;
  perform set_config('tdb.tag_move', '', true);
  return jsonb_build_object('ok', true);
end $$;

-- move tags into another list of the same owner (owner or editor on both); a name already there is merged into it
create or replace function public.move_tags(p_tags uuid[], p_to uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_t public.tags; v_into uuid; v_moved int := 0; v_merged int := 0;
begin
  if not exists (select 1 from public.tag_lists where id = p_to and archived_at is null)
     or not public.has_tag_list_role(p_to, array['owner','editor']) then
    raise exception 'no such tag list' using errcode = '42501';
  end if;
  for v_t in select * from public.tags where id = any (coalesce(p_tags, '{}')) and deleted_at is null order by sort, name loop
    continue when v_t.tag_list_id = p_to;
    if not public.tag_lists_same_editable(v_t.tag_list_id, p_to) then
      raise exception 'tags move only between lists of one owner that you may edit' using errcode = '42501';
    end if;
    select id into v_into from public.tags where tag_list_id = p_to and lower(name) = lower(v_t.name);
    if v_into is not null then
      perform public.merge_tag_into(v_t.id, v_into); v_merged := v_merged + 1;
    else
      perform set_config('tdb.tag_move', '1', true);
      update public.tags set tag_list_id = p_to where id = v_t.id;
      perform set_config('tdb.tag_move', '', true);
      v_moved := v_moved + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'moved', v_moved, 'merged', v_merged);
end $$;

-- merge one tag into another (lists of one owner, owner or editor on both)
create or replace function public.merge_tags(p_from uuid, p_into uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_a public.tags; v_b public.tags; v_n int;
begin
  select * into v_a from public.tags where id = p_from and deleted_at is null;
  select * into v_b from public.tags where id = p_into and deleted_at is null;
  if v_a.id is null or v_b.id is null or p_from = p_into or not public.tag_lists_same_editable(v_a.tag_list_id, v_b.tag_list_id) then
    raise exception 'no such tags to merge' using errcode = '42501';
  end if;
  v_n := public.merge_tag_into(p_from, p_into);
  return jsonb_build_object('ok', true);
end $$;

-- merge a tag list into another of the same owner, then archive it; its members are not copied (sharing stays
-- explicit): the answer counts the members who lose sight of those tags
create or replace function public.merge_tag_lists(p_from uuid, p_into uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[]; v_r jsonb; v_lost int;
begin
  if p_from = p_into or not public.tag_lists_same_editable(p_from, p_into) then
    raise exception 'tag lists merge only within one owner''s lists that you may edit' using errcode = '42501';
  end if;
  if exists (select 1 from public.tag_lists where id = p_from and is_default) then
    raise exception 'the default tag list is not merged away' using errcode = '22023';
  end if;
  select array_agg(id) into v_ids from public.tags where tag_list_id = p_from and deleted_at is null;
  v_r := public.move_tags(coalesce(v_ids, '{}'), p_into);
  select count(*) into v_lost from public.tag_list_members m
   where m.tag_list_id = p_from and m.role <> 'owner'
     and not exists (select 1 from public.tag_list_members n where n.tag_list_id = p_into and n.profile_id = m.profile_id);
  update public.tag_lists set archived_at = now() where id = p_from;
  return v_r || jsonb_build_object('members_lost', v_lost);
end $$;

-- ---------- sharing (adjustment 3, G1-G5, V4-8) ----------

-- One body for every share: the same answer for every email (S4, S5). 012, p_join: a first share (no earlier
-- invitation row for this target and address) to exactly one existing human profile with that verified address, who
-- is not yet a member and has not blocked the sharer, joins at once: an accepted invitation (auto_joined) and a
-- shared_notices row for the invitee. Otherwise the invitation flow as before (a block wins: no join, same answer).
create or replace function public.invite_upsert(p_list uuid, p_tag_list uuid, p_email text, p_role text, p_name text,
                                                p_join boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(trim(coalesce(p_email, ''))); v_n int; v_id uuid; v_users uuid[]; v_to uuid;
        v_target uuid := coalesce(p_list, p_tag_list);
        v_owner uuid := coalesce((select owner_id from public.lists where id = p_list), (select owner_id from public.tag_lists where id = p_tag_list));
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'that does not look like an email address' using errcode = '22023';
  end if;
  if v_email in (select public.my_verified_emails()) then
    raise exception 'that is your own address' using errcode = '22023';
  end if;
  select count(*) into v_n from public.invites where invited_by = auth.uid() and created_at > now() - interval '1 day';
  if v_n >= public.setting('invites_per_day') then raise exception 'invitation limit for today reached' using errcode = '54000'; end if;
  select count(*) into v_n from public.invites
   where invited_by = auth.uid() and accepted_at is null and declined_at is null and revoked_at is null and expires_at > now();
  if v_n >= public.setting('invites_open') then raise exception 'too many open invitations' using errcode = '54000'; end if;
  -- one share at a time per target and address, so two at once cannot both count as "first"
  perform pg_advisory_xact_lock(hashtext(v_target::text || '/' || v_email));
  if p_join then
    select array_agg(distinct i.user_id) into v_users
      from auth.identities i join public.profiles p on p.id = i.user_id
     where lower(i.identity_data->>'email') = v_email and p.kind = 'human'
       and (i.provider = 'email' or (i.provider = 'google' and coalesce((i.identity_data->>'email_verified')::boolean, false)));
    if cardinality(v_users) = 1 then v_to := v_users[1]; end if;
    -- first share = no earlier invitation for this target to this person, under any of their verified addresses, and no
    -- earlier notice; a block of the sharer or of the target's owner wins
    if v_to is not null and v_to <> auth.uid()
       and not exists (select 1 from public.invites x where coalesce(x.list_id, x.tag_list_id) = v_target
                        and (x.accepted_by = v_to or x.email_lower in (
                          select lower(i.identity_data->>'email') from auth.identities i where i.user_id = v_to and i.identity_data->>'email' is not null)))
       and not exists (select 1 from public.shared_notices s where s.profile_id = v_to and coalesce(s.list_id, s.tag_list_id) = v_target)
       and not exists (select 1 from public.invite_blocks b where b.profile_id = v_to and b.blocked_id in (auth.uid(), v_owner))
       and not exists (select 1 from public.list_members m where m.list_id = p_list and m.profile_id = v_to)
       and not exists (select 1 from public.tag_list_members m where m.tag_list_id = p_tag_list and m.profile_id = v_to) then
      insert into public.invites (list_id, tag_list_id, email_lower, role, invited_by, target_name, accepted_at, accepted_by, auto_joined)
      values (p_list, p_tag_list, v_email, p_role, auth.uid(), p_name, now(), v_to, true) returning id into v_id;
      if p_list is not null then
        insert into public.list_members (list_id, profile_id, role, added_by) values (p_list, v_to, p_role, auth.uid())
        on conflict (list_id, profile_id) do nothing;
      else
        insert into public.tag_list_members (tag_list_id, profile_id, role, added_by) values (p_tag_list, v_to, p_role, auth.uid())
        on conflict (tag_list_id, profile_id) do nothing;
      end if;
      insert into public.shared_notices (profile_id, list_id, tag_list_id, invite_id, invited_by, inviter_name, target_name, role)
      select v_to, p_list, p_tag_list, v_id, auth.uid(), p.display_name, p_name, p_role from public.profiles p where p.id = auth.uid();
      return jsonb_build_object('ok', true);
    end if;
  end if;
  -- an open or declined row is refreshed, so the owner always sees one "pending" row (S4); a decline is cleared
  -- unless the invitee blocked this sharer or the owner. An editor never takes over the owner's invitation (only the
  -- owner revokes it).
  select id into v_id from public.invites
   where coalesce(list_id, tag_list_id) = v_target and email_lower = v_email
     and accepted_at is null and revoked_at is null;
  if v_id is not null then
    update public.invites set role = p_role, target_name = p_name,
                              invited_by = case when invited_by = v_owner then invited_by else auth.uid() end,
                              created_at = now(), expires_at = now() + interval '30 days',
                              declined_at = case when exists (
                                select 1 from public.invite_blocks b join auth.identities i on i.user_id = b.profile_id
                                 where b.blocked_id in (auth.uid(), v_owner) and lower(i.identity_data->>'email') = v_email)
                                then declined_at end
     where id = v_id;
  else
    insert into public.invites (list_id, tag_list_id, email_lower, role, invited_by, target_name)
    values (p_list, p_tag_list, v_email, p_role, auth.uid(), p_name);
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.invite_upsert(p_list uuid, p_tag_list uuid, p_email text, p_role text, p_name text)
returns jsonb language sql security definer set search_path = '' as $$
  select public.invite_upsert(p_list, p_tag_list, p_email, p_role, p_name, false)
$$;

-- share a list (owner only); p_join: a first share joins at once (the app sends true; the 3-argument form invites)
create or replace function public.share_list(p_list uuid, p_email text, p_role text, p_join boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_name text; v_arch timestamptz;
begin
  if not public.is_human() or not public.has_list_role(p_list, array['owner']) then
    raise exception 'only the owner shares a list' using errcode = '42501';
  end if;
  if p_role not in ('editor','contributor','viewer') then raise exception 'unknown role' using errcode = '22023'; end if;
  select name, archived_at into v_name, v_arch from public.lists where id = p_list;
  if v_arch is not null then raise exception 'this list is archived' using errcode = '22023'; end if;
  return public.invite_upsert(p_list, null, p_email, p_role, v_name, coalesce(p_join, false));
end $$;

create or replace function public.share_list(p_list uuid, p_email text, p_role text default 'viewer') returns jsonb
language sql security definer set search_path = '' as $$
  select public.share_list(p_list, p_email, p_role, false)
$$;

-- share a tag list: the owner or an editor (G5), up to editor; not an archived one
create or replace function public.share_tag_list(p_tag_list uuid, p_email text, p_role text, p_join boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_name text; v_arch timestamptz;
begin
  if not public.is_human() or not public.has_tag_list_role(p_tag_list, array['owner','editor']) then
    raise exception 'only owners and editors share a tag list' using errcode = '42501';
  end if;
  if p_role not in ('editor','contributor','viewer') then raise exception 'unknown role' using errcode = '22023'; end if;
  select name, archived_at into v_name, v_arch from public.tag_lists where id = p_tag_list;
  if v_arch is not null then raise exception 'this tag list is archived' using errcode = '22023'; end if;
  return public.invite_upsert(null, p_tag_list, p_email, p_role, v_name, coalesce(p_join, false));
end $$;

create or replace function public.share_tag_list(p_tag_list uuid, p_email text, p_role text default 'viewer') returns jsonb
language sql security definer set search_path = '' as $$
  select public.share_tag_list(p_tag_list, p_email, p_role, false)
$$;

-- the caller's open invitations, not into archived lists or tag lists (V4-8)
create or replace function public.my_invitations()
returns table (id uuid, kind text, target_name text, inviter_name text, role text, created_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, case when i.list_id is not null then 'list' else 'tag_list' end, i.target_name, p.display_name, i.role,
         i.created_at, i.expires_at
    from public.invites i join public.profiles p on p.id = i.invited_by
    left join public.lists l on l.id = i.list_id left join public.tag_lists t on t.id = i.tag_list_id
   where i.email_lower in (select public.my_verified_emails())
     and i.accepted_at is null and i.declined_at is null and i.revoked_at is null and i.expires_at > now()
     and i.invited_by <> auth.uid() and coalesce(l.archived_at, t.archived_at) is null
     and not exists (select 1 from public.invite_blocks b where b.profile_id = auth.uid() and b.blocked_id = i.invited_by)
   order by i.created_at desc
$$;

-- accept an open invitation addressed to the caller; into an archived list or tag list: 22023 (V4-8). Decline stays
-- possible (decline_invite reads my_open_invite, which is unchanged).
create or replace function public.accept_invite(p_invite uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.invites;
begin
  if not public.is_human() then raise exception 'only people accept invitations' using errcode = '42501'; end if;
  v := public.my_open_invite(p_invite);
  if v.id is null then raise exception 'no such invitation' using errcode = '42501'; end if;
  if exists (select 1 from public.lists where id = v.list_id and archived_at is not null)
     or exists (select 1 from public.tag_lists where id = v.tag_list_id and archived_at is not null) then
    raise exception 'this list is archived' using errcode = '22023';
  end if;
  if v.list_id is not null then
    insert into public.list_members (list_id, profile_id, role, added_by) values (v.list_id, auth.uid(), v.role, v.invited_by)
    on conflict (list_id, profile_id) do update set role = excluded.role, hidden_at = null
      where public.list_members.role <> 'owner';
  else
    insert into public.tag_list_members (tag_list_id, profile_id, role, added_by) values (v.tag_list_id, auth.uid(), v.role, v.invited_by)
    on conflict (tag_list_id, profile_id) do update set role = excluded.role, hidden_at = null
      where public.tag_list_members.role <> 'owner';
  end if;
  update public.invites set accepted_at = now(), accepted_by = auth.uid() where id = v.id;
  return jsonb_build_object('ok', true, 'list_id', v.list_id, 'tag_list_id', v.tag_list_id);
end $$;

-- the sharer withdraws an invitation: the owner any; an editor who shared a tag list only their own pending one. An
-- accepted one also removes that member (never an owner): owners only remove people.
create or replace function public.revoke_invite(p_invite uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.invites; v_owner boolean;
begin
  select * into v from public.invites where id = p_invite and revoked_at is null;
  v_owner := (v.list_id is not null and public.has_list_role(v.list_id, array['owner']))
          or (v.tag_list_id is not null and public.has_tag_list_role(v.tag_list_id, array['owner']));
  if v.id is null or not (coalesce(v_owner, false)
                          or (v.tag_list_id is not null and v.invited_by = auth.uid() and v.accepted_at is null
                              and public.has_tag_list_role(v.tag_list_id, array['editor']))) then
    raise exception 'no such invitation' using errcode = '42501';
  end if;
  update public.invites set revoked_at = now() where id = v.id;
  if v.accepted_by is not null then
    delete from public.list_members where list_id = v.list_id and profile_id = v.accepted_by and role <> 'owner';
    delete from public.tag_list_members where tag_list_id = v.tag_list_id and profile_id = v.accepted_by and role <> 'owner';
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- people on a tag list: members for every member; pending invitations for the owner and editors (they share)
create or replace function public.tag_list_people(p_tag_list uuid)
returns table (profile_id uuid, display_name text, email text, role text, state text, invite_id uuid)
language sql stable security definer set search_path = '' as $$
  select m.profile_id, p.display_name, null::text, m.role, 'member', null::uuid
    from public.tag_list_members m join public.profiles p on p.id = m.profile_id
   where m.tag_list_id = p_tag_list and public.has_tag_list_role(p_tag_list, array['owner','editor','contributor','viewer'])
  union all
  select null, null, i.email_lower, i.role, 'pending', i.id
    from public.invites i
   where i.tag_list_id = p_tag_list and public.has_tag_list_role(p_tag_list, array['owner','editor'])
     and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
$$;

-- the one-time notice of a first share: seen, leave, or block (leave and block the sharer)
create or replace function public.answer_shared_notice(p_notice uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.shared_notices;
begin
  select * into v from public.shared_notices where id = p_notice and profile_id = auth.uid();
  if v.id is null then raise exception 'no such notice' using errcode = '42501'; end if;
  if p_action not in ('seen','leave','block') then raise exception 'unknown action' using errcode = '22023'; end if;
  update public.shared_notices set seen_at = coalesce(seen_at, now()) where id = v.id;
  if p_action in ('leave','block') then
    delete from public.list_members where list_id = v.list_id and profile_id = auth.uid() and role <> 'owner';
    delete from public.tag_list_members where tag_list_id = v.tag_list_id and profile_id = auth.uid() and role <> 'owner';
  end if;
  if p_action = 'block' then
    insert into public.invite_blocks (profile_id, blocked_id) values (auth.uid(), v.invited_by) on conflict do nothing;
    -- every other list and tag list this sharer joined the caller to without Accept goes too
    delete from public.list_members m using public.invites i
     where i.accepted_by = auth.uid() and i.invited_by = v.invited_by and i.auto_joined
       and m.list_id = i.list_id and m.profile_id = auth.uid() and m.role <> 'owner';
    delete from public.tag_list_members m using public.invites i
     where i.accepted_by = auth.uid() and i.invited_by = v.invited_by and i.auto_joined
       and m.tag_list_id = i.tag_list_id and m.profile_id = auth.uid() and m.role <> 'owner';
    update public.shared_notices set seen_at = coalesce(seen_at, now()) where profile_id = auth.uid() and invited_by = v.invited_by;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- urgency settings for HomeOS readers (G12) ----------

-- windowDays, threshold and doLimit from a person's app preferences (null when unset; readers use the app defaults).
-- Readable for oneself, and by household members and agents for household profiles; anything else 42501.
create or replace function public.urgency_settings(p_profile uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid := coalesce(p_profile, auth.uid()); v_hh boolean; v jsonb;
begin
  select is_household into v_hh from public.profiles where id = v_id;
  if not (public.is_admin_sql() or (v_id = auth.uid() and v_hh is not null) or (coalesce(v_hh, false) and public.is_household())) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select prefs->'settings' into v from public.preferences where profile_id = v_id;
  return jsonb_build_object('profile_id', v_id,
    'windowDays', case when jsonb_typeof(v->'windowDays') = 'number' then v->'windowDays' end,
    'threshold',  case when jsonb_typeof(v->'threshold')  = 'number' then v->'threshold'  end,
    'doLimit',    case when jsonb_typeof(v->'doLimit')    = 'number' then v->'doLimit'    end);
end $$;

-- ---------- sign-up (V4-1) ----------

-- New auth user: a profile (guest unless an allowlist row says otherwise), "My tasks" for people, a "My tags" default
-- tag list, the allowlist row marked used. 012: a password login made through the API claims a live allowlist row
-- only with that row's nonce in its metadata (signup_nonce; tasksdb.js add-login sends it), else the insert is
-- refused, so nobody who merely knows the address can take the row's kind while it is live. Admin SQL needs no nonce.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row    ops.signup_allowlist%rowtype;
  v_kind   text := 'human';
  v_hh     boolean := false;
  v_handle text;
  v_name   text;
  v_list   uuid;
  v_tl     uuid;
  v_email  boolean := coalesce(new.raw_app_meta_data->>'provider', '') = 'email';
  v_nonce  text := coalesce(new.raw_user_meta_data->>'signup_nonce', new.raw_app_meta_data->>'signup_nonce');
begin
  if exists (select 1 from public.profiles where id = new.id) then return null; end if;
  if public.is_admin_sql() and coalesce(new.raw_app_meta_data->>'provider', '') = '' then return null; end if;
  -- allowlist rows are for password logins only; a Google sign-up never claims one
  select * into v_row from ops.signup_allowlist a
   where a.email_lower = lower(new.email) and a.used_at is null and a.expires_at > now() and v_email
     and (public.is_admin_sql() or a.nonce = v_nonce)
   order by a.created_at limit 1 for update;
  if found then
    v_kind := v_row.kind; v_hh := v_row.is_household;
    update ops.signup_allowlist set used_at = now() where id = v_row.id;
  elsif v_email and not public.is_admin_sql() then
    raise exception 'password logins are made with tasksdb.js add-login' using errcode = '42501';
  end if;
  v_name := left(regexp_replace(trim(coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', '')),
                                '[[:cntrl:]]', '', 'g'), 60);
  if v_name = '' then v_name := left(nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 60); end if;
  v_name := coalesce(nullif(v_name, ''), 'User');
  loop
    v_handle := 'u-' || substr(md5(random()::text || clock_timestamp()::text || new.id::text), 1, 8);
    exit when not exists (select 1 from public.profiles where handle = v_handle);
  end loop;
  insert into public.profiles (id, handle, display_name, kind, email, is_household, mine_tags, reminder_channel)
  values (new.id, v_handle, v_name, v_kind, new.email, v_hh, '{}', 'local');
  if v_kind = 'human' then
    insert into public.lists (slug, name, default_category, owner_id, created_by, sort)
    values ('my-tasks', 'My tasks', 'task', new.id, new.id, 1) returning id into v_list;
    insert into public.list_members (list_id, profile_id, role, added_by) values (v_list, new.id, 'owner', new.id);
  end if;
  insert into public.tag_lists (owner_id, name, is_default) values (new.id, 'My tags', true) returning id into v_tl;
  insert into public.tag_list_members (tag_list_id, profile_id, role, added_by) values (v_tl, new.id, 'owner', new.id);
  return null;
end $$;

-- >>> 012 policies: grants and policies that 003 and 011 reset. tasksdb.js apply-sql appends this block after 003 and
-- 011 (order rule 003, 011, this block, 900, 901, 902). Re-runnable.

revoke all on public.shared_notices from anon, authenticated;
grant select on public.shared_notices to authenticated;
grant select (mine_tag_ids), update (mine_tag_ids) on public.profiles to authenticated;
grant select (auto_joined) on public.invites to authenticated;

revoke execute on function
  public.create_list_row(text, text, boolean, text), public.share_list(uuid, text, text, boolean),
  public.share_tag_list(uuid, text, text, boolean), public.answer_shared_notice(uuid, text), public.create_tag_list(text),
  public.set_default_tag_list(uuid), public.set_tag_list_archived(uuid, boolean), public.move_tags(uuid[], uuid),
  public.merge_tags(uuid, uuid), public.merge_tag_lists(uuid, uuid), public.urgency_settings(uuid),
  public.invite_upsert(uuid, uuid, text, text, text, boolean), public.merge_tag_into(uuid, uuid),
  public.tag_lists_same_editable(uuid, uuid), public.tag_lists_before_write()
  from public, anon;
grant execute on function
  public.create_list_row(text, text, boolean, text), public.share_list(uuid, text, text, boolean),
  public.share_tag_list(uuid, text, text, boolean), public.answer_shared_notice(uuid, text), public.create_tag_list(text),
  public.set_default_tag_list(uuid), public.set_tag_list_archived(uuid, boolean), public.move_tags(uuid[], uuid),
  public.merge_tags(uuid, uuid), public.merge_tag_lists(uuid, uuid), public.urgency_settings(uuid)
  to authenticated;
revoke execute on function
  public.invite_upsert(uuid, uuid, text, text, text, boolean), public.merge_tag_into(uuid, uuid),
  public.tag_lists_same_editable(uuid, uuid), public.tag_lists_before_write()
  from authenticated;

-- tag lists (G4, G5): viewer reads and uses tags; contributor also adds, renames and reorders tags; editor also deletes
-- tags and renames and reorders lists (archive, move, merge and share are functions); owner also manages people
drop policy if exists tag_lists_read on public.tag_lists;
create policy tag_lists_read on public.tag_lists for select to authenticated
  using (public.has_tag_list_role(id, array['owner','editor','contributor','viewer']));
drop policy if exists tag_lists_edit on public.tag_lists;
create policy tag_lists_edit on public.tag_lists for update to authenticated
  using (public.has_tag_list_role(id, array['owner','editor'])) with check (public.has_tag_list_role(id, array['owner','editor']));

drop policy if exists tags_read on public.tags;
create policy tags_read on public.tags for select to authenticated
  using (public.has_tag_list_role(tag_list_id, array['owner','editor','contributor','viewer']));
drop policy if exists tags_add on public.tags;
create policy tags_add on public.tags for insert to authenticated
  with check (public.has_tag_list_role(tag_list_id, array['owner','editor','contributor']));
drop policy if exists tags_edit on public.tags;
create policy tags_edit on public.tags for update to authenticated
  using (public.has_tag_list_role(tag_list_id, array['owner','editor','contributor']))
  with check (public.has_tag_list_role(tag_list_id, array['owner','editor','contributor']));

drop policy if exists item_tags_read on public.item_tags;
create policy item_tags_read on public.item_tags for select to authenticated
  using (public.has_item_role(item_id, array['owner','editor','contributor','viewer'])
     and public.has_tag_role(tag_id, array['owner','editor','contributor','viewer']));
drop policy if exists item_tags_add on public.item_tags;
create policy item_tags_add on public.item_tags for insert to authenticated
  with check (public.can_edit_item(item_id) and public.has_tag_role(tag_id, array['owner','editor','contributor','viewer']));
drop policy if exists item_tags_edit on public.item_tags;
create policy item_tags_edit on public.item_tags for update to authenticated
  using (public.can_edit_item(item_id) and public.has_tag_role(tag_id, array['owner','editor','contributor','viewer']))
  with check (public.can_edit_item(item_id) and public.has_tag_role(tag_id, array['owner','editor','contributor','viewer']));

drop policy if exists shared_notices_own on public.shared_notices;
create policy shared_notices_own on public.shared_notices for select to authenticated using (profile_id = auth.uid());

-- final check, as in 011, plus this block in force
do $$
declare v text;
begin
  select string_agg(c.relname, ', ') into v from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if v is not null then raise exception '012: RLS is off on public tables: %', v; end if;
  select string_agg(p.proname, ', ') into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
  if v is not null then raise exception '012: functions executable by anon: %', v; end if;
  if has_function_privilege('authenticated', 'public.invite_upsert(uuid, uuid, text, text, text, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.merge_tag_into(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.tag_lists_same_editable(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.tag_lists_before_write()', 'execute') then
    raise exception '012: an internal function is executable by authenticated';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'item_tags_add' and with_check like '%viewer%') then
    raise exception '012: the tag-list role policies are not in force';
  end if;
end $$;
-- <<< 012 policies
