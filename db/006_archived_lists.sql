-- db/006_archived_lists.sql: archived lists are frozen (design.md D18). Replaces items_before_write from 002 with one more
-- check: a non-admin UPDATE of an item whose list is archived raises 42501 "this list is archived". The insert and
-- move-into checks stay. Idempotent. Re-run 003_rls.sql and 900_selftest.sql after it.

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
      -- 006: an archived list is frozen; only admin SQL changes its items (design.md D18)
      if exists (select 1 from public.lists where id = old.list_id and archived_at is not null) then
        raise exception 'this list is archived' using errcode = '42501';
      end if;
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

