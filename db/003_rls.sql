-- db/003_rls.sql: row level security, grants and policies.
-- Source of truth since 2026-10-27; was HomeOS references/homeos/tasksdb/schema.md §3, now history.
-- Apply in file order as postgres (Supabase SQL editor or the Management API). Re-runnable. README "Database".
-- Re-run after every new db/ file (new columns, tables or functions).

alter table public.profiles                enable row level security;
alter table public.preferences             enable row level security;
alter table public.categories              enable row level security;
alter table public.lists                   enable row level security;
alter table public.list_members            enable row level security;
alter table public.items                   enable row level security;
alter table public.item_links              enable row level security;
alter table public.item_refs               enable row level security;
alter table public.item_events             enable row level security;
alter table public.notification_deliveries enable row level security;

-- Grants: nothing for anon; authenticated gets only what the policies below can allow.
-- No DELETE except item_links and list_members (relations, not data).
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon;
-- Supabase's default privileges would hand future tables and functions to anon and authenticated again
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;
grant usage on schema public to authenticated;
-- profiles: every column except email (agent and project logins don't need the household's addresses)
grant select (id, handle, display_name, kind, timezone, locale, mine_tags, reminder_channel, created_at, updated_at)
  on public.profiles to authenticated;
grant update (display_name, timezone, locale, mine_tags, reminder_channel) on public.profiles to authenticated;
grant select, insert, update on public.preferences to authenticated;
grant select, insert on public.categories to authenticated;
grant update (name, description, default_list_id, details_hint, archived_at) on public.categories to authenticated;
grant select on public.lists to authenticated;
grant update (name, description, default_category, sort, archived_at) on public.lists to authenticated;
grant select, insert, delete on public.list_members to authenticated;
grant update (role) on public.list_members to authenticated;
grant select, insert, update on public.items to authenticated;
grant select, insert, delete on public.item_links to authenticated;
grant select, insert, update (note) on public.item_refs to authenticated;
grant select on public.item_events to authenticated;
grant select, insert, update (status, error) on public.notification_deliveries to authenticated;
grant execute on function public.create_list(text, text, boolean, text), public.keepalive(text), public.keepalive_status(),
                          public.has_list_role(uuid, text[]), public.has_item_role(uuid, text[]),
                          public.is_human(), public.is_agent(), public.my_kind() to authenticated;
-- internal helpers are not RPC endpoints (the triggers call them as the owner)
revoke execute on function public.luhn_ok(text), public.assert_no_sensitive(text), public.req_header(text) from authenticated;
-- trigger functions: Supabase grants new functions to authenticated by name; they are never RPC endpoints
revoke execute on function public.items_before_write(), public.items_after_write(), public.touch(), public.stamp_created_by(),
                           public.stamp_added_by(), public.members_keep_owner() from authenticated;
-- Re-run this file after adding a table or a function.

-- profiles: everyone signed in sees the household; each edits only their own row (columns limited by grant)
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (public.my_kind() is not null);
drop policy if exists profiles_own on public.profiles;
create policy profiles_own  on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- preferences: own rows only
drop policy if exists prefs_own on public.preferences;
create policy prefs_own on public.preferences for all to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- categories: all read; people create and edit
drop policy if exists categories_read on public.categories;
create policy categories_read  on public.categories for select to authenticated using (public.my_kind() is not null);
drop policy if exists categories_add on public.categories;
create policy categories_add   on public.categories for insert to authenticated with check (public.is_human());
drop policy if exists categories_edit on public.categories;
create policy categories_edit  on public.categories for update to authenticated using (public.is_human()) with check (public.is_human());

-- lists: members read; human owners edit; insert only through create_list()
drop policy if exists lists_read on public.lists;
create policy lists_read on public.lists for select to authenticated
  using (public.has_list_role(id, array['owner','editor','contributor','viewer']));
drop policy if exists lists_edit on public.lists;
create policy lists_edit on public.lists for update to authenticated
  using (public.is_human() and public.has_list_role(id, array['owner']))
  with check (public.is_human() and public.has_list_role(id, array['owner']));

