-- db/031_harness_web.sql: the Eisenhower Harness live page on the web (HomeOS task "HomeOS - SelfImprovements #45", plan v4,
-- 2026-11-09). One link, /harness/ on the app host, shows exactly the page of a PC's local runs-server, read from here, and its
-- buttons queue commands that the PC that owns the run carries out (the PC program HomeOS-TasksBoardHarness/scripts/harness-web.js).
--
--   harness_devices   one row per PC: label, the login that writes for it (writer_id, homeos-agent), the person who owns its runs
--                     (owner_id: Maksym for MDENYSIUK-PERS, Anastasiia for AKhrystina-Lap), and the program's last beat, state
--                     (running | offline), controls switch and the last time a reader looked. Rows by admin SQL only.
--   harness_heads     one row per device and run: seq (bumped by every push, compare-and-set), live, the head (run-list row,
--                     trimmed parts, withheld count) and, in a column no API role may select, the session index name -> list_id | 'master' | null.
--   harness_parts     the run split by the PC (lib/run-snapshot.js): 'household', 'list:<list_id>', 'feed:<name>:<k>'; list_id says
--                     who may select it (null: the household only).
--   harness_commands  a button pressed on the web: pending -> taken -> done | refused | unknown, or expired after 2 minutes.
--
-- Who may select: heads and devices every whitelisted login; a part with a list_id the household or a member of that list
-- (owner, editor, contributor, viewer); a part with no list_id the household; commands the household and the person who asked.
-- Runs older than 30 days are never selected and are deleted by harness_sweep. No API role writes a table: every write is an RPC.
-- Who may press (plan v4 decision 2): a session of a list, and that list's limits: an owner of that list (has_list_role owner);
-- the master session and the default limits: the owner of that PC's runs (harness_devices.owner_id). Checked when queued and
-- again when taken. A note and a limits change also need a sign-in younger than 15 minutes (JWT amr), errcode 28000.
-- The PC: harness_push / harness_beat / harness_take / harness_done / harness_recover / harness_sweep only for a device whose
-- writer_id is the caller. Both PCs sign in as homeos-agent, so the device name is the PC's own claim; the program also refuses
-- a run that is not in its own Runs/ folder (C19).
--
-- Error codes: 42501 not allowed, 22023 bad value, 40001 stale seq (push again from a fresh head), 54000 size or rate limit,
-- 55000 the device is silent or its remote control is off, 28000 sign in again.
-- Additive and re-runnable. 003_rls.sql revokes every table grant from authenticated: re-run this file after 003 (like 026).
-- Rollback: 031_down_harness_web.sql. Selftest: 914_selftest_harness_web.sql.

-- ---------- tables ----------

