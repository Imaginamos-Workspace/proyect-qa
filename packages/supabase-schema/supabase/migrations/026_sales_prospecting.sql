-- 026_sales_prospecting.sql
-- Etapa de PROSPECCIÓN (CRM previo a la oportunidad): los resultados de Apollo
-- se GUARDAN (idempotente por apollo_id — la búsqueda semanal no duplica), el
-- vendedor los contacta (llamadas/correos/WhatsApp), registra el resultado de
-- cada intento (sin respuesta / contactado / reunión / referido / rechazado),
-- agenda reintentos y nutre datos (teléfono, referidos). Convertir → crea la
-- oportunidad y enlaza. Solo escribe el backend (service role).

create table if not exists public.sales_prospects (
  id uuid primary key default gen_random_uuid(),
  -- Idempotencia entre corridas (manual o semanal): mismo prospecto de Apollo
  -- = misma fila. Los referidos usan 'ref-<uuid>' (no vienen de Apollo).
  apollo_id text not null unique,
  vendedor_login text not null,
  estado text not null default 'por-contactar',
  -- por-contactar | en-seguimiento | contactado | reunion-agendada |
  -- referido | descartado | convertido
  origen text not null default 'manual', -- manual | semanal | referido
  name text not null,
  title text,
  company text,
  company_website text,
  industry text,
  location text,
  linkedin_url text,
  email text,
  phone text,
  notes text,
  next_attempt_at timestamptz, -- "volver a intentar" agendado
  opportunity_id uuid references public.sales_opportunities(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sales_prospects_vendedor
  on public.sales_prospects (vendedor_login, estado, updated_at desc);

-- Bitácora de contactos: cada intento con su canal, resultado y notas.
create table if not exists public.sales_prospect_interactions (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references public.sales_prospects(id) on delete cascade,
  vendedor_login text not null,
  tipo text not null,      -- llamada | correo | whatsapp | linkedin | otro
  resultado text not null, -- sin-respuesta | contacto-logrado | reunion-agendada | referido | rechazado
  notas text,
  referido_nombre text,
  referido_contacto text,
  reintentar_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_sales_prospect_interactions_prospect
  on public.sales_prospect_interactions (prospect_id, created_at desc);

-- Búsquedas guardadas: la corrida semanal (cron) las ejecuta y guarda los
-- prospectos nuevos como 'por-contactar' (origen semanal, sin duplicar).
create table if not exists public.sales_prospect_searches (
  id uuid primary key default gen_random_uuid(),
  vendedor_login text not null,
  keywords text,
  titles text[] not null default '{}',
  locations text[] not null default '{}',
  active boolean not null default true,
  last_run_at timestamptz,
  created_at timestamptz not null default now()
);
