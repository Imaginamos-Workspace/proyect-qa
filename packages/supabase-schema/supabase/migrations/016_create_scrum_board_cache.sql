-- 016_create_scrum_board_cache.sql
-- Caché COMPARTIDO del board normalizado por cliente.
--
-- Problema: el caché en memoria del backend (Map) NO sobrevive a los cold-starts
-- de Vercel (cada función serverless arranca en frío con tráfico bajo), así que
-- cada entrada al Tablero reconstruía el board desde GitHub: listar proyectos +
-- columnas/sprints/miembros + paginación de items (secuencial, 100/página). Para
-- clientes con muchos items (p. ej. equirent-fleet) eso son varios segundos.
--
-- Solución: persistimos el snapshot ya armado. Entrar al módulo pasa a ser UNA
-- lectura indexada (~50-100ms) en vez del waterfall completo a GitHub. El backend
-- usa la service-role key (bypassa RLS), por eso no hacen falta políticas.
create table if not exists public.scrum_board_cache (
  slug text primary key references public.qa_clients(slug) on delete cascade,
  board jsonb not null,
  updated_at timestamptz not null default now()
);

-- Solo el service-role (backend) toca esta tabla; RLS sin políticas = deny-all
-- para anon/authenticated, consistente con el resto del esquema (009_enable_rls).
alter table public.scrum_board_cache enable row level security;
