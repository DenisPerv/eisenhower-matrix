-- db/009_multiuser_schema.sql: multi-user tables and columns (HomeOS multi-user-plan.md T2, review §4-§9).
-- Household flag, category audience, owner-scoped slugs and dedup keys, hide-for-me, invitations and blocks, private tags
-- in tag lists, the sign-up allowlist and settings, indexes, a Default tag list per profile. Additive and idempotent.
-- Order rule after this file: 010_multiuser_functions.sql, then 003_rls.sql, 011_multiuser_rls.sql, 900, 901.

-- household vs guest (review §4): set by admin SQL only, never through the API
alter table public.profiles add column if not exists is_household boolean not null default false;
update public.profiles set is_household = true
 where handle in ('maksym','anastasiia','homeos-agent','telegram-bot') and not is_household;

-- categories: 'all' for everyone, 'household' for household members and agents (F3)
alter table public.categories add column if not exists audience text not null default 'all';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'categories_audience_check') then
    alter table public.categories add constraint categories_audience_check check (audience in ('all','household'));
  end if;
end $$;
update public.categories set audience = 'household'
 where slug in ('tbd','decision','candidate','plan','wish','renewal') and audience <> 'household';

-- lists: slug unique per owner, not globally (F4)
do $$
declare c text;
begin
  for c in select con.conname from pg_constraint con
            where con.conrelid = 'public.lists'::regclass and con.contype = 'u'
              and con.conkey = array[(select attnum from pg_attribute where attrelid = 'public.lists'::regclass and attname = 'slug')]
  loop execute format('alter table public.lists drop constraint %I', c); end loop;
  if not exists (select 1 from pg_constraint where conname = 'lists_owner_slug_key') then
    alter table public.lists add constraint lists_owner_slug_key unique (owner_id, slug);
  end if;
end $$;

