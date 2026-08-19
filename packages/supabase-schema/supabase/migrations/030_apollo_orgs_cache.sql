-- 030_apollo_orgs_cache.sql
-- CACHÉ de empresas de Apollo (`organizations/search`).
--
-- Regla de consumo: a la API de Apollo se le pega SOLO en la corrida semanal
-- (cron). Las búsquedas manuales del vendedor desde la UI leen esta tabla, y
-- si no hay nada, caen al registro público (datos.gov.co), que es gratis e
-- ilimitado. Así una tarde de pruebas no quema la cuota del plan.
--
-- La tabla es un catálogo, no un caché por query: guarda EMPRESAS con su
-- sector y segmento, y la UI filtra sobre eso. Es más útil que cachear por
-- texto de búsqueda — dos consultas distintas reusan las mismas filas.

create table if not exists public.sales_apollo_orgs (
  -- Id de Apollo: llave natural, idempotente entre corridas semanales.
  apollo_id text primary key,
  name text not null,
  domain text,
  website text,
  industry text,
  employees integer,
  -- Startup (≤50) | SMB (≤500) | Enterprise — derivado del headcount real.
  segment text,
  linkedin_url text,
  phone text,
  city text,
  country text,
  founded_year integer,
  description text,
  -- Sector del KEYWORD_SET que la trajo ('logistica', 'seguros'…). La UI
  -- filtra por acá, que es como el vendedor piensa el mercado.
  sector text not null,
  -- Cuándo la vimos por última vez en Apollo. Sirve para saber qué tan
  -- fresco está el catálogo y para purgar lo viejo si hiciera falta.
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.sales_apollo_orgs is
  'Catálogo de empresas de Apollo. Lo llena SOLO el cron semanal; la UI lo lee. Ver rules de consumo de cuota.';

-- La UI busca por sector + segmento, ordenado por tamaño (los leads grandes
-- primero) — este índice cubre ese acceso.
create index if not exists idx_sales_apollo_orgs_sector
  on public.sales_apollo_orgs (sector, segment, employees desc nulls last);

-- Búsqueda por texto en el nombre, para cuando el vendedor busca una empresa
-- puntual dentro del catálogo ya descargado.
create index if not exists idx_sales_apollo_orgs_name
  on public.sales_apollo_orgs (lower(name) text_pattern_ops);

create index if not exists idx_sales_apollo_orgs_fetched
  on public.sales_apollo_orgs (fetched_at desc);

-- Cuántas empresas trajo cada corrida, para ver si el catálogo crece o se
-- estancó (y detectar si Apollo dejó de responder sin que nadie se entere).
create table if not exists public.sales_apollo_sync_log (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  sectors integer not null default 0,
  calls integer not null default 0,
  fetched integer not null default 0,
  inserted integer not null default 0,
  error text
);
