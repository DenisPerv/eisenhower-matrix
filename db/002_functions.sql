-- db/002_functions.sql: helpers, triggers (protected columns, numbering, audit, sensitive data), create_list, keepalive.
-- Source of truth since 2026-10-27; was HomeOS references/homeos/tasksdb/schema.md §2, now history.
-- Apply in file order as postgres (Supabase SQL editor or the Management API). Re-runnable. README "Database".
-- 006_archived_lists.sql replaces items_before_write: re-run 006 after re-running this file.

-- Helpers: security definer, empty search_path, every name schema-qualified.
create or replace function public.my_kind() returns text
language sql stable security definer set search_path = '' as $$
  select kind from public.profiles where id = auth.uid()
$$;
create or replace function public.is_human() returns boolean
language sql stable security definer set search_path = '' as $$ select coalesce(public.my_kind() = 'human', false) $$;
create or replace function public.is_agent() returns boolean
language sql stable security definer set search_path = '' as $$ select coalesce(public.my_kind() = 'agent', false) $$;

create or replace function public.has_list_role(p_list uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.list_members m
                 where m.list_id = p_list and m.profile_id = auth.uid() and m.role = any (p_roles))
$$;
create or replace function public.has_item_role(p_item uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select public.has_list_role(i.list_id, p_roles) from public.items i where i.id = p_item), false)
$$;

-- Request metadata sent by clients as headers (PostgREST exposes them as request.headers)
create or replace function public.req_header(p_name text) returns text
language sql stable set search_path = '' as $$
  select nullif(current_setting('request.headers', true), '')::json ->> p_name
$$;

