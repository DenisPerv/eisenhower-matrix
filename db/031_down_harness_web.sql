-- db/031_down_harness_web.sql: removes everything 031_harness_web.sql made (the web copy of the Eisenhower Harness page).
-- Run by hand only, as admin SQL; it sorts before 031, where it is a no-op on a database that never had it. Deletes the published
-- run snapshots and the command log with the tables. Nothing else depends on them.

drop function if exists public.harness_request(text, text, text, text, text, jsonb, uuid, text, text, text);
drop function if exists public.harness_sweep(text);
drop function if exists public.harness_recover(text);
drop function if exists public.harness_done(uuid, text, text);
drop function if exists public.harness_take(text);
drop function if exists public.harness_view(text);
drop function if exists public.harness_beat(text, text, boolean);
drop function if exists public.harness_push(text, text, bigint, boolean, jsonb, jsonb, text[]);
drop table if exists public.harness_commands;
drop table if exists public.harness_parts;
drop table if exists public.harness_heads;
drop table if exists public.harness_devices;
drop function if exists public.harness_right(uuid, text, text, text, text, uuid);
drop function if exists public.harness_signin_age();
drop function if exists public.harness_is_writer(text);
drop function if exists public.harness_in_window(text);
drop function if exists public.harness_run_at(text);