-- list_members: you see your own row; owners and editors see the list's members; human owners manage
drop policy if exists members_read on public.list_members;
create policy members_read on public.list_members for select to authenticated
  using (profile_id = auth.uid() or public.has_list_role(list_id, array['owner','editor']));
drop policy if exists members_add on public.list_members;
create policy members_add on public.list_members for insert to authenticated
  with check (public.is_human() and public.has_list_role(list_id, array['owner']));
drop policy if exists members_edit on public.list_members;
create policy members_edit on public.list_members for update to authenticated
  using (public.is_human() and public.has_list_role(list_id, array['owner']))
  with check (public.is_human() and public.has_list_role(list_id, array['owner']));
drop policy if exists members_remove on public.list_members;
create policy members_remove on public.list_members for delete to authenticated
  using (public.is_human() and public.has_list_role(list_id, array['owner']) and profile_id <> auth.uid());

-- items
drop policy if exists items_read on public.items;
create policy items_read on public.items for select to authenticated
  using (public.has_list_role(list_id, array['owner','editor','contributor','viewer']));
drop policy if exists items_add on public.items;
create policy items_add on public.items for insert to authenticated
  with check (public.has_list_role(list_id, array['owner','editor','contributor']));
drop policy if exists items_edit on public.items;
create policy items_edit on public.items for update to authenticated
  using (public.has_list_role(list_id, array['owner','editor'])
         or (public.has_list_role(list_id, array['contributor']) and created_by = auth.uid()))
  with check (public.has_list_role(list_id, array['owner','editor'])
         or (public.has_list_role(list_id, array['contributor']) and created_by = auth.uid()));

-- links and refs follow the item
drop policy if exists links_read on public.item_links;
create policy links_read on public.item_links for select to authenticated
  using (public.has_item_role(from_item, array['owner','editor','contributor','viewer']));
drop policy if exists links_add on public.item_links;
create policy links_add on public.item_links for insert to authenticated
  with check (public.has_item_role(from_item, array['owner','editor','contributor'])
          and public.has_item_role(to_item,   array['owner','editor','contributor','viewer']));
drop policy if exists links_remove on public.item_links;
create policy links_remove on public.item_links for delete to authenticated
  using (public.has_item_role(from_item, array['owner','editor']));
drop policy if exists refs_read on public.item_refs;
create policy refs_read on public.item_refs for select to authenticated
  using (public.has_item_role(item_id, array['owner','editor','contributor','viewer']));
drop policy if exists refs_add on public.item_refs;
create policy refs_add on public.item_refs for insert to authenticated
  with check (public.has_item_role(item_id, array['owner','editor','contributor']));
drop policy if exists refs_edit on public.item_refs;
create policy refs_edit on public.item_refs for update to authenticated
  using (public.has_item_role(item_id, array['owner','editor'])) with check (public.has_item_role(item_id, array['owner','editor']));

-- events: read with the item; written only by the trigger (security definer)
drop policy if exists events_read on public.item_events;
create policy events_read on public.item_events for select to authenticated
  using (public.has_item_role(item_id, array['owner','editor','contributor','viewer']));

-- deliveries: readers of the item see them; agents write them
drop policy if exists deliveries_read on public.notification_deliveries;
create policy deliveries_read on public.notification_deliveries for select to authenticated
  using (public.has_item_role(item_id, array['owner','editor','contributor','viewer']));
drop policy if exists deliveries_add on public.notification_deliveries;
create policy deliveries_add on public.notification_deliveries for insert to authenticated
  with check (public.is_agent() and public.has_item_role(item_id, array['owner','editor','contributor','viewer']));
drop policy if exists deliveries_edit on public.notification_deliveries;
create policy deliveries_edit on public.notification_deliveries for update to authenticated
  using (public.is_agent() and public.has_item_role(item_id, array['owner','editor','contributor','viewer']))
  with check (public.is_agent() and public.has_item_role(item_id, array['owner','editor','contributor','viewer']));
