-- db/010_multiuser_functions.sql: multi-user functions and triggers (HomeOS multi-user-plan.md T3, review §5-§9).
-- Replaces items_before_write (from 006; the order is 002 -> 006 -> 010), create_list and keepalive_status; adds the tag
-- compatibility trigger, the sign-up hook, handle_new_user, the identity guards on auth.users and auth.identities,
-- invitations, membership functions and visible_profiles. Every function is security definer with search_path = ''.
-- Error codes: 42501 not allowed, 22023 bad value, 54000 limit reached. Re-runnable.
-- Order rule after this file: 003_rls.sql, 011_multiuser_rls.sql, 900_selftest.sql, 901_selftest_multiuser.sql.

-- ---------- helpers ----------

-- admin = a direct SQL session (Management API, SQL editor), never a PostgREST request or GoTrue
create or replace function public.is_admin_sql() returns boolean
language sql stable set search_path = '' as $$
  select session_user in ('postgres','supabase_admin') and nullif(current_setting('request.jwt.claims', true), '') is null
$$;

-- a limit from ops.settings; a missing key raises, so a limit never fails open
create or replace function public.setting(p_key text) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v numeric;
begin
  select value into v from ops.settings where key = p_key;
  if v is null then raise exception 'ops.settings has no %', p_key; end if;
  return v;
end $$;

create or replace function public.is_household() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_household from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.has_tag_list_role(p_tag_list uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tag_list_members m
                 where m.tag_list_id = p_tag_list and m.profile_id = auth.uid() and m.role = any (p_roles))
$$;

create or replace function public.has_tag_role(p_tag uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select public.has_tag_list_role(t.tag_list_id, p_roles) from public.tags t where t.id = p_tag), false)
$$;

-- edit rights on an item, as items_edit in 003: owner or editor, or a contributor on their own item
create or replace function public.can_edit_item(p_item uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select public.has_list_role(i.list_id, array['owner','editor'])
                       or (public.has_list_role(i.list_id, array['contributor']) and i.created_by = auth.uid())
                     from public.items i where i.id = p_item), false)
$$;

-- category visible to the caller: audience all, or household members and agents (F3)
create or replace function public.can_use_category(p_slug text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.categories c
                 where c.slug = p_slug and (c.audience = 'all' or public.is_household()))
$$;

-- the caller's verified identity emails (S1): Google identities with email_verified, and email identities (admin-made,
-- because the hook refuses password sign-ups). Never the JWT email claim.
create or replace function public.my_verified_emails() returns setof text
language sql stable security definer set search_path = '' as $$
  select distinct lower(i.identity_data->>'email') from auth.identities i
   where i.user_id = auth.uid() and i.identity_data->>'email' is not null
     and (i.provider = 'email'
          or (i.provider = 'google' and coalesce((i.identity_data->>'email_verified')::boolean, false)))
$$;

-- ---------- items ----------

create or replace function public.items_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  -- admin = a direct SQL session (Management API, SQL editor), never a PostgREST request.
  -- session_user, not current_user: inside a security definer function current_user is always the owner.
  v_admin boolean := session_user in ('postgres','supabase_admin')
                     and nullif(current_setting('request.jwt.claims', true), '') is null;
  v_kind  text;
  v_hh    boolean;
  v_n     int;
