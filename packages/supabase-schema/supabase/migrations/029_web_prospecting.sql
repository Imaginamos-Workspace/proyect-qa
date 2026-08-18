-- 029_web_prospecting.sql
-- Prospección WEB propia (Google CSE + scraping liviano) como alternativa a
-- Apollo. Estrategia HÍBRIDA: la web descubre EMPRESAS (barato, ilimitado en
-- la práctica) y Apollo enriquece SOLO las que el vendedor marca (caro, 1
-- crédito). Así se deja de quemar cuota en prospectos que nunca se contactan.
--
-- Decisión de diseño: NO se crea una tabla `companies` paralela. Se extiende
-- `sales_prospects` (026) para que el kanban, la bitácora de intentos, los
-- referidos y la conversión a oportunidad sigan funcionando igual. La 026 ya
-- había previsto fuentes que no son Apollo — los referidos usan 'ref-<uuid>'
-- en apollo_id; acá se sigue el mismo patrón con 'web:<dominio>'.

-- ── sales_prospects: origen web ────────────────────────────────────────────

alter table public.sales_prospects
  -- De dónde salió la fila. 'apollo' para lo existente (backfill abajo).
  add column if not exists source text not null default 'apollo',
  -- Dominio normalizado a eTLD+1 (sin www, sin esquema, minúsculas). Es la
  -- llave de idempotencia de la fuente web: un dominio = una empresa.
  add column if not exists domain text,
  -- URL concreta de la que se extrajo el dato. Trazabilidad para Habeas Data
  -- (Ley 1581/2012): hay que poder responder de dónde salió cada dato.
  add column if not exists source_url text,
  -- NULL = nunca scrapeado (la cola de trabajo del cron lee esto).
  add column if not exists last_scraped_at timestamptz;

comment on column public.sales_prospects.source is
  'apollo | web | referido — de dónde salió el prospecto.';
comment on column public.sales_prospects.domain is
  'Dominio normalizado eTLD+1. Llave de idempotencia de la fuente web.';
comment on column public.sales_prospects.source_url is
  'URL exacta de la que se extrajo el dato (trazabilidad Habeas Data).';
comment on column public.sales_prospects.last_scraped_at is
  'NULL = pendiente de scrapear. El cron toma lotes acotados de acá.';

-- Backfill explícito: lo que ya existía vino de Apollo, salvo los referidos.
update public.sales_prospects
   set source = case when apollo_id like 'ref-%' then 'referido' else 'apollo' end
 where source = 'apollo';

alter table public.sales_prospects
  drop constraint if exists sales_prospects_source_check;
alter table public.sales_prospects
  add constraint sales_prospects_source_check
  check (source in ('apollo', 'web', 'referido'));

-- Un dominio = una empresa, pero POR VENDEDOR: dos vendedores pueden trabajar
-- la misma empresa sin pisarse (igual que hoy con apollo_id + vendedor_login).
-- Parcial: solo aplica a la fuente web; Apollo y referidos no tienen dominio.
create unique index if not exists uq_sales_prospects_domain_vendedor
  on public.sales_prospects (vendedor_login, domain)
  where domain is not null;

-- Cola del cron: los pendientes de scrapear, más viejos primero.
create index if not exists idx_sales_prospects_scrape_queue
  on public.sales_prospects (last_scraped_at nulls first)
  where source = 'web';

create index if not exists idx_sales_prospects_source_estado
  on public.sales_prospects (source, estado);

-- ── sales_prospect_searches: filtros de la fuente web ──────────────────────

alter table public.sales_prospect_searches
  -- Qué motor corre esta búsqueda guardada.
  add column if not exists source text not null default 'apollo',
  -- Ciudad para la query de Google ("Bogotá", "Medellín").
  add column if not exists city text;

alter table public.sales_prospect_searches
  drop constraint if exists sales_prospect_searches_source_check;
alter table public.sales_prospect_searches
  add constraint sales_prospect_searches_source_check
  check (source in ('apollo', 'web'));

-- ── Dominios que no se deben tocar ─────────────────────────────────────────
-- Bloqueo explícito: robots.txt prohibido, opt-out del titular, agregadores
-- que no son empresas (directorios, redes sociales, marketplaces). Evita
-- re-descubrir y re-scrapear lo mismo en cada corrida.

create table if not exists public.sales_domain_blocklist (
  domain text primary key,
  reason text not null, -- robots | opt-out | no-es-empresa | error-permanente
  created_at timestamptz not null default now()
);

comment on table public.sales_domain_blocklist is
  'Dominios excluidos del descubrimiento y del scraping. Ver rules de Habeas Data.';

-- Semilla: agregadores y redes que Google devuelve siempre y nunca son leads.
insert into public.sales_domain_blocklist (domain, reason) values
  ('linkedin.com',      'no-es-empresa'),
  ('facebook.com',      'no-es-empresa'),
  ('instagram.com',     'no-es-empresa'),
  ('x.com',             'no-es-empresa'),
  ('twitter.com',       'no-es-empresa'),
  ('youtube.com',       'no-es-empresa'),
  ('wikipedia.org',     'no-es-empresa'),
  ('paginasamarillas.com.co', 'no-es-empresa'),
  ('computrabajo.com.co',     'no-es-empresa'),
  ('einforma.co',       'no-es-empresa'),
  ('empresite.co',      'no-es-empresa'),
  ('mercadolibre.com.co',     'no-es-empresa')
on conflict (domain) do nothing;
