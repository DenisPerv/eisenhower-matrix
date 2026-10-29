-- TasksDashboardDB 019: removing a bot from a list or tag list sticks (HomeOS telegram-rework-plan.md, review fix).
-- 017's one-time grant runs again whenever 017 is re-run and would put a removed bot back. Now:
--   * removing a linked bot from a list or tag list records an opt-out (ops.bot_opt_out);
--   * an insert of that bot there without a person behind it (admin SQL such as a 017 re-run, or a trigger) is undone
--     at once; a person who adds the bot back (app, CLI as a person) clears the opt-out.
-- Seeds the opt-out of access-requests, so it stays out even if 017 or 015 is re-run. Re-runnable.
-- After it: 003, 011, the 012 policy block, then 900-905.

create table if not exists ops.bot_opt_out (
  bot_id      uuid not null references public.profiles(id) on delete cascade,
  list_id     uuid references public.lists(id) on delete cascade,
  tag_list_id uuid references public.tag_lists(id) on delete cascade,
  created_at  timestamptz not null default now(),
  check ((list_id is null) <> (tag_list_id is null))
);
create unique index if not exists bot_opt_out_list_uq on ops.bot_opt_out (bot_id, list_id) where list_id is not null;
create unique index if not exists bot_opt_out_tag_list_uq on ops.bot_opt_out (bot_id, tag_list_id) where tag_list_id is not null;
revoke all on ops.bot_opt_out from public, anon, authenticated;

insert into ops.bot_opt_out (bot_id, list_id)
select distinct k.bot_id, l.id from ops.bot_links k join public.lists l on l.slug = 'access-requests' and l.owner_id = k.person_id
on conflict do nothing;

-- true when the current request is made by a person (not admin SQL, not an agent login)
create or replace function public.by_person() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.kind = 'human')
$$;
revoke all on function public.by_person() from public, anon, authenticated;

create or replace function public.bot_member_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_list uuid; v_tag uuid; v_bot uuid;
begin
  if tg_table_name = 'list_members' then
    v_list := coalesce(new.list_id, old.list_id); v_bot := coalesce(new.profile_id, old.profile_id);
  else
    v_tag := coalesce(new.tag_list_id, old.tag_list_id); v_bot := coalesce(new.profile_id, old.profile_id);
  end if;
  if not exists (select 1 from ops.bot_links k where k.bot_id = v_bot) then
    return null;
  end if;
  if tg_op = 'DELETE' then
    -- a removal is remembered; skipped while the list itself is being deleted (cascade)
    if v_list is not null and exists (select 1 from public.lists where id = v_list) then
      insert into ops.bot_opt_out (bot_id, list_id) values (v_bot, v_list) on conflict do nothing;
    elsif v_tag is not null and exists (select 1 from public.tag_lists where id = v_tag) then
      insert into ops.bot_opt_out (bot_id, tag_list_id) values (v_bot, v_tag) on conflict do nothing;
    end if;
    return null;
  end if;
  if public.by_person() then
    delete from ops.bot_opt_out o where o.bot_id = v_bot
       and (o.list_id = v_list or o.tag_list_id = v_tag);
  elsif v_list is not null and exists (select 1 from ops.bot_opt_out o where o.bot_id = v_bot and o.list_id = v_list) then
    delete from public.list_members m where m.list_id = v_list and m.profile_id = v_bot;
  elsif v_tag is not null and exists (select 1 from ops.bot_opt_out o where o.bot_id = v_bot and o.tag_list_id = v_tag) then
    delete from public.tag_list_members m where m.tag_list_id = v_tag and m.profile_id = v_bot;
  end if;
  return null;
end $$;
revoke all on function public.bot_member_guard() from public, anon, authenticated;
drop trigger if exists bot_member_guard on public.list_members;
create trigger bot_member_guard after insert or delete on public.list_members
  for each row execute function public.bot_member_guard();
drop trigger if exists bot_member_guard on public.tag_list_members;
create trigger bot_member_guard after insert or delete on public.tag_list_members
  for each row execute function public.bot_member_guard();
