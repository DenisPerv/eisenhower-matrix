-- db/041_down_harness_prefs.sql: rollback of 041_harness_prefs.sql. Drops the RPCs and harness_configs (published copies the PCs
-- write again). Never deletes a person's preferences row (app 'harness'): the settings stay, and limits.js keeps its file cache.

drop function if exists public.harness_config_publish(text, jsonb);
drop function if exists public.harness_prefs_write(jsonb, int, text);
drop function if exists public.harness_prefs_read(text);
drop function if exists public.harness_prefs_target(text);
drop table if exists public.harness_configs;
