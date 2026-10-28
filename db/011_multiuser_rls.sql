-- db/011_multiuser_rls.sql: multi-user row level security, grants and policies (HomeOS multi-user-plan.md T4).
-- Runs after 003_rls.sql every time (003 resets grants and recreates the household policies this file replaces).
-- Order rule after any db/ change: 003, 011, 900, 901. Ends with a check that fails if any public table has RLS off or
-- any public function is executable by anon. Re-runnable.

alter table public.tag_lists        enable row level security;
alter table public.tag_list_members enable row level security;
alter table public.tags             enable row level security;
alter table public.item_tags        enable row level security;
alter table public.invites          enable row level security;
alter table public.invite_blocks    enable row level security;

-- ---------- grants ----------
revoke all on public.tag_lists, public.tag_list_members, public.tags, public.item_tags, public.invites, public.invite_blocks
  from anon, authenticated;
-- profiles: is_household readable; never updatable through the API
grant select (id, handle, display_name, kind, timezone, locale, mine_tags, reminder_channel, is_household, created_at, updated_at)
  on public.profiles to authenticated;
-- categories: read only through the API; changed by admin SQL (F3)
revoke insert, update on public.categories from authenticated;
-- list_members: role changes by owners; hidden_at only through set_list_hidden
revoke update on public.list_members from authenticated;
grant update (role) on public.list_members to authenticated;
grant select on public.tag_lists to authenticated;
grant update (name, sort) on public.tag_lists to authenticated;
grant select, delete on public.tag_list_members to authenticated;
grant update (role) on public.tag_list_members to authenticated;
grant select on public.tags to authenticated;
grant insert (tag_list_id, name, sort) on public.tags to authenticated;
grant update (name, sort, deleted_at) on public.tags to authenticated;
grant select on public.item_tags to authenticated;
grant insert (item_id, tag_id) on public.item_tags to authenticated;
grant update (removed_at) on public.item_tags to authenticated;
-- invites: no direct writes; the inviter never sees declined_at (S4)
grant select (id, list_id, tag_list_id, email_lower, role, invited_by, target_name, created_at, expires_at, accepted_at, revoked_at)
  on public.invites to authenticated;
grant select, insert (profile_id, blocked_id), delete on public.invite_blocks to authenticated;

grant execute on function
  public.create_list(text, text, boolean, text),
  public.share_list(uuid, text, text), public.share_tag_list(uuid, text, text), public.my_invitations(),
  public.accept_invite(uuid), public.decline_invite(uuid, boolean), public.revoke_invite(uuid),
  public.leave_list(uuid), public.leave_tag_list(uuid), public.set_list_hidden(uuid, boolean),
  public.set_tag_list_hidden(uuid, boolean), public.list_people(uuid), public.tag_list_people(uuid),
  public.visible_profiles(), public.my_verified_emails(), public.is_household(),
  public.has_tag_list_role(uuid, text[]), public.has_tag_role(uuid, text[]), public.can_edit_item(uuid),
  public.can_use_category(text)
  to authenticated;
-- internal helpers and trigger functions are never RPC endpoints
revoke execute on function
  public.is_admin_sql(), public.setting(text), public.invite_upsert(uuid, uuid, text, text, text), public.my_open_invite(uuid),
  public.hook_before_user_created(jsonb), public.handle_new_user(), public.guard_auth_email_change(), public.guard_auth_identity(),
  public.items_tags_compat(), public.items_tags_compat_after(), public.tags_before_write(), public.item_tags_before_write(),
  public.tag_members_keep_owner(), public.members_after_remove(), public.items_write_rate()
  from public, anon, authenticated;
-- the sign-up hook: Supabase Auth only
grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;

-- ---------- policies ----------

-- profiles (F2): own row; household rows for household members and agents. Others' names: visible_profiles().
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or (is_household and public.is_household()));

-- categories (F3): audience all for everyone with a profile; household categories for household and agents
drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories for select to authenticated
  using (public.my_kind() is not null and (audience = 'all' or public.is_household()));
drop policy if exists categories_add on public.categories;
drop policy if exists categories_edit on public.categories;

-- list_members: direct adds only by a household owner adding a household profile (the household app, CLI and 900);
-- everyone else gains a membership through accept_invite, create_list or handle_new_user. Owner is not grantable.
drop policy if exists members_add on public.list_members;
create policy members_add on public.list_members for insert to authenticated
  with check (public.is_human() and public.is_household() and public.has_list_role(list_id, array['owner'])
              and role <> 'owner'
              and exists (select 1 from public.profiles p where p.id = profile_id and p.is_household));