begin
  if not v_admin then
    select kind, is_household into v_kind, v_hh from public.profiles where id = v_uid;
    if v_kind is null then raise exception 'no profile for this login' using errcode = '42501'; end if;
  end if;

  if tg_op = 'INSERT' then
    if v_admin then                                   -- migration and seed: caller supplies created_by and num
      if new.created_by is null then raise exception 'admin insert needs created_by'; end if;
      new.updated_by := new.created_by;
      select kind into new.actor_kind from public.profiles where id = new.created_by;
    else
      new.created_by := v_uid; new.updated_by := v_uid; new.actor_kind := v_kind;
      new.created_at := now(); new.version := 1; new.deleted_at := null; new.num := null;
      if exists (select 1 from public.lists where id = new.list_id and archived_at is not null) then
        raise exception 'this list is archived' using errcode = '42501';
      end if;
      if new.created_via = 'migration' then
        raise exception 'created_via migration is reserved for admin SQL' using errcode = '42501';
      end if;
      if v_kind = 'agent' then
        new.validation := 'unverified';
        if new.created_via = 'app' then
          raise exception 'agents must name their channel (skill:, routine:, script:, project:, telegram)' using errcode = '42501';
        end if;
        if new.review_state not in ('none','needs_review') then
          raise exception 'only people confirm or reject items' using errcode = '42501';
        end if;
      else
        new.on_behalf_of := null;
      end if;
      -- 010: category audience (F3) and limits (D-g)
      if not public.can_use_category(new.category) then
        raise exception 'this category is not available' using errcode = '42501';
      end if;
      if v_hh then
        select count(*) into v_n from public.items
         where list_id = new.list_id and deleted_at is null and status not in ('done','cancelled');
        if v_n >= public.setting('household_items_per_list') then
          raise exception 'this list is full' using errcode = '54000';
        end if;
      else
        select count(*) into v_n from public.items where created_by = v_uid and deleted_at is null;
        if v_n >= public.setting('guest_items') then
          raise exception 'item limit reached' using errcode = '54000';
        end if;
        select count(*) into v_n from public.items where created_by = v_uid;
        if v_n >= public.setting('guest_items_total') then
          raise exception 'item limit reached' using errcode = '54000';
        end if;
      end if;
    end if;
    select owner_id into new.space_owner_id from public.lists where id = new.list_id;   -- 010 (F5)
    if new.num is null then
      update public.lists set next_num = next_num + 1 where id = new.list_id returning next_num - 1 into new.num;
    else
      update public.lists set next_num = greatest(next_num, new.num + 1) where id = new.list_id;
    end if;
  else -- UPDATE
    new.id := old.id; new.created_by := old.created_by; new.created_at := old.created_at;
    new.actor_kind := old.actor_kind; new.created_via := old.created_via; new.dedup_key := old.dedup_key;
    new.on_behalf_of := old.on_behalf_of;
    new.updated_by := coalesce(v_uid, old.updated_by); new.version := old.version + 1;
    if new.list_id is distinct from old.list_id then
      update public.lists set next_num = next_num + 1 where id = new.list_id returning next_num - 1 into new.num;
      select owner_id into new.space_owner_id from public.lists where id = new.list_id;  -- 010 (F5)
    else
      new.num := old.num; new.space_owner_id := old.space_owner_id;
    end if;
    if not v_admin then
      -- 006: an archived list is frozen; only admin SQL changes its items (design.md D18)
      if exists (select 1 from public.lists where id = old.list_id and archived_at is not null) then
        raise exception 'this list is archived' using errcode = '42501';
      end if;
      if new.list_id is distinct from old.list_id
         and exists (select 1 from public.lists where id = new.list_id and archived_at is not null) then
        raise exception 'this list is archived' using errcode = '42501';
      end if;
      if new.category is distinct from old.category and not public.can_use_category(new.category) then
        raise exception 'this category is not available' using errcode = '42501';
      end if;
      if new.deleted_at is distinct from old.deleted_at then
        if v_kind = 'agent' then
          raise exception 'agents cannot delete or restore items' using errcode = '42501';
        end if;
        if not public.has_list_role(old.list_id, array['owner','editor']) then
          raise exception 'only owners and editors delete or restore items' using errcode = '42501';
        end if;
      end if;
      if v_kind = 'agent' then
        if new.validation = 'verified' and old.validation <> 'verified' then
          raise exception 'agents cannot mark items verified' using errcode = '42501';
        end if;
        if new.review_state in ('confirmed','rejected') and new.review_state is distinct from old.review_state then
          raise exception 'only people confirm or reject items' using errcode = '42501';
        end if;
        if old.review_state in ('confirmed','rejected') and new.review_state is distinct from old.review_state then
          raise exception 'only people change a review decision' using errcode = '42501';
        end if;
        -- an AI edit of a person-verified item is no longer verified (design §9: an AI yes is not evidence)
        if (new.title, new.body_md, new.details) is distinct from (old.title, old.body_md, old.details) then
          new.validation := 'unverified';
        end if;
      end if;
    end if;
  end if;

  -- 010: owner_id must be a member of the item's list (F8). Set explicitly to a non-member: 22023; carried along by a
  -- move into a list the owner is not in: cleared. An unchanged owner on an unmoved item is left as it is.
  if new.owner_id is not null and not v_admin
     and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id or new.list_id is distinct from old.list_id)
     and not exists (select 1 from public.list_members m where m.list_id = new.list_id and m.profile_id = new.owner_id) then
    if tg_op = 'UPDATE' and new.owner_id is not distinct from old.owner_id then
      new.owner_id := null;
    else
      raise exception 'owner must be a member of the list' using errcode = '22023';
    end if;
  end if;
  -- on_behalf_of: a household person (F8)
  if new.on_behalf_of is not null and not exists
     (select 1 from public.profiles where id = new.on_behalf_of and kind = 'human' and is_household) then
    raise exception 'on_behalf_of must be a person' using errcode = '22023';
  end if;
  -- guest size limits (D-g)
  if not v_admin and not v_hh
     and (tg_op = 'INSERT' or (new.body_md, new.details) is distinct from (old.body_md, old.details)) then
    if char_length(new.body_md) > public.setting('guest_body_chars')
       or octet_length(new.details::text) > public.setting('guest_details_bytes') then
      raise exception 'text too long' using errcode = '54000';
    end if;
  end if;
  if new.status = 'done' then
    -- keep the first completion time; a done -> done edit never re-stamps it
    new.completed_at := case when tg_op = 'UPDATE' and old.status = 'done'
                             then coalesce(old.completed_at, new.completed_at, now())
                             else coalesce(new.completed_at, now()) end;
  else
    new.completed_at := null;
  end if;
  new.updated_at := now();
  -- only new or changed text is screened, so an old row never becomes uneditable
  if tg_op = 'INSERT' or (new.title, new.body_md, new.details, new.tags, new.source_ref, new.ai)
     is distinct from (old.title, old.body_md, old.details, old.tags, old.source_ref, old.ai) then
    perform public.assert_no_sensitive(concat_ws(' ', new.title, new.body_md, new.details::text,
                                                 array_to_string(new.tags, ' '), new.source_ref, new.ai::text));
  end if;
  return new;
