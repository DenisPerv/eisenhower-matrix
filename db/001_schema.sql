-- db/001_schema.sql: TasksDashboardDB tables and indexes.
-- Source of truth since 2026-10-27; was HomeOS references/homeos/tasksdb/schema.md §1, now history.
-- Apply in file order as postgres (Supabase SQL editor or the Management API). Re-runnable. README "Database".

-- TasksDashboardDB schema. Supabase Postgres 15+. Applied as postgres through the Management API.
create schema if not exists ops;                       -- not exposed through the API; keep-alive only
revoke all on schema ops from public, anon, authenticated;
create table if not exists ops.keepalive (host text primary key, pinged_at timestamptz not null, runs int not null default 0);
revoke all on ops.keepalive from public, anon, authenticated;
alter table ops.keepalive enable row level security;   -- the dashboard asks for it; the definer function bypasses as owner

create table if not exists public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  handle           text not null unique check (handle ~ '^[a-z0-9-]+$'),
  display_name     text not null,
  kind             text not null default 'human' check (kind in ('human','agent')),
  email            text,
  timezone         text not null default 'Europe/Lisbon',
  locale           text not null default 'en',
  mine_tags        text[] not null default '{}',
  reminder_channel text not null default 'local' check (reminder_channel in ('local','telegram','both')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.preferences (
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  app         text not null default 'tasksdashboard' check (app ~ '^[a-z0-9-]+$'),
  prefs       jsonb not null default '{}'::jsonb,
  version     int not null default 1,
  updated_at  timestamptz not null default now(),
  primary key (profile_id, app)
);

create table if not exists public.categories (
  slug            text primary key check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name            text not null,
  description     text,
  default_list_id uuid,                                 -- FK added after lists
  details_hint    text,                                 -- what goes into items.details for this category
  archived_at     timestamptz,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now()
);

create table if not exists public.lists (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique check (slug ~ '^[a-z0-9_][a-z0-9-]*$'),
  name             text not null check (char_length(name) between 1 and 60),
  description      text,
  default_category text references public.categories(slug),
  sort             int not null default 0,
  owner_id         uuid not null references public.profiles(id),
  next_num         int not null default 1,
  archived_at      timestamptz,
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'categories_default_list_fk') then
    alter table public.categories
      add constraint categories_default_list_fk foreign key (default_list_id) references public.lists(id);
  end if;
end $$;

create table if not exists public.list_members (
  list_id    uuid not null references public.lists(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role       text not null check (role in ('owner','editor','contributor','viewer')),
  added_by   uuid references public.profiles(id),
  added_at   timestamptz not null default now(),
  primary key (list_id, profile_id)
);

create table if not exists public.items (
  id            uuid primary key default gen_random_uuid(),
  list_id       uuid not null references public.lists(id),
  category      text not null references public.categories(slug),
  num           int not null,
  title         text not null check (char_length(title) between 1 and 300),
  body_md       text not null default '',
  status        text not null default 'open'
                check (status in ('inbox','open','in_progress','waiting','proposed','agreed','done','cancelled')),
  quadrant      char(1) check (quadrant in ('A','B','C','D')),
  urgent_pin    boolean,
  tags          text[] not null default '{}',
  priority      smallint check (priority between 0 and 5),
  effort_hours  numeric(6,2) check (effort_hours >= 0),
  due_at        timestamptz,
  start_at      timestamptz,
  completed_at  timestamptz,
  owner_id      uuid references public.profiles(id),
  details       jsonb not null default '{}'::jsonb,
  -- provenance and trust (design.md §9); created_by .. actor_kind are set by trigger, never by the client
  created_by    uuid not null references public.profiles(id),
  updated_by    uuid not null references public.profiles(id),
  actor_kind    text not null check (actor_kind in ('human','agent')),
  on_behalf_of  uuid references public.profiles(id),
  created_via   text not null default 'app'
                check (created_via ~ '^(app|migration|telegram|(skill|routine|script|project):[a-z0-9._-]+)$'),
  source_app    text,
  source_ref    text,
  run_id        text,
  dedup_key     text unique,
  ai            jsonb,
  ai_confidence numeric(4,3) check (ai_confidence between 0 and 1),
  review_state  text not null default 'none' check (review_state in ('none','needs_review','confirmed','rejected')),
  validation    text not null default 'verified' check (validation in ('verified','unverified')),
  sensitivity   text not null default 'normal' check (sensitivity in ('normal','personal','restricted')),
  keep_until    date,
  version       int not null default 1,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (list_id, num)
);
create index if not exists items_list_live_idx on public.items (list_id) where deleted_at is null;
create index if not exists items_updated_idx   on public.items (updated_at);
create index if not exists items_due_open_idx  on public.items (due_at) where deleted_at is null and status not in ('done','cancelled');
create index if not exists items_tags_idx      on public.items using gin (tags);
create index if not exists items_review_idx    on public.items (ai_confidence) where review_state = 'needs_review';
create index if not exists items_category_idx  on public.items (category);

create table if not exists public.item_links (
  from_item  uuid not null references public.items(id),
  to_item    uuid not null references public.items(id),
  kind       text not null check (kind in ('depends_on','blocks','relates','duplicates','parent')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (from_item, to_item, kind),
  check (from_item <> to_item)
);

create table if not exists public.item_refs (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.items(id),
  kind       text not null check (kind in ('file','url','memory','decision')),
  target     text not null,                             -- repo-relative path or URL
  note       text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (item_id, kind, target)
);

create table if not exists public.item_events (
  id         bigint generated always as identity primary key,
  item_id    uuid not null references public.items(id),
  at         timestamptz not null default now(),
  actor_id   uuid,
  actor_kind text,
  via        text,
  action     text not null check (action in ('create','update','move','complete','reopen','delete','restore')),
  diff       jsonb,
  run_id     text
);
create index if not exists item_events_item_idx on public.item_events (item_id, at);

create table if not exists public.notification_deliveries (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.items(id),
  profile_id uuid not null references public.profiles(id),
  channel    text not null check (channel in ('telegram','local')),
  for_day    date not null,
  status     text not null default 'sent' check (status in ('sent','failed','skipped')),
  sent_at    timestamptz not null default now(),
  run_id     text,
  error      text,
  unique (item_id, profile_id, channel, for_day)
);
