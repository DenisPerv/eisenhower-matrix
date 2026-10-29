-- db/022_share_by_person.sql: share by person, not by email (HomeOS tags-round-plan.md #2, Maksym 2026-10-29: suggestions
-- from "accounts that were whitelisted (accepted by household members and allowed to use system) available in database").
--   * shareable_profiles() -> (id, display_name): every whitelisted person except the caller. Whitelisted = a human profile
--     that is a household member, or whose password login a used sign-up allowlist row let in (ops.signup_allowlist,
--     tasksdb.js add-login), or whose access request was approved (users_pending_for_decision, access_request_decided).
--     Never an agent or bot, never the caller, never an email. Only a whitelisted person gets the list; any other signed-in
--     account (a Google sign-in nobody let in) gets none.
--   * share_list_with(p_list, p_profile, p_role) and share_tag_list_with(p_tag_list, p_profile, p_role): the same rights
--     checks as share_list / share_tag_list (list: the owner; tag list: the owner or an editor; never an archived one; the
--     same roles), and the person must be in the caller's shareable_profiles(). The person's verified address is resolved
--     here, on the server, and the share goes through invite_upsert(..., p_join := true) like the app's share by email: a
--     first share joins at once, otherwise an invitation. Both answer as share_list / share_tag_list do: {"ok": true}.
-- Every function is security definer with search_path = ''. Error codes: 42501 not allowed, 22023 bad value, 54000 limit.
-- Re-runnable. Order rule after this file: 003_rls.sql, 011_multiuser_rls.sql, the 012 policy block, then 900-907.
--
-- Rollback (not applied):
--   drop function if exists public.share_tag_list_with(uuid, uuid, text);
--   drop function if exists public.share_list_with(uuid, uuid, text);
--   drop function if exists public.shareable_profiles();
--   drop function if exists public.shareable_email(uuid);   -- the internal helpers
--   drop function if exists public.is_whitelisted(uuid);

-- whitelisted human profile (internal): household, a used allowlist row for its address, or an approved access request
create or replace function public.is_whitelisted(p_profile uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
     where p.id = p_profile and p.kind = 'human'
       and (p.is_household
            or exists (select 1 from ops.signup_allowlist a
                        where a.used_at is not null and a.kind = 'human' and a.email_lower = lower(p.email))
            or exists (select 1 from public.users_pending_for_decision r
                        where r.user_id = p.id and r.status = 'approved')))
$$;

-- the people the caller may pick in the Share dialog: names and ids only
create or replace function public.shareable_profiles() returns table (id uuid, display_name text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.display_name from public.profiles p
   where auth.uid() is not null and public.is_whitelisted(auth.uid())
     and p.id <> auth.uid() and p.kind = 'human' and public.is_whitelisted(p.id)
   order by lower(p.display_name), p.id
$$;

-- the verified address of a person the caller may share with (internal); 42501 for anyone not in shareable_profiles()
create or replace function public.shareable_email(p_profile uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_email text;
begin
  if p_profile is null or not exists (select 1 from public.shareable_profiles() s where s.id = p_profile) then
    raise exception 'pick a name from the list' using errcode = '42501';
  end if;
  -- a verified identity address (email identities are admin-made; Google ones with email_verified), the profile's own first
  select lower(i.identity_data->>'email') into v_email
    from auth.identities i join public.profiles p on p.id = i.user_id
   where i.user_id = p_profile and i.identity_data->>'email' is not null
     and (i.provider = 'email' or (i.provider = 'google' and coalesce((i.identity_data->>'email_verified')::boolean, false)))
   order by (lower(i.identity_data->>'email') = lower(coalesce(p.email, ''))) desc, i.created_at nulls last
   limit 1;
  if v_email is null then raise exception 'this person has no verified address to share with' using errcode = '22023'; end if;
  return v_email;
end $$;

-- share a list with a person by id: the owner only, as share_list
create or replace function public.share_list_with(p_list uuid, p_profile uuid, p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_name text; v_arch timestamptz;
begin
  if not public.is_human() or not public.has_list_role(p_list, array['owner']) then
    raise exception 'only the owner shares a list' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('editor','contributor','viewer') then raise exception 'unknown role' using errcode = '22023'; end if;
  select name, archived_at into v_name, v_arch from public.lists where id = p_list;
  if v_arch is not null then raise exception 'this list is archived' using errcode = '22023'; end if;
  return public.invite_upsert(p_list, null, public.shareable_email(p_profile), p_role, v_name, true);
end $$;

-- share a tag list with a person by id: the owner or an editor, as share_tag_list
create or replace function public.share_tag_list_with(p_tag_list uuid, p_profile uuid, p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_name text; v_arch timestamptz;
begin
  if not public.is_human() or not public.has_tag_list_role(p_tag_list, array['owner','editor']) then
    raise exception 'only owners and editors share a tag list' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('editor','contributor','viewer') then raise exception 'unknown role' using errcode = '22023'; end if;
  select name, archived_at into v_name, v_arch from public.tag_lists where id = p_tag_list;
  if v_arch is not null then raise exception 'this tag list is archived' using errcode = '22023'; end if;
  return public.invite_upsert(null, p_tag_list, public.shareable_email(p_profile), p_role, v_name, true);
end $$;

-- rights: the three RPCs for signed-in people; the helpers are never endpoints
revoke all on function public.shareable_profiles(), public.share_list_with(uuid, uuid, text),
  public.share_tag_list_with(uuid, uuid, text), public.shareable_email(uuid), public.is_whitelisted(uuid) from public, anon;
grant execute on function public.shareable_profiles(), public.share_list_with(uuid, uuid, text),
  public.share_tag_list_with(uuid, uuid, text) to authenticated;
revoke all on function public.shareable_email(uuid), public.is_whitelisted(uuid) from authenticated;

-- final check
do $$
declare v text;
begin
  select string_agg(p.proname, ', ') into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('shareable_profiles','share_list_with','share_tag_list_with','shareable_email','is_whitelisted')
     and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']);
  if v is not null then raise exception '022: not a definer with search_path '''': %', v; end if;
  if pg_get_function_result('public.shareable_profiles()'::regprocedure) <> 'TABLE(id uuid, display_name text)' then
    raise exception '022: shareable_profiles returns more than id and display_name';
  end if;
  if has_function_privilege('anon', 'public.shareable_profiles()', 'execute')
     or has_function_privilege('authenticated', 'public.shareable_email(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.is_whitelisted(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.share_list_with(uuid, uuid, text)', 'execute') then
    raise exception '022: a function is executable by the wrong role';
  end if;
end $$;