end $$;
drop trigger if exists items_before_write on public.items;
create trigger items_before_write before insert or update on public.items
  for each row execute function public.items_before_write();

-- Write rate (S7), per statement: AFTER STATEMENT runs after the statement's row events are written, so a bulk PATCH or
-- an array POST is counted in full and rolled back whole. Household members and agents have their own, higher rate;
-- guests also have a daily quota.
create or replace function public.items_write_rate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_hh boolean; v_n int;
begin
  if public.is_admin_sql() or v_uid is null then return null; end if;
  select is_household into v_hh from public.profiles where id = v_uid;
  select count(*) into v_n from public.item_events e where e.actor_id = v_uid and e.at > now() - interval '1 minute';
  if v_n > public.setting(case when coalesce(v_hh, false) then 'household_write_rate_per_min' else 'write_rate_per_min' end) then
    raise exception 'too many changes in a minute; wait a moment' using errcode = '54000';
  end if;
  if not coalesce(v_hh, false) then
    select count(*) into v_n from public.item_events e where e.actor_id = v_uid and e.at > now() - interval '1 day';
    if v_n > public.setting('guest_writes_per_day') then
      raise exception 'too many changes today' using errcode = '54000';
    end if;
  end if;
  return null;
end $$;
drop trigger if exists items_write_rate on public.items;
create trigger items_write_rate after insert or update on public.items
  for each statement execute function public.items_write_rate();

-- every item has a space owner from here on (009 back-filled the existing ones)
update public.items i set space_owner_id = l.owner_id
  from public.lists l where l.id = i.list_id and i.space_owner_id is null;
alter table public.items alter column space_owner_id set not null;

-- ---------- tags ----------

-- Compatibility (review §6): writers may still send items.tags. The names are filed into a Default tag list and the
-- column is cleared. Whose Default: a person's own; an agent's on_behalf_of person's, else the list owner's (the agent
-- must edit that Default, else 42501); admin SQL: the list owner's. Additive on INSERT and UPDATE: names are added (a
-- removed one comes back), nothing is removed; an empty array changes nothing. Removal goes through item_tags.
-- The before trigger runs after items_before_write (name order), so the sensitive-data screen saw the names.
create or replace function public.items_tags_compat() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if cardinality(new.tags) > 0 then
    perform set_config('tdb.tags_' || replace(new.id::text, '-', ''), array_to_string(new.tags, chr(31)), true);
    new.tags := '{}';
  end if;
  return new;
