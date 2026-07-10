-- 027_sales_rate_limits.sql
-- Rate limiting por-usuario para endpoints que consumen cuota PAGA (créditos
-- de Apollo, cuota de LLM). En serverless un limitador en memoria no sirve
-- (cada invocación es un proceso nuevo) — el estado vive en la base, igual
-- que el cooldown de regeneración de contraseña (password_regenerate_*).
-- Un registro por request; el enforce cuenta los de la ventana y poda los
-- viejos. Solo escribe el backend (service role).
create table if not exists public.sales_rate_limits (
  id uuid primary key default gen_random_uuid(),
  actor text not null,   -- login del vendedor (identidad no falsificable)
  action text not null,  -- 'apollo-search' | 'apollo-enrich' | 'llm-message'
  created_at timestamptz not null default now()
);

create index if not exists idx_sales_rate_limits_lookup
  on public.sales_rate_limits (actor, action, created_at desc);
