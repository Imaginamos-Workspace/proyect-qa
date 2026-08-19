-- 032_estados_comerciales.sql
-- Reemplaza los 7 estados del pipeline por los 11 del proceso comercial real.
--
-- Los anteriores describían el INTENTO DE CONTACTO (por-contactar,
-- en-seguimiento, contactado…). Los nuevos describen el AVANCE DEL NEGOCIO
-- (propuesta, en revisión, aprobado, perdido…), que es como el vendedor
-- piensa su embudo.
--
-- MAPEO — cada equivalencia es una decisión, no una obviedad:
--
--   por-contactar     → contacto      el lead está registrado, sin trabajar
--   contactado        → contacto      hubo contacto pero aún no hay reunión;
--                                     "Contacto" cubre todo el acercamiento
--   referido          → contacto      un referido entra como lead nuevo
--   en-seguimiento    → recontactar   venía de "sin respuesta, insistir", que
--                                     es exactamente Recontactar (Frío es solo
--                                     tras agotar los 3 intentos)
--   reunion-agendada  → reunion
--   convertido        → aprobado-cerrado   se cerró y pasó a operaciones
--   descartado        → perdido       se registra el motivo en las notas
--
-- `estado_legacy` conserva el valor original: si algún mapeo no refleja la
-- realidad de un negocio concreto, se puede revisar y corregir a mano sin
-- haber perdido nada.

alter table public.sales_prospects
  add column if not exists estado_legacy text;

update public.sales_prospects
   set estado_legacy = estado
 where estado_legacy is null;

-- El check viejo tiene que caer ANTES de escribir los valores nuevos.
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
    'en-revision',         -- 4. propuesta enviada, el cliente la está evaluando
    'aprobado-documentos', -- 5. confirmó avanzar: contrato, documentos, primera factura
    'aprobado-cerrado',    -- 6. cerrado y firmado, listo para operaciones
    'perdido',             -- 7. no avanzó — el motivo es obligatorio en notas
    'frio',                -- 8. sin contacto tras 3 intentos
    'cambio-propuesta',    -- 9. pidió ajustes de alcance, tiempos o inversión
    'no-calificado',       -- 10. tras la reunión inicial, no es cliente potencial
    'recontactar'          -- 11. aplazó o dejó de responder, pero sigue siendo potencial
  ));

comment on column public.sales_prospects.estado is
  'Etapa del proceso comercial. Ver el check para el significado de cada una.';
comment on column public.sales_prospects.estado_legacy is
  'Estado en el esquema anterior (7 etapas de contacto). Solo para auditar el mapeo de la 032.';

-- El tablero filtra por estado y ordena por actividad reciente.
create index if not exists idx_sales_prospects_estado_actividad
  on public.sales_prospects (vendedor_login, estado, updated_at desc);
