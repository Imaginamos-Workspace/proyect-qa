-- 034_apollo_rotacion.sql
-- La corrida semanal de Apollo pasa a barrer VARIOS PAÍSES, no solo Colombia.
--
-- El problema: 17 países × 14 sectores = 238 combinaciones, y en los 45s de
-- presupuesto de la función serverless entran ~30 llamadas. Sin memoria, cada
-- semana volvería a empezar por Colombia/seguros y nunca llegaría al resto.
--
-- `next_index` guarda dónde quedó el barrido. Cada corrida arranca ahí, procesa
-- su cupo y deja anotado el punto siguiente; al llegar al final vuelve a cero.
-- Un ciclo completo toma ~8 semanas, y el catálogo es acumulativo: lo que se
-- descargó sigue disponible mientras el barrido avanza.

alter table public.sales_apollo_sync_log
  add column if not exists next_index integer not null default 0,
  -- Qué combinaciones tocó esta corrida, para poder auditar el avance.
  add column if not exists combos text;

comment on column public.sales_apollo_sync_log.next_index is
  'Posición donde continuará el próximo barrido (país × sector). Al llegar al final vuelve a 0.';
comment on column public.sales_apollo_sync_log.combos is
  'Combinaciones país/sector que procesó esta corrida.';

-- El catálogo se consulta por país desde la UI.
create index if not exists idx_sales_apollo_orgs_country
  on public.sales_apollo_orgs (country, sector, employees desc nulls last);