-- items: dedup key unique per space owner (= the list's owner), not globally (F5).
-- 010's items_before_write sets space_owner_id on insert and move, then makes it not null.
alter table public.items add column if not exists space_owner_id uuid references public.profiles(id);
update public.items i set space_owner_id = l.owner_id
  from public.lists l where l.id = i.list_id and i.space_owner_id is distinct from l.owner_id;
do $$
declare c text;
begin
  for c in select con.conname from pg_constraint con
            where con.conrelid = 'public.items'::regclass and con.contype = 'u'
              and con.conkey = array[(select attnum from pg_attribute where attrelid = 'public.items'::regclass and attname = 'dedup_key')]
  loop execute format('alter table public.items drop constraint %I', c); end loop;
  if not exists (select 1 from pg_constraint where conname = 'items_space_dedup_key') then
    alter table public.items add constraint items_space_dedup_key unique (space_owner_id, dedup_key);
  end if;
end $$;

-- hide a list for me, next to archive for everyone (F11)
alter table public.list_members add column if not exists hidden_at timestamptz;

-- tag lists (M3, review §6): one Default per person in v1
create table if not exists public.tag_lists (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  is_default  boolean not null default false,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists tag_lists_one_default on public.tag_lists (owner_id) where is_default;

create table if not exists public.tag_list_members (
  tag_list_id uuid not null references public.tag_lists(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  role        text not null check (role in ('owner','editor','viewer')),
  added_by    uuid references public.profiles(id),
  added_at    timestamptz not null default now(),
  hidden_at   timestamptz,
  primary key (tag_list_id, profile_id)
);

create table if not exists public.tags (
  id          uuid primary key default gen_random_uuid(),
  tag_list_id uuid not null references public.tag_lists(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  sort        double precision not null default 0,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create unique index if not exists tags_list_name_key on public.tags (tag_list_id, lower(name));

-- a tag on an item; removal is soft so pollers see it (A1)
create table if not exists public.item_tags (
  item_id    uuid not null references public.items(id),
  tag_id     uuid not null references public.tags(id),
  added_by   uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  changed_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (item_id, tag_id)
);

-- invitations to a list or a tag list (review §6); matched on the invitee's verified identity email (S1)
create table if not exists public.invites (
  id          uuid primary key default gen_random_uuid(),
  list_id     uuid references public.lists(id) on delete cascade,
  tag_list_id uuid references public.tag_lists(id) on delete cascade,
  email_lower text not null check (email_lower = lower(email_lower) and email_lower ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  role        text not null,
  invited_by  uuid not null references public.profiles(id) on delete cascade,
  target_name text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 days',
  accepted_at timestamptz,
  accepted_by uuid references public.profiles(id) on delete set null,
  declined_at timestamptz,
  revoked_at  timestamptz,
  check (num_nonnulls(list_id, tag_list_id) = 1),
  check ((list_id is not null and role in ('editor','contributor','viewer'))
      or (tag_list_id is not null and role in ('editor','viewer')))
);
-- one open invitation per target and email, a declined one included (share again refreshes that row, so the owner
-- never sees a second "pending" row that would reveal a decline: S4)
create unique index if not exists invites_one_open on public.invites (coalesce(list_id, tag_list_id), email_lower)
  where accepted_at is null and revoked_at is null;

create table if not exists public.invite_blocks (
  profile_id uuid not null references public.profiles(id) on delete cascade,   -- who blocks
  blocked_id uuid not null references public.profiles(id) on delete cascade,   -- whose invitations are hidden
  created_at timestamptz not null default now(),
  primary key (profile_id, blocked_id)
);

-- sign-up allowlist (one-shot rows for admin-created password logins) and settings (caps, limits); admin SQL only
create table if not exists ops.signup_allowlist (
  id           uuid primary key default gen_random_uuid(),
  email_lower  text not null check (email_lower = lower(email_lower)),
  kind         text not null default 'human' check (kind in ('human','agent')),
  is_household boolean not null default false,
  created_by   text not null default session_user,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '15 minutes',   -- add it right before creating the login
  used_at      timestamptz
);
create table if not exists ops.settings (key text primary key, value numeric not null, note text);
revoke all on ops.signup_allowlist, ops.settings from public, anon, authenticated;
alter table ops.signup_allowlist enable row level security;
alter table ops.settings         enable row level security;
insert into ops.settings (key, value, note) values
  ('max_users',               200,   'hook: human profiles before Google sign-ups are refused'),
  ('max_db_mb',               400,   'hook: database size before Google sign-ups are refused'),
  ('write_rate_per_min',      120,   'item writes per guest per minute, any statement size (S7)'),
  ('household_write_rate_per_min', 1000, 'item writes per household member or agent per minute'),
  ('guest_writes_per_day',    2000,  'item writes per guest per 24 hours'),
  ('guest_lists',             20,    'live lists a guest owns'),
  ('guest_lists_total',       100,   'lists a guest owns, archived included'),
  ('guest_items',             1000,  'live items a guest created'),
  ('guest_items_total',       3000,  'items a guest created, deleted included'),
  ('guest_tags',              500,   'live tags in a guest''s tag lists'),
  ('guest_body_chars',        10000, 'body_md length for guests'),
  ('guest_details_bytes',     8192,  'details size for guests'),
  ('household_lists',         50,    'live lists a household member owns'),
  ('household_items_per_list',5000,  'live items per list for household writers'),
  ('household_tags',          5000,  'live tags in a household member''s tag lists'),
  ('invites_per_day',         20,    'invitations a person sends per 24 hours'),
  ('invites_open',            50,    'open invitations a person has at once')
on conflict (key) do nothing;

-- size caps on text people set through the API (S6)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_display_name_len') then
    alter table public.profiles add constraint profiles_display_name_len check (char_length(display_name) between 1 and 60);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_mine_tags_len') then
    alter table public.profiles add constraint profiles_mine_tags_len check (cardinality(mine_tags) <= 50);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'preferences_prefs_size') then
    alter table public.preferences add constraint preferences_prefs_size check (octet_length(prefs::text) <= 65536);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'item_refs_target_len') then
    alter table public.item_refs add constraint item_refs_target_len
      check (char_length(target) <= 2048 and char_length(coalesce(note, '')) <= 2000);
  end if;
end $$;

-- indexes (A2)
create index if not exists list_members_profile_idx     on public.list_members (profile_id);
create index if not exists tag_list_members_profile_idx on public.tag_list_members (profile_id);
create index if not exists item_tags_item_idx           on public.item_tags (item_id);
create index if not exists item_tags_changed_idx        on public.item_tags (changed_at);
create index if not exists invites_open_email_idx       on public.invites (email_lower)
  where accepted_at is null and declined_at is null and revoked_at is null;
create index if not exists item_events_actor_idx        on public.item_events (actor_id, at);
create index if not exists items_created_by_live_idx    on public.items (created_by) where deleted_at is null;
create index if not exists items_space_owner_idx        on public.items (space_owner_id);

-- back-fill: a profile (guest) for any auth user without one, then a Default tag list for every profile and
-- "My tasks" for back-filled guests. 010's handle_new_user does the same for new users.
insert into public.profiles (id, handle, display_name, kind, email, is_household, mine_tags, reminder_channel)
select u.id, 'u-' || substr(md5(u.id::text), 1, 8),
       left(coalesce(nullif(regexp_replace(trim(coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', '')), '[[:cntrl:]]', '', 'g'), ''),
                     nullif(split_part(coalesce(u.email, ''), '@', 1), ''), 'User'), 60),
       'human', u.email, false, '{}', 'local'
  from auth.users u
 where not exists (select 1 from public.profiles p where p.id = u.id)
   and coalesce(u.raw_app_meta_data->>'provider', '') <> ''
   and not coalesce(u.is_anonymous, false);
with p as (select id from public.profiles pr
            where pr.handle ~ '^u-[0-9a-f]{8}$'
              and not exists (select 1 from public.lists l where l.owner_id = pr.id)),
     l as (insert into public.lists (slug, name, default_category, owner_id, created_by, sort)
           select 'my-tasks', 'My tasks', 'task', p.id, p.id, 1 from p
           on conflict (owner_id, slug) do nothing returning id, owner_id)
insert into public.list_members (list_id, profile_id, role, added_by)
select l.id, l.owner_id, 'owner', l.owner_id from l on conflict do nothing;
insert into public.tag_lists (owner_id, name, is_default)
select p.id, 'Default', true from public.profiles p
 where not exists (select 1 from public.tag_lists t where t.owner_id = p.id and t.is_default);
insert into public.tag_list_members (tag_list_id, profile_id, role, added_by)
select t.id, t.owner_id, 'owner', t.owner_id from public.tag_lists t
on conflict (tag_list_id, profile_id) do nothing;
