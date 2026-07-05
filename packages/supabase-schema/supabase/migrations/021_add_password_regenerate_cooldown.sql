-- 021_add_password_regenerate_cooldown.sql
-- Evita dos dispatches de "regenerar contraseña" en carrera (ej. el
-- vendedor recarga la página y vuelve a apretar el botón mientras el
-- workflow de CI del primer intento todavía está corriendo) — sin esto,
-- el vendedor podría terminar compartiendo con el cliente una contraseña
-- que está a punto de invalidarse por el segundo dispatch.
alter table public.sales_opportunities
  add column if not exists password_regenerate_requested_at timestamptz;