-- Sensitive data: Luhn-valid card numbers, IBANs, labelled Portuguese/ID numbers. Order numbers and ids inside links pass.
create or replace function public.luhn_ok(p_digits text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare s int := 0; d int; alt boolean := false; i int;
begin
  for i in reverse length(p_digits)..1 loop
    d := substr(p_digits, i, 1)::int;
    if alt then d := d * 2; if d > 9 then d := d - 9; end if; end if;
    s := s + d; alt := not alt;
  end loop;
  return s % 10 = 0;
end $$;

create or replace function public.assert_no_sensitive(p_text text) returns void
language plpgsql immutable set search_path = '' as $$
declare t text; m text[];
begin
  if p_text is null then return; end if;
  t := regexp_replace(p_text, 'https?://[^[:space:]]+', ' ', 'gi');      -- ids inside links are not card numbers
  -- a standalone 13-19 digit token with a card prefix (2-6), or a formatted 4-4-4-4 / Amex 4-6-5 group
  for m in select regexp_matches(t,
      '(?<![0-9])([2-6][0-9]{12,18}|[2-6][0-9]{3}(?:[ -][0-9]{4}){3}|3[47][0-9]{2}[ -][0-9]{6}[ -][0-9]{5})(?![0-9])', 'g') loop
    if public.luhn_ok(regexp_replace(m[1], '\D', '', 'g')) then
      raise exception 'sensitive data: looks like a card number' using errcode = '22023';
    end if;
  end loop;
  if t ~ '\m[A-Z]{2}[0-9]{2}( ?[A-Z0-9]{4}){3,7}( ?[A-Z0-9]{1,4})?\M' then
    raise exception 'sensitive data: looks like an IBAN' using errcode = '22023';
  end if;
  if t ~* '\m(nif|niss|nipc|passport|passaporte|cart[aã]o de cidad[aã]o|citizen card|id card|id number)\s*(no\.?|n\.?º|number|#|:)?\s*[a-z]{0,2}[0-9]{6,}' then
    raise exception 'sensitive data: looks like an ID number' using errcode = '22023';
  end if;
end $$;

-- items: protected columns, numbering, lifecycle, agent limits
create or replace function public.items_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  -- admin = a direct SQL session (Management API, SQL editor), never a PostgREST request.
  -- session_user, not current_user: inside a security definer function current_user is always the owner.
  v_admin boolean := session_user in ('postgres','supabase_admin')
                     and nullif(current_setting('request.jwt.claims', true), '') is null;
  v_kind  text;
begin
  if not v_admin then
    select kind into v_kind from public.profiles where id = v_uid;
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
    end if;
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
    else
      new.num := old.num;
    end if;
    if not v_admin then
      if new.list_id is distinct from old.list_id
         and exists (select 1 from public.lists where id = new.list_id and archived_at is not null) then
        raise exception 'this list is archived' using errcode = '42501';
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

  if new.on_behalf_of is not null and not exists
     (select 1 from public.profiles where id = new.on_behalf_of and kind = 'human') then
    raise exception 'on_behalf_of must be a person' using errcode = '22023';
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

-- items: append-only audit
create or replace function public.items_after_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_action text; v_diff jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'create'; v_diff := null;
  else
    select jsonb_object_agg(o.key, jsonb_build_object('old', o.value, 'new', n.value)) into v_diff
      from jsonb_each(to_jsonb(old)) o join jsonb_each(to_jsonb(new)) n using (key)
     where o.value is distinct from n.value and o.key not in ('updated_at','version','updated_by');
    if v_diff is null then return null; end if;
    v_action := case
      when old.deleted_at is null and new.deleted_at is not null then 'delete'
      when old.deleted_at is not null and new.deleted_at is null then 'restore'
      when old.status <> 'done' and new.status = 'done' then 'complete'
      when old.status = 'done' and new.status <> 'done' then 'reopen'
      when old.list_id <> new.list_id or old.quadrant is distinct from new.quadrant then 'move'
      else 'update' end;
  end if;
  insert into public.item_events (item_id, actor_id, actor_kind, via, action, diff, run_id)
  values (new.id, new.updated_by, (select kind from public.profiles where id = new.updated_by),
          coalesce(public.req_header('x-homeos-via'), case when tg_op = 'INSERT' then new.created_via end, 'unknown'),
          v_action, v_diff, coalesce(public.req_header('x-homeos-run-id'), new.run_id));
  return null;
end $$;
drop trigger if exists items_after_write on public.items;
create trigger items_after_write after insert or update on public.items
  for each row execute function public.items_after_write();

-- updated_at / version on the other mutable tables
create or replace function public.touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if tg_table_name = 'preferences' then new.version := coalesce(old.version, 0) + 1; end if;
  return new;
end $$;
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch    before update on public.profiles    for each row execute function public.touch();
drop trigger if exists lists_touch on public.lists;
create trigger lists_touch       before update on public.lists       for each row execute function public.touch();
drop trigger if exists preferences_touch on public.preferences;
create trigger preferences_touch before update on public.preferences for each row execute function public.touch();

-- links and refs: created_by from the login
create or replace function public.stamp_created_by() returns trigger
language plpgsql set search_path = '' as $$
begin new.created_by := coalesce(auth.uid(), new.created_by); return new; end $$;
drop trigger if exists item_links_stamp on public.item_links;
create trigger item_links_stamp before insert on public.item_links for each row execute function public.stamp_created_by();
drop trigger if exists item_refs_stamp on public.item_refs;
create trigger item_refs_stamp  before insert on public.item_refs  for each row execute function public.stamp_created_by();
drop trigger if exists categories_stamp on public.categories;
create trigger categories_stamp before insert on public.categories for each row execute function public.stamp_created_by();

-- list_members: added_by from the login; owners are changed only by admin SQL (no list left without an owner,
-- no owner locking the other one out)
create or replace function public.stamp_added_by() returns trigger
language plpgsql set search_path = '' as $$
begin new.added_by := coalesce(auth.uid(), new.added_by); return new; end $$;
drop trigger if exists list_members_stamp on public.list_members;
create trigger list_members_stamp before insert on public.list_members for each row execute function public.stamp_added_by();

create or replace function public.members_keep_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner')
     and not (session_user in ('postgres','supabase_admin')
              and nullif(current_setting('request.jwt.claims', true), '') is null) then
    raise exception 'owners are changed by admin SQL only' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists members_keep_owner on public.list_members;
create trigger members_keep_owner before update or delete on public.list_members
  for each row execute function public.members_keep_owner();

-- New list: humans only. Shared lists add every other person as editor and homeos-agent as editor.
create or replace function public.create_list(p_name text, p_slug text default null,
                                              p_shared boolean default true, p_default_category text default 'task')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
        v_slug text := coalesce(p_slug, trim(both '-' from lower(regexp_replace(trim(p_name), '[^A-Za-z0-9]+', '-', 'g'))));
begin
  if not public.is_human() then raise exception 'only people create lists' using errcode = '42501'; end if;
  if v_slug !~ '^[a-z0-9_][a-z0-9-]*$' then
    raise exception 'a list name needs letters or digits' using errcode = '22023';
  end if;
  insert into public.lists (slug, name, default_category, owner_id, created_by, sort)
  values (v_slug, trim(p_name), p_default_category, auth.uid(), auth.uid(),
          coalesce((select max(sort) + 1 from public.lists), 1))
  returning id into v_id;
  insert into public.list_members (list_id, profile_id, role, added_by) values (v_id, auth.uid(), 'owner', auth.uid());
  if p_shared then
    insert into public.list_members (list_id, profile_id, role, added_by)
    select v_id, p.id, 'editor', auth.uid() from public.profiles p
     where p.id <> auth.uid() and (p.kind = 'human' or p.handle = 'homeos-agent');
  end if;
  return v_id;
end $$;

-- Keep-alive: creates the hidden table if it went missing (001 creates it), then records the ping. Agents only.
create or replace function public.keepalive(p_host text) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare v_at timestamptz;
begin
  if not public.is_agent() then raise exception 'agents only' using errcode = '42501'; end if;
  if to_regclass('ops.keepalive') is null then
    create table ops.keepalive (host text primary key, pinged_at timestamptz not null, runs int not null default 0);
    revoke all on ops.keepalive from public, anon, authenticated;
  end if;
  insert into ops.keepalive (host, pinged_at, runs) values (left(p_host, 64), now(), 1)
  on conflict (host) do update set pinged_at = now(), runs = ops.keepalive.runs + 1
  returning pinged_at into v_at;
  return v_at;
end $$;

-- Keep-alive status for /audit: readable by any login, without the admin token
create or replace function public.keepalive_status() returns table (host text, pinged_at timestamptz, runs int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if public.my_kind() is null or to_regclass('ops.keepalive') is null then return; end if;
  return query select k.host, k.pinged_at, k.runs from ops.keepalive k order by k.pinged_at desc;
end $$;
