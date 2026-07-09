-- 025_sales_notifications.sql
-- Notificaciones del pipeline de ventas para el VENDEDOR: cuando el TL (u otro
-- rol) mueve status.md en el monorepo (propuesta lista, negociación, ganada,
-- congelada por tiempo, diseño/desarrollo, etc.), el discovery detecta la
-- transición y crea una notificación con CTA (ruta directa a la acción que
-- sigue: chat, propuesta o resumen). Solo escribe el backend (service role),
-- igual que el resto de tablas de ventas.
create table if not exists public.sales_notifications (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.sales_opportunities(id) on delete cascade,
  vendedor_login text not null,
  type text not null,
  title text not null,
  body text,
  cta_label text,
  cta_path text,
  seen boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_sales_notifications_vendedor
  on public.sales_notifications (vendedor_login, seen, created_at desc);
