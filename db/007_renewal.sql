-- db/007_renewal.sql: category `renewal` (HomeOS step 2 W2.2) for document renewals that /store-document turns into
-- items: dates and the records-index row name only, never a document number (the sensitive-data screen refuses those).
-- Default list Reminders. Re-runnable: a second run changes nothing; a later run puts name, description, hint and
-- default list back to these values. Re-run 003_rls.sql and 900_selftest.sql after it.

insert into public.categories (slug, name, description, details_hint, default_list_id)
select 'renewal', 'Renewal', 'a document or contract to renew (records-index.md)', 'renew_by, record row name; dates only', l.id
from public.lists l where l.slug = 'reminders'
on conflict (slug) do update
  set name = excluded.name, description = excluded.description, details_hint = excluded.details_hint,
      default_list_id = excluded.default_list_id
  where (public.categories.name, public.categories.description, public.categories.details_hint, public.categories.default_list_id)
        is distinct from (excluded.name, excluded.description, excluded.details_hint, excluded.default_list_id);

do $$
begin
  if not exists (select 1 from public.categories c join public.lists l on l.id = c.default_list_id
                 where c.slug = 'renewal' and l.slug = 'reminders' and c.archived_at is null) then
    raise exception '007_renewal: category renewal is missing or not on Reminders (is the Reminders list seeded?)';
  end if;
end $$;
