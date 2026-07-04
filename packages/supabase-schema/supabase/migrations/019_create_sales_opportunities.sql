-- 019_create_sales_opportunities.sql
-- Módulo Ventas: el vendedor llena el brief de una oportunidad chateando con
-- un LLM gratuito desde la plataforma, sin necesitar OpenCode/CLI local.
--
-- El draft vive acá (JSONB, shape flexible — mismo criterio que `board jsonb`
-- en scrum_board_cache: evita una migración cada vez que cambia un campo del
-- brief). El monorepo (sales/<cliente>/<oportunidad>/brief.md) sigue siendo
-- la fuente de verdad para el TL — esta tabla es solo el borrador en progreso,
-- sincronizado a mano por el vendedor ("Sincronizar brief.md"/"Pasar a TL").
create table if not exists public.sales_opportunities (
  id uuid primary key default gen_random_uuid(),
  cliente text not null,
  oportunidad text not null,
  vendedor_login text not null,          -- login de GitHub (team.json)
  status text not null default 'brief',  -- 'brief' | 'propuesta-en-armado'
  draft jsonb not null default '{}',
  synced_at timestamptz,                 -- último "Sincronizar brief.md" exitoso
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cliente, oportunidad)
);

create table if not exists public.sales_messages (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.sales_opportunities(id) on delete cascade,
  role text not null check (role in ('vendor', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_sales_messages_opportunity_id on public.sales_messages(opportunity_id);

-- Solo el service-role (backend) toca estas tablas → RLS sin políticas
-- (deny-all para anon/authenticated), consistente con scrum_board_cache/
-- scrum_sprints (016/017).
alter table public.sales_opportunities enable row level security;
alter table public.sales_messages enable row level security;