end $$;
drop trigger if exists items_tags_compat on public.items;
create trigger items_tags_compat before insert or update on public.items
  for each row execute function public.items_tags_compat();

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
  v_tag   uuid;
  v_name  text;
begin
  if v_raw is null then return null; end if;
  perform set_config(v_key, '', true);
  select array_agg(distinct trim(x)) into v_names from unnest(string_to_array(v_raw, chr(31))) x where trim(x) <> '';
  if v_names is null then return null; end if;
  select kind into v_kind from public.profiles where id = v_uid;
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

-- tags: trimmed names, the sensitive-data screen, the per-owner limit
create or replace function public.tags_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_hh boolean; v_n int;
begin
  new.name := trim(new.name);
  if tg_op = 'UPDATE' then new.tag_list_id := old.tag_list_id; new.created_by := old.created_by; new.created_at := old.created_at;
  else new.created_by := coalesce(auth.uid(), new.created_by); new.created_at := now(); end if;
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
drop trigger if exists tags_before_write on public.tags;
create trigger tags_before_write before insert or update on public.tags
  for each row execute function public.tags_before_write();

-- item_tags: who added it, when it changed; the pair never changes
create or replace function public.item_tags_before_write() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.item_id := old.item_id; new.tag_id := old.tag_id; new.added_by := old.added_by; new.created_at := old.created_at;
  else
    new.added_by := coalesce(auth.uid(), new.added_by); new.created_at := now();
  end if;
  new.changed_at := now();
  return new;
end $$;
drop trigger if exists item_tags_before_write on public.item_tags;
create trigger item_tags_before_write before insert or update on public.item_tags
  for each row execute function public.item_tags_before_write();

drop trigger if exists tag_lists_touch on public.tag_lists;
create trigger tag_lists_touch before update on public.tag_lists for each row execute function public.touch();
drop trigger if exists tag_list_members_stamp on public.tag_list_members;
create trigger tag_list_members_stamp before insert on public.tag_list_members
  for each row execute function public.stamp_added_by();

-- owners of tag lists change by admin SQL only, as for lists
create or replace function public.tag_members_keep_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner'))
     or (tg_op = 'UPDATE' and new.role = 'owner' and old.role <> 'owner') then
    if not public.is_admin_sql() then
      raise exception 'owners are changed by admin SQL only' using errcode = '42501';
    end if;
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists tag_members_keep_owner on public.tag_list_members;
create trigger tag_members_keep_owner before update or delete on public.tag_list_members
  for each row execute function public.tag_members_keep_owner();

-- list members: owner is not grantable (D-c); a member who leaves or is removed is cleared as item owner (review §6)
create or replace function public.members_keep_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if ((old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner'))
      or (tg_op = 'UPDATE' and new.role = 'owner' and old.role <> 'owner'))
     and not (session_user in ('postgres','supabase_admin')
              and nullif(current_setting('request.jwt.claims', true), '') is null) then
    raise exception 'owners are changed by admin SQL only' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

create or replace function public.members_after_remove() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.items i set owner_id = null
   where i.list_id = old.list_id and i.owner_id = old.profile_id
     and not exists (select 1 from public.lists l where l.id = i.list_id and l.archived_at is not null);
  return null;
end $$;
drop trigger if exists members_after_remove on public.list_members;
create trigger members_after_remove after delete on public.list_members
  for each row execute function public.members_after_remove();

-- ---------- lists ----------

-- New list: people only. Private unless p_shared, which means "share with the household": household members only,
-- adding the other household people and homeos-agent as editors (F1). Sort over the caller's own lists (F9).
create or replace function public.create_list(p_name text, p_slug text default null,
                                              p_shared boolean default false, p_default_category text default 'task')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_hh boolean := public.is_household(); v_n int;
        v_slug text := coalesce(p_slug, trim(both '-' from lower(regexp_replace(trim(p_name), '[^A-Za-z0-9]+', '-', 'g'))));
begin
  if not public.is_human() then raise exception 'only people create lists' using errcode = '42501'; end if;
  if p_shared and not v_hh then raise exception 'only household members share with the household' using errcode = '42501'; end if;
  if v_slug !~ '^[a-z0-9_][a-z0-9-]*$' then
    raise exception 'a list name needs letters or digits' using errcode = '22023';
  end if;
  if p_default_category is not null and not public.can_use_category(p_default_category) then
    raise exception 'this category is not available' using errcode = '42501';
  end if;
  select count(*) into v_n from public.lists where owner_id = auth.uid() and archived_at is null;
  if v_n >= public.setting(case when v_hh then 'household_lists' else 'guest_lists' end)
     or (not v_hh and (select count(*) from public.lists where owner_id = auth.uid()) >= public.setting('guest_lists_total')) then
    raise exception 'list limit reached' using errcode = '54000';
  end if;
  insert into public.lists (slug, name, default_category, owner_id, created_by, sort)
  values (v_slug, trim(p_name), p_default_category, auth.uid(), auth.uid(),
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

-- Keep-alive status for /audit: household members and agents only (F6)
create or replace function public.keepalive_status() returns table (host text, pinged_at timestamptz, runs int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_household() or public.is_agent()) or to_regclass('ops.keepalive') is null then return; end if;
  return query select k.host, k.pinged_at, k.runs from ops.keepalive k order by k.pinged_at desc;
end $$;

-- ---------- sign-up ----------

-- Before User Created hook (review §5). Google: allowed under the user and size caps. Email (password): only with a
-- live one-shot ops.signup_allowlist row. Anything else: refused. Granted to supabase_auth_admin only (011).
create or replace function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_provider text := event->'user'->'app_metadata'->>'provider';
  v_email    text := lower(event->'user'->>'email');
begin
  if v_provider = 'google' then
    if (select count(*) from public.profiles where kind = 'human') >= public.setting('max_users')
       or pg_database_size(current_database()) >= public.setting('max_db_mb') * 1024 * 1024 then
      return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'TasksDashboard is full right now.'));
    end if;
    return '{}'::jsonb;
  end if;
  if v_provider = 'email' and v_email is not null
     and exists (select 1 from ops.signup_allowlist a
                  where a.email_lower = v_email and a.used_at is null and a.expires_at > now()) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Sign-up is by Google only.'));
