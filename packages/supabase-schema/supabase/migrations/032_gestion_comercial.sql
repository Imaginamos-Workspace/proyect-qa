-- 032_gestion_comercial.sql
-- Rehace la gestión del cliente alrededor de UN solo vocabulario.
--
-- El problema que resuelve: había dos listas compitiendo. Las columnas del
-- tablero (por-contactar, en-seguimiento…) y los resultados del intento de
-- contacto (sin-respuesta, contacto-logrado…). El vendedor no sabía cuál
-- mandaba, y al registrar una llamada la tarjeta se movía sola a una columna
-- que él no había elegido.
--
-- Ahora:
--   ESTADO    → dónde está el negocio. 11 etapas. Se cambia arrastrando la
--               tarjeta o con el desplegable del card: mismo dato, dos formas.
--   BITÁCORA  → qué se hizo (llamada, correo, WhatsApp). YA NO mueve la
--               tarjeta; solo registra la actividad.

-- ── 1. Las 11 etapas del proceso comercial ────────────────────────────────
--
-- MAPEO desde las 7 anteriores. Cada equivalencia es una decisión:
--
--   por-contactar / contactado / referido  →  contacto
--       "Contacto" cubre todo el acercamiento inicial; un referido entra
--       como lead nuevo, en la primera etapa.
--   en-seguimiento  →  recontactar
--       venía de "sin respuesta, insistir". Frío es solo tras los 3 intentos.
--   reunion-agendada  →  reunion
--   convertido        →  aprobado-cerrado
--   descartado        →  perdido
--
-- `estado_legacy` conserva el valor original: el mapeo queda auditable y
-- cualquier caso mal clasificado se corrige a mano sin haber perdido nada.

alter table public.sales_prospects
  add column if not exists estado_legacy text;

update public.sales_prospects
   set estado_legacy = estado
 where estado_legacy is null;

alter table public.sales_prospects
  drop constraint if exists sales_prospects_estado_check;

update public.sales_prospects
   set estado = case estado
     when 'por-contactar'    then 'contacto'
     when 'contactado'       then 'contacto'
     when 'referido'         then 'contacto'
     when 'en-seguimiento'   then 'recontactar'
     when 'reunion-agendada' then 'reunion'
     when 'convertido'       then 'aprobado-cerrado'
     when 'descartado'       then 'perdido'
     else estado
   end;

alter table public.sales_prospects
  alter column estado set default 'contacto';

alter table public.sales_prospects
  add constraint sales_prospects_estado_check
  check (estado in (
    'contacto',            -- 1. lead registrado, primer acercamiento (inbound/outbound)
    'reunion',             -- 2. reuniones para entender necesidad y alcance (1, 2, 3…)
    'propuesta',           -- 3. INTERNA: el comercial arma alcance, tiempos e inversión
    'en-revision',         -- 4. propuesta enviada, el cliente la evalúa
    'aprobado-documentos', -- 5. confirmó avanzar: contrato, documentos, primera factura
    'aprobado-cerrado',    -- 6. cerrado y firmado, listo para operaciones
    'perdido',             -- 7. no avanzó — motivo obligatorio en observaciones
    'frio',                -- 8. sin contacto tras 3 intentos
    'cambio-propuesta',    -- 9. pidió ajustes de alcance, tiempos o inversión
    'no-calificado',       -- 10. tras la reunión inicial, no es cliente potencial
    'recontactar'          -- 11. aplazó o dejó de responder, pero sigue potencial
  ));

comment on column public.sales_prospects.estado is
  'Etapa del proceso comercial (11). Se cambia arrastrando la tarjeta o con el desplegable del card.';
comment on column public.sales_prospects.estado_legacy is
  'Estado en el esquema de 7 etapas. Solo para auditar el mapeo de esta migración.';

create index if not exists idx_sales_prospects_estado_actividad
  on public.sales_prospects (vendedor_login, estado, updated_at desc);

-- ── 2. Envíos de la propuesta al TL para revisión ─────────────────────────
--
-- Es una TABLA y no columnas porque el envío se repite: si el cliente pide
-- ajustes (etapa "Cambio de propuesta"), la propuesta vuelve al TL. Con
-- columnas se perdería el historial de revisiones.

create table if not exists public.sales_prospect_tl_reviews (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references public.sales_prospects(id) on delete cascade,
  vendedor_login text not null,
  -- Correo del TL al que se le envió. Se guarda el correo y no un login de
  -- GitHub porque el TL puede no estar en team.json todavía.
  tl_email text not null,
  -- Fecha de envío declarada por el vendedor: puede haberla mandado ayer y
  -- registrarla hoy, así que no sirve `now()`.
  sent_at date not null,
  comments text,
  created_at timestamptz not null default now()
);

comment on table public.sales_prospect_tl_reviews is
  'Cada vez que la propuesta se manda al TL a revisar. Se repite si el cliente pide cambios.';

create index if not exists idx_sales_prospect_tl_reviews_prospect
  on public.sales_prospect_tl_reviews (prospect_id, sent_at desc);
