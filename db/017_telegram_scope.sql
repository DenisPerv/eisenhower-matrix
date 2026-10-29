-- TasksDashboardDB 017: a chat bot's scope (HomeOS telegram-rework-plan.md T1). A bot is an agent login (telegram-bot)
-- that works for some household people. ops.bot_links says which: one row per (bot, person). Then:
--   * a list or tag list that a linked person creates gets the bot as a member (editor on a list, viewer on a tag list);
--   * telegram_scope(p_person) gives the bot only what the bot and that person share: the live lists both are members of
--     (the person may write there) and the tag lists both are members of, with their live tags. Lists owned by someone
--     outside the household (guests) are never returned, even when the bot or the person is a member.
-- Seeds: telegram-bot works for maksym and anastasiia; it becomes editor on every live household list they own except
-- access-requests (requests from people outside the household stay out of chat) and viewer on their tag lists.
-- Re-runnable. After it: 003, 011, the 012 policy block, then 900-905 (README Set up).

create table if not exists ops.bot_links (
  bot_id     uuid not null references public.profiles(id) on delete cascade,
  person_id  uuid not null references public.profiles(id) on delete cascade,
  auto_share boolean not null default true,      -- new lists and tag lists of the person get the bot as a member
  created_at timestamptz not null default now(),
  primary key (bot_id, person_id)
);
revoke all on ops.bot_links from public, anon, authenticated;

insert into ops.bot_links (bot_id, person_id)
select b.id, p.id from public.profiles b, public.profiles p
 where b.handle = 'telegram-bot' and p.handle in ('maksym', 'anastasiia')
on conflict do nothing;

-- one-time grants: live household lists of the linked people, minus access-requests and test lists
insert into public.list_members (list_id, profile_id, role, added_by)
select l.id, k.bot_id, 'editor', l.owner_id
  from public.lists l join ops.bot_links k on k.person_id = l.owner_id
 where l.archived_at is null and l.slug not like '\_%' and l.slug <> 'access-requests'
on conflict (list_id, profile_id) do nothing;
insert into public.tag_list_members (tag_list_id, profile_id, role)
select t.id, k.bot_id, 'viewer'
  from public.tag_lists t join ops.bot_links k on k.person_id = t.owner_id
 where t.archived_at is null
on conflict do nothing;

-- new lists and tag lists of a linked person: the bot joins
create or replace function public.bot_join_list() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.list_members (list_id, profile_id, role, added_by)
  select new.id, k.bot_id, 'editor', new.owner_id from ops.bot_links k
   where k.person_id = new.owner_id and k.auto_share and new.slug not like '\_%'
  on conflict (list_id, profile_id) do nothing;
  return null;
end $$;
drop trigger if exists bot_join_list on public.lists;
create trigger bot_join_list after insert on public.lists for each row execute function public.bot_join_list();

create or replace function public.bot_join_tag_list() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.tag_list_members (tag_list_id, profile_id, role)
  select new.id, k.bot_id, 'viewer' from ops.bot_links k
   where k.person_id = new.owner_id and k.auto_share
  on conflict do nothing;
  return null;
end $$;
drop trigger if exists bot_join_tag_list on public.tag_lists;
create trigger bot_join_tag_list after insert on public.tag_lists for each row execute function public.bot_join_tag_list();
revoke all on function public.bot_join_list(), public.bot_join_tag_list() from public, anon, authenticated;

-- what the calling bot and p_person share. Only a bot linked to p_person may ask (42501 otherwise). p_include_test also
-- returns live '_'-prefixed lists (the test lists); archived lists never come back.
create or replace function public.telegram_scope(p_person uuid, p_include_test boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_bot uuid := auth.uid();
begin
  if v_bot is null or not exists (
       select 1 from ops.bot_links k join public.profiles b on b.id = k.bot_id join public.profiles p on p.id = k.person_id
        where k.bot_id = v_bot and k.person_id = p_person and b.kind = 'agent' and p.kind = 'human' and p.is_household) then
    raise exception 'not a bot linked to this person' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'person', (select handle from public.profiles where id = p_person),
    'lists', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'slug', l.slug, 'name', l.name, 'default_category', l.default_category, 'sort', l.sort,
               'role', mp.role, 'bot_role', mb.role,
               'members', (select jsonb_agg(jsonb_build_object('id', p.id, 'handle', p.handle, 'kind', p.kind, 'role', m.role)
                                            order by p.handle)
                             from public.list_members m join public.profiles p on p.id = m.profile_id
                            where m.list_id = l.id and p.is_household))
             order by l.sort, l.name)
        from public.lists l
        join public.list_members mb on mb.list_id = l.id and mb.profile_id = v_bot and mb.role in ('owner','editor','contributor')
        join public.list_members mp on mp.list_id = l.id and mp.profile_id = p_person and mp.role in ('owner','editor','contributor')
        join public.profiles o on o.id = l.owner_id and o.is_household
       where l.archived_at is null and (p_include_test or l.slug not like '\_%')), '[]'::jsonb),
    'tag_lists', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'name', t.name, 'owner', o.handle, 'sort', t.sort, 'is_default', t.is_default,
               'tags', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) order by g.sort, g.name)
                                   from public.tags g where g.tag_list_id = t.id and g.deleted_at is null), '[]'::jsonb))
             order by (t.owner_id <> p_person), t.sort, t.name)
        from public.tag_lists t
        join public.tag_list_members tb on tb.tag_list_id = t.id and tb.profile_id = v_bot
        join public.tag_list_members tp on tp.tag_list_id = t.id and tp.profile_id = p_person
        join public.profiles o on o.id = t.owner_id and o.is_household
       where t.archived_at is null), '[]'::jsonb));
end $$;
revoke all on function public.telegram_scope(uuid, boolean) from public, anon;
grant execute on function public.telegram_scope(uuid, boolean) to authenticated;