create table if not exists public.harness_devices (
  device      text primary key check (device ~ '^[A-Za-z0-9_-]{1,40}$'),
  label       text not null check (length(label) between 1 and 60),
  writer_id   uuid not null references public.profiles(id),
  owner_id    uuid not null references public.profiles(id),
  beat_at     timestamptz,
  state       text not null default 'offline' check (state in ('running', 'offline')),
  controls    boolean not null default false,
  viewed_at   timestamptz,
  bytes_day   date,
  bytes_up    bigint not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.harness_heads (
  device      text not null references public.harness_devices(device) on delete cascade,
  run_ts      text not null check (run_ts ~ '^\d{4}-\d\d-\d\d--\d\d-\d\d$'),
  seq         bigint not null default 0,
  live        boolean not null default false,
  head        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (device, run_ts)
);
-- the session index (name -> list_id | 'master' | null), taken out of the head by harness_push: only harness_right reads it, no API role
-- may select it, so a guest of one list does not learn the names of the household's other sessions (critic 2026-11-09)
alter table public.harness_heads add column if not exists sessions jsonb not null default '{}'::jsonb;

create table if not exists public.harness_parts (
  device      text not null,
  run_ts      text not null,
  part        text not null check (part ~ '^(household|list:[0-9a-f-]{36}|feed:[a-z0-9_-]{1,60}:\d{1,3})$'),
  list_id     uuid references public.lists(id) on delete cascade,
  seq         bigint not null,
  hash        text not null check (length(hash) <= 64),
  body        jsonb not null,
  bytes       int not null,
  primary key (device, run_ts, part),
  foreign key (device, run_ts) references public.harness_heads(device, run_ts) on delete cascade
);
create index if not exists harness_parts_list on public.harness_parts (list_id);

create table if not exists public.harness_commands (
  id            uuid primary key default gen_random_uuid(),
  device        text not null references public.harness_devices(device) on delete cascade,
  run_ts        text not null check (run_ts ~ '^\d{4}-\d\d-\d\d--\d\d-\d\d$'),
  name          text check (name is null or name ~ '^[a-z0-9_-]{1,60}$'),
  scope_list_id uuid references public.lists(id) on delete cascade,
  action        text not null check (action in ('stop', 'continue', 'takeover', 'release', 'limits')),
  note          text check (note is null or length(note) <= 1000),
  payload       jsonb check (payload is null or octet_length(payload::text) <= 4096),
  expect_state  text check (expect_state is null or expect_state ~ '^[a-z][a-z-]{1,30}$'),
  base_hash     text check (base_hash is null or base_hash ~ '^[0-9a-f]{1,64}$'),
  idem_key      text not null check (idem_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  requested_by  uuid not null references public.profiles(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '2 minutes',
  state         text not null default 'pending' check (state in ('pending', 'taken', 'done', 'refused', 'expired', 'unknown')),
  taken_at      timestamptz,
  result        text check (result is null or length(result) <= 2000),
  unique (requested_by, idem_key),
  check ((action = 'limits') = (payload is not null)),
  check (action = 'limits' or name is not null),
  check (action = 'limits' or expect_state is not null),
  check (action <> 'limits' or base_hash is not null),
  check (note is null or action = 'continue')
);
create index if not exists harness_commands_queue on public.harness_commands (device, state, created_at);

alter table public.harness_devices  enable row level security;
alter table public.harness_heads    enable row level security;
alter table public.harness_parts    enable row level security;
alter table public.harness_commands enable row level security;

-- ---------- helpers (not RPC endpoints) ----------

-- the time a run started, from its folder name; null when it is not one
create or replace function public.harness_run_at(p_ts text) returns timestamptz
language sql stable set search_path = '' as $$
  select case when p_ts ~ '^\d{4}-\d\d-\d\d--\d\d-\d\d$' then to_timestamp(p_ts, 'YYYY-MM-DD--HH24-MI') end
$$;

create or replace function public.harness_in_window(p_ts text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(public.harness_run_at(p_ts) > now() - interval '30 days' and public.harness_run_at(p_ts) < now() + interval '1 day', false)
$$;

-- the caller writes for that device
create or replace function public.harness_is_writer(p_device text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.harness_devices d where d.device = p_device and d.writer_id = auth.uid())
$$;

-- seconds since the caller signed in (JWT amr), or null when the token says nothing
create or replace function public.harness_signin_age() returns numeric
language sql stable set search_path = '' as $$
  select extract(epoch from now()) - max((e ->> 'timestamp')::numeric)
    from jsonb_array_elements(case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr' else '[]'::jsonb end) e
   where (e ->> 'timestamp') ~ '^\d+$'
$$;

-- may p_who press this command's button now? null = yes, else the reason (decision 2)
create or replace function public.harness_right(p_who uuid, p_device text, p_run_ts text, p_name text, p_action text, p_scope_list uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid; v_idx text;
begin
  select owner_id into v_owner from public.harness_devices where device = p_device;
  if v_owner is null then return 'no such device'; end if;
  if p_action = 'limits' then
    if p_scope_list is null then
      return case when p_who = v_owner then null else 'only the owner of this PC may change the default limits' end;
    end if;
    return case when exists (select 1 from public.list_members m where m.list_id = p_scope_list and m.profile_id = p_who and m.role = 'owner')
                then null else 'only the owners of this list may change its limits' end;
  end if;
  select h.sessions ->> p_name into v_idx from public.harness_heads h where h.device = p_device and h.run_ts = p_run_ts;
  if v_idx is null then return 'no such session in this run'; end if;
  if v_idx = 'master' then
    return case when p_who = v_owner then null else 'only the owner of this PC may control its master' end;
  end if;
  if v_idx !~ '^[0-9a-f-]{36}$' then return 'this session belongs to no shared list'; end if;
  return case when exists (select 1 from public.list_members m where m.list_id = v_idx::uuid and m.profile_id = p_who and m.role = 'owner')
              then null else 'only the owners of this list may' end;
end $$;

-- ---------- the PC: push, beat, take, done, recover, sweep ----------

-- One push = one transaction and one seq (C1, C3). p_put: { "<part>": { "list_id": uuid|null, "hash": text, "body": json } }.
create or replace function public.harness_push(p_device text, p_run_ts text, p_base_seq bigint, p_live boolean, p_head jsonb,
                                               p_put jsonb, p_del text[] default '{}') returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_seq bigint; v_new bigint; k text; v jsonb; v_list uuid; v_bytes int; v_total int; d public.harness_devices;
begin
  if not public.harness_is_writer(p_device) then raise exception 'not the writer of this device' using errcode = '42501'; end if;
  if not public.harness_in_window(p_run_ts) then raise exception 'run outside the 30 days' using errcode = '22023'; end if;
  if jsonb_typeof(p_put) is distinct from 'object' or jsonb_typeof(p_head) is distinct from 'object' then
    raise exception 'put and head are objects' using errcode = '22023';
  end if;
  v_total := octet_length(p_put::text) + octet_length(p_head::text);
  if v_total > 2 * 1024 * 1024 then raise exception 'push over 2 MB' using errcode = '54000'; end if;
  select * into d from public.harness_devices where device = p_device for update;
  if d.bytes_day is distinct from current_date then d.bytes_up := 0; end if;
  if d.bytes_up + v_total > 200 * 1024 * 1024 then raise exception 'over 200 MB today: pushing stops until tomorrow' using errcode = '54000'; end if;
  update public.harness_devices set bytes_day = current_date, bytes_up = d.bytes_up + v_total, beat_at = now(), state = 'running' where device = p_device;

  insert into public.harness_heads (device, run_ts) values (p_device, p_run_ts) on conflict do nothing;
  select seq into v_seq from public.harness_heads where device = p_device and run_ts = p_run_ts for update;
  if v_seq <> p_base_seq then raise exception 'stale seq: % here, % sent', v_seq, p_base_seq using errcode = '40001'; end if;
  v_new := v_seq + 1;

  for k, v in select * from jsonb_each(p_put) loop
    v_list := nullif(v ->> 'list_id', '')::uuid;
    if k !~ '^(household|list:[0-9a-f-]{36}|feed:[a-z0-9_-]{1,60}:\d{1,3})$' then raise exception 'bad part %', k using errcode = '22023'; end if;
    if k = 'household' and v_list is not null then raise exception 'the household part has no list' using errcode = '22023'; end if;
    if k like 'list:%' and v_list is distinct from substr(k, 6)::uuid then raise exception 'part % names another list', k using errcode = '22023'; end if;
    if v_list is not null and not public.has_list_role(v_list, array['owner', 'editor', 'contributor', 'viewer']) then
      raise exception 'no role on the list of part %', k using errcode = '42501';
    end if;
    v_bytes := octet_length((v -> 'body')::text);
    if v -> 'body' is null then raise exception 'part % has no body', k using errcode = '22023'; end if;
    if v_bytes > (case when k like 'feed:%' then 64 else 512 end) * 1024 then raise exception 'part % too large', k using errcode = '54000'; end if;
    insert into public.harness_parts (device, run_ts, part, list_id, seq, hash, body, bytes)
    values (p_device, p_run_ts, k, v_list, v_new, left(coalesce(v ->> 'hash', ''), 64), v -> 'body', v_bytes)
    on conflict (device, run_ts, part) do update set list_id = excluded.list_id, seq = excluded.seq, hash = excluded.hash, body = excluded.body, bytes = excluded.bytes;
  end loop;
  delete from public.harness_parts where device = p_device and run_ts = p_run_ts and part = any (coalesce(p_del, '{}'));
  update public.harness_heads set seq = v_new, live = coalesce(p_live, false), head = p_head - 'sessions',
         sessions = case when jsonb_typeof(p_head -> 'sessions') = 'object' then p_head -> 'sessions' else '{}'::jsonb end, updated_at = now()
   where device = p_device and run_ts = p_run_ts;
  return v_new;
end $$;

-- Once a minute (C9), and "offline" on a clean exit. Returns the time a reader last looked (the program polls faster after it).
create or replace function public.harness_beat(p_device text, p_state text, p_controls boolean) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare v timestamptz;
begin
  if not public.harness_is_writer(p_device) then raise exception 'not the writer of this device' using errcode = '42501'; end if;
  if p_state not in ('running', 'offline') then raise exception 'bad state' using errcode = '22023'; end if;
  update public.harness_devices set beat_at = now(), state = p_state, controls = coalesce(p_controls, false)
   where device = p_device returning viewed_at into v;
  return v;
end $$;

-- A reader has the page open (the program polls commands every 5 s for 2 minutes after it).
create or replace function public.harness_view(p_device text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_whitelisted_login(auth.uid()) then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.harness_devices set viewed_at = now() where device = p_device and (viewed_at is null or viewed_at < now() - interval '20 seconds');
end $$;

-- The commands for this device, taken at most once each (C18): expired ones are marked first; rights are checked again (C28).
create or replace function public.harness_take(p_device text) returns setof public.harness_commands
language plpgsql security definer set search_path = '' as $$
declare c public.harness_commands; why text;
begin
  if not public.harness_is_writer(p_device) then raise exception 'not the writer of this device' using errcode = '42501'; end if;
  update public.harness_commands set state = 'expired' where device = p_device and state = 'pending' and expires_at <= now();
  for c in select * from public.harness_commands where device = p_device and state = 'pending' order by created_at for update skip locked loop
    why := public.harness_right(c.requested_by, c.device, c.run_ts, c.name, c.action, c.scope_list_id);
    if why is not null then
      update public.harness_commands set state = 'refused', result = 'refused when taken: ' || why where id = c.id;
      continue;
    end if;
    update public.harness_commands set state = 'taken', taken_at = now() where id = c.id and state = 'pending' returning * into c;
    if found then return next c; end if;
  end loop;
end $$;

create or replace function public.harness_done(p_id uuid, p_state text, p_result text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_dev text;
begin
  if p_state not in ('done', 'refused', 'unknown') then raise exception 'bad state' using errcode = '22023'; end if;
  select device into v_dev from public.harness_commands where id = p_id;
  if v_dev is null or not public.harness_is_writer(v_dev) then raise exception 'not the writer of this device' using errcode = '42501'; end if;
  update public.harness_commands set state = p_state, result = left(p_result, 2000) where id = p_id and state = 'taken';
  if not found then raise exception 'not a taken command' using errcode = '22023'; end if;
end $$;

-- At the program's start, after a crash between take and done (F4, F6): continue and takeover become unknown and never run again;
-- stop, release and limits taken in the last 5 minutes are returned (still taken) to run once more if the session is still in the
-- state they expected; older ones become unknown too, so a stale stop never ends a session the person resumed since (critic 2026-11-09).
create or replace function public.harness_recover(p_device text) returns setof public.harness_commands
language plpgsql security definer set search_path = '' as $$
begin
  if not public.harness_is_writer(p_device) then raise exception 'not the writer of this device' using errcode = '42501'; end if;
  update public.harness_commands set state = 'unknown', result = 'the PC stopped while carrying it out: look at the session'
   where device = p_device and state = 'taken'
     and (action in ('continue', 'takeover') or taken_at is null or taken_at <= now() - interval '5 minutes');
  return query select * from public.harness_commands where device = p_device and state = 'taken' and action in ('stop', 'release', 'limits') order by created_at;
end $$;

-- Every minute: expiry and the 30-day retention of this device's rows.
create or replace function public.harness_sweep(p_device text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n_exp int; n_cmd int; n_run int;
begin
  if not public.harness_is_writer(p_device) then raise exception 'not the writer of this device' using errcode = '42501'; end if;
  update public.harness_commands set state = 'expired' where device = p_device and state = 'pending' and expires_at <= now();
  get diagnostics n_exp = row_count;
  delete from public.harness_commands where device = p_device and created_at < now() - interval '30 days';
  get diagnostics n_cmd = row_count;
  delete from public.harness_heads where device = p_device and not public.harness_in_window(run_ts);
  get diagnostics n_run = row_count;
  return jsonb_build_object('expired', n_exp, 'commands_deleted', n_cmd, 'runs_deleted', n_run);
end $$;

-- ---------- the reader: a button ----------

-- Queues one command (decision 2 rights, rates, expiry, idempotency, fresh sign-in). The session's list comes from the head the PC
-- pushed, never from the caller; for limits, the caller names the list (p_scope_list) and its owner role is checked.
create or replace function public.harness_request(p_device text, p_run_ts text, p_action text, p_name text default null, p_note text default null,
                                                  p_payload jsonb default null, p_scope_list uuid default null, p_expect_state text default null,
                                                  p_base_hash text default null, p_idem_key text default null) returns public.harness_commands
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); c public.harness_commands; d public.harness_devices; why text; v_scope uuid;
begin
  if me is null or not public.is_human() or not public.is_whitelisted_login(me) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_idem_key is null or p_idem_key !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'idem_key is required' using errcode = '22023'; end if;
  select * into c from public.harness_commands where requested_by = me and idem_key = p_idem_key;
  if found then return c; end if;   -- a second press of the same click (two tabs, a retry) gets the same row
  if p_action not in ('stop', 'continue', 'takeover', 'release', 'limits') then raise exception 'bad action' using errcode = '22023'; end if;
  if not public.harness_in_window(p_run_ts) then raise exception 'run outside the 30 days' using errcode = '22023'; end if;
  select * into d from public.harness_devices where device = p_device;
  if not found then raise exception 'no such device' using errcode = '22023'; end if;
  if d.beat_at is null or d.beat_at < now() - interval '3 minutes' or d.state <> 'running' then
    raise exception '% is silent: run the local version', d.label using errcode = '55000';
  end if;
  if not d.controls then raise exception 'remote control is off on %', d.label using errcode = '55000'; end if;
  if p_action = 'limits' then
    if p_payload is null or jsonb_typeof(p_payload) <> 'object' or p_base_hash is null then raise exception 'limits need a payload and a base_hash' using errcode = '22023'; end if;
    if p_scope_list is not null then
      if not exists (select 1 from public.lists l where l.id = p_scope_list and l.slug = p_payload ->> 'slug') then
        raise exception 'the payload names another list' using errcode = '22023';
      end if;
    elsif p_payload ? 'slug' then raise exception 'default limits name no list' using errcode = '22023';
    end if;
    v_scope := p_scope_list;
  else
    if p_name is null or p_expect_state is null then raise exception 'a session button needs the session and its state' using errcode = '22023'; end if;
    if p_note is not null and p_action <> 'continue' then raise exception 'a note goes with continue only' using errcode = '22023'; end if;
    select nullif(h.sessions ->> p_name, 'master') into why from public.harness_heads h where h.device = p_device and h.run_ts = p_run_ts;
    v_scope := case when why ~ '^[0-9a-f-]{36}$' then why::uuid end;
  end if;
  if (p_action = 'limits' or nullif(btrim(coalesce(p_note, '')), '') is not null)
     and coalesce(public.harness_signin_age(), 1e9) > 15 * 60 then
    raise exception 'sign in again: notes and limits need a sign-in from the last 15 minutes' using errcode = '28000';
  end if;
  why := public.harness_right(me, p_device, p_run_ts, p_name, p_action, v_scope);
  if why is not null then raise exception '%', why using errcode = '42501'; end if;
  if (select count(*) from public.harness_commands where device = p_device and state = 'pending' and expires_at > now()) >= 10 then
    raise exception 'too many commands waiting for %', d.label using errcode = '54000';
  end if;
  if (select count(*) from public.harness_commands where requested_by = me and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'too many commands in the last hour' using errcode = '54000';
  end if;
  insert into public.harness_commands (device, run_ts, name, scope_list_id, action, note, payload, expect_state, base_hash, idem_key, requested_by)
  values (p_device, p_run_ts, case when p_action = 'limits' then null else p_name end, v_scope, p_action, nullif(btrim(coalesce(p_note, '')), ''),
          case when p_action = 'limits' then p_payload end, case when p_action = 'limits' then null else p_expect_state end,
          case when p_action = 'limits' then p_base_hash end, p_idem_key, me)
  on conflict (requested_by, idem_key) do nothing
  returning * into c;
  if c.id is null then select * into c from public.harness_commands where requested_by = me and idem_key = p_idem_key; end if;
  return c;
end $$;

-- ---------- policies: select only ----------

drop policy if exists harness_devices_select on public.harness_devices;
create policy harness_devices_select on public.harness_devices for select to authenticated
  using ((select public.is_whitelisted_login(auth.uid())));
drop policy if exists harness_heads_select on public.harness_heads;
create policy harness_heads_select on public.harness_heads for select to authenticated
  using ((select public.is_whitelisted_login(auth.uid())) and public.harness_in_window(run_ts));
drop policy if exists harness_parts_select on public.harness_parts;
create policy harness_parts_select on public.harness_parts for select to authenticated
  using ((select public.is_whitelisted_login(auth.uid())) and public.harness_in_window(run_ts)
         and ((select public.is_household())
              or (list_id is not null and public.has_list_role(list_id, array['owner', 'editor', 'contributor', 'viewer']))));
drop policy if exists harness_commands_select on public.harness_commands;
create policy harness_commands_select on public.harness_commands for select to authenticated
  using (created_at > now() - interval '30 days' and ((select public.is_household()) or requested_by = auth.uid()));

-- ---------- grants ----------

revoke all on public.harness_devices, public.harness_heads, public.harness_parts, public.harness_commands from anon, authenticated, public;
grant select (device, label, owner_id, beat_at, state, controls, viewed_at) on public.harness_devices to authenticated;
grant select (device, run_ts, seq, live, head, updated_at) on public.harness_heads to authenticated;
grant select on public.harness_parts, public.harness_commands to authenticated;

revoke all on function public.harness_run_at(text), public.harness_in_window(text), public.harness_is_writer(text), public.harness_signin_age(),
  public.harness_right(uuid, text, text, text, text, uuid),
  public.harness_push(text, text, bigint, boolean, jsonb, jsonb, text[]), public.harness_beat(text, text, boolean), public.harness_view(text),
  public.harness_take(text), public.harness_done(uuid, text, text), public.harness_recover(text), public.harness_sweep(text),
  public.harness_request(text, text, text, text, text, jsonb, uuid, text, text, text) from public, anon, authenticated;
-- the policies call these two as the reader
grant execute on function public.harness_in_window(text), public.harness_run_at(text) to authenticated;
grant execute on function public.harness_push(text, text, bigint, boolean, jsonb, jsonb, text[]), public.harness_beat(text, text, boolean),
  public.harness_view(text), public.harness_take(text), public.harness_done(uuid, text, text), public.harness_recover(text),
  public.harness_sweep(text), public.harness_request(text, text, text, text, text, jsonb, uuid, text, text, text) to authenticated;
