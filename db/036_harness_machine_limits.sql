-- db/036_harness_machine_limits.sql: the web may set "mothers at once" (the Workload machine scope, max_mothers in this PC's
-- limits file, read by spawn.js) like the local page (2026-11-12, HomeOS plan #3). A limits command with no list may now carry
-- { "machine": { "max_mothers": 1..10 } } (the local page's range) and nothing else; only the owner of the device who is in the
-- household may send it, with the same 15-minute sign-in rule as other limits. harness_right already gives a command with no
-- list to the device's owner only, at request and again at take, so it is unchanged. The body is the live function (031) with
-- only the machine branch added. No 40001 anywhere (PostgREST 14 retries it forever, db/035). Re-run 003 and its followers after
-- it; create or replace keeps the grants of harness_request.

CREATE OR REPLACE FUNCTION public.harness_request(p_device text, p_run_ts text, p_action text, p_name text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_payload jsonb DEFAULT NULL::jsonb, p_scope_list uuid DEFAULT NULL::uuid, p_expect_state text DEFAULT NULL::text, p_base_hash text DEFAULT NULL::text, p_idem_key text DEFAULT NULL::text)
 RETURNS public.harness_commands
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    elsif p_payload ? 'machine' then   -- db/036: mothers at once on this PC (limits.js max_mothers)
      if (select count(*) from jsonb_object_keys(p_payload)) <> 1 or jsonb_typeof(p_payload -> 'machine') is distinct from 'object'
         or (select count(*) from jsonb_object_keys(p_payload -> 'machine')) <> 1
         or jsonb_typeof(p_payload #> '{machine,max_mothers}') is distinct from 'number'
         or (p_payload #>> '{machine,max_mothers}') !~ '^([1-9]|10)$' then
        raise exception 'mothers at once is a whole number from 1 to 10' using errcode = '22023';
      end if;
      if not public.is_household() or me is distinct from d.owner_id then
        raise exception 'only the owner of % may change mothers at once', d.label using errcode = '42501';
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
end $function$;
