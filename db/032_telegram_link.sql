-- db/032_telegram_link.sql: the Telegram link for the household Telegram server "Telegram v2" (HomeOS
-- references/homeos/telegram-v2/solution.md D18, D21, D29, D31; build-plan.md T9).
--
-- What it adds (nothing existing is replaced or dropped; every function is security definer with search_path = ''):
--   - ops.telegram_links: one Telegram account per user. The numeric Telegram id (from.id) is the key; the username is
--     shown, never trusted, because usernames can be changed and re-taken (D21).
--   - ops.telegram_claims: the optional "Telegram (username or id)" a person types at registration. Only a claim: it is
--     shown to the owner on the access-request card and proves nothing.
--   - ops.telegram_link_tokens: single-use link tokens, 15 minutes, stored as a sha256 hash.
--   - RPCs for people: telegram_link_token() (a token for the deep link t.me/<bot>?start=<token>),
--     my_telegram_link(), set_telegram_claim(text), telegram_unlink().
--   - RPCs for the telegram login only (profile handle 'telegram-bot'): telegram_redeem_link(text, bigint, text) and
--     telegram_member(bigint), the narrow membership read (group household | guest, display name, default list).
--   - On link (and on approval of a linked guest) the user's default list "My tasks" is shared with the telegram login
--     as editor (D18); a removed request takes the bot out again.
--   - The household list "HomeOS - Global" (owner maksym) with the telegram login and homeos-agent as editors (D29).
--   - The private Storage bucket workorder-material: the telegram login may only upload, homeos-agent may read and
--     delete (D31).
--   - A trigger that adds the claimed Telegram as a line to a new access-request task.
-- Error codes: 42501 not allowed, 22023 bad value or bad token, 54000 limit reached.
-- Order after this file: 003_rls.sql, 011_multiuser_rls.sql, the 012 policy block, 026, 030, 031, then 900-915
-- (915_selftest_telegram_link.sql covers this file). Re-runnable. Rollback: db/032_down_telegram_link.sql.

-- ---------- schema (ops: never exposed through the API) ----------

create table if not exists ops.telegram_links (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  tg_id       bigint not null unique check (tg_id > 0),
  tg_username text check (tg_username ~ '^[A-Za-z0-9_]{4,32}$'),
  linked_at   timestamptz not null default now()
);
create table if not exists ops.telegram_claims (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  claim      text not null check (claim ~ '^(@[A-Za-z0-9_]{4,32}|[0-9]{5,15})$'),
  claimed_at timestamptz not null default now()
);
create table if not exists ops.telegram_link_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
create index if not exists telegram_link_tokens_user_idx on ops.telegram_link_tokens (user_id, created_at);
revoke all on ops.telegram_links, ops.telegram_claims, ops.telegram_link_tokens from public, anon, authenticated;

insert into ops.settings (key, value, note) values
  ('telegram_link_minutes',         15, 'minutes a Telegram link token is valid (D21)'),
  ('telegram_link_tokens_per_hour', 10, 'Telegram link tokens one person may ask for per hour')
on conflict (key) do nothing;

-- ---------- helpers ----------

-- the telegram login: the agent profile with handle telegram-bot
create or replace function public.telegram_login_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.profiles where handle = 'telegram-bot' and kind = 'agent'
$$;

-- is the caller the telegram login / homeos-agent? (used by the storage policies, so callable by authenticated;
-- they answer only about the caller)
create or replace function public.is_telegram_login() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and auth.uid() is not distinct from public.telegram_login_id()
$$;
create or replace function public.is_homeos_agent() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and handle = 'homeos-agent' and kind = 'agent')
$$;