drop policy if exists members_edit on public.list_members;
create policy members_edit on public.list_members for update to authenticated
  using (public.is_human() and public.has_list_role(list_id, array['owner']))
  with check (public.is_human() and public.has_list_role(list_id, array['owner']) and role <> 'owner');
drop policy if exists members_remove on public.list_members;
create policy members_remove on public.list_members for delete to authenticated
  using ((public.is_human() and public.has_list_role(list_id, array['owner']) and profile_id <> auth.uid())
         or (profile_id = auth.uid() and role <> 'owner'));

-- links: readable only with read access to both ends (F7)
drop policy if exists links_read on public.item_links;
create policy links_read on public.item_links for select to authenticated
  using (public.has_item_role(from_item, array['owner','editor','contributor','viewer'])
     and public.has_item_role(to_item,   array['owner','editor','contributor','viewer']));

-- tag lists: members read; the owner renames
drop policy if exists tag_lists_read on public.tag_lists;
create policy tag_lists_read on public.tag_lists for select to authenticated
  using (public.has_tag_list_role(id, array['owner','editor','viewer']));
drop policy if exists tag_lists_edit on public.tag_lists;
create policy tag_lists_edit on public.tag_lists for update to authenticated
  using (public.has_tag_list_role(id, array['owner'])) with check (public.has_tag_list_role(id, array['owner']));

drop policy if exists tag_members_read on public.tag_list_members;
create policy tag_members_read on public.tag_list_members for select to authenticated
  using (profile_id = auth.uid() or public.has_tag_list_role(tag_list_id, array['owner','editor']));
drop policy if exists tag_members_edit on public.tag_list_members;
create policy tag_members_edit on public.tag_list_members for update to authenticated
  using (public.has_tag_list_role(tag_list_id, array['owner']))
  with check (public.has_tag_list_role(tag_list_id, array['owner']) and role <> 'owner');
drop policy if exists tag_members_remove on public.tag_list_members;
create policy tag_members_remove on public.tag_list_members for delete to authenticated
  using ((public.has_tag_list_role(tag_list_id, array['owner']) and profile_id <> auth.uid())
         or (profile_id = auth.uid() and role <> 'owner'));

-- tags: members of the tag list read; owner and editors write (no delete: deleted_at)
drop policy if exists tags_read on public.tags;
create policy tags_read on public.tags for select to authenticated
  using (public.has_tag_list_role(tag_list_id, array['owner','editor','viewer']));
drop policy if exists tags_add on public.tags;
create policy tags_add on public.tags for insert to authenticated
  with check (public.has_tag_list_role(tag_list_id, array['owner','editor']));
drop policy if exists tags_edit on public.tags;
create policy tags_edit on public.tags for update to authenticated
  using (public.has_tag_list_role(tag_list_id, array['owner','editor']))
  with check (public.has_tag_list_role(tag_list_id, array['owner','editor']));

-- item_tags: read needs the item AND the tag's list; add and soft-remove need edit rights on the item AND owner or
-- editor on the tag's list
drop policy if exists item_tags_read on public.item_tags;
create policy item_tags_read on public.item_tags for select to authenticated
  using (public.has_item_role(item_id, array['owner','editor','contributor','viewer'])
     and public.has_tag_role(tag_id, array['owner','editor','viewer']));
drop policy if exists item_tags_add on public.item_tags;
create policy item_tags_add on public.item_tags for insert to authenticated
  with check (public.can_edit_item(item_id) and public.has_tag_role(tag_id, array['owner','editor']));
drop policy if exists item_tags_edit on public.item_tags;
create policy item_tags_edit on public.item_tags for update to authenticated
  using (public.can_edit_item(item_id) and public.has_tag_role(tag_id, array['owner','editor']))
  with check (public.can_edit_item(item_id) and public.has_tag_role(tag_id, array['owner','editor']));

-- invites: the inviter, or the invitee by verified identity email (S1); writes only through the functions
drop policy if exists invites_read on public.invites;
create policy invites_read on public.invites for select to authenticated
  using (invited_by = auth.uid() or email_lower in (select public.my_verified_emails()));

-- invite blocks: own rows
drop policy if exists blocks_own on public.invite_blocks;
create policy blocks_own on public.invite_blocks for all to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- ---------- final check ----------
do $$
declare v text;
begin
  select string_agg(c.relname, ', ') into v from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if v is not null then raise exception '011: RLS is off on public tables: %', v; end if;
  select string_agg(p.proname, ', ') into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
  if v is not null then raise exception '011: functions executable by anon: %', v; end if;
end $$;
