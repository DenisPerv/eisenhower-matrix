-- db/027_agent_lists.sql: homeos-agent may create and rename household lists (2026-11-04, Maksym's request: "Create lists in a
-- database on your side. You should have this option in a skill for work items creation").
--
-- This narrows, not removes, the rule "agents can't create lists" (design.md, risk "an agent goes wild"):
--   - create_list, create_list_row and the policy lists_edit stay people-only. An agent calling them is still refused.
--   - two new functions, callable by one login only: the profile with handle 'homeos-agent', kind agent, household.
--     telegram-bot, other agents, guests and people are refused.
--   - agent_create_list: the list belongs to a household person named by handle, never to the agent, and is shared the way
--     the app's "Share with the household" does it (household people and homeos-agent as editors; telegram-bot through its
--     own trigger). The household list limit, the name rules and the sensitive-data screen apply.
--   - agent_rename_list: only a live, household-owned list the agent is already a member of, name only. The slug never
--     changes, so scripts and routines that name a list by slug keep working.
-- Nothing here deletes or archives a list, changes a member, or changes an owner.
--
-- Error codes: 42501 not allowed, 22023 bad value, 23505 name taken, 54000 limit reached, 55000 list archived.
-- Additive and re-runnable. Order rule after this file: 003_rls.sql, 011_multiuser_rls.sql, the 012 policy block, 026, 900-912.

create or replace function public.agent_lists_caller() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p
                  where p.id = auth.uid() and p.handle = 'homeos-agent' and p.kind = 'agent' and p.is_household)
$$;

create or replace function public.agent_lists_name(p_name text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_name text := trim(coalesce(p_name, ''));
begin
  if char_length(v_name) not between 1 and 60 then raise exception 'a list name has 1 to 60 characters' using errcode = '22023'; end if;
  perform public.assert_no_sensitive(v_name);
  return v_name;
end $$;

create or replace function public.agent_create_list(p_name text, p_owner text default 'maksym', p_default_category text default 'task')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_owner uuid; v_name text; v_base text; v_slug text; v_i int := 1; v_clash uuid; v_arch timestamptz; v_n int;
begin
  if not public.agent_lists_caller() then raise exception 'only homeos-agent may use this function' using errcode = '42501'; end if;
  v_name := public.agent_lists_name(p_name);
  select p.id into v_owner from public.profiles p
   where p.handle = lower(trim(coalesce(p_owner, ''))) and p.kind = 'human' and p.is_household;
  if v_owner is null then raise exception 'the owner must be a household person' using errcode = '22023'; end if;
  if p_default_category is not null and not public.can_use_category(p_default_category) then
    raise exception 'this category is not available' using errcode = '22023';
  end if;
  select count(*) into v_n from public.lists where owner_id = v_owner and archived_at is null;
  if v_n >= public.setting('household_lists') then raise exception 'list limit reached' using errcode = '54000'; end if;
  select id, archived_at into v_clash, v_arch from public.lists
   where owner_id = v_owner and lower(trim(name)) = lower(v_name) order by archived_at nulls first limit 1;
  if v_clash is not null then
    raise exception 'this owner already has a list named %', v_name using errcode = '23505',
      detail = case when v_arch is null then 'live' else 'archived' end, hint = v_clash::text;
  end if;
  v_base := trim(both '-' from left(lower(regexp_replace(v_name, '[^A-Za-z0-9]+', '-', 'g')), 50));
  if v_base = '' then v_base := 'list-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6); end if;
  v_slug := v_base;
  while exists (select 1 from public.lists where owner_id = v_owner and slug = v_slug) loop
    v_i := v_i + 1; v_slug := v_base || '-' || v_i;
  end loop;
  insert into public.lists (slug, name, default_category, owner_id, created_by, sort)
  values (v_slug, v_name, p_default_category, v_owner, auth.uid(),
          coalesce((select max(sort) + 1 from public.lists where owner_id = v_owner), 1))
  returning id into v_id;
  insert into public.list_members (list_id, profile_id, role, added_by) values (v_id, v_owner, 'owner', auth.uid());
  insert into public.list_members (list_id, profile_id, role, added_by)
  select v_id, p.id, 'editor', auth.uid() from public.profiles p
   where p.id <> v_owner and p.is_household and (p.kind = 'human' or p.handle = 'homeos-agent');
  return (select jsonb_build_object('id', l.id, 'slug', l.slug, 'name', l.name, 'sort', l.sort, 'owner_id', l.owner_id,
                                    'archived_at', l.archived_at, 'default_category', l.default_category)
            from public.lists l where l.id = v_id);
end $$;

create or replace function public.agent_rename_list(p_list uuid, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_name text; v public.lists%rowtype; v_clash uuid;
begin
  if not public.agent_lists_caller() then raise exception 'only homeos-agent may use this function' using errcode = '42501'; end if;
  select * into v from public.lists where id = p_list;
  if v.id is null or not public.has_list_role(p_list, array['owner', 'editor'])
     or not exists (select 1 from public.profiles p where p.id = v.owner_id and p.is_household and p.kind = 'human') then
    raise exception 'not a household list this agent is a member of' using errcode = '42501';
  end if;
  if v.archived_at is not null then raise exception 'list archived' using errcode = '55000'; end if;
  v_name := public.agent_lists_name(p_name);
  select id into v_clash from public.lists
   where owner_id = v.owner_id and id <> p_list and lower(trim(name)) = lower(v_name) limit 1;
  if v_clash is not null then raise exception 'this owner already has a list named %', v_name using errcode = '23505', hint = v_clash::text; end if;
  update public.lists set name = v_name where id = p_list;
  return (select jsonb_build_object('id', l.id, 'slug', l.slug, 'name', l.name, 'sort', l.sort, 'owner_id', l.owner_id,
                                    'archived_at', l.archived_at, 'default_category', l.default_category)
            from public.lists l where l.id = p_list);
end $$;

revoke all on function public.agent_lists_caller(), public.agent_lists_name(text) from public, anon, authenticated;
revoke all on function public.agent_create_list(text, text, text), public.agent_rename_list(uuid, text) from public, anon;
grant execute on function public.agent_create_list(text, text, text), public.agent_rename_list(uuid, text) to authenticated;