end $$;

-- New auth user: a profile (guest unless an allowlist row says otherwise), "My tasks" for people, a Default tag list,
-- the allowlist row marked used. No other membership. A bare admin insert without a provider (900's fixtures) makes
-- its own profile and is skipped; GoTrue always sets the provider.
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
begin
  if exists (select 1 from public.profiles where id = new.id) then return null; end if;
  if public.is_admin_sql() and coalesce(new.raw_app_meta_data->>'provider', '') = '' then return null; end if;
  -- allowlist rows are for password logins only; a Google sign-up never claims one
  select * into v_row from ops.signup_allowlist a
   where a.email_lower = lower(new.email) and a.used_at is null and a.expires_at > now()
     and coalesce(new.raw_app_meta_data->>'provider', '') = 'email'
   order by a.created_at limit 1 for update;
  if found then
    v_kind := v_row.kind; v_hh := v_row.is_household;
    update ops.signup_allowlist set used_at = now() where id = v_row.id;
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
  insert into public.tag_lists (owner_id, name, is_default) values (new.id, 'Default', true) returning id into v_tl;
  insert into public.tag_list_members (tag_list_id, profile_id, role, added_by) values (v_tl, new.id, 'owner', new.id);
  return null;
end $$;
drop trigger if exists handle_new_user on auth.users;
create trigger handle_new_user after insert on auth.users for each row execute function public.handle_new_user();

-- Identity guards (S1, S2). An email change outside admin SQL is refused; a non-email identity on an agent is refused.
create or replace function public.guard_auth_email_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- allowed: admin SQL, or the new address is already one of this user's verified Google identity emails (a Google
  -- account whose address changed); never an address the user merely typed
  if new.email is distinct from old.email and old.email is not null and not public.is_admin_sql()
     and not exists (select 1 from auth.identities i
                      where i.user_id = new.id and i.provider = 'google'
                        and lower(i.identity_data->>'email') = lower(new.email)
                        and coalesce((i.identity_data->>'email_verified')::boolean, false)) then
    raise exception 'email changes are made by admin SQL only' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists guard_auth_email_change on auth.users;
create trigger guard_auth_email_change before update of email on auth.users
  for each row execute function public.guard_auth_email_change();

create or replace function public.guard_auth_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.provider <> 'email' and exists (select 1 from public.profiles where id = new.user_id and kind = 'agent') then
    raise exception 'agent logins sign in with a password only' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists guard_auth_identity on auth.identities;
