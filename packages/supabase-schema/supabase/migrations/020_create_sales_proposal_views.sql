-- 020_create_sales_proposal_views.sql
-- Métricas de apertura de propuestas: cada vez que un visitante pasa el
-- gate de contraseña de una propuesta (infra-templates/cloudflare-pages/
-- proposals-worker.template.js), el worker avisa acá (POST /api/ingest/
-- proposal-view, mismo mecanismo que el resto de la ingesta CI-a-backend).
-- Tabla append-only — el conteo/última apertura se agregan al leer.
create table if not exists public.sales_proposal_views (
  id uuid primary key default gen_random_uuid(),
  cliente text not null,
  oportunidad text not null,
  viewed_at timestamptz not null default now()
);

create index if not exists idx_sales_proposal_views_cliente_oportunidad
  on public.sales_proposal_views(cliente, oportunidad);

-- Solo el service-role (backend) toca esta tabla → RLS sin políticas
-- (deny-all para anon/authenticated), consistente con sales_opportunities (019).
alter table public.sales_proposal_views enable row level security;
