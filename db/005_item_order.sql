-- db/005_item_order.sql: shared card order (design.md D14). A card's place in its quadrant is sort_key, ascending.
-- The app puts a moved card at the midpoint of its neighbours, a new card 1024 above the first, and renumbers a quadrant
-- (spacing 1024) when a gap gets under 1e-6. Idempotent. Re-run 003_rls.sql and 900_selftest.sql after it.

alter table public.items add column if not exists sort_key double precision;
create index if not exists items_order_idx on public.items (list_id, quadrant, sort_key) where deleted_at is null;