create trigger guard_auth_identity before insert or update of provider, user_id on auth.identities
  for each row execute function public.guard_auth_identity();

-- ---------- invitations ----------

-- one body for share_list and share_tag_list: the same answer for every email (S4, S5)
create or replace function public.invite_upsert(p_list uuid, p_tag_list uuid, p_email text, p_role text, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(trim(coalesce(p_email, ''))); v_n int; v_id uuid;
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
  -- an open or declined row is refreshed, so the owner always sees one "pending" row (S4); a decline is cleared
  -- unless the invitee blocked this owner
  select id into v_id from public.invites
   where coalesce(list_id, tag_list_id) = coalesce(p_list, p_tag_list) and email_lower = v_email
     and accepted_at is null and revoked_at is null;
  if v_id is not null then
    update public.invites set role = p_role, invited_by = auth.uid(), target_name = p_name,
                              created_at = now(), expires_at = now() + interval '30 days',
                              declined_at = case when exists (
                                select 1 from public.invite_blocks b join auth.identities i on i.user_id = b.profile_id
                                 where b.blocked_id = auth.uid() and lower(i.identity_data->>'email') = v_email)
                                then declined_at end
     where id = v_id;
  else
    insert into public.invites (list_id, tag_list_id, email_lower, role, invited_by, target_name)
    values (p_list, p_tag_list, v_email, p_role, auth.uid(), p_name);
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.share_list(p_list uuid, p_email text, p_role text default 'viewer') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_name text; v_arch timestamptz;
begin
  if not public.is_human() or not public.has_list_role(p_list, array['owner']) then
    raise exception 'only the owner shares a list' using errcode = '42501';
  end if;
  if p_role not in ('editor','contributor','viewer') then raise exception 'unknown role' using errcode = '22023'; end if;
  select name, archived_at into v_name, v_arch from public.lists where id = p_list;
  if v_arch is not null then raise exception 'this list is archived' using errcode = '22023'; end if;
  return public.invite_upsert(p_list, null, p_email, p_role, v_name);
end $$;

create or replace function public.share_tag_list(p_tag_list uuid, p_email text, p_role text default 'viewer') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  if not public.is_human() or not public.has_tag_list_role(p_tag_list, array['owner']) then
    raise exception 'only the owner shares a tag list' using errcode = '42501';
  end if;
  if p_role not in ('editor','viewer') then raise exception 'unknown role' using errcode = '22023'; end if;
  select name into v_name from public.tag_lists where id = p_tag_list;
  return public.invite_upsert(null, p_tag_list, p_email, p_role, v_name);
end $$;

-- the caller's open invitations: matched on verified identity emails, not from people the caller blocked
create or replace function public.my_invitations()
returns table (id uuid, kind text, target_name text, inviter_name text, role text, created_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, case when i.list_id is not null then 'list' else 'tag_list' end, i.target_name, p.display_name, i.role,
         i.created_at, i.expires_at
    from public.invites i join public.profiles p on p.id = i.invited_by
   where i.email_lower in (select public.my_verified_emails())
     and i.accepted_at is null and i.declined_at is null and i.revoked_at is null and i.expires_at > now()
     and i.invited_by <> auth.uid()
     and not exists (select 1 from public.invite_blocks b where b.profile_id = auth.uid() and b.blocked_id = i.invited_by)
   order by i.created_at desc
$$;

-- an open invitation addressed to the caller, or null
create or replace function public.my_open_invite(p_invite uuid) returns public.invites
language sql stable security definer set search_path = '' as $$
  select i.* from public.invites i
   where i.id = p_invite and i.email_lower in (select public.my_verified_emails())
     and i.accepted_at is null and i.declined_at is null and i.revoked_at is null and i.expires_at > now()
     and not exists (select 1 from public.invite_blocks b where b.profile_id = auth.uid() and b.blocked_id = i.invited_by)
$$;

create or replace function public.accept_invite(p_invite uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.invites;
begin
  if not public.is_human() then raise exception 'only people accept invitations' using errcode = '42501'; end if;
  v := public.my_open_invite(p_invite);
  if v.id is null then raise exception 'no such invitation' using errcode = '42501'; end if;
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

create or replace function public.decline_invite(p_invite uuid, p_block boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.invites;
begin
  v := public.my_open_invite(p_invite);
  if v.id is null then raise exception 'no such invitation' using errcode = '42501'; end if;
  update public.invites set declined_at = now() where id = v.id;
  if p_block then
    insert into public.invite_blocks (profile_id, blocked_id) values (auth.uid(), v.invited_by) on conflict do nothing;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- the owner withdraws an invitation; an accepted one also removes that member (never an owner)
create or replace function public.revoke_invite(p_invite uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.invites;
begin
  select * into v from public.invites where id = p_invite and revoked_at is null;
  if v.id is null or not ((v.list_id is not null and public.has_list_role(v.list_id, array['owner']))
                          or (v.tag_list_id is not null and public.has_tag_list_role(v.tag_list_id, array['owner']))) then
    raise exception 'no such invitation' using errcode = '42501';
  end if;
  update public.invites set revoked_at = now() where id = v.id;
  if v.accepted_by is not null then
    delete from public.list_members where list_id = v.list_id and profile_id = v.accepted_by and role <> 'owner';
    delete from public.tag_list_members where tag_list_id = v.tag_list_id and profile_id = v.accepted_by and role <> 'owner';
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- membership ----------

create or replace function public.leave_list(p_list uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if public.has_list_role(p_list, array['owner']) then raise exception 'owners cannot leave their list' using errcode = '42501'; end if;
  delete from public.list_members where list_id = p_list and profile_id = auth.uid();
  if not found then raise exception 'not a member' using errcode = '42501'; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.leave_tag_list(p_tag_list uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if public.has_tag_list_role(p_tag_list, array['owner']) then
    raise exception 'owners cannot leave their tag list' using errcode = '42501';
  end if;
  delete from public.tag_list_members where tag_list_id = p_tag_list and profile_id = auth.uid();
  if not found then raise exception 'not a member' using errcode = '42501'; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.set_list_hidden(p_list uuid, p_hidden boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  update public.list_members set hidden_at = case when p_hidden then now() end
   where list_id = p_list and profile_id = auth.uid();
  if not found then raise exception 'not a member' using errcode = '42501'; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.set_tag_list_hidden(p_tag_list uuid, p_hidden boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  update public.tag_list_members set hidden_at = case when p_hidden then now() end
   where tag_list_id = p_tag_list and profile_id = auth.uid();
  if not found then raise exception 'not a member' using errcode = '42501'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- People on a list: members by name and role for every member; the owner also sees invitations by email, as
-- "pending" until accepted (also after a decline, a block or an expiry, until the row expires: S4).
create or replace function public.list_people(p_list uuid)
returns table (profile_id uuid, display_name text, email text, role text, state text, invite_id uuid)
language sql stable security definer set search_path = '' as $$
  select m.profile_id, p.display_name, null::text, m.role, 'member', null::uuid
    from public.list_members m join public.profiles p on p.id = m.profile_id
   where m.list_id = p_list and public.has_list_role(p_list, array['owner','editor','contributor','viewer'])
  union all
  select null, null, i.email_lower, i.role, 'pending', i.id
    from public.invites i
   where i.list_id = p_list and public.has_list_role(p_list, array['owner'])
     and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
$$;

create or replace function public.tag_list_people(p_tag_list uuid)
returns table (profile_id uuid, display_name text, email text, role text, state text, invite_id uuid)
language sql stable security definer set search_path = '' as $$
  select m.profile_id, p.display_name, null::text, m.role, 'member', null::uuid
    from public.tag_list_members m join public.profiles p on p.id = m.profile_id
   where m.tag_list_id = p_tag_list and public.has_tag_list_role(p_tag_list, array['owner','editor','viewer'])
  union all
  select null, null, i.email_lower, i.role, 'pending', i.id
    from public.invites i
   where i.tag_list_id = p_tag_list and public.has_tag_list_role(p_tag_list, array['owner'])
     and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
$$;

-- names of people who share an accepted membership with the caller on a list or a tag list (F2, S4)
create or replace function public.visible_profiles() returns table (id uuid, handle text, display_name text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.handle, p.display_name from public.profiles p
   where p.id <> auth.uid()
     and (exists (select 1 from public.list_members a join public.list_members b on b.list_id = a.list_id
                   where a.profile_id = auth.uid() and b.profile_id = p.id)
       or exists (select 1 from public.tag_list_members a join public.tag_list_members b on b.tag_list_id = a.tag_list_id
                   where a.profile_id = auth.uid() and b.profile_id = p.id))
$$;
