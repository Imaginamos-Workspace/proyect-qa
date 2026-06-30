-- 017_create_scrum_sprints.sql
-- Ciclo de vida de los sprints (iniciar/cerrar) + velocidad por sprint.
--
-- En GitHub Projects los sprints son ITERACIONES por fecha (no hay "iniciar/cerrar"
-- nativo como Jira). En vez de pelear con ese modelo, llevamos el ESTADO del sprint
-- acá: así "iniciar" y "cerrar" son acciones reales del portal SIN necesitar el
-- token de escritura de GitHub (solo el carry-over de issues lo necesita). El
-- assignment issue↔sprint sigue viviendo en el campo Sprint del board.
create table if not exists public.scrum_sprints (
  slug text not null references public.qa_clients(slug) on delete cascade,
  title text not null,                       -- título de la iteración (campo Sprint)
  status text not null default 'active',     -- 'active' | 'closed'
  started_at timestamptz,
  closed_at timestamptz,
  completed_points numeric,                  -- velocidad: puntos completados al cerrar
  total_points numeric,
  carried_over int not null default 0,       -- issues movidos al siguiente sprint
  updated_at timestamptz not null default now(),
  primary key (slug, title)
);

-- Solo el service-role (backend) toca esta tabla → RLS sin políticas (deny-all
-- para anon/authenticated), consistente con el resto del esquema.
alter table public.scrum_sprints enable row level security;
