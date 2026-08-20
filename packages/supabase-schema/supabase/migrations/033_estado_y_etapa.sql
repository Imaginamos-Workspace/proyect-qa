-- 033_estado_y_etapa.sql
-- Dos niveles, uno derivado del otro. Es lo que hace que el tablero y el card
-- sean coherentes sin que el vendedor tenga que mantener dos cosas a mano.
--
--   ETAPA   las 11 del proceso comercial. Es la FUENTE DE VERDAD: la elige el
--           vendedor en el desplegable del card.
--   ESTADO  las 4 columnas del tablero. Se DERIVA de la etapa.
--
-- Cambiar la etapa mueve la tarjeta de columna sola. Arrastrar la tarjeta a
-- otra columna pone la primera etapa de esa columna. Nunca quedan en
-- desacuerdo porque el estado no se edita por separado.
--
--   BACKLOG     ← contacto, recontactar
--   EN GESTIÓN  ← reunion, propuesta, en-revision, cambio-propuesta
--   RECHAZADO   ← perdido, frio, no-calificado
--   APROBADO    ← aprobado-documentos, aprobado-cerrado
--
-- Idempotente y tolerante a los dos puntos de partida (7 estados originales,
-- u 11 si la 032 llegó a correr).

alter table public.sales_prospects
  add column if not exists estado_legacy text,
  add column if not exists etapa text;

update public.sales_prospects
   set estado_legacy = estado
 where estado_legacy is null;

-- ── 1. Etapa (11) ─────────────────────────────────────────────────────────

update public.sales_prospects
   set etapa = case estado
     -- desde el esquema original de 7
     when 'por-contactar'       then 'contacto'
     when 'referido'            then 'contacto'
     when 'contactado'          then 'contacto'
     when 'en-seguimiento'      then 'recontactar'
     when 'reunion-agendada'    then 'reunion'
     when 'convertido'          then 'aprobado-cerrado'
     when 'descartado'          then 'perdido'
     -- desde el esquema de 11 (la 032 ya usaba estos valores)
     when 'contacto'            then 'contacto'
     when 'recontactar'         then 'recontactar'
     when 'reunion'             then 'reunion'
     when 'propuesta'           then 'propuesta'
     when 'en-revision'         then 'en-revision'
     when 'cambio-propuesta'    then 'cambio-propuesta'
     when 'aprobado-documentos' then 'aprobado-documentos'
     when 'aprobado-cerrado'    then 'aprobado-cerrado'
     when 'perdido'             then 'perdido'
     when 'no-calificado'       then 'no-calificado'
     when 'frio'                then 'frio'
     else 'contacto'
   end
 where etapa is null;

alter table public.sales_prospects
  alter column etapa set default 'contacto';

alter table public.sales_prospects
  drop constraint if exists sales_prospects_etapa_check;
alter table public.sales_prospects
  add constraint sales_prospects_etapa_check
  check (etapa in (
    'contacto',            -- 1. lead registrado, primer acercamiento
    'reunion',             -- 2. reuniones para entender necesidad y alcance
    'propuesta',           -- 3. INTERNA: armando alcance, tiempos e inversión
    'en-revision',         -- 4. enviada, el cliente la evalúa
    'aprobado-documentos', -- 5. contrato, documentos, primera factura
    'aprobado-cerrado',    -- 6. firmado, listo para operaciones
    'perdido',             -- 7. no avanzó — motivo obligatorio
    'frio',                -- 8. sin contacto tras 3 intentos
    'cambio-propuesta',    -- 9. pidió ajustes
    'no-calificado',       -- 10. no es cliente potencial
    'recontactar'          -- 11. aplazó, pero sigue potencial
  ));

-- ── 2. Estado (4 columnas), derivado de la etapa ──────────────────────────

alter table public.sales_prospects
  drop constraint if exists sales_prospects_estado_check;

update public.sales_prospects
   set estado = case etapa
     when 'contacto'            then 'backlog'
     when 'recontactar'         then 'backlog'
     when 'reunion'             then 'en-gestion'
     when 'propuesta'           then 'en-gestion'
     when 'en-revision'         then 'en-gestion'
     when 'cambio-propuesta'    then 'en-gestion'
     when 'perdido'             then 'rechazado'
     when 'frio'                then 'rechazado'
     when 'no-calificado'       then 'rechazado'
     when 'aprobado-documentos' then 'aprobado'
     when 'aprobado-cerrado'    then 'aprobado'
     else 'backlog'
   end;

alter table public.sales_prospects
  alter column estado set default 'backlog';

alter table public.sales_prospects
  add constraint sales_prospects_estado_check
  check (estado in ('backlog', 'en-gestion', 'rechazado', 'aprobado'));

comment on column public.sales_prospects.etapa is
  'Etapa del proceso comercial (11). Fuente de verdad: la elige el vendedor en el card.';
comment on column public.sales_prospects.estado is
  'Columna del tablero (4). DERIVADA de la etapa — no se edita por separado.';

create index if not exists idx_sales_prospects_estado_actividad
  on public.sales_prospects (vendedor_login, estado, updated_at desc);

-- Envíos de la propuesta al TL. Se crea acá para que esta migración baste por
-- sí sola aunque la 032 no se haya aplicado.
create table if not exists public.sales_prospect_tl_reviews (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references public.sales_prospects(id) on delete cascade,
  vendedor_login text not null,
  tl_email text not null,
  sent_at date not null,
  comments text,
  created_at timestamptz not null default now()
);

create index if not exists idx_sales_prospect_tl_reviews_prospect
  on public.sales_prospect_tl_reviews (prospect_id, sent_at desc);
