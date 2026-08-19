-- 031_prospect_contacts.sql
-- CONTACTOS de un prospecto (las personas dentro de la empresa).
--
-- Regla de consumo de Apollo, en una frase: se paga UNA vez por dato y nunca
-- más. El descubrimiento de empresas es gratis; traer las personas de una
-- empresa (cargo, correo, teléfono) es lo caro, así que:
--
--   1. solo se dispara cuando el vendedor SELECCIONA un prospecto y empieza
--      a trabajarlo — no al buscar, no al listar, no al guardar;
--   2. el resultado se persiste acá;
--   3. si ya está persistido, se lee de esta tabla y NO se llama a Apollo.
--
-- `enriched_at` es lo que hace cumplir el punto 3: si tiene fecha, ya se pagó
-- por esa empresa y no se vuelve a consultar aunque no se haya encontrado a
-- nadie (un "no hay contactos" también costó, y también hay que recordarlo).

create table if not exists public.sales_prospect_contacts (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references public.sales_prospects(id) on delete cascade,

  -- Id de la persona en Apollo. Idempotente: volver a enriquecer no duplica.
  -- Los contactos cargados a mano por el vendedor van con 'manual-<uuid>'.
  external_id text not null,
  source text not null default 'apollo', -- apollo | manual | web

  name text not null,
  title text,
  -- Cargo normalizado para poder filtrar ("ceo", "rrhh", "compras"…), porque
  -- Apollo devuelve el título libre y cada empresa lo escribe distinto.
  role_tag text,
  email text,
  phone text,
  linkedin_url text,
  seniority text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (prospect_id, external_id)
);

comment on table public.sales_prospect_contacts is
  'Personas de una empresa. Se llena SOLO al trabajar un prospecto y se persiste para no volver a pagar el mismo dato.';
comment on column public.sales_prospect_contacts.role_tag is
  'Cargo normalizado (ceo | direccion | rrhh | tecnologia | compras | comercial | finanzas | otro).';

create index if not exists idx_sales_prospect_contacts_prospect
  on public.sales_prospect_contacts (prospect_id, role_tag);

-- ── Marca de "ya se pagó por esta empresa" ─────────────────────────────────

alter table public.sales_prospects
  -- NULL = nunca se buscaron contactos. Con fecha = ya se consultó Apollo,
  -- así que NO se vuelve a llamar aunque la búsqueda haya vuelto vacía.
  add column if not exists contacts_enriched_at timestamptz,
  -- Qué devolvió esa consulta, para poder explicarle al vendedor por qué no
  -- ve contactos sin tener que repetir la llamada.
  add column if not exists contacts_status text;

comment on column public.sales_prospects.contacts_enriched_at is
  'Cuándo se buscaron contactos en Apollo. Con valor, NO se vuelve a consultar (ya se pagó).';
comment on column public.sales_prospects.contacts_status is
  'ok | sin-resultados | plan-no-permite | error — resultado de la última búsqueda de contactos.';

-- Cola de los que todavía no se enriquecieron, para el panel del vendedor.
create index if not exists idx_sales_prospects_contacts_pendientes
  on public.sales_prospects (vendedor_login, contacts_enriched_at nulls first);
