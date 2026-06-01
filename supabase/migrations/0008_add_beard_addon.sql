-- Add "Beard" add-on ($10). Idempotent so it can be re-run safely.
insert into addons (slug, display_name, price_cents, is_active, sort_order) values
  ('beard', 'Beard', 1000, true, 50)
on conflict (slug) do update set
  display_name = excluded.display_name,
  price_cents  = excluded.price_cents,
  is_active    = excluded.is_active,
  sort_order   = excluded.sort_order;
