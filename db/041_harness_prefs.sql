-- db/041_harness_prefs.sql: the Eisenhower harness settings in the database, private per person (HomeOS bug round 2026-11-13,
-- plan eventual-giggling-charm B1/B2). Until now the workload limits lived per device in localConfigs/eisenhower-harness-limits.json
-- and the web Configurations page waited for a PC to publish them inside a run head.
--
--   preferences (app 'harness')   one row per person: { version, defaults, lists: { <slug>: {enabled, max_sessions,
--                         max_agents_per_session} }, devices: { <device>: { max_mothers } }, imported? }. The person reads and writes
--                         their own row (003 prefs_own); the PC that runs their harness reads and writes it only through the RPCs below.
--   harness_prefs_read(p_device default null) -> jsonb   { prefs, version, updated_at } or null (no row yet).
--                         p_device null: the caller's own row (a person, whitelisted). p_device set: the row of that device's owner,
--                         for the device's writer login only (homeos-agent on that PC).
--   harness_prefs_write(p_prefs, p_expected, p_device default null) -> int   the new version. p_expected null = the row must not
--                         exist yet (the one-time import, a first save); else it must equal the row's version. A stale value raises
--                         PT409 (HTTP 409), never 40001 (PostgREST 14 retries 40001 forever, db/035). Same callers as the read.
--                         p_prefs must be an object with a defaults object and a lists object (devices, if any, an object); 64 KB at
--                         most (009 preferences_prefs_size).
--   harness_configs       one row per device: the Configurations view the PC last published (board, machine, routing, E0), no
--                         longer tied to a run head. Select: household logins only. Written only by harness_config_publish.
--   harness_config_publish(p_device, p_config) -> timestamptz   the device's writer only; 512 KB at most.
--
-- Error codes: 42501 not allowed, 22023 bad value, PT409 stale version.
-- Additive and re-runnable. 003_rls.sql revokes table grants: re-run this file after 003 (like 031). Rollback
-- 041_down_harness_prefs.sql (never deletes a person's preferences row). Selftest 921_selftest_harness_prefs.sql.

-- ---------- the published configuration ----------

create table if not exists public.harness_configs (
  device       text primary key references public.harness_devices(device) on delete cascade,
  config       jsonb not null,
  published_at timestamptz not null default now(),
  constraint harness_configs_size check (octet_length(config::text) <= 524288),
  constraint harness_configs_object check (jsonb_typeof(config) = 'object')
);
alter table public.harness_configs enable row level security;
drop policy if exists harness_configs_household on public.harness_configs;
create policy harness_configs_household on public.harness_configs for select to authenticated using (public.is_household());

-- ---------- whose row ----------

create or replace function public.harness_prefs_target(p_device text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); d public.harness_devices;
begin
  if me is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_device is null then
    if not public.is_human() or not public.is_whitelisted_login(me) then raise exception 'not allowed' using errcode = '42501'; end if;
    return me;
  end if;
  select * into d from public.harness_devices where device = p_device;
  if not found then raise exception 'no such device' using errcode = '22023'; end if;
  if d.writer_id is distinct from me then raise exception 'only the writer of % reads its owner''s harness settings', d.label using errcode = '42501'; end if;
  if d.owner_id is null then raise exception '% has no owner', d.label using errcode = '22023'; end if;
  return d.owner_id;
end $$;

create or replace function public.harness_prefs_read(p_device text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v uuid := public.harness_prefs_target(p_device); r public.preferences;
begin
  select * into r from public.preferences where profile_id = v and app = 'harness';
  if not found then return null; end if;
  return jsonb_build_object('prefs', r.prefs, 'version', r.version, 'updated_at', r.updated_at);
end $$;

create or replace function public.harness_prefs_write(p_prefs jsonb, p_expected int, p_device text default null) returns int
language plpgsql security definer set search_path = '' as $$
declare v uuid := public.harness_prefs_target(p_device); n int;
begin
  if p_prefs is null or jsonb_typeof(p_prefs) <> 'object'
     or jsonb_typeof(p_prefs -> 'defaults') is distinct from 'object'
     or jsonb_typeof(p_prefs -> 'lists') is distinct from 'object'
     or (p_prefs ? 'devices' and jsonb_typeof(p_prefs -> 'devices') is distinct from 'object') then
    raise exception 'harness settings need a defaults object and a lists object' using errcode = '22023';
  end if;
  if octet_length(p_prefs::text) > 65536 then raise exception 'harness settings are larger than 64 KB' using errcode = '22023'; end if;
  if p_expected is null then
    insert into public.preferences (profile_id, app, prefs) values (v, 'harness', p_prefs)
    on conflict (profile_id, app) do nothing returning version into n;
    if n is null then
      select version into n from public.preferences where profile_id = v and app = 'harness';
      raise exception 'the harness settings changed meanwhile (now version %)', n using errcode = 'PT409';
    end if;
  else
    update public.preferences set prefs = p_prefs where profile_id = v and app = 'harness' and version = p_expected returning version into n;
    if n is null then
      select version into n from public.preferences where profile_id = v and app = 'harness';
      raise exception 'the harness settings changed meanwhile (now version %)', coalesce(n::text, 'none') using errcode = 'PT409';
    end if;
  end if;
  return n;
end $$;

create or replace function public.harness_config_publish(p_device text, p_config jsonb) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare t timestamptz := now();
begin
  if not public.harness_is_writer(p_device) then raise exception 'not the writer of this device' using errcode = '42501'; end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object' then raise exception 'the configuration is an object' using errcode = '22023'; end if;
  if octet_length(p_config::text) > 524288 then raise exception 'the configuration is larger than 512 KB' using errcode = '22023'; end if;
  insert into public.harness_configs (device, config, published_at) values (p_device, p_config, t)
  on conflict (device) do update set config = excluded.config, published_at = excluded.published_at;
  return t;
end $$;

-- ---------- grants ----------

revoke all on public.harness_configs from anon, authenticated, public;
grant select on public.harness_configs to authenticated;
revoke all on function public.harness_prefs_target(text) from public, anon, authenticated;
revoke all on function public.harness_prefs_read(text), public.harness_prefs_write(jsonb, int, text), public.harness_config_publish(text, jsonb) from public, anon;
grant execute on function public.harness_prefs_read(text), public.harness_prefs_write(jsonb, int, text), public.harness_config_publish(text, jsonb) to authenticated;
