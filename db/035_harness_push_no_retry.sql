-- db/035_harness_push_no_retry.sql: harness_push answers a stale seq with PT409 (HTTP 409) instead of 40001 (2026-11-12,
-- HomeOS plan nested-plotting-reddy). PostgREST 14 retries a transaction that fails with 40001 (serialization_failure), so
-- concurrent pushes from one device on a stale seq looped forever inside PostgREST and held every connection of its pool:
-- TasksDB answered no REST call from 00:24 to 00:40 UTC. The body is the live 031 function with only that code changed.
-- harness-web.js treats PT409 and 40001 alike (take the server seq, push every part again). Re-run 003 and its followers
-- after it like after any schema change; the grants of harness_push are kept by create or replace.

CREATE OR REPLACE FUNCTION public.harness_push(p_device text, p_run_ts text, p_base_seq bigint, p_live boolean, p_head jsonb, p_put jsonb, p_del text[] DEFAULT '{}'::text[])
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if v_seq <> p_base_seq then raise exception 'stale seq: % here, % sent', v_seq, p_base_seq using errcode = 'PT409'; end if;
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
end $function$;