-- a user's default list: their own live "My tasks" (internal)
create or replace function public.telegram_default_list(p_user uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select l.id from public.lists l
   where l.owner_id = p_user and l.slug = 'my-tasks' and l.archived_at is null
   order by l.created_at limit 1
$$;

-- a user's group for the bot: household (a household person), guest (a whitelisted person outside the household:
-- an approved access request or a used allowlist row, db/022), else null = no bot access (internal)
create or replace function public.telegram_group(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when p.is_household then 'household' when public.is_whitelisted(p.id) then 'guest' end
    from public.profiles p where p.id = p_user and p.kind = 'human'
$$;

-- share the user's default list with the telegram login as editor, when the user may use the bot (internal).
-- The link is the person's own act, so an earlier opt-out of that list (db/019) is cleared first.
create or replace function public.telegram_share_default(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_bot uuid := public.telegram_login_id(); v_list uuid := public.telegram_default_list(p_user);
begin
  if v_bot is null or v_list is null or public.telegram_group(p_user) is null then return; end if;
  delete from ops.bot_opt_out o where o.bot_id = v_bot and o.list_id = v_list;
  insert into public.list_members (list_id, profile_id, role, added_by)
  values (v_list, v_bot, 'editor', p_user)
  on conflict (list_id, profile_id) do update set role = 'editor' where public.list_members.role in ('viewer', 'contributor');
end $$;

-- take the telegram login out of the user's default list (internal)
create or replace function public.telegram_unshare_default(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_bot uuid := public.telegram_login_id(); v_list uuid := public.telegram_default_list(p_user);
begin
  if v_bot is null or v_list is null then return; end if;
  delete from public.list_members m where m.list_id = v_list and m.profile_id = v_bot and m.role <> 'owner';
end $$;

-- what the bot gets about a linked user, or null when the user may not use the bot (internal)
create or replace function public.telegram_member_json(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('user_id', p.id, 'handle', p.handle, 'display_name', p.display_name,
                            'group', public.telegram_group(p.id), 'default_list_id', public.telegram_default_list(p.id),
                            'tg_id', k.tg_id, 'tg_username', k.tg_username, 'linked_at', k.linked_at)
    from public.profiles p join ops.telegram_links k on k.user_id = p.id
   where p.id = p_user and public.telegram_group(p.id) is not null
$$;

-- ---------- RPCs for people ----------

-- a new single-use link token for the caller (a person, any group: a guest may link before approval; the bot still
-- answers nobody until telegram_member() returns a group). Earlier unused tokens of the caller stop working.
create or replace function public.telegram_link_token() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_token text; v_exp timestamptz;
begin
  if v_uid is null or not public.is_human() then raise exception 'people only' using errcode = '42501'; end if;
  if (select count(*) from ops.telegram_link_tokens where user_id = v_uid and created_at > now() - interval '1 hour')
       >= public.setting('telegram_link_tokens_per_hour') then
    raise exception 'too many link codes, try again in an hour' using errcode = '54000';
  end if;
  delete from ops.telegram_link_tokens where expires_at < now() - interval '1 day';
  update ops.telegram_link_tokens set used_at = now() where user_id = v_uid and used_at is null;
  -- 40 hex characters (160 random bits); Telegram's start parameter allows up to 64 of [A-Za-z0-9_-]
  v_token := substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 40);
  v_exp   := now() + make_interval(mins => public.setting('telegram_link_minutes')::int);
  insert into ops.telegram_link_tokens (token_hash, user_id, expires_at)
  values (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_uid, v_exp);
  return jsonb_build_object('token', v_token, 'expires_at', v_exp);
end $$;

-- the caller's link state, for the app
create or replace function public.my_telegram_link() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'linked', k.user_id is not null, 'tg_username', k.tg_username, 'linked_at', k.linked_at,
    'claim', (select c.claim from ops.telegram_claims c where c.user_id = auth.uid()))
    from (select auth.uid() as uid) me left join ops.telegram_links k on k.user_id = me.uid
   where me.uid is not null
$$;

-- the caller's claimed Telegram (username with or without @, or a numeric id); null or '' clears it.
-- Stored as '@name' or the digits. Returns the stored claim or null.
create or replace function public.set_telegram_claim(p_claim text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v text := trim(coalesce(p_claim, ''));
begin
  if v_uid is null or not public.is_human() then raise exception 'people only' using errcode = '42501'; end if;
  if v = '' then
    delete from ops.telegram_claims where user_id = v_uid;
    return jsonb_build_object('claim', null);
  end if;
  v := regexp_replace(v, '^(https?://)?(t\.me/|telegram\.me/)', '', 'i');
  if v ~ '^[0-9]{5,15}$' then null;
  elsif v ~ '^@?[A-Za-z][A-Za-z0-9_]{4,31}$' then v := '@' || ltrim(v, '@');
  else raise exception 'a Telegram username (5-32 letters, digits, _) or a numeric id' using errcode = '22023';
  end if;
  insert into ops.telegram_claims (user_id, claim) values (v_uid, v)
  on conflict (user_id) do update set claim = excluded.claim, claimed_at = now();
  return jsonb_build_object('claim', v);
end $$;

-- the caller removes their link; the bot leaves their default list (db/019 records the opt-out; a new link clears it)
create or replace function public.telegram_unlink() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_human() then raise exception 'people only' using errcode = '42501'; end if;
  delete from ops.telegram_links where user_id = v_uid;
  update ops.telegram_link_tokens set used_at = now() where user_id = v_uid and used_at is null;
  perform public.telegram_unshare_default(v_uid);
  return jsonb_build_object('linked', false);
end $$;

-- ---------- RPCs for the telegram login ----------

-- The bot redeems a token from /start <token> with the sender's numeric id (from.id) and username (display only).
-- Single use, 15 minutes. One Telegram account per user and one user per Telegram account: a fresh proof moves the
-- link. Every bad token gets the same answer (no oracle). Returns telegram_member_json, or the link without a group
-- (group null) when the user may not use the bot yet (a guest whose request is not approved).
create or replace function public.telegram_redeem_link(p_token text, p_tg_id bigint, p_username text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_row ops.telegram_link_tokens%rowtype; v_user text; v_name text := nullif(ltrim(trim(coalesce(p_username, '')), '@'), '');
begin
  if not public.is_telegram_login() then raise exception 'the telegram login only' using errcode = '42501'; end if;
  if p_tg_id is null or p_tg_id <= 0 then raise exception 'bad telegram id' using errcode = '22023'; end if;
  if p_token is null or p_token !~ '^[0-9a-f]{40}$' then raise exception 'link code invalid or expired' using errcode = '22023'; end if;
  select * into v_row from ops.telegram_link_tokens
   where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') for update;
  if not found or v_row.used_at is not null or v_row.expires_at <= now() then
    raise exception 'link code invalid or expired' using errcode = '22023';
  end if;
  update ops.telegram_link_tokens set used_at = now() where token_hash = v_row.token_hash;
  if v_name is not null and v_name !~ '^[A-Za-z0-9_]{4,32}$' then v_name := null; end if;
  delete from ops.telegram_links where tg_id = p_tg_id or user_id = v_row.user_id;
  insert into ops.telegram_links (user_id, tg_id, tg_username) values (v_row.user_id, p_tg_id, v_name);
  perform public.telegram_share_default(v_row.user_id);
  return coalesce(public.telegram_member_json(v_row.user_id),
                  jsonb_build_object('user_id', v_row.user_id, 'group', null, 'tg_id', p_tg_id, 'tg_username', v_name));
end $$;

-- The membership read (D21): who is behind a Telegram id. Null when the id is not linked or its user may not use the
-- bot. Never returns an email.
create or replace function public.telegram_member(p_tg_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_telegram_login() then raise exception 'the telegram login only' using errcode = '42501'; end if;
  return (select public.telegram_member_json(k.user_id) from ops.telegram_links k where k.tg_id = p_tg_id);
end $$;

-- ---------- access requests: claim on the card, share on approval ----------

-- a new access-request task (db/015, db/028) gets the requester's claimed Telegram as a line and in details
create or replace function public.items_telegram_claim() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_claim text; v_linked text;
begin
  if new.created_via is distinct from 'rpc:request_access' or new.details->>'access_request_id' is null then return new; end if;
  select c.claim, k.tg_username into v_claim, v_linked
    from public.users_pending_for_decision r
    left join ops.telegram_claims c on c.user_id = r.user_id
    left join ops.telegram_links k on k.user_id = r.user_id
   where r.id = (new.details->>'access_request_id')::uuid;
  if v_claim is not null then
    new.body_md := new.body_md || E'\n' || '- Telegram (claimed, not yet proved): ' || v_claim;
    new.details := new.details || jsonb_build_object('telegram_claim', v_claim);
  end if;
  return new;
end $$;
drop trigger if exists items_telegram_claim on public.items;
create trigger items_telegram_claim before insert on public.items
  for each row when (new.created_via = 'rpc:request_access') execute function public.items_telegram_claim();

-- approved -> the bot joins the default list of a linked user; removed -> it leaves
create or replace function public.access_request_telegram() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = old.status or not exists (select 1 from ops.telegram_links where user_id = new.user_id) then return null; end if;
  if new.status = 'approved' then perform public.telegram_share_default(new.user_id);
  elsif new.status = 'removed' and public.telegram_group(new.user_id) is null then perform public.telegram_unshare_default(new.user_id);
  end if;
  return null;
end $$;
drop trigger if exists access_request_telegram on public.users_pending_for_decision;
create trigger access_request_telegram after update of status on public.users_pending_for_decision
  for each row execute function public.access_request_telegram();

-- ---------- D29: the household list HomeOS - Global ----------

-- found by slug homeos-global or by name among maksym's lists, else created
do $$
declare v_owner uuid; v_list uuid; v_bot uuid := public.telegram_login_id();
begin
  select id into v_owner from public.profiles where handle = 'maksym' and kind = 'human';
  if v_owner is null then return; end if;   -- a database without the household seed (fresh set-up, CI)
  select id into v_list from public.lists
   where owner_id = v_owner and (slug = 'homeos-global' or lower(name) = 'homeos - global')
   order by (slug = 'homeos-global') desc, created_at limit 1;
  if v_list is null then
    insert into public.lists (slug, name, description, default_category, sort, owner_id, created_by)
    values ('homeos-global', 'HomeOS - Global',
            'work orders for HomeOS: learn and reference orders from Telegram (family and friends), friends'' tasks on request',
            'task', coalesce((select max(sort) + 1 from public.lists where owner_id = v_owner), 1), v_owner, v_owner)
    returning id into v_list;
    insert into public.list_members (list_id, profile_id, role, added_by) values (v_list, v_owner, 'owner', v_owner)
    on conflict (list_id, profile_id) do nothing;
  end if;
  if v_bot is not null then
    delete from ops.bot_opt_out o where o.bot_id = v_bot and o.list_id = v_list;
  end if;
  insert into public.list_members (list_id, profile_id, role, added_by)
  select v_list, p.id, 'editor', v_owner from public.profiles p
   where p.handle in ('anastasiia', 'homeos-agent', 'telegram-bot')
  on conflict (list_id, profile_id) do update set role = 'editor' where public.list_members.role in ('viewer', 'contributor');
end $$;

-- ---------- D31: Storage bucket for work-order material ----------

-- private; 20 MB per file; images, PDF, text, voice and short video. The telegram login uploads only (no read, no
-- overwrite: an upsert would need select and update); homeos-agent reads and deletes (a file goes when its work order
-- is closed). Skipped where Supabase Storage is not installed.
do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then return; end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('workorder-material', 'workorder-material', false, 20971520,
          array['image/jpeg','image/png','image/webp','image/gif','image/heic','application/pdf','text/plain',
                'text/markdown','text/html','audio/ogg','audio/mpeg','video/mp4'])
  on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                                 allowed_mime_types = excluded.allowed_mime_types;
  drop policy if exists workorder_material_insert on storage.objects;
  drop policy if exists workorder_material_select on storage.objects;
  drop policy if exists workorder_material_delete on storage.objects;
  create policy workorder_material_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'workorder-material' and public.is_telegram_login() and char_length(name) <= 300);
  create policy workorder_material_select on storage.objects for select to authenticated
    using (bucket_id = 'workorder-material' and public.is_homeos_agent());
  create policy workorder_material_delete on storage.objects for delete to authenticated
    using (bucket_id = 'workorder-material' and public.is_homeos_agent());
end $$;

-- ---------- grants ----------

revoke all on function public.telegram_login_id(), public.telegram_default_list(uuid), public.telegram_group(uuid),
  public.telegram_share_default(uuid), public.telegram_unshare_default(uuid), public.telegram_member_json(uuid),
  public.items_telegram_claim(), public.access_request_telegram()
  from public, anon, authenticated;
revoke all on function public.is_telegram_login(), public.is_homeos_agent(), public.telegram_link_token(),
  public.my_telegram_link(), public.set_telegram_claim(text), public.telegram_unlink(),
  public.telegram_redeem_link(text, bigint, text), public.telegram_member(bigint)
  from public, anon;
grant execute on function public.is_telegram_login(), public.is_homeos_agent(), public.telegram_link_token(),
  public.my_telegram_link(), public.set_telegram_claim(text), public.telegram_unlink(),
  public.telegram_redeem_link(text, bigint, text), public.telegram_member(bigint)
  to authenticated;
